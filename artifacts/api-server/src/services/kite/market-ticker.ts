// Global KiteTicker market-data feed.
//
// Replaces the 5-second REST poll of the NIFTY option chain (kite.getQuote on ~60
// instruments every tick) with a single WebSocket connection that pushes LTP / OI /
// volume on change. The feed:
//   • subscribes the NIFTY 50 spot token + the ATM-centred ±STRIKE_RANGE option tokens
//     in full mode (OI + volume require full mode),
//   • maintains a live token->tick map,
//   • recomputes the chain observation (PCR / maxPain / IV / gamma) on each relevant
//     tick via the shared pure computeChainMetrics(),
//   • feeds the tier-3 intraday signal buffer at the same ~5s cadence the signal math
//     was tuned for (metrics/gate update per tick; the buffer sample rate is preserved),
//   • re-resolves + re-subscribes the chain when spot drifts into a new ATM band,
//   • reconnects and re-subscribes automatically.
//
// The buffer feed is throttled (not the metrics): tier3-signal.ts uses time-windowed
// EMAs calibrated to a ~5s observation cadence, so pushing every raw tick would distort
// D/P. We therefore sample the latest metrics into recordObservation() every
// OBSERVATION_INTERVAL_MS, driven by ticks (no network, no separate poll).

import { EventEmitter } from "events";
import { KiteTicker } from "kiteconnect";
import { logger } from "../../lib/logger.js";
import { recordObservation } from "../market/tier3-signal.js";
import {
  getGlobalDataCreds,
  getGlobalKiteClient,
  resolveNiftyChain,
  computeChainMetrics,
  findInstrumentToken,
  NIFTY_SPOT_TOKEN,
  type TickData,
  type ResolvedChain,
  type KiteOptionChainObservation,
} from "./kite-option-chain.js";

// Minimum spacing between observations fed into the tier-3 buffer. Now that the direction
// EMA is time-based (see tier3-signal.ts), the feed rate no longer changes the smoothing,
// so we feed roughly per tick — capped at ~1s, matched to the evaluator's cadence (no
// point sampling faster than we act, and it keeps realized-vol out of microstructure
// noise). This drops edge-detection lag from ~6s (5s feed + 1s eval) to ~1-2s.
const OBSERVATION_INTERVAL_MS = 1_000;
// Re-resolve the chain when spot drifts this far from the current ATM strike.
// 250 pts = 5 strikes; still leaves ≥10 strikes of coverage on each side of ATM.
const RESOLVE_DRIFT_PTS = 250;

// ── Event bus (consumed by the tick evaluator / position monitor in later batches) ──
export const marketTicker = new EventEmitter();

// ── Module state ──────────────────────────────────────────────────────────────
let ticker: KiteTicker | null = null;
let started = false;
let resolving = false;

let tickMap = new Map<number, TickData>();
let chain: ResolvedChain | null = null;
let subscribedOptionTokens: number[] = [];
let spotPrice = 0;
let latestMetrics: KiteOptionChainObservation | null = null;
let lastRecordAt = 0;

// Held-position instruments subscribed for tick-driven exits (R5), plus a symbol->token
// index covering both the chain and held instruments.
const heldTokens = new Set<number>();
const symbolToToken = new Map<string, number>();

// ── Public accessors ──────────────────────────────────────────────────────────
export function getLatestChainMetrics(): KiteOptionChainObservation | null {
  return latestMetrics;
}
export function getTickMap(): ReadonlyMap<number, TickData> {
  return tickMap;
}
export function isTickerConnected(): boolean {
  return ticker?.connected() ?? false;
}

/** Latest tick LTP for a tracked trading symbol, or null if not subscribed / no tick yet. */
export function getLtpBySymbol(tradingsymbol: string): number | null {
  const token = symbolToToken.get(tradingsymbol);
  if (!token) return null;
  const t = tickMap.get(token);
  return t && t.ltp > 0 ? t.ltp : null;
}

/** Subscribe a held position's instrument so its ticks flow into the feed (R5). */
export async function trackHeldSymbol(tradingsymbol: string): Promise<void> {
  let token = symbolToToken.get(tradingsymbol);
  if (token && heldTokens.has(token)) return; // already tracked
  if (!token) {
    const resolved = await findInstrumentToken(tradingsymbol);
    if (!resolved) return;
    token = resolved;
    symbolToToken.set(tradingsymbol, token);
  }
  heldTokens.add(token);
  if (ticker && ticker.connected()) {
    ticker.subscribe([token]);
    ticker.setMode(ticker.modeFull, [token]);
  }
}

/** Stop tracking a held position (unsubscribe only if it isn't part of the chain set). */
export function untrackHeldSymbol(tradingsymbol: string): void {
  const token = symbolToToken.get(tradingsymbol);
  if (!token) return;
  heldTokens.delete(token);
  if (!subscribedOptionTokens.includes(token)) {
    if (ticker && ticker.connected()) ticker.unsubscribe([token]);
    tickMap.delete(token);
  }
}

// ── Tick handling ─────────────────────────────────────────────────────────────
function parseTick(raw: unknown): { token: number; ltp: number; oi: number; volume: number } | null {
  const t = raw as Record<string, unknown>;
  const token = Number(t["instrument_token"] ?? 0);
  if (!token) return null;
  return {
    token,
    ltp: Number(t["last_price"] ?? 0),
    oi: Number(t["oi"] ?? 0),
    volume: Number(t["volume_traded"] ?? t["volume"] ?? 0),
  };
}

function onTicks(ticks: unknown[]): void {
  let spotUpdated = false;
  let optionUpdated = false;

  for (const raw of ticks) {
    const p = parseTick(raw);
    if (!p) continue;

    if (p.token === NIFTY_SPOT_TOKEN) {
      if (p.ltp > 0) {
        spotPrice = p.ltp;
        spotUpdated = true;
      }
      continue;
    }

    // Option token — merge, keeping the last good value for fields absent from this tick.
    const prev = tickMap.get(p.token);
    tickMap.set(p.token, {
      ltp: p.ltp > 0 ? p.ltp : prev?.ltp ?? 0,
      oi: p.oi > 0 ? p.oi : prev?.oi ?? 0,
      volume: p.volume > 0 ? p.volume : prev?.volume ?? 0,
    });
    optionUpdated = true;
  }

  // Re-resolve the subscribed chain if spot moved into a new ATM band.
  if (spotUpdated) void maybeResolveChain();

  if (chain && spotPrice > 0 && (optionUpdated || spotUpdated)) {
    const metrics = computeChainMetrics(tickMap, chain, spotPrice);
    if (metrics) {
      latestMetrics = metrics;
      marketTicker.emit("chain", metrics);

      // Feed the tier-3 buffer at the preserved cadence.
      const now = Date.now();
      if (now - lastRecordAt >= OBSERVATION_INTERVAL_MS) {
        lastRecordAt = now;
        recordObservation({
          t: now,
          price: metrics.spotPrice,
          callOI: metrics.callOI,
          putOI: metrics.putOI,
          optionVolume: metrics.optionVolume,
          atmIV: metrics.atmIV,
          atmGamma: metrics.atmGamma,
        });
      }
    }
  }

  marketTicker.emit("tick", { spotUpdated, optionUpdated });
}

// ── Chain (re)subscription ──────────────────────────────────────────────────────
async function maybeResolveChain(): Promise<void> {
  if (resolving || spotPrice <= 0) return;
  if (chain && Math.abs(spotPrice - chain.atmStrike) < RESOLVE_DRIFT_PTS) return;

  resolving = true;
  try {
    const kite = await getGlobalKiteClient();
    if (!kite) return;
    const next = await resolveNiftyChain(kite, spotPrice);
    if (!next) return;
    applyChain(next);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "market-ticker: chain resolve failed");
  } finally {
    resolving = false;
  }
}

function applyChain(next: ResolvedChain): void {
  const nextTokens = next.relevantInstruments.map((i) => i.instrument_token);
  const nextSet = new Set(nextTokens);
  const prevSet = new Set(subscribedOptionTokens);
  const toAdd = nextTokens.filter((t) => !prevSet.has(t));
  // Never unsubscribe a token we still hold a position in (R5 tick-driven exits).
  const toRemove = subscribedOptionTokens.filter((t) => !nextSet.has(t) && !heldTokens.has(t));

  // Keep the symbol->token index current for LTP-by-symbol lookups.
  for (const inst of next.relevantInstruments) symbolToToken.set(inst.tradingsymbol, inst.instrument_token);

  if (ticker && ticker.connected()) {
    if (toRemove.length) ticker.unsubscribe(toRemove);
    if (toAdd.length) {
      ticker.subscribe(toAdd);
      ticker.setMode(ticker.modeFull, toAdd);
    }
  }

  for (const t of toRemove) tickMap.delete(t);
  subscribedOptionTokens = nextTokens;
  chain = next;

  logger.info(
    { expiry: next.expiryStr, atmStrike: next.atmStrike, tokens: nextTokens.length, added: toAdd.length, removed: toRemove.length },
    "market-ticker: chain (re)subscribed"
  );
}

// ── Lifecycle ───────────────────────────────────────────────────────────────────
export async function startMarketTicker(): Promise<boolean> {
  if (started) return true;

  const creds = await getGlobalDataCreds();
  if (!creds) {
    logger.warn("market-ticker: no global data credentials available — feed not started");
    return false;
  }

  ticker = new KiteTicker({
    api_key: creds.apiKey,
    access_token: creds.accessToken,
    reconnect: true,
    max_retry: 10,
    max_delay: 60,
  });

  ticker.on("connect", () => {
    logger.info("market-ticker: connected");
    // Always (re)subscribe spot; re-subscribe option tokens if a chain is already resolved.
    ticker!.subscribe([NIFTY_SPOT_TOKEN]);
    ticker!.setMode(ticker!.modeFull, [NIFTY_SPOT_TOKEN]);
    if (subscribedOptionTokens.length) {
      ticker!.subscribe(subscribedOptionTokens);
      ticker!.setMode(ticker!.modeFull, subscribedOptionTokens);
    }
    if (heldTokens.size) {
      const held = [...heldTokens];
      ticker!.subscribe(held);
      ticker!.setMode(ticker!.modeFull, held);
    }
  });

  ticker.on("ticks", (ticks: unknown[]) => {
    try {
      onTicks(ticks);
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : err }, "market-ticker: onTicks failed");
    }
  });

  ticker.on("reconnect", (attempt: number, delay: number) => {
    logger.warn({ attempt, delay }, "market-ticker: reconnecting");
  });
  ticker.on("noreconnect", () => logger.error("market-ticker: gave up reconnecting"));
  ticker.on("error", (err: unknown) => logger.error({ err }, "market-ticker: error"));
  ticker.on("disconnect", () => logger.warn("market-ticker: disconnected"));
  ticker.on("close", (code: number, reason: string) => logger.warn({ code, reason }, "market-ticker: closed"));

  ticker.connect();
  started = true;
  logger.info("market-ticker: started");
  return true;
}

export function stopMarketTicker(): void {
  if (ticker) {
    try {
      ticker.disconnect();
    } catch {
      // ignore
    }
    ticker = null;
  }
  started = false;
  tickMap = new Map();
  chain = null;
  subscribedOptionTokens = [];
  spotPrice = 0;
  latestMetrics = null;
  lastRecordAt = 0;
  heldTokens.clear();
  symbolToToken.clear();
}

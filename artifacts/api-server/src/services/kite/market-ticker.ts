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
  NIFTY_SPOT_TOKEN,
  type TickData,
  type ResolvedChain,
  type KiteOptionChainObservation,
} from "./kite-option-chain.js";

// Preserve the tier-3 buffer cadence that the D/P math was tuned for (was the 5s poll).
const OBSERVATION_INTERVAL_MS = 5_000;
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
  const toRemove = subscribedOptionTokens.filter((t) => !nextSet.has(t));

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
}

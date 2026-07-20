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
import { recordObservation, resetSignalState } from "../market/tier3-signal.js";
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
import {
  archiveSpotTick,
  archiveEquityTick,
  archiveOptionTick,
  archiveChainMetrics,
  setTokenSymbolMap,
  startTickArchive,
} from "./tick-archive.js";
import { computeIntradaySignal } from "../market/tier3-signal.js";
import { broadcastMarketData } from "../../lib/ws-hub.js";
import { AMF_STOCKS, AMF_STOCK_SYMBOLS } from "./amf-stock-universe.js";

// Minimum spacing between observations fed into the tier-3 buffer. Now that the direction
// EMA is time-based (see tier3-signal.ts), the feed rate no longer changes the smoothing,
// so we feed roughly per tick — capped at ~1s, matched to the evaluator's cadence (no
// point sampling faster than we act, and it keeps realized-vol out of microstructure
// noise). This drops edge-detection lag from ~6s (5s feed + 1s eval) to ~1-2s.
const OBSERVATION_INTERVAL_MS = 1_000;
// Re-resolve the chain when spot drifts this far from the current ATM strike.
// 250 pts = 5 strikes; still leaves ≥10 strikes of coverage on each side of ATM.
const RESOLVE_DRIFT_PTS = 250;

// ── Spot equity tokens for KiteTicker (replaces Yahoo in the fast path) ───────
// Well-known Kite instrument tokens for NSE equities + BSE index. Override via env.
const SPOT_EQUITY_TOKENS: Record<string, { token: number; symbol: string }> = {
  RELIANCE:  { token: Number(process.env["KITE_RELIANCE_TOKEN"] ?? 779521),   symbol: "RELIANCE" },
  TCS:       { token: Number(process.env["KITE_TCS_TOKEN"] ?? 2953217),      symbol: "TCS" },
  HDFCBANK:  { token: Number(process.env["KITE_HDFCBANK_TOKEN"] ?? 857857),  symbol: "HDFCBANK" },
  SENSEX:    { token: Number(process.env["KITE_SENSEX_TOKEN"] ?? 265),       symbol: "SENSEX" },
};
const spotEquityPrices = new Map<string, { ltp: number; lastTickAt: number }>();
const SPOT_EQUITY_STALE_MS = 30_000; // fall back to Yahoo if no tick in 30s

// ── Event bus (consumed by the tick evaluator / position monitor in later batches) ──
export const marketTicker = new EventEmitter();

// ── Module state ──────────────────────────────────────────────────────────────
let ticker: KiteTicker | null = null;
let started = false;
let resolving = false;

let tickMap = new Map<number, TickData>();
let chain: ResolvedChain | null = null;
let subscribedOptionTokens: number[] = [];
// Reverse lookup: token → tradingsymbol for tick archive
const tokenToSymbolArchive = new Map<number, string>();
let spotPrice = 0;
let spotPrevClose = 0; // NIFTY previous-day close from the full-mode tick's ohlc.close
let latestMetrics: KiteOptionChainObservation | null = null;

// Short rolling history of NIFTY spot ticks for the intraday persistence (chop) read.
const spotSamples: { t: number; p: number }[] = [];
const SPOT_SAMPLE_WINDOW_MS = 30_000; // keep ~30s of spot ticks
let lastRecordAt = 0;

// Reverse lookup: token → equity symbol for spot tick parsing.
const tokenToEquitySymbol = new Map<number, string>();

// AMF stock tokens resolved dynamically from Kite NSE instruments.
// Populated on connect by resolveAmfStockTokens().
const amfStockTokens = new Map<string, number>(); // symbol → token

/**
 * Resolve Kite instrument tokens for all AMF stocks by fetching NSE instruments.
 * Called once on ticker connect. Stores results in amfStockTokens + tokenToEquitySymbol.
 */
async function resolveAmfStockTokens(kite: Awaited<ReturnType<typeof getGlobalKiteClient>>): Promise<void> {
  if (!kite) return;
  try {
    const raw = await kite.getInstruments("NSE");
    let allInstruments: Array<Record<string, unknown>>;
    if (typeof raw === "string") {
      // Manual CSV parse — same approach as kite-option-chain.ts
      const csvStr = raw as string;
      const lines = csvStr.trim().split("\n");
      const header = lines[0]!.split(",");
      allInstruments = lines.slice(1).map((line: string) => {
        const vals = line.split(",");
        const row: Record<string, unknown> = {};
        for (let i = 0; i < header.length; i++) {
          row[header[i]!] = vals[i];
        }
        return row;
      });
    } else if (Array.isArray(raw)) {
      allInstruments = raw as Array<Record<string, unknown>>;
    } else {
      allInstruments = [];
    }
    const symbolSet = new Set(AMF_STOCK_SYMBOLS);
    let resolved = 0;
    for (const inst of allInstruments) {
      const ts = String(inst["tradingsymbol"] ?? "");
      if (symbolSet.has(ts) && inst["instrument_token"] != null) {
        const token = Number(inst["instrument_token"]);
        amfStockTokens.set(ts, token);
        tokenToEquitySymbol.set(token, ts);
        symbolToToken.set(ts, token);
        resolved++;
      }
    }
    logger.info({ resolved, total: AMF_STOCKS.length }, "market-ticker: resolved AMF stock tokens from NSE instruments");
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "market-ticker: failed to resolve AMF stock tokens");
  }
}

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

/**
 * NIFTY spot's current move from previous close, in % — the axis the expected-move
 * band (priceImpactEstimate) lives on. Null until both a live tick and the ohlc
 * previous close have been seen, so the range gate can safely pass-through on warmup.
 */
export function getNiftySpotMovePct(): number | null {
  if (spotPrice <= 0 || spotPrevClose <= 0) return null;
  return ((spotPrice - spotPrevClose) / spotPrevClose) * 100;
}

/**
 * Intraday persistence ("efficiency ratio") of NIFTY spot over the last ~30s:
 * |net move| / total path travelled. ~1 = clean directional trend, ~0 = choppy
 * oscillation that goes nowhere. Also returns the net % move over the window.
 * `ready=false` until enough ticks have accumulated, so the chop gate fails open on
 * a cold buffer rather than blocking the whole session at the open.
 */
export function getNiftySpotPersistence(): { persistence: number; netPct: number; ready: boolean } {
  const n = spotSamples.length;
  if (n < 5) return { persistence: 0, netPct: 0, ready: false };
  const first = spotSamples[0]!;
  const last = spotSamples[n - 1]!;
  if (last.t - first.t < 10_000) return { persistence: 0, netPct: 0, ready: false }; // need ≥10s span
  const net = last.p - first.p;
  let path = 0;
  for (let i = 1; i < n; i++) path += Math.abs(spotSamples[i]!.p - spotSamples[i - 1]!.p);
  if (path <= 0) return { persistence: 0, netPct: 0, ready: false };
  return {
    persistence: Math.abs(net) / path,
    netPct: first.p > 0 ? (net / first.p) * 100 : 0,
    ready: true,
  };
}

/** Latest tick LTP for a tracked trading symbol, or null if not subscribed / no tick yet. */
export function getLtpBySymbol(tradingsymbol: string): number | null {
  const token = symbolToToken.get(tradingsymbol);
  if (!token) return null;
  const t = tickMap.get(token);
  return t && t.ltp > 0 ? t.ltp : null;
}

/** Latest LTP for a spot equity (RELIANCE/TCS/HDFCBANK/SENSEX + AMF stocks) from KiteTicker, or null if stale. */
export function getSpotEquityLtp(symbol: string): number | null {
  const entry = spotEquityPrices.get(symbol);
  if (!entry) return null;
  if (Date.now() - entry.lastTickAt > SPOT_EQUITY_STALE_MS) return null;
  return entry.ltp > 0 ? entry.ltp : null;
}

/** Get LTP for any AMF stock by symbol. Alias for getSpotEquityLtp. */
export function getAmfStockLtp(symbol: string): number | null {
  return getSpotEquityLtp(symbol);
}

/** Get all AMF stock LTPs as a map of symbol → { ltp, lastTickAt }. */
export function getAllAmfStockPrices(): Map<string, { ltp: number; lastTickAt: number }> {
  const result = new Map<string, { ltp: number; lastTickAt: number }>();
  for (const stock of AMF_STOCKS) {
    const entry = spotEquityPrices.get(stock.symbol);
    if (entry && entry.ltp > 0) {
      result.set(stock.symbol, entry);
    }
  }
  return result;
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
function parseTick(raw: unknown): { token: number; ltp: number; oi: number; volume: number; prevClose: number } | null {
  const t = raw as Record<string, unknown>;
  const token = Number(t["instrument_token"] ?? 0);
  if (!token) return null;
  // Full mode carries ohlc: { open, high, low, close }; close = previous-day close.
  const ohlc = t["ohlc"] as Record<string, unknown> | undefined;
  return {
    token,
    ltp: Number(t["last_price"] ?? 0),
    oi: Number(t["oi"] ?? 0),
    volume: Number(t["volume_traded"] ?? t["volume"] ?? 0),
    prevClose: Number(ohlc?.["close"] ?? 0),
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
        const now = Date.now();
        spotSamples.push({ t: now, p: p.ltp });
        const cutoff = now - SPOT_SAMPLE_WINDOW_MS;
        while (spotSamples.length && spotSamples[0]!.t < cutoff) spotSamples.shift();
        archiveSpotTick(p.token, p.ltp, p.prevClose);
      }
      if (p.prevClose > 0) spotPrevClose = p.prevClose;
      continue;
    }

    // Spot equity token — update the equity price map.
    const equitySymbol = tokenToEquitySymbol.get(p.token);
    if (equitySymbol) {
      if (p.ltp > 0) {
        spotEquityPrices.set(equitySymbol, { ltp: p.ltp, lastTickAt: Date.now() });
        archiveEquityTick(p.token, equitySymbol, p.ltp);
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
    archiveOptionTick(p.token, p.ltp > 0 ? p.ltp : prev?.ltp ?? 0, p.oi > 0 ? p.oi : prev?.oi ?? 0, p.volume > 0 ? p.volume : prev?.volume ?? 0);
  }

  // Re-resolve the subscribed chain if spot moved into a new ATM band.
  if (spotUpdated) void maybeResolveChain();

  if (chain && spotPrice > 0 && (optionUpdated || spotUpdated)) {
    const metrics = computeChainMetrics(tickMap, chain, spotPrice);
    if (metrics) {
      latestMetrics = metrics;
      marketTicker.emit("chain", metrics);

      // Broadcast to WebSocket clients for real-time UI updates
      broadcastMarketData(metrics);

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

        // Archive computed metrics + tier-3 state
        const sig = computeIntradaySignal();
        const pers = getNiftySpotPersistence();
        archiveChainMetrics(
          {
            spotPrice: metrics.spotPrice,
            callOI: metrics.callOI,
            putOI: metrics.putOI,
            optionVolume: metrics.optionVolume,
            atmIV: metrics.atmIV,
            atmGamma: metrics.atmGamma,
            pcr: metrics.pcr,
            maxPainStrike: metrics.maxPainStrike,
          },
          {
            d: sig.ready ? sig.D : null,
            p: sig.ready ? sig.P : null,
            persistence: pers.persistence,
            netPct: pers.netPct,
          }
        );
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
  for (const inst of next.relevantInstruments) {
    symbolToToken.set(inst.tradingsymbol, inst.instrument_token);
    tokenToSymbolArchive.set(inst.instrument_token, inst.tradingsymbol);
  }
  // Update the tick archive's reverse lookup
  setTokenSymbolMap(tokenToSymbolArchive);

  if (ticker && ticker.connected()) {
    if (toRemove.length) ticker.unsubscribe(toRemove);
    if (toAdd.length) {
      ticker.subscribe(toAdd);
      ticker.setMode(ticker!.modeFull, toAdd);
    }
  }

  for (const t of toRemove) tickMap.delete(t);
  subscribedOptionTokens = nextTokens;
  chain = next;

  // Reset the tier-3 intraday buffer on chain re-resolve. When spot drifts 250 points
  // and we re-subscribe to a new strike set, dCall/dPut deltas computed across the
  // boundary compare OI of different instruments — garbage direction scores for the
  // next ~5 minutes. Clearing the buffer forces a natural warmup (READY_FRACTION=0.5).
  resetSignalState();
  logger.info("market-ticker: tier-3 buffer reset on chain re-resolve");

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
    max_retry: 300,
    max_delay: 60,
  });

  ticker.on("connect", () => {
    logger.info("market-ticker: connected");
    startTickArchive();
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
    // Subscribe spot equity tokens (RELIANCE/TCS/HDFCBANK/SENSEX) for live LTP.
    const equityTokens = Object.values(SPOT_EQUITY_TOKENS).map((e) => e.token);
    ticker!.subscribe(equityTokens);
    ticker!.setMode(ticker!.modeFull, equityTokens);

    // Subscribe AMF stock universe (resolved from NSE instruments).
    if (amfStockTokens.size > 0) {
      const amfTokens = [...amfStockTokens.values()];
      ticker!.subscribe(amfTokens);
      ticker!.setMode(ticker!.modeFull, amfTokens);
      logger.info({ count: amfTokens.length }, "market-ticker: subscribed AMF stock universe");
    }
  });

  ticker.on("ticks", (ticks: unknown[]) => {
    try {
      onTicks(ticks);
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : err }, "market-ticker: onTicks failed");
    }
  });

  // Kite order postbacks arrive on this same WebSocket for the connected account. Re-emit
  // them on the shared bus so the entry tracker (R6) can confirm fills sub-second, instead
  // of waiting on the 10s reconcile. (Order updates route to the account that owns the
  // ticker's access token; per-user accounts still fall back to the tracker's poll.)
  ticker.on("order_update", (order: unknown) => {
    marketTicker.emit("order_update", order);
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

  // Build reverse lookup for spot equity tick parsing.
  tokenToEquitySymbol.clear();
  for (const [symbol, info] of Object.entries(SPOT_EQUITY_TOKENS)) {
    tokenToEquitySymbol.set(info.token, symbol);
  }

  // Resolve AMF stock tokens from NSE instruments, then subscribe if ticker is already connected.
  void getGlobalKiteClient().then(async (kite) => {
    await resolveAmfStockTokens(kite);
    // If ticker already connected (connect handler ran before resolution finished),
    // subscribe the AMF tokens now.
    if (ticker && ticker.connected() && amfStockTokens.size > 0) {
      const amfTokens = [...amfStockTokens.values()];
      ticker.subscribe(amfTokens);
      ticker.setMode(ticker.modeFull, amfTokens);
      logger.info({ count: amfTokens.length }, "market-ticker: subscribed AMF stock universe (post-resolve)");
    }
  });

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
  spotPrevClose = 0;
  spotSamples.length = 0;
  latestMetrics = null;
  lastRecordAt = 0;
  heldTokens.clear();
  symbolToToken.clear();
  spotEquityPrices.clear();
  tokenToEquitySymbol.clear();
}

// Tick archive — batches raw Kite ticks and computed chain metrics into the DB.
//
// Every tick received from the KiteTicker WebSocket is queued here and flushed
// in batches every ~2s to avoid per-tick INSERT overhead. This stores:
//   • Raw spot/option/equity ticks (ltp, oi, volume, timestamp)
//   • Computed chain metrics (PCR, maxPain, IV, gamma, callOI, putOI, etc.)
//   • Tier-3 signal state (D, P, persistence, netPct)
//
// The data is used for backtesting, audit, and post-hoc analysis.

import { db } from "@workspace/db";
import { tickArchiveTable, chainMetricsArchiveTable } from "@workspace/db";
import { logger } from "../../lib/logger.js";

// ── Batch buffers ─────────────────────────────────────────────────────────────
const tickBuffer: typeof tickArchiveTable.$inferInsert[] = [];
const metricsBuffer: typeof chainMetricsArchiveTable.$inferInsert[] = [];

const FLUSH_INTERVAL_MS = 2_000;
const MAX_BUFFER_SIZE = 500;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let running = false;

// Reverse lookup for tradingsymbol — populated from the chain resolution.
let tokenToSymbol = new Map<number, string>();

export function setTokenSymbolMap(map: Map<number, string>): void {
  tokenToSymbol = map;
}

// ── Public API: queue ticks and metrics ───────────────────────────────────────

export function archiveSpotTick(token: number, ltp: number, prevClose: number): void {
  tickBuffer.push({
    ts: new Date(),
    category: "spot",
    token,
    tradingsymbol: null,
    ltp: String(ltp),
    oi: null,
    volume: null,
    prevClose: prevClose > 0 ? String(prevClose) : null,
    extra: null,
  });
  maybeFlush();
}

export function archiveEquityTick(token: number, symbol: string, ltp: number): void {
  tickBuffer.push({
    ts: new Date(),
    category: "equity",
    token,
    tradingsymbol: symbol,
    ltp: String(ltp),
    oi: null,
    volume: null,
    prevClose: null,
    extra: null,
  });
  maybeFlush();
}

export function archiveOptionTick(token: number, ltp: number, oi: number, volume: number): void {
  const symbol = tokenToSymbol.get(token) ?? null;
  tickBuffer.push({
    ts: new Date(),
    category: "option",
    token,
    tradingsymbol: symbol,
    ltp: String(ltp),
    oi: oi > 0 ? String(oi) : null,
    volume: volume > 0 ? String(volume) : null,
    prevClose: null,
    extra: null,
  });
  maybeFlush();
}

export function archiveChainMetrics(
  metrics: {
    spotPrice: number;
    callOI: number;
    putOI: number;
    optionVolume: number;
    atmIV: number;
    atmGamma: number;
    pcr: number;
    maxPainStrike: number | null;
  },
  tier3: {
    d: number | null;
    p: number | null;
    persistence: number;
    netPct: number;
  }
): void {
  metricsBuffer.push({
    ts: new Date(),
    spotPrice: String(metrics.spotPrice),
    callOI: String(metrics.callOI),
    putOI: String(metrics.putOI),
    optionVolume: String(metrics.optionVolume),
    atmIV: metrics.atmIV ? String(metrics.atmIV) : null,
    atmGamma: metrics.atmGamma ? String(metrics.atmGamma) : null,
    pcr: metrics.pcr ? String(metrics.pcr) : null,
    maxPainStrike: metrics.maxPainStrike != null ? String(metrics.maxPainStrike) : null,
    tier3D: tier3.d != null ? String(tier3.d) : null,
    tier3P: tier3.p != null ? String(tier3.p) : null,
    spotPersistence: String(tier3.persistence),
    spotNetPct: String(tier3.netPct),
  });
  maybeFlush();
}

// ── Flush logic ───────────────────────────────────────────────────────────────

function maybeFlush(): void {
  if (tickBuffer.length >= MAX_BUFFER_SIZE || metricsBuffer.length >= 50) {
    void flush();
  } else if (!flushTimer) {
    flushTimer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
  }
}

async function flush(): Promise<void> {
  if (running) return;
  running = true;

  const ticks = tickBuffer.splice(0, tickBuffer.length);
  const metrics = metricsBuffer.splice(0, metricsBuffer.length);

  if (ticks.length === 0 && metrics.length === 0) {
    running = false;
    return;
  }

  try {
    if (ticks.length > 0) {
      await db.insert(tickArchiveTable).values(ticks);
    }
    if (metrics.length > 0) {
      await db.insert(chainMetricsArchiveTable).values(metrics);
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, tickCount: ticks.length, metricsCount: metrics.length },
      "tick-archive: flush failed (non-fatal, data lost)"
    );
  } finally {
    running = false;
  }
}

export function startTickArchive(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
  logger.info("tick-archive: started (2s flush interval)");
}

export function stopTickArchive(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  void flush(); // final flush
}

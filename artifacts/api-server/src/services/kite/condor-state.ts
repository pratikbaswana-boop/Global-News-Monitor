// Shared read-only helpers for the Iron Condor engine (Part 4/5 of the master guide).
// Everything here is additive: it only *reads* from tables/streams that already exist
// (market_regimes, market_snapshots, condor_positions, the marketTicker event bus) and
// never mutates any existing module's state.

import { db, marketRegimesTable, marketSnapshotsTable, condorPositionsTable } from "@workspace/db";
import { eq, desc, and, gte, isNotNull } from "drizzle-orm";
import { marketTicker } from "./market-ticker.js";
import { getLatestChainMetrics } from "./market-ticker.js";

const OPTION_ASSET_ID = "nifty50";

// ── Day high/low of spot (S/R proxy — Edge #2) ─────────────────────────────────
// The KiteTicker feed only exposes yesterday's close (ohlc.close) via market-ticker.ts,
// not today's running high/low. Rather than touch that file, we derive today's range
// ourselves by listening to the same public "tick" event every other module already
// subscribes to, and reading the already-exported getLatestChainMetrics().spotPrice.
let dayHigh = 0;
let dayLow = Infinity;
let dayKey = "";

function istDateKey(d: Date): string {
  const ist = new Date(d.getTime() + 330 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

function trackDayRange(): void {
  const spot = getLatestChainMetrics()?.spotPrice ?? 0;
  if (spot <= 0) return;
  const today = istDateKey(new Date());
  if (today !== dayKey) {
    dayKey = today;
    dayHigh = spot;
    dayLow = spot;
    return;
  }
  if (spot > dayHigh) dayHigh = spot;
  if (spot < dayLow) dayLow = spot;
}

let dayRangeListenerAttached = false;
export function startDayRangeTracker(): void {
  if (dayRangeListenerAttached) return;
  dayRangeListenerAttached = true;
  marketTicker.on("tick", trackDayRange);
}

/** Today's spot high/low seen so far — a live proxy for intraday support/resistance. */
export function getDayRange(): { high: number; low: number } | null {
  if (dayHigh <= 0 || dayLow === Infinity) return null;
  return { high: dayHigh, low: dayLow };
}

// ── VIX + HMM regime (Edge #1, #6, Rule #7 dynamic proxy) ──────────────────────
export interface RegimeSnapshot {
  regime: string; // RISK_ON | RISK_OFF | CRISIS
  crisisProbability: number;
  vixLevel: number | null;
}

export async function getLatestRegime(): Promise<RegimeSnapshot | null> {
  const rows = await db
    .select()
    .from(marketRegimesTable)
    .where(eq(marketRegimesTable.assetId, OPTION_ASSET_ID))
    .orderBy(desc(marketRegimesTable.detectedAt))
    .limit(1);
  if (rows.length === 0) return null;
  const r = rows[0]!;
  return {
    regime: r.regime,
    crisisProbability: r.crisisProbability,
    vixLevel: r.vixLevel ?? null,
  };
}

// ── Direction-signal self-audit (Edge #8, Rule #14) ────────────────────────────
// Below 60% resolved accuracy over the trailing window → the tilt logic falls back
// to neutral (symmetric) strikes instead of trusting the app's direction.
const ACCURACY_WINDOW_DAYS = 30;
const ACCURACY_MIN_SAMPLES = 5;

export async function getTiltAccuracyPct(): Promise<number | null> {
  const since = new Date(Date.now() - ACCURACY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ isCorrect: marketSnapshotsTable.isCorrect })
    .from(marketSnapshotsTable)
    .where(and(
      eq(marketSnapshotsTable.assetId, OPTION_ASSET_ID),
      isNotNull(marketSnapshotsTable.isCorrect),
      gte(marketSnapshotsTable.snapshotAt, since),
    ))
    .orderBy(desc(marketSnapshotsTable.snapshotAt))
    .limit(200);

  if (rows.length < ACCURACY_MIN_SAMPLES) return null; // not enough data → caller treats as unknown
  const correct = rows.filter((r) => r.isCorrect === true).length;
  return (correct / rows.length) * 100;
}

// ── Event-risk calendar (Edge #5, Rule #7) ─────────────────────────────────────
// A real economic calendar feed isn't wired up yet, so this is a small, editable list
// of known high-impact dates (RBI MPC, Union Budget, etc.) as a static safety net —
// update this array as new dates are announced. The *dynamic* half of the guard
// (crisisProbability spike, below) is the primary, always-current protection.
export const EVENT_RISK_DATES: string[] = [
  // "2026-02-01", // Union Budget (example — add real dates as they're announced)
];

export function isEventRiskDay(d: Date = new Date()): boolean {
  const today = istDateKey(d);
  const tomorrow = istDateKey(new Date(d.getTime() + 24 * 60 * 60 * 1000));
  return EVENT_RISK_DATES.includes(today) || EVENT_RISK_DATES.includes(tomorrow);
}

// ── Monthly max loss (Rule #16) ─────────────────────────────────────────────────
export async function getMonthToDateRealisedPnl(mode: "paper" | "real"): Promise<number> {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const rows = await db
    .select({ realisedPnl: condorPositionsTable.realisedPnl, closedAt: condorPositionsTable.closedAt })
    .from(condorPositionsTable)
    .where(and(
      eq(condorPositionsTable.mode, mode),
      eq(condorPositionsTable.status, "closed"),
    ));
  return rows
    .filter((r) => r.closedAt && r.closedAt >= monthStart)
    .reduce((sum, r) => sum + Number(r.realisedPnl ?? 0), 0);
}

// ── Revenge-trading cooldown (Rule #17) ─────────────────────────────────────────
const BIG_LOSS_THRESHOLD = -5_000;
const REVENGE_COOLDOWN_MS = 2 * 24 * 60 * 60 * 1000;

export async function getRevengeCooldownUntil(mode: "paper" | "real"): Promise<number | null> {
  const rows = await db
    .select({ realisedPnl: condorPositionsTable.realisedPnl, closedAt: condorPositionsTable.closedAt })
    .from(condorPositionsTable)
    .where(and(
      eq(condorPositionsTable.mode, mode),
      eq(condorPositionsTable.status, "closed"),
    ))
    .orderBy(desc(condorPositionsTable.closedAt))
    .limit(1);

  if (rows.length === 0) return null;
  const last = rows[0]!;
  if (!last.closedAt) return null;
  if (Number(last.realisedPnl ?? 0) > BIG_LOSS_THRESHOLD) return null;

  const until = last.closedAt.getTime() + REVENGE_COOLDOWN_MS;
  return until > Date.now() ? until : null;
}

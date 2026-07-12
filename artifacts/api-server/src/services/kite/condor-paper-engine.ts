// Iron Condor (option-selling) paper trading engine — implements the "Directional
// Iron Condor with Hedge" strategy from nifty_master_guide.md.
//
// This module is completely additive: it never touches signal-executor.ts,
// position-monitor.ts, tick-evaluator.ts or paper-trade-engine.ts (the existing
// option-BUYING paper engine). It has its own capital pool, its own DB table
// (condor_positions), and its own tick-driven monitor.
//
// Strategy recap (see nifty_master_guide.md Part 3-5 for full detail):
//   SELL far-OTM Put + far-OTM Call (income from theta decay)
//   BUY  farther-OTM Put + Call (hedge — caps max loss, defined risk)
//   Tilt strikes (not width) toward the app's direction signal when it's trustworthy
//   Exit a sold leg at 1.5x its entry premium; book profit at ~65% of max profit;
//   never hold into expiry-day gamma; close early on a 5-day slow bleed or a
//   crisis-regime news shock; skip entry on event-risk days or when VIX is too thin;
//   monthly max-loss circuit breaker + a revenge-trade cooldown after a big loss.

import { db, condorPositionsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { randomUUID } from "crypto";
import { logger } from "../../lib/logger.js";
import { marketTicker, getLatestChainMetrics, getLtpBySymbol } from "./market-ticker.js";
import { getGlobalKiteClient, getNearestExpiry } from "./kite-option-chain.js";
import { getHotContext } from "../market/hot-context.js";
import { broadcastCondor } from "../../lib/ws-hub.js";
import {
  startDayRangeTracker,
  getDayRange,
  getLatestRegime,
  getTiltAccuracyPct,
  isEventRiskDay,
  getMonthToDateRealisedPnl,
  getRevengeCooldownUntil,
} from "./condor-state.js";

const MODE = "paper" as const;
const OPTION_ASSET_ID = "nifty50";
const LOT_SIZE = 65;
const STRIKE_INTERVAL = 50;

const CAPITAL_INITIAL = 100_000;
const SOLD_LEG_OFFSET = 250;   // tightened: sold strikes ~250pts OTM for higher premium
const HEDGE_GAP = 150;         // hedge strikes 150pts beyond sold strikes (tighter = better risk:reward)
const TILT_SHIFT = 100;        // tilt shifts one side closer by 100pts

const MARGIN_CAPITAL_PCT = 0.55;   // Money Rule #1: max 55% of capital as margin
const MAX_LOTS = 3;                 // paper-trading cap, mirrors "start with 1 lot" (Rule #4) with room to scale

const SOLD_LEG_EXIT_MULT = 1.5;     // Rule #9: 1.5x premium → exit that leg
const BOOK_PROFIT_FRACTION = 0.65;  // Rule #10: book at 50-70% of max profit
const SLOW_BLEED_DAYS = 5;          // Rule #12
const TAX_COST_PCT = 20;            // Part 7 #5: taxes/costs eat 15-25% of gross profit

const VIX_LOW_THRESHOLD = 12;   // Edge #6: too thin, sit out
const VIX_HIGH_THRESHOLD = 18;  // Edge #6: fat premiums, bonus week
const CRISIS_PROB_ENTRY_MAX = 0.30;    // Edge #1: only enter when regime is calm
const CRISIS_PROB_EXIT_TRIGGER = 0.55; // Rule #13 / Edge #4: news-shock exit trigger

const MONTHLY_MAX_LOSS_PCT = 5; // Rule #16

const ENTRY_WINDOW_START_MIN = 615; // 10:15 IST
const ENTRY_WINDOW_END_MIN = 660;   // 11:00 IST

let started = false;
let lastEntryAttemptDay = "";
let crisisExitedToday = false;

type LegRole = "sold_put" | "sold_call" | "hedge_put" | "hedge_call";

interface CondorLeg {
  leg: 1 | 2 | 3 | 4;
  role: LegRole;
  strike: number;
  symbol: string;
  entryPremium: number;
  quantity: number;
  closed: boolean;
  exitPremium: number | null;
  closedAt: number | null;
}

interface ActiveCondorState {
  id: string;
  legs: CondorLeg[];
  spotAtEntry: number;
  expiryDate: string;
  directionTilt: "bullish" | "bearish" | "neutral";
  netPremium: number;
  maxLoss: number;
  maxProfit: number;
  lots: number;
  quantity: number;
  capitalAtEntry: number;
  enteredAt: number;
  sameDirectionDays: number;
  lastTrendDirection: "up" | "down" | "neutral";
  lastTrendCheckDay: string;
}

let activeState: ActiveCondorState | null = null;
let paperCapital = CAPITAL_INITIAL;

// ── IST time helpers ─────────────────────────────────────────────────────────────
function istMinutesOfDay(d: Date = new Date()): number {
  return (d.getUTCHours() * 60 + d.getUTCMinutes() + 330) % (24 * 60);
}
function istDay(d: Date = new Date()): number {
  return new Date(d.getTime() + 330 * 60 * 1000).getUTCDay(); // 0=Sun..6=Sat
}
function istDateKey(d: Date = new Date()): string {
  return new Date(d.getTime() + 330 * 60 * 1000).toISOString().slice(0, 10);
}
function isTradingOpen(d: Date = new Date()): boolean {
  const day = istDay(d);
  if (day === 0 || day === 6) return false;
  const min = istMinutesOfDay(d);
  return min >= 555 && min < 930; // 09:15–15:30
}
function isEntryWindow(d: Date = new Date()): boolean {
  if (!isTradingOpen(d)) return false;
  const min = istMinutesOfDay(d);
  return min >= ENTRY_WINDOW_START_MIN && min < ENTRY_WINDOW_END_MIN;
}
/** Days remaining until expiry (calendar days, IST). */
function daysToExpiry(expiryDate: string, d: Date = new Date()): number {
  const expiry = new Date(`${expiryDate}T15:30:00+05:30`);
  const ms = expiry.getTime() - d.getTime();
  return ms / (24 * 60 * 60 * 1000);
}
/** True from Wednesday 15:00 IST onward for the current weekly expiry (Rule #11). */
function isPastGammaCutoff(expiryDate: string, d: Date = new Date()): boolean {
  const dte = daysToExpiry(expiryDate, d);
  return dte <= 1.5; // roughly Wed afternoon / Thu morning for a Thu expiry
}

// ── Symbol construction (self-contained — mirrors signal-executor's private helper
// so we never need to modify or import a private function from that file) ─────────
function formatExpiryForSymbol(expiry: Date): string {
  const yy = String(expiry.getFullYear()).slice(-2);
  const mm = String(expiry.getMonth() + 1);
  const dd = String(expiry.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}
function buildOptionSymbol(expiry: Date, strike: number, type: "CE" | "PE"): string {
  return `NIFTY${formatExpiryForSymbol(expiry)}${strike}${type}`;
}
function formatExpiryDateKey(expiry: Date): string {
  const y = expiry.getFullYear();
  const m = String(expiry.getMonth() + 1).padStart(2, "0");
  const d = String(expiry.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Fetch a premium: tick feed first (sold legs, always in-range), REST fallback (hedge legs
 *  sit outside the ±750pt subscribed chain so they usually need this path). */
async function getOptionPremium(symbol: string): Promise<number | null> {
  const tick = getLtpBySymbol(symbol);
  if (tick !== null && tick > 0) return tick;
  try {
    const kite = await getGlobalKiteClient();
    if (!kite) return null;
    const quotes = await kite.getQuote([`NFO:${symbol}`]);
    const q = (quotes as Record<string, unknown>)[`NFO:${symbol}`] as Record<string, unknown> | undefined;
    const ltp = Number(q?.["last_price"] ?? 0);
    return ltp > 0 ? ltp : null;
  } catch {
    return null;
  }
}

// ── DB load/persist ────────────────────────────────────────────────────────────
async function loadStateFromDb(): Promise<void> {
  const openRows = await db
    .select()
    .from(condorPositionsTable)
    .where(eq(condorPositionsTable.mode, MODE))
    .orderBy(desc(condorPositionsTable.executedAt))
    .limit(1);

  const openRow = openRows[0]?.status === "open" ? openRows[0] : null;

  if (openRow) {
    const legs = JSON.parse(openRow.legsJson) as CondorLeg[];
    const notes = openRow.notesJson ? JSON.parse(openRow.notesJson) : {};
    activeState = {
      id: openRow.id,
      legs,
      spotAtEntry: Number(openRow.spotAtEntry),
      expiryDate: openRow.expiryDate,
      directionTilt: openRow.directionTilt as "bullish" | "bearish" | "neutral",
      netPremium: Number(openRow.netPremium),
      maxLoss: Number(openRow.maxLoss),
      maxProfit: Number(openRow.maxProfit),
      lots: openRow.lots,
      quantity: openRow.quantity,
      capitalAtEntry: Number(openRow.capitalAtEntry),
      enteredAt: openRow.executedAt.getTime(),
      sameDirectionDays: notes.sameDirectionDays ?? 0,
      lastTrendDirection: notes.lastTrendDirection ?? "neutral",
      lastTrendCheckDay: notes.lastTrendCheckDay ?? "",
    };
    paperCapital = Number(openRow.capitalAtEntry);
    logger.info({ id: openRow.id, capital: paperCapital }, "condor-paper: loaded active condor from DB");
    return;
  }

  const closedRows = await db
    .select()
    .from(condorPositionsTable)
    .where(eq(condorPositionsTable.mode, MODE))
    .orderBy(desc(condorPositionsTable.closedAt));
  const lastClosed = closedRows.find((r) => r.status === "closed");
  paperCapital = lastClosed
    ? Number(lastClosed.capitalAtEntry) + Number(lastClosed.realisedPnl ?? 0)
    : CAPITAL_INITIAL;
  logger.info({ capital: paperCapital }, "condor-paper: no open condor, capital restored");
}

function legsPnl(legs: CondorLeg[], liveQuotes: Map<string, number>): { unrealized: number; realized: number } {
  let unrealized = 0;
  let realized = 0;
  for (const leg of legs) {
    const isSold = leg.role === "sold_put" || leg.role === "sold_call";
    if (leg.closed && leg.exitPremium !== null) {
      const pnl = isSold
        ? (leg.entryPremium - leg.exitPremium) * leg.quantity
        : (leg.exitPremium - leg.entryPremium) * leg.quantity;
      realized += pnl;
    } else {
      const current = liveQuotes.get(leg.symbol) ?? leg.entryPremium;
      const pnl = isSold
        ? (leg.entryPremium - current) * leg.quantity
        : (current - leg.entryPremium) * leg.quantity;
      unrealized += pnl;
    }
  }
  return { unrealized, realized };
}

// ── Entry ──────────────────────────────────────────────────────────────────────
async function tryEnterCondor(): Promise<void> {
  if (activeState !== null) return;

  const today = istDateKey();
  if (lastEntryAttemptDay === today && !crisisExitedToday) return;
  lastEntryAttemptDay = today;

  // Rule #7 / Edge #5 — event-risk day guard (static calendar + dynamic crisis check below).
  if (isEventRiskDay()) {
    logger.info("condor-paper: skipping entry — event-risk day");
    return;
  }

  // Rule #16 — monthly max loss circuit breaker.
  const mtdPnl = await getMonthToDateRealisedPnl(MODE);
  if (mtdPnl <= -(CAPITAL_INITIAL * MONTHLY_MAX_LOSS_PCT) / 100) {
    logger.info({ mtdPnl }, "condor-paper: skipping entry — monthly max loss hit");
    return;
  }

  // Rule #17 — revenge-trade cooldown after a big loss.
  const cooldownUntil = await getRevengeCooldownUntil(MODE);
  if (cooldownUntil !== null) {
    logger.info({ cooldownUntil }, "condor-paper: skipping entry — revenge-trade cooldown active");
    return;
  }

  // Edge #1 / #6 — regime + VIX filter.
  const regime = await getLatestRegime();
  const crisisExit = crisisExitedToday;
  if (!crisisExit) {
    if (regime && regime.crisisProbability > CRISIS_PROB_ENTRY_MAX) {
      logger.info({ regime }, "condor-paper: skipping entry — elevated crisis probability");
      return;
    }
    if (regime?.vixLevel !== null && regime?.vixLevel !== undefined && regime.vixLevel < VIX_LOW_THRESHOLD) {
      logger.info({ vix: regime.vixLevel }, "condor-paper: skipping entry — VIX too low, premiums too thin");
      return;
    }
  } else {
    // Edge #4 — fear re-entry: only re-enter same day once the panic has genuinely passed.
    if (!regime || regime.regime === "CRISIS" || regime.crisisProbability > CRISIS_PROB_ENTRY_MAX) {
      return;
    }
    crisisExitedToday = false;
    logger.info({ regime }, "condor-paper: fear re-entry — panic passed, re-entering with richer premiums");
  }

  const metrics = getLatestChainMetrics();
  const spot = metrics?.spotPrice ?? 0;
  if (spot <= 0) return;

  // Edge #8 / Rule #14 — self-audit the direction signal before trusting a tilt.
  const accuracy = await getTiltAccuracyPct();
  const hot = getHotContext(OPTION_ASSET_ID);
  const trustSignal = accuracy !== null && accuracy >= 60 && hot?.confidence === "high";
  let tilt: "bullish" | "bearish" | "neutral" = "neutral";
  if (trustSignal) {
    if (hot!.direction === "up") tilt = "bullish";
    else if (hot!.direction === "down") tilt = "bearish";
  }

  // Edge #2 — shift strikes toward (but never past) the live day-range, not blindly fixed.
  const dayRange = getDayRange();
  let putOffset = SOLD_LEG_OFFSET;
  let callOffset = SOLD_LEG_OFFSET;
  if (tilt === "bullish") { putOffset -= TILT_SHIFT; callOffset += TILT_SHIFT; }
  if (tilt === "bearish") { putOffset += TILT_SHIFT; callOffset -= TILT_SHIFT; }
  if (dayRange) {
    // Never sell a strike inside today's already-traded range — keep it just beyond.
    const minPutOffset = Math.max(50, Math.round((spot - dayRange.low) / STRIKE_INTERVAL) * STRIKE_INTERVAL + 50);
    const minCallOffset = Math.max(50, Math.round((dayRange.high - spot) / STRIKE_INTERVAL) * STRIKE_INTERVAL + 50);
    putOffset = Math.max(putOffset, minPutOffset);
    callOffset = Math.max(callOffset, minCallOffset);
  }

  const roundToStrike = (v: number) => Math.round(v / STRIKE_INTERVAL) * STRIKE_INTERVAL;
  const soldPutStrike = roundToStrike(spot - putOffset);
  const soldCallStrike = roundToStrike(spot + callOffset);
  const hedgePutStrike = soldPutStrike - HEDGE_GAP;
  const hedgeCallStrike = soldCallStrike + HEDGE_GAP;

  const expiry = await getNearestExpiry();
  const soldPutSymbol = buildOptionSymbol(expiry, soldPutStrike, "PE");
  const soldCallSymbol = buildOptionSymbol(expiry, soldCallStrike, "CE");
  const hedgePutSymbol = buildOptionSymbol(expiry, hedgePutStrike, "PE");
  const hedgeCallSymbol = buildOptionSymbol(expiry, hedgeCallStrike, "CE");

  const [soldPutPremium, soldCallPremium, hedgePutPremium, hedgeCallPremium] = await Promise.all([
    getOptionPremium(soldPutSymbol),
    getOptionPremium(soldCallSymbol),
    getOptionPremium(hedgePutSymbol),
    getOptionPremium(hedgeCallSymbol),
  ]);

  if (!soldPutPremium || !soldCallPremium || !hedgePutPremium || !hedgeCallPremium) {
    logger.info({ soldPutPremium, soldCallPremium, hedgePutPremium, hedgeCallPremium }, "condor-paper: missing quotes, skipping entry");
    return;
  }

  const netPremiumPerUnit = (soldPutPremium + soldCallPremium) - (hedgePutPremium + hedgeCallPremium);
  if (netPremiumPerUnit <= 0) {
    logger.info({ netPremiumPerUnit }, "condor-paper: non-positive net premium, skipping entry");
    return;
  }

  const maxLossPerUnit = HEDGE_GAP - netPremiumPerUnit;
  const maxLossPerLot = maxLossPerUnit * LOT_SIZE;
  if (maxLossPerLot <= 0) return;

  const marginBudget = paperCapital * MARGIN_CAPITAL_PCT;
  let lots = Math.floor(marginBudget / maxLossPerLot);
  // Edge #6 — VIX bonus: size up slightly (still capped) when premiums are fat.
  if (regime?.vixLevel && regime.vixLevel >= VIX_HIGH_THRESHOLD) lots += 1;
  lots = Math.max(1, Math.min(lots, MAX_LOTS));

  const quantity = lots * LOT_SIZE;
  const netPremium = netPremiumPerUnit * quantity;
  const maxLoss = maxLossPerUnit * quantity;
  const maxProfit = netPremium;

  const legs: CondorLeg[] = [
    { leg: 3, role: "hedge_put", strike: hedgePutStrike, symbol: hedgePutSymbol, entryPremium: hedgePutPremium, quantity, closed: false, exitPremium: null, closedAt: null },
    { leg: 4, role: "hedge_call", strike: hedgeCallStrike, symbol: hedgeCallSymbol, entryPremium: hedgeCallPremium, quantity, closed: false, exitPremium: null, closedAt: null },
    { leg: 1, role: "sold_put", strike: soldPutStrike, symbol: soldPutSymbol, entryPremium: soldPutPremium, quantity, closed: false, exitPremium: null, closedAt: null },
    { leg: 2, role: "sold_call", strike: soldCallStrike, symbol: soldCallSymbol, entryPremium: soldCallPremium, quantity, closed: false, exitPremium: null, closedAt: null },
  ];
  // Order-sequence rule: hedges are recorded/"placed" first, sold legs second (paper — no
  // real margin engine to protect, but we preserve the sequence semantics for parity with
  // the real-money engine that will reuse this same leg ordering).

  const id = randomUUID();
  const expiryDateKey = formatExpiryDateKey(expiry);

  activeState = {
    id,
    legs,
    spotAtEntry: spot,
    expiryDate: expiryDateKey,
    directionTilt: tilt,
    netPremium,
    maxLoss,
    maxProfit,
    lots,
    quantity,
    capitalAtEntry: paperCapital,
    enteredAt: Date.now(),
    sameDirectionDays: 0,
    lastTrendDirection: hot?.direction === "up" || hot?.direction === "down" ? hot.direction : "neutral",
    lastTrendCheckDay: today,
  };

  await db.insert(condorPositionsTable).values({
    id,
    mode: MODE,
    status: "open",
    spotAtEntry: String(spot),
    expiryDate: expiryDateKey,
    directionTilt: tilt,
    legsJson: JSON.stringify(legs),
    netPremium: String(netPremium),
    maxLoss: String(maxLoss),
    maxProfit: String(maxProfit),
    lots,
    quantity,
    capitalAtEntry: String(paperCapital),
    marginBlocked: String(marginBudget),
    notesJson: JSON.stringify({
      vixLevel: regime?.vixLevel ?? null,
      regime: regime?.regime ?? null,
      crisisProbability: regime?.crisisProbability ?? null,
      tiltAccuracyPct: accuracy,
      sameDirectionDays: 0,
      lastTrendDirection: activeState.lastTrendDirection,
      lastTrendCheckDay: today,
    }),
  });

  logger.info({
    id, spot, tilt, soldPutStrike, soldCallStrike, hedgePutStrike, hedgeCallStrike,
    netPremium, maxLoss, maxProfit, lots,
  }, "condor-paper: entered iron condor");

  void broadcastState();
}

// ── Exit helpers ───────────────────────────────────────────────────────────────
async function closeLeg(leg: CondorLeg, exitPremium: number): Promise<void> {
  leg.closed = true;
  leg.exitPremium = exitPremium;
  leg.closedAt = Date.now();
}

async function closeFullCondor(reason: string, liveQuotes: Map<string, number>): Promise<void> {
  if (!activeState) return;
  for (const leg of activeState.legs) {
    if (!leg.closed) {
      const exitPremium = liveQuotes.get(leg.symbol) ?? leg.entryPremium;
      await closeLeg(leg, exitPremium);
    }
  }
  const { realized } = legsPnl(activeState.legs, liveQuotes);
  // Part 7 #5 — factor in taxes/costs so the journaled number is realistic, not gross.
  const netAfterCosts = realized > 0 ? realized * (1 - TAX_COST_PCT / 100) : realized;
  paperCapital = activeState.capitalAtEntry + netAfterCosts;

  await db.update(condorPositionsTable).set({
    status: "closed",
    legsJson: JSON.stringify(activeState.legs),
    realisedPnl: String(netAfterCosts.toFixed(2)),
    exitReason: reason,
    closedAt: new Date(),
  }).where(eq(condorPositionsTable.id, activeState.id));

  logger.info({ id: activeState.id, reason, realized, netAfterCosts, capital: paperCapital }, "condor-paper: closed condor");

  if (reason === "news_shock") crisisExitedToday = true;

  activeState = null;
  void broadcastState();
}

// ── Monitor ────────────────────────────────────────────────────────────────────
async function monitorCondor(): Promise<void> {
  if (!activeState) return;

  const liveQuotes = new Map<string, number>();
  for (const leg of activeState.legs) {
    if (leg.closed) continue;
    const premium = await getOptionPremium(leg.symbol);
    if (premium !== null) liveQuotes.set(leg.symbol, premium);
  }

  // Rule #11 — never hold into expiry-day gamma.
  if (isPastGammaCutoff(activeState.expiryDate)) {
    await closeFullCondor("gamma_cutoff", liveQuotes);
    return;
  }

  // Rule #13 / Edge #4 — news shock: crisis regime spike → exit the threatened leg(s) now.
  const regime = await getLatestRegime();
  if (regime && regime.crisisProbability >= CRISIS_PROB_EXIT_TRIGGER) {
    await closeFullCondor("news_shock", liveQuotes);
    return;
  }

  // Rule #9 — a sold leg hitting 1.5x its entry premium is exited on its own; the position
  // keeps running on the other side (Pressure Test #2) unless both sides are now closed.
  for (const leg of activeState.legs) {
    if (leg.closed || (leg.role !== "sold_put" && leg.role !== "sold_call")) continue;
    const current = liveQuotes.get(leg.symbol);
    if (current !== undefined && current >= leg.entryPremium * SOLD_LEG_EXIT_MULT) {
      await closeLeg(leg, current);
      logger.info({ id: activeState.id, leg: leg.role, entry: leg.entryPremium, exit: current }, "condor-paper: exited breached sold leg");
    }
  }

  const soldLegs = activeState.legs.filter((l) => l.role === "sold_put" || l.role === "sold_call");
  if (soldLegs.every((l) => l.closed)) {
    await closeFullCondor("both_sold_legs_exited", liveQuotes);
    return;
  }

  // Rule #10 — book profit once ~65% of max profit is captured.
  const { unrealized, realized } = legsPnl(activeState.legs, liveQuotes);
  const totalPnl = unrealized + realized;
  if (totalPnl >= activeState.maxProfit * BOOK_PROFIT_FRACTION) {
    await closeFullCondor("profit_booked", liveQuotes);
    return;
  }

  // Rule #12 — slow-bleed: 5 consecutive days trending the same adverse direction.
  const today = istDateKey();
  if (today !== activeState.lastTrendCheckDay) {
    const hot = getHotContext(OPTION_ASSET_ID);
    const dir = hot?.direction === "up" || hot?.direction === "down" ? hot.direction : "neutral";
    if (dir !== "neutral" && dir === activeState.lastTrendDirection) {
      activeState.sameDirectionDays += 1;
    } else {
      activeState.sameDirectionDays = 0;
    }
    activeState.lastTrendDirection = dir;
    activeState.lastTrendCheckDay = today;

    if (activeState.sameDirectionDays >= SLOW_BLEED_DAYS) {
      await closeFullCondor("slow_bleed", liveQuotes);
      return;
    }
  }

  // Persist live legs/notes and broadcast.
  await db.update(condorPositionsTable).set({
    legsJson: JSON.stringify(activeState.legs),
    notesJson: JSON.stringify({
      vixLevel: regime?.vixLevel ?? null,
      regime: regime?.regime ?? null,
      crisisProbability: regime?.crisisProbability ?? null,
      sameDirectionDays: activeState.sameDirectionDays,
      lastTrendDirection: activeState.lastTrendDirection,
      lastTrendCheckDay: activeState.lastTrendCheckDay,
    }),
  }).where(eq(condorPositionsTable.id, activeState.id));

  void broadcastState();
}

// ── Broadcast / public state ───────────────────────────────────────────────────
export interface CondorPublicState {
  capital: number;
  initialCapital: number;
  active: {
    id: string;
    legs: (CondorLeg & { currentPremium: number | null })[];
    spotAtEntry: number;
    expiryDate: string;
    directionTilt: string;
    netPremium: number;
    maxLoss: number;
    maxProfit: number;
    capitalInvested: number;
    lots: number;
    quantity: number;
    unrealizedPnl: number;
    realizedPnl: number;
    daysToExpiry: number;
    enteredAt: string;
  } | null;
  history: Array<Record<string, unknown>>;
  totalPnl: number;
  totalPositions: number;
  winningPositions: number;
}

async function buildPublicState(): Promise<CondorPublicState> {
  const rows = await db
    .select()
    .from(condorPositionsTable)
    .where(eq(condorPositionsTable.mode, MODE))
    .orderBy(desc(condorPositionsTable.executedAt))
    .limit(50);

  const closedRows = rows.filter((r) => r.status === "closed");
  const totalPnl = closedRows.reduce((sum, r) => sum + Number(r.realisedPnl ?? 0), 0);
  const winningPositions = closedRows.filter((r) => Number(r.realisedPnl ?? 0) > 0).length;

  let active: CondorPublicState["active"] = null;
  if (activeState) {
    const liveQuotes = new Map<string, number>();
    for (const leg of activeState.legs) {
      if (leg.closed) continue;
      const premium = await getOptionPremium(leg.symbol);
      if (premium !== null) liveQuotes.set(leg.symbol, premium);
    }
    const { unrealized, realized } = legsPnl(activeState.legs, liveQuotes);
    active = {
      id: activeState.id,
      legs: activeState.legs.map((l) => ({ ...l, currentPremium: liveQuotes.get(l.symbol) ?? (l.closed ? l.exitPremium : null) })),
      spotAtEntry: activeState.spotAtEntry,
      expiryDate: activeState.expiryDate,
      directionTilt: activeState.directionTilt,
      netPremium: activeState.netPremium,
      maxLoss: activeState.maxLoss,
      maxProfit: activeState.maxProfit,
      capitalInvested: activeState.maxLoss, // margin at risk — the honest "invested" figure for a hedged condor
      lots: activeState.lots,
      quantity: activeState.quantity,
      unrealizedPnl: Number(unrealized.toFixed(2)),
      realizedPnl: Number(realized.toFixed(2)),
      daysToExpiry: Number(daysToExpiry(activeState.expiryDate).toFixed(1)),
      enteredAt: new Date(activeState.enteredAt).toISOString(),
    };
  }

  return {
    capital: paperCapital,
    initialCapital: CAPITAL_INITIAL,
    active,
    history: rows.map((r) => ({
      ...r,
      spotAtEntry: Number(r.spotAtEntry),
      netPremium: Number(r.netPremium),
      maxLoss: Number(r.maxLoss),
      maxProfit: Number(r.maxProfit),
      capitalAtEntry: Number(r.capitalAtEntry),
      realisedPnl: r.realisedPnl ? Number(r.realisedPnl) : null,
      legs: JSON.parse(r.legsJson),
    })),
    totalPnl,
    totalPositions: closedRows.length,
    winningPositions,
  };
}

async function broadcastState(): Promise<void> {
  const state = await buildPublicState();
  broadcastCondor(state);
}

export async function getCondorState(): Promise<CondorPublicState> {
  return buildPublicState();
}

// ── Lifecycle ──────────────────────────────────────────────────────────────────
const EVAL_THROTTLE_MS = 2_000;
let lastEvalAt = 0;

async function evaluateCondor(): Promise<void> {
  if (!isTradingOpen()) return;
  if (activeState) {
    await monitorCondor();
  } else if (isEntryWindow() || crisisExitedToday) {
    await tryEnterCondor();
  }
}

export function startCondorPaperEngine(): void {
  if (started) return;
  started = true;
  logger.info("condor-paper: starting Iron Condor paper trading engine (Rs 1L, separate capital pool)");

  startDayRangeTracker();

  void loadStateFromDb().then(() => {
    void broadcastState();
  });

  marketTicker.on("tick", () => {
    const now = Date.now();
    if (now - lastEvalAt < EVAL_THROTTLE_MS) return;
    lastEvalAt = now;
    void evaluateCondor();
  });
}

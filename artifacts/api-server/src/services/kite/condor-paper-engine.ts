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

import { db, condorPositionsTable, brokerAccountsTable } from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import { randomUUID } from "crypto";
import { logger } from "../../lib/logger.js";
import { marketTicker, getLatestChainMetrics, getLtpBySymbol } from "./market-ticker.js";
import { getGlobalKiteClient, getNearestWeeklyExpiry, getNextWeeklyExpiry, lookupOptionSymbol } from "./kite-option-chain.js";
import { getHotContext } from "../market/hot-context.js";
import { broadcastCondor, broadcastCondorUser } from "../../lib/ws-hub.js";
import { pushTradeNotification } from "../../lib/trade-notifications.js";
import { placeOrder } from "./orders.js";
import { getMargins } from "./portfolio.js";
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
const REENTRY_WINDOW_START_MIN = 780; // 13:00 IST (1:00 PM)
const REENTRY_WINDOW_END_MIN = 870;   // 14:30 IST (2:30 PM)

let started = false;
let lastEntryAttemptDay = "";
let crisisExitedToday = false;
let condorClosedToday = false;   // set on ANY close — enables afternoon re-entry
let reEntryDoneToday = false;    // caps at 2 entries/day (1 morning + 1 afternoon)
let lastResetDay = "";           // tracks daily flag reset

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
  netPremiumPerUnit: number;
  maxLoss: number;
  maxLossPerLot: number;
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
function isReEntryWindow(d: Date = new Date()): boolean {
  if (!isTradingOpen(d)) return false;
  const min = istMinutesOfDay(d);
  return min >= REENTRY_WINDOW_START_MIN && min < REENTRY_WINDOW_END_MIN;
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
  } catch (err) {
    logger.warn({ symbol, err: err instanceof Error ? err.message : err }, "condor-paper: REST quote fallback failed");
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
      netPremiumPerUnit: notes.netPremiumPerUnit ?? Number(openRow.netPremium) / openRow.quantity,
      maxLoss: Number(openRow.maxLoss),
      maxLossPerLot: notes.maxLossPerLot ?? Number(openRow.maxLoss) / openRow.lots,
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

  // Three entry paths:
  // 1. Morning entry: isEntryWindow() + not yet attempted today
  // 2. Crisis re-entry: crisisExitedToday (news shock passed, re-enter with richer premiums)
  // 3. Afternoon re-entry: isReEntryWindow() + condorClosedToday + !reEntryDoneToday
  const isMorning = isEntryWindow();
  const isAfternoonReEntry = isReEntryWindow() && condorClosedToday && !reEntryDoneToday;
  const isCrisisReEntry = crisisExitedToday;

  if (!isMorning && !isAfternoonReEntry && !isCrisisReEntry) return;
  if (lastEntryAttemptDay === today && !isCrisisReEntry && !isAfternoonReEntry) return;
  if (reEntryDoneToday && isAfternoonReEntry) return;

  // Rule #7 / Edge #5 — event-risk day guard (static calendar + dynamic crisis check below).
  if (isEventRiskDay()) {
    logger.info("condor-paper: skipping entry — event-risk day");
    pushTradeNotification("condor", "skip", "Iron Condor entry skipped — today is an event-risk day (RBI policy, budget, expiry, or major event). Selling options on these days is dangerous due to sudden volatility spikes.");
    return;
  }

  // Rule #16 — monthly max loss circuit breaker.
  const mtdPnl = await getMonthToDateRealisedPnl(MODE);
  if (mtdPnl <= -(CAPITAL_INITIAL * MONTHLY_MAX_LOSS_PCT) / 100) {
    logger.info({ mtdPnl }, "condor-paper: skipping entry — monthly max loss hit");
    pushTradeNotification("condor", "skip", `Iron Condor entry skipped — monthly loss limit reached. Month-to-date P&L is ₹${mtdPnl.toFixed(0)}, which exceeds the maximum allowed loss of ${MONTHLY_MAX_LOSS_PCT}% of capital. The engine will resume next month.`, { mtdPnl });
    return;
  }

  // Rule #17 — revenge-trade cooldown after a big loss.
  const cooldownUntil = await getRevengeCooldownUntil(MODE);
  if (cooldownUntil !== null) {
    logger.info({ cooldownUntil }, "condor-paper: skipping entry — revenge-trade cooldown active");
    pushTradeNotification("condor", "skip", `Iron Condor entry skipped — revenge-trade cooldown is active until ${new Date(cooldownUntil).toLocaleString("en-IN")}. This prevents emotional re-entry after a significant loss.`, { cooldownUntil });
    return;
  }

  // Edge #1 / #6 — regime + VIX filter.
  const regime = await getLatestRegime();
  const crisisExit = crisisExitedToday;
  if (!crisisExit) {
    if (regime && regime.crisisProbability > CRISIS_PROB_ENTRY_MAX) {
      logger.info({ regime }, "condor-paper: skipping entry — elevated crisis probability");
      pushTradeNotification("condor", "skip", `Iron Condor entry skipped — market crisis probability is ${(regime.crisisProbability * 100).toFixed(1)}%, which is above the safe entry threshold of ${(CRISIS_PROB_ENTRY_MAX * 100).toFixed(1)}%. Selling options during high crisis risk can lead to large losses.`, { crisisProbability: regime.crisisProbability });
      return;
    }
    if (regime?.vixLevel !== null && regime?.vixLevel !== undefined && regime.vixLevel < VIX_LOW_THRESHOLD) {
      logger.info({ vix: regime.vixLevel }, "condor-paper: skipping entry — VIX too low, premiums too thin");
      pushTradeNotification("condor", "skip", `Iron Condor entry skipped — VIX is ${regime.vixLevel.toFixed(2)}, which is below the minimum threshold of ${VIX_LOW_THRESHOLD}. Option premiums are too thin to sell profitably at this volatility level.`, { vix: regime.vixLevel });
      return;
    }
  } else {
    // Edge #4 — fear re-entry: only re-enter same day once the panic has genuinely passed.
    if (!regime || regime.regime === "CRISIS" || regime.crisisProbability > CRISIS_PROB_ENTRY_MAX) {
      pushTradeNotification("condor", "skip", "Iron Condor fear re-entry skipped — market is still in crisis regime. Waiting for the panic to genuinely subside before re-entering.");
      return;
    }
    crisisExitedToday = false;
    logger.info({ regime }, "condor-paper: fear re-entry — panic passed, re-entering with richer premiums");
  }

  const metrics = getLatestChainMetrics();
  const spot = metrics?.spotPrice ?? 0;
  if (spot <= 0) {
    pushTradeNotification("condor", "skip", "Iron Condor entry skipped — no live NIFTY spot price available from the tick feed. Cannot calculate strike prices without knowing the current index level.");
    return;
  }

  // Edge #8 / Rule #14 — self-audit the direction signal before trusting a tilt.
  const accuracy = await getTiltAccuracyPct();
  const hot = getHotContext(OPTION_ASSET_ID);
  const trustSignal = accuracy !== null && accuracy >= 60 && hot?.confidence === "high";
  let tilt: "bullish" | "bearish" | "neutral" = "neutral";
  if (trustSignal) {
    if (hot!.direction === "up") tilt = "bullish";
    else if (hot!.direction === "down") tilt = "bearish";
  }

  // Directional mode: when AI has a clear direction, sell only that side's spread.
  // AI up → sell Put spread only (bullish). AI down → sell Call spread only (bearish).
  // Neutral/uncertain → sell both sides (full iron condor, current behavior).
  const sellPutSide = tilt === "bullish" || tilt === "neutral";
  const sellCallSide = tilt === "bearish" || tilt === "neutral";

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

  // Pick expiry — if nearest is past gamma cutoff (Wed afternoon/Thu), roll to next week.
  let expiry = getNearestWeeklyExpiry();
  const nearestExpiryKey = formatExpiryDateKey(expiry);
  if (isPastGammaCutoff(nearestExpiryKey)) {
    expiry = getNextWeeklyExpiry();
    logger.info({ nearestExpiryKey, rolledTo: formatExpiryDateKey(expiry) }, "condor-paper: nearest expiry past gamma cutoff, rolling to next week");
  }

  // Fetch only the premiums for the sides we're actually selling.
  const fetchTasks: Promise<{ symbol: string; premium: number }>[] = [];
  if (sellPutSide) {
    fetchTasks.push(
      getOptionPremium(lookupOptionSymbol(soldPutStrike, "PE", expiry)).then(p => ({ symbol: "soldPut", premium: p ?? 0 })),
      getOptionPremium(lookupOptionSymbol(hedgePutStrike, "PE", expiry)).then(p => ({ symbol: "hedgePut", premium: p ?? 0 })),
    );
  }
  if (sellCallSide) {
    fetchTasks.push(
      getOptionPremium(lookupOptionSymbol(soldCallStrike, "CE", expiry)).then(p => ({ symbol: "soldCall", premium: p ?? 0 })),
      getOptionPremium(lookupOptionSymbol(hedgeCallStrike, "CE", expiry)).then(p => ({ symbol: "hedgeCall", premium: p ?? 0 })),
    );
  }
  const results = await Promise.all(fetchTasks);
  const premiumMap = new Map(results.map(r => [r.symbol, r.premium]));

  const soldPutPremium = premiumMap.get("soldPut") ?? null;
  const hedgePutPremium = premiumMap.get("hedgePut") ?? null;
  const soldCallPremium = premiumMap.get("soldCall") ?? null;
  const hedgeCallPremium = premiumMap.get("hedgeCall") ?? null;

  // Validate premiums for the sides we're selling
  if (sellPutSide && (!soldPutPremium || !hedgePutPremium)) {
    logger.info({ soldPutPremium, hedgePutPremium }, "condor-paper: missing put-side quotes, skipping entry");
    pushTradeNotification("condor", "skip", `Iron Condor entry skipped — could not fetch live prices for the Put side options (sold Put at strike ${soldPutStrike} and/or hedge Put at strike ${hedgePutStrike}). The option symbol format may not match Kite's current format, or these strikes are not in the tick feed.`, { soldPutPremium, hedgePutPremium, soldPutStrike, hedgePutStrike });
    return;
  }
  if (sellCallSide && (!soldCallPremium || !hedgeCallPremium)) {
    logger.info({ soldCallPremium, hedgeCallPremium }, "condor-paper: missing call-side quotes, skipping entry");
    pushTradeNotification("condor", "skip", `Iron Condor entry skipped — could not fetch live prices for the Call side options (sold Call at strike ${soldCallStrike} and/or hedge Call at strike ${hedgeCallStrike}). The option symbol format may not match Kite's current format, or these strikes are not in the tick feed.`, { soldCallPremium, hedgeCallPremium, soldCallStrike, hedgeCallStrike });
    return;
  }

  const soldPutSymbol = lookupOptionSymbol(soldPutStrike, "PE", expiry);
  const soldCallSymbol = lookupOptionSymbol(soldCallStrike, "CE", expiry);
  const hedgePutSymbol = lookupOptionSymbol(hedgePutStrike, "PE", expiry);
  const hedgeCallSymbol = lookupOptionSymbol(hedgeCallStrike, "CE", expiry);

  const soldPremiumTotal = (sellPutSide ? soldPutPremium! : 0) + (sellCallSide ? soldCallPremium! : 0);
  const hedgePremiumTotal = (sellPutSide ? hedgePutPremium! : 0) + (sellCallSide ? hedgeCallPremium! : 0);
  const netPremiumPerUnit = soldPremiumTotal - hedgePremiumTotal;
  if (netPremiumPerUnit <= 0) {
    logger.info({ netPremiumPerUnit }, "condor-paper: non-positive net premium, skipping entry");
    pushTradeNotification("condor", "skip", `Iron Condor entry skipped — the net premium (sold income minus hedge cost) is ₹${netPremiumPerUnit.toFixed(2)} per unit, which is not profitable. The hedge is costing more than the sold legs are earning.`, { netPremiumPerUnit });
    return;
  }

  // All gates passed and quotes validated — mark today's attempt as consumed.
  lastEntryAttemptDay = today;
  if (isAfternoonReEntry) reEntryDoneToday = true;

  const maxLossPerUnit = HEDGE_GAP - netPremiumPerUnit;
  const maxLossPerLot = maxLossPerUnit * LOT_SIZE;
  if (maxLossPerLot <= 0) return;

  const marginBudget = paperCapital * MARGIN_CAPITAL_PCT;
  let lots = Math.floor(marginBudget / maxLossPerLot);
  // Edge #6 — VIX bonus: size up slightly when premiums are fat.
  if (regime?.vixLevel && regime.vixLevel >= VIX_HIGH_THRESHOLD) lots += 1;
  lots = Math.max(1, lots);

  const quantity = lots * LOT_SIZE;
  const netPremium = netPremiumPerUnit * quantity;
  const maxLoss = maxLossPerUnit * quantity;
  const maxProfit = netPremium;

  // Build legs array — only include the sides we're selling
  const legs: CondorLeg[] = [];
  let legNum = 1;
  if (sellPutSide) {
    legs.push({ leg: legNum++ as 1 | 2 | 3 | 4, role: "hedge_put", strike: hedgePutStrike, symbol: hedgePutSymbol, entryPremium: hedgePutPremium!, quantity, closed: false, exitPremium: null, closedAt: null });
    legs.push({ leg: legNum++ as 1 | 2 | 3 | 4, role: "sold_put", strike: soldPutStrike, symbol: soldPutSymbol, entryPremium: soldPutPremium!, quantity, closed: false, exitPremium: null, closedAt: null });
  }
  if (sellCallSide) {
    legs.push({ leg: legNum++ as 1 | 2 | 3 | 4, role: "hedge_call", strike: hedgeCallStrike, symbol: hedgeCallSymbol, entryPremium: hedgeCallPremium!, quantity, closed: false, exitPremium: null, closedAt: null });
    legs.push({ leg: legNum++ as 1 | 2 | 3 | 4, role: "sold_call", strike: soldCallStrike, symbol: soldCallSymbol, entryPremium: soldCallPremium!, quantity, closed: false, exitPremium: null, closedAt: null });
  }
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
    netPremiumPerUnit,
    maxLoss,
    maxLossPerLot,
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
      netPremiumPerUnit,
      maxLossPerLot,
    }),
  });

  logger.info({
    id, spot, tilt, sellPutSide, sellCallSide,
    soldPutStrike: sellPutSide ? soldPutStrike : null,
    soldCallStrike: sellCallSide ? soldCallStrike : null,
    hedgePutStrike: sellPutSide ? hedgePutStrike : null,
    hedgeCallStrike: sellCallSide ? hedgeCallStrike : null,
    netPremium, maxLoss, maxProfit, lots,
  }, "condor-paper: entered directional condor");

  const sideDesc = sellPutSide && sellCallSide ? "both sides (full iron condor)" : sellPutSide ? "Put side only (bullish)" : "Call side only (bearish)";
  pushTradeNotification("condor", "entry", `Entered Iron Condor (${sideDesc}) with ${lots} lots. Net premium: ₹${netPremium.toFixed(2)}, Max profit: ₹${maxProfit.toFixed(0)}, Max loss: ₹${maxLoss.toFixed(0)}. Spot at entry: ${spot.toFixed(0)}.`, { id, tilt, lots, netPremium, maxLoss, maxProfit });

  void broadcastState();

  // Fan out real broker orders to all condor-strategy users.
  // Awaited (not fire-and-forget) to prevent a race condition where the monitor
  // triggers an exit on the next tick before real DB rows are saved.
  try { await fanOutCondorEntry(activeState); } catch (err) {
    logger.error({ err }, "condor-real: fan-out entry failed");
  }
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

  const humanReason: Record<string, string> = {
    gamma_cutoff: "Approaching expiry — gamma risk too high",
    news_shock: "Crisis news detected — exiting for safety",
    both_sold_legs_exited: "Both sold legs were closed at 1.5x premium",
    profit_booked: "Profit target reached (65% of max profit)",
    slow_bleed: "Slow bleed — 5 consecutive days of adverse trend",
  };
  pushTradeNotification("condor", "exit", `Closed Iron Condor position. P&L: ${realized >= 0 ? "+" : ""}₹${realized.toFixed(0)}. Reason: ${humanReason[reason] ?? reason}. Capital after exit: ₹${paperCapital.toFixed(0)}.`, { id: activeState.id, reason, realized, capital: paperCapital });

  if (reason === "news_shock") crisisExitedToday = true;
  condorClosedToday = true;

  // Fan out real broker exit orders to all condor-strategy users
  try { await fanOutCondorExit(activeState, reason, netAfterCosts); } catch (err) {
    logger.error({ err }, "condor-real: fan-out exit failed");
  }

  activeState = null;
  void broadcastState();
}

// ── Real broker fan-out ─────────────────────────────────────────────────────────
// After the paper engine enters a condor, we fan out real 4-leg orders to every
// user with strategy_preference='condor' and an active broker account. Each user
// gets their own condor_positions row (mode='real', userId set) so the trading
// page can display it per-user.

async function getCondorUsers(): Promise<typeof brokerAccountsTable.$inferSelect[]> {
  const allActive = await db
    .select()
    .from(brokerAccountsTable)
    .where(and(
      eq(brokerAccountsTable.isActive, true),
      eq(brokerAccountsTable.autoTradeEnabled, true),
    ));
  return allActive.filter((a) => (a.strategyPreference ?? "fno") === "condor");
}

async function placeCondorLegOrder(
  userId: string,
  leg: CondorLeg,
  product: string,
): Promise<boolean> {
  const isSold = leg.role === "sold_put" || leg.role === "sold_call";
  // Sold legs: SELL (we receive premium). Hedge legs: BUY (we pay premium).
  const transactionType = isSold ? "SELL" : "BUY";
  try {
    const result = await placeOrder(userId, {
      exchange: "NFO",
      tradingsymbol: leg.symbol,
      transactionType,
      quantity: leg.quantity,
      orderType: "MARKET",
      product: product as "MIS" | "CNC" | "NRML",
      tag: `condor-${leg.role}`,
    });
    logger.info({ userId, leg: leg.role, symbol: leg.symbol, orderId: result.kiteOrderId }, "condor-real: leg order placed");
    return true;
  } catch (err) {
    logger.error({ userId, leg: leg.role, symbol: leg.symbol, err: err instanceof Error ? err.message : err }, "condor-real: leg order failed");
    return false;
  }
}

async function fanOutCondorEntry(state: ActiveCondorState): Promise<void> {
  const users = await getCondorUsers();
  if (users.length === 0) {
    logger.info("condor-real: no condor-strategy users with active broker accounts");
    return;
  }

  logger.info({ userCount: users.length, condorId: state.id }, "condor-real: fanning out entry to condor users");

  await Promise.all(users.map(async (account) => {
    const product = (account.defaultProduct ?? "NRML") as string;

    // Check margins and calculate per-user lots
    let userLots = state.lots;
    let userQuantity = state.quantity;
    let userMaxLoss = state.maxLoss;
    let userNetPremium = state.netPremium;
    let userMaxProfit = state.maxProfit;
    let availableCash = 0;

    try {
      const margins = await getMargins(account.userId);
      if (!margins) {
        logger.warn({ userId: account.userId }, "condor-real: could not fetch margins, skipping user");
        pushTradeNotification("condor", "skip", `Could not place Iron Condor orders for your account — broker token expired or margins unavailable. Please re-login to Kite.`, { userId: account.userId });
        return;
      }
      availableCash = margins.equity?.available?.cash ?? margins.equity?.available?.liveBalance ?? 0;

      // Recalculate lots based on user's actual available cash (same formula as paper engine)
      const userMarginBudget = availableCash * MARGIN_CAPITAL_PCT;
      userLots = Math.max(1, Math.floor(userMarginBudget / state.maxLossPerLot));
      userQuantity = userLots * LOT_SIZE;
      userMaxLoss = state.maxLossPerLot * userLots;
      userNetPremium = state.netPremiumPerUnit * userQuantity;
      userMaxProfit = userNetPremium;

      if (availableCash < userMaxLoss) {
        logger.warn({ userId: account.userId, availableCash, maxLoss: userMaxLoss }, "condor-real: insufficient margin, skipping user");
        pushTradeNotification("condor", "skip", `Iron Condor entry skipped for your account — insufficient margin. Available: ₹${availableCash.toFixed(0)}, Required: ₹${userMaxLoss.toFixed(0)}.`, { userId: account.userId });
        return;
      }
    } catch {
      logger.warn({ userId: account.userId }, "condor-real: margin check failed, skipping user");
      return;
    }

    // Build per-user legs with adjusted quantity
    const userLegs: CondorLeg[] = state.legs.map(l => ({
      ...l,
      quantity: userQuantity,
    }));

    // Place orders: hedges first (BUY), then sold legs (SELL) — same sequence as paper
    const hedgeLegs = userLegs.filter((l) => l.role === "hedge_put" || l.role === "hedge_call");
    const soldLegs = userLegs.filter((l) => l.role === "sold_put" || l.role === "sold_call");

    const results: boolean[] = [];
    for (const leg of hedgeLegs) {
      results.push(await placeCondorLegOrder(account.userId, leg, product));
    }
    for (const leg of soldLegs) {
      results.push(await placeCondorLegOrder(account.userId, leg, product));
    }

    const allSuccess = results.every((r) => r);
    const userCondorId = randomUUID();

    // Save a per-user real condor position row
    await db.insert(condorPositionsTable).values({
      id: userCondorId,
      mode: "real",
      status: allSuccess ? "open" : "cancelled",
      userId: account.userId,
      spotAtEntry: String(state.spotAtEntry),
      expiryDate: state.expiryDate,
      directionTilt: state.directionTilt,
      legsJson: JSON.stringify(userLegs),
      netPremium: String(userNetPremium),
      maxLoss: String(userMaxLoss),
      maxProfit: String(userMaxProfit),
      lots: userLots,
      quantity: userQuantity,
      capitalAtEntry: String(availableCash),
      marginBlocked: String(userMaxLoss),
      notesJson: JSON.stringify({
        paperCondorId: state.id,
        orderResults: results,
        product,
        netPremiumPerUnit: state.netPremiumPerUnit,
        maxLossPerLot: state.maxLossPerLot,
      }),
    });

    if (allSuccess) {
      logger.info({ userId: account.userId, condorId: userCondorId, lots: userLots }, "condor-real: all legs placed for user");
      pushTradeNotification("condor", "entry", `Iron Condor entered for your account — ${userLots} lots, ${userLegs.length} legs placed on Kite. Net premium: ₹${userNetPremium.toFixed(2)}, Max loss: ₹${userMaxLoss.toFixed(0)}.`, { userId: account.userId, condorId: userCondorId });
    } else {
      logger.warn({ userId: account.userId, condorId: userCondorId, results }, "condor-real: some legs failed for user");
      pushTradeNotification("condor", "warning", `Iron Condor partially placed for your account — some legs failed. Please check your Kite orders tab and manually close any filled legs.`, { userId: account.userId, condorId: userCondorId });
    }
  }));
}

async function placeCondorExitOrder(
  userId: string,
  leg: CondorLeg,
  product: string,
): Promise<boolean> {
  const isSold = leg.role === "sold_put" || leg.role === "sold_call";
  // To close: sold legs were SELL → now BUY back. Hedge legs were BUY → now SELL.
  const transactionType = isSold ? "BUY" : "SELL";
  try {
    const result = await placeOrder(userId, {
      exchange: "NFO",
      tradingsymbol: leg.symbol,
      transactionType,
      quantity: leg.quantity,
      orderType: "MARKET",
      product: product as "MIS" | "CNC" | "NRML",
      tag: `condor-exit-${leg.role}`,
    });
    logger.info({ userId, leg: leg.role, symbol: leg.symbol, orderId: result.kiteOrderId }, "condor-real: exit leg order placed");
    return true;
  } catch (err) {
    logger.error({ userId, leg: leg.role, symbol: leg.symbol, err: err instanceof Error ? err.message : err }, "condor-real: exit leg order failed");
    return false;
  }
}

async function fanOutCondorExit(state: ActiveCondorState, reason: string, estimatedPnl: number): Promise<void> {
  const openRealRows = await db
    .select()
    .from(condorPositionsTable)
    .where(and(
      eq(condorPositionsTable.mode, "real"),
      eq(condorPositionsTable.status, "open"),
    ));

  if (openRealRows.length === 0) {
    logger.info("condor-real: no open real condor positions to exit");
    return;
  }

  logger.info({ count: openRealRows.length, reason }, "condor-real: fanning out exit to condor users");

  for (const row of openRealRows) {
    if (!row.userId) continue;
    const legs = JSON.parse(row.legsJson) as CondorLeg[];
    const notes = row.notesJson ? JSON.parse(row.notesJson) : {};
    const product = (notes.product ?? "NRML") as string;

    // Place exit orders for all legs (reverse of entry)
    const results: boolean[] = [];
    for (const leg of legs) {
      if (leg.closed) continue;
      results.push(await placeCondorExitOrder(row.userId, leg, product));
    }

    // Mark all legs as closed in the real row (mirror paper engine's closeFullCondor)
    const closedLegs = legs.map(l => ({ ...l, closed: true, exitPremium: l.exitPremium ?? l.entryPremium, closedAt: Date.now() }));

    await db.update(condorPositionsTable).set({
      status: "closed",
      legsJson: JSON.stringify(closedLegs),
      realisedPnl: String(estimatedPnl.toFixed(2)),
      exitReason: reason,
      closedAt: new Date(),
    }).where(eq(condorPositionsTable.id, row.id));

    const allSuccess = results.every((r) => r);
    if (allSuccess) {
      pushTradeNotification("condor", "exit", `Iron Condor closed for your account. Reason: ${reason}. Check your Kite orders for fill details.`, { userId: row.userId, reason });
    } else {
      pushTradeNotification("condor", "warning", `Iron Condor exit partially completed for your account — some legs failed to close. Please manually close remaining positions in Kite.`, { userId: row.userId, reason });
    }
  }
}

// Fan out a single-leg exit (Rule #9: sold leg at 1.5x premium) to real broker positions.
// Closes just that one leg across all open real condor rows, mirroring the paper engine's closeLeg().
async function fanOutCondorSingleLegExit(legRole: LegRole, legSymbol: string, exitPremium: number): Promise<void> {
  const openRealRows = await db
    .select()
    .from(condorPositionsTable)
    .where(and(
      eq(condorPositionsTable.mode, "real"),
      eq(condorPositionsTable.status, "open"),
    ));

  if (openRealRows.length === 0) return;

  logger.info({ count: openRealRows.length, legRole, legSymbol }, "condor-real: fanning out single-leg exit");

  for (const row of openRealRows) {
    if (!row.userId) continue;
    const legs = JSON.parse(row.legsJson) as CondorLeg[];
    const notes = row.notesJson ? JSON.parse(row.notesJson) : {};
    const product = (notes.product ?? "NRML") as string;

    const leg = legs.find(l => l.role === legRole && l.symbol === legSymbol && !l.closed);
    if (!leg) continue;

    const success = await placeCondorExitOrder(row.userId, leg, product);
    if (success) {
      leg.closed = true;
      leg.exitPremium = exitPremium;
      leg.closedAt = Date.now();

      await db.update(condorPositionsTable).set({
        legsJson: JSON.stringify(legs),
      }).where(eq(condorPositionsTable.id, row.id));

      logger.info({ userId: row.userId, legRole, condorId: row.id }, "condor-real: single-leg exit placed");
    } else {
      pushTradeNotification("condor", "warning", `Failed to close ${legRole.replace(/_/g, " ")} leg (${legSymbol}) on your account. Please manually close it in Kite.`, { userId: row.userId, legRole });
    }
  }
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
      // Fan out single-leg exit to real broker positions
      try { await fanOutCondorSingleLegExit(leg.role, leg.symbol, current); } catch (err) {
        logger.error({ err, leg: leg.role }, "condor-real: single-leg exit fan-out failed");
      }
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

// Broadcast per-user real condor positions with live premiums to each user via WebSocket.
// Called from the monitor tick so users see real-time unrealized P&L on the trading page.
let lastUserBroadcastAt = 0;
const USER_BROADCAST_THROTTLE_MS = 3_000;

async function broadcastUserCondorStates(): Promise<void> {
  const now = Date.now();
  if (now - lastUserBroadcastAt < USER_BROADCAST_THROTTLE_MS) return;
  lastUserBroadcastAt = now;

  try {
    const openRows = await db
      .select()
      .from(condorPositionsTable)
      .where(and(
        eq(condorPositionsTable.mode, "real"),
        eq(condorPositionsTable.status, "open"),
      ))
      .orderBy(desc(condorPositionsTable.executedAt));

    if (openRows.length === 0) return;

    // Group by userId
    const byUser = new Map<string, typeof openRows>();
    for (const r of openRows) {
      const uid = r.userId ?? "";
      if (!byUser.has(uid)) byUser.set(uid, []);
      byUser.get(uid)!.push(r);
    }

    // For each user, enrich positions with live premiums and broadcast
    for (const [userId, rows] of byUser) {
      if (!userId) continue;

      const enriched = await Promise.all(rows.map(async (r) => {
        const legs = JSON.parse(r.legsJson) as CondorLeg[];
        const liveQuotes = new Map<string, number>();
        for (const leg of legs) {
          if (leg.closed) continue;
          const premium = await getOptionPremium(leg.symbol);
          if (premium !== null) liveQuotes.set(leg.symbol, premium);
        }
        const { unrealized, realized } = legsPnl(legs, liveQuotes);

        return {
          ...r,
          spotAtEntry: Number(r.spotAtEntry),
          netPremium: Number(r.netPremium),
          maxLoss: Number(r.maxLoss),
          maxProfit: Number(r.maxProfit),
          capitalAtEntry: Number(r.capitalAtEntry),
          marginBlocked: r.marginBlocked ? Number(r.marginBlocked) : null,
          realisedPnl: r.realisedPnl ? Number(r.realisedPnl) : null,
          legs: legs.map((l) => ({
            ...l,
            currentPremium: liveQuotes.get(l.symbol) ?? (l.closed ? l.exitPremium : null),
          })),
          unrealizedPnl: Number(unrealized.toFixed(2)),
          realizedPnl: Number(realized.toFixed(2)),
        };
      }));

      broadcastCondorUser(userId, { positions: enriched });
    }
  } catch (err) {
    logger.error({ err }, "condor-real: broadcast user states failed");
  }
}

export async function getCondorState(): Promise<CondorPublicState> {
  return buildPublicState();
}

// ── Lifecycle ──────────────────────────────────────────────────────────────────
const EVAL_THROTTLE_MS = 2_000;
let lastEvalAt = 0;

async function evaluateCondor(): Promise<void> {
  if (!isTradingOpen()) return;

  // Daily reset of flags
  const today = istDateKey();
  if (lastResetDay !== today) {
    lastResetDay = today;
    crisisExitedToday = false;
    condorClosedToday = false;
    reEntryDoneToday = false;
  }

  if (activeState) {
    await monitorCondor();
  } else if (isEntryWindow() || crisisExitedToday || isReEntryWindow()) {
    await tryEnterCondor();
  }

  // Broadcast per-user real condor positions with live premiums (throttled internally)
  void broadcastUserCondorStates();
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

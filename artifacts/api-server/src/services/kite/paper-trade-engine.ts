import { db, paperTradesTable, marketSnapshotsTable } from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import { logger } from "../../lib/logger.js";
import { getLatestChainMetrics, getLtpBySymbol, marketTicker } from "./market-ticker.js";
import { computeLiveOptionSide, quoteCandidatesFromTicks, buildStrikeCandidates, selectBestOption } from "./signal-executor.js";
import { getNearestExpiry } from "./kite-option-chain.js";
import { broadcastPaperTrading } from "../../lib/ws-hub.js";
import { pushTradeNotification } from "../../lib/trade-notifications.js";
import { randomUUID } from "crypto";
import { getLatestRegime } from "./condor-state.js";

const PAPER_CAPITAL_INITIAL = 100_000;
const NIFTY_LOT_SIZE = 65;
const OPTION_HARD_STOP_PCT = 15;
const OPTION_TRAIL_GAP_PCT = 8;
const OPTION_MILESTONE_STEP = 10;
const FAR_OTM_HARD_STOP_PCT = 15;
const FAR_OTM_TRAIL_GAP_PCT = 8;
const FAR_OTM_MILESTONE_STEP = 5;
const FAR_OTM_TIME_STOP_MS = 15 * 60 * 1000;
const FAR_OTM_DELTA_THRESHOLD = 0.15;
const FAR_OTM_MIN_GAIN_PCT = 5;

// ── New exit strategy constants ───────────────────────────────────────────────
const EOD_SQUAREOFF_IST_MIN = 915;             // 3:15 PM IST (broker MIS squareoff starts ~3:20)
const MOMENTUM_WINDOW_MS = 5 * 60 * 1000;      // 5-minute rolling window
const MOMENTUM_DROPPCT = 8;                     // 8% drop from window-peak → fast reversal
const MOMENTUM_MIN_HOLD_MS = 120_000;            // 120s minimum hold before momentum_reversal can fire
const SIGNAL_FLIP_CONFIRM_TICKS = 2;            // 2 consecutive flipped ticks → confirmed
const SPOT_PROXIMITY_THRESHOLD = 50;            // 50pts from strike → gamma cliff risk
const SPOT_PROXIMITY_MIN_HOLD_MS = 60_000;       // 60s minimum hold before proximity can fire
const SPOT_PROXIMITY_DEEP_ITM_THRESHOLD = 80;   // must have been >80pts ITM before proximity triggers
const VIX_SPIKE_PCT = 20;                       // 20% above 15-min baseline → exit
const VIX_BASELINE_WINDOW_MS = 15 * 60 * 1000;  // 15-minute VIX baseline
const VIX_CHECK_THROTTLE_MS = 30_000;           // only query regime every 30s

const OPTION_ASSET_ID = "nifty50";

let started = false;
let lastOptionSide: "BUY_CALL" | "BUY_PUT" | "NO_TRADE" = "NO_TRADE";
let paperCapital: number = PAPER_CAPITAL_INITIAL;
let activeTradeId: string | null = null;
let lastExitAt = 0;
const REENTRY_COOLDOWN_MS = 3 * 60 * 1000;       // 3 min cooldown before re-entry after exit (matches live trade cooldown)

function humanizeExitReason(reason: string): string {
  const map: Record<string, string> = {
    hard_stop: "Stop-loss hit (price fell below the hard stop level)",
    trailing_ratchet: "Trailing stop triggered (price gave back too much from peak)",
    time_stop: "Time-based exit (option held too long without meaningful move)",
    signal_flip: "Signal reversed direction",
    spot_proximity: "Spot price moved too close to the option strike",
    gamma_cutoff: "Approaching expiry — gamma risk too high",
    news_shock: "Crisis news detected — exiting for safety",
    both_sold_legs_exited: "Both sold legs were closed",
    profit_booked: "Profit target reached",
    slow_bleed: "Slow bleed — multiple days of small losses",
  };
  return map[reason] ?? reason;
}

interface ActiveTradeState {
  id: string;
  symbol: string;
  strike: number;
  entryPrice: number;
  quantity: number;
  direction: "up" | "down";
  signal: "BUY_CALL" | "BUY_PUT";
  highestPrice: number;
  stopLossPrice: number;
  trailGapPct: number;
  hardStopPct: number;
  milestoneStep: number;
  isFarOTM: boolean;
  lastMilestoneLevel: number;
  executedAt: number;
  capitalAtEntry: number;
  // New: momentum reversal tracking (in-memory only, not persisted)
  tickHistory: { ts: number; price: number }[];
  // New: signal flip confirmation counter (in-memory only)
  signalFlipCount: number;
  // New: VIX baseline tracking (in-memory only)
  vixHistory: { ts: number; vix: number }[];
  // Track whether trade was ever deep ITM (for spot_proximity guard)
  wasDeepITM: boolean;
  spotAtEntry: number;
}

let activeState: ActiveTradeState | null = null;
let lastVixCheckAt = 0;

async function loadStateFromDb(): Promise<void> {
  const openTrades = await db
    .select()
    .from(paperTradesTable)
    .where(eq(paperTradesTable.status, "open"))
    .orderBy(desc(paperTradesTable.executedAt))
    .limit(1);

  if (openTrades.length > 0) {
    const t = openTrades[0];
    const notes = t.notes ? JSON.parse(t.notes) : {};
    activeTradeId = t.id;
    activeState = {
      id: t.id,
      symbol: t.assetSymbol,
      strike: Number(t.strike ?? 0),
      entryPrice: Number(t.entryPrice),
      quantity: t.quantity,
      direction: t.direction as "up" | "down",
      signal: t.signal as "BUY_CALL" | "BUY_PUT",
      highestPrice: Number(t.highestPriceReached ?? t.entryPrice),
      stopLossPrice: Number(t.stopLossPrice ?? 0),
      trailGapPct: Number(t.trailGapPct ?? OPTION_TRAIL_GAP_PCT),
      hardStopPct: notes.hardStopPct ?? OPTION_HARD_STOP_PCT,
      milestoneStep: notes.milestoneStep ?? OPTION_MILESTONE_STEP,
      isFarOTM: notes.isFarOTM ?? false,
      lastMilestoneLevel: notes.lastMilestoneLevel ?? 0,
      executedAt: t.executedAt.getTime(),
      capitalAtEntry: Number(t.capitalAtEntry),
      tickHistory: [],
      signalFlipCount: 0,
      vixHistory: [],
      wasDeepITM: false,
      spotAtEntry: 0,
    };
    paperCapital = Number(t.capitalAtEntry);
    logger.info({ tradeId: t.id, symbol: t.assetSymbol, capital: paperCapital }, "paper-trade: loaded active trade from DB");
  } else {
    const closedTrades = await db
      .select()
      .from(paperTradesTable)
      .where(eq(paperTradesTable.status, "closed"))
      .orderBy(desc(paperTradesTable.closedAt));

    if (closedTrades.length > 0) {
      const last = closedTrades[0];
      paperCapital = Number(last.capitalAtEntry) + Number(last.realisedPnl ?? 0);
    } else {
      paperCapital = PAPER_CAPITAL_INITIAL;
    }
    logger.info({ capital: paperCapital }, "paper-trade: no open trade, capital restored");
  }
}

function computeRatchetStop(
  entryPrice: number,
  peakPrice: number,
  trailGapPct: number,
  hardStopPct: number,
  milestoneStep: number,
  lastMilestoneLevel: number
): { stopPrice: number; milestoneLevel: number } {
  const profitPct = ((peakPrice - entryPrice) / entryPrice) * 100;

  // Below first milestone: use hard stop
  if (profitPct < milestoneStep) {
    return {
      stopPrice: entryPrice * (1 - hardStopPct / 100),
      milestoneLevel: 0,
    };
  }

  // Trailing: trailGapPct below peak (caps giveback at 8%)
  const trailingStop = peakPrice * (1 - trailGapPct / 100);

  // Floor: lock 70% of profit, minimum 8% (ATM/ITM) or 3% (far OTM)
  const floorMinPct = milestoneStep === 5 ? 3 : 8;
  const floorLockPct = Math.max(floorMinPct, profitPct * 0.70);
  const floorStop = entryPrice * (1 + floorLockPct / 100);

  const stopPrice = Math.max(trailingStop, floorStop);

  // Milestone level for SL modification cadence (every 5%)
  const milestoneLevel = milestoneStep + Math.floor((profitPct - milestoneStep) / 5) * 5;

  return { stopPrice, milestoneLevel };
}

/**
 * Adaptive trailing gap — scales the trail tighter as profit grows.
 * Only applies above the first milestone (below milestone, hard stop is used).
 *
 * | Profit range | ATM/ITM gap | Far-OTM gap | Rationale                         |
 * |  < 20%       | 6%          | 7%          | Tighter than old 8%, lock early   |
 * | 20-35%       | 5%          | 6%          | Sweet spot, most exits happen     |
 * | 35-50%       | 4%          | 5%          | Big move, protect aggressively    |
 * |  50%+        | 3%          | 4%          | Let it run but cap giveback       |
 */
function adaptiveTrailGap(profitPct: number, isFarOTM: boolean): number {
  if (isFarOTM) {
    if (profitPct < 20) return 7;
    if (profitPct < 35) return 6;
    if (profitPct < 50) return 5;
    return 4;
  }
  if (profitPct < 20) return 6;
  if (profitPct < 35) return 5;
  if (profitPct < 50) return 4;
  return 3;
}

async function enterPaperTrade(signal: "BUY_CALL" | "BUY_PUT"): Promise<void> {
  if (activeState !== null) return;

  const metrics = getLatestChainMetrics();
  const spot = metrics?.spotPrice ?? 0;
  if (spot <= 0) {
    pushTradeNotification("paper", "skip", "No live market price available for NIFTY — cannot determine strike prices for entry");
    return;
  }

  const atmStrike = Math.round(spot / 50) * 50;
  const expiry = await getNearestExpiry();
  const candidates = buildStrikeCandidates(atmStrike, signal, expiry);

  let quotes = quoteCandidatesFromTicks(candidates);
  if (quotes.length === 0) {
    pushTradeNotification("paper", "skip", `Signal was ${signal} but no live option prices found in the tick feed for any candidate strike near ${atmStrike}. The option symbol format may not match Kite's current format.`, { signal, atmStrike, candidateCount: candidates.length });
    return;
  }

  const best = selectBestOption(quotes, paperCapital);
  if (!best) {
    pushTradeNotification("paper", "skip", `Signal was ${signal} but no affordable option was found with the available capital of ₹${paperCapital.toFixed(0)}. Option premiums may be too expensive or too cheap for the allowed range.`, { signal, capital: paperCapital, quoteCount: quotes.length });
    return;
  }

  const isFarOTM = best.deltaEstimate < FAR_OTM_DELTA_THRESHOLD;
  const hardStopPct = isFarOTM ? FAR_OTM_HARD_STOP_PCT : OPTION_HARD_STOP_PCT;
  const trailGapPct = isFarOTM ? FAR_OTM_TRAIL_GAP_PCT : OPTION_TRAIL_GAP_PCT;
  const milestoneStep = isFarOTM ? FAR_OTM_MILESTONE_STEP : OPTION_MILESTONE_STEP;
  const stopLossPrice = best.premium * (1 - hardStopPct / 100);

  const tradeId = randomUUID();
  const direction = "up";

  activeTradeId = tradeId;
  activeState = {
    id: tradeId,
    symbol: best.symbol,
    strike: best.strike,
    entryPrice: best.premium,
    quantity: best.lots * NIFTY_LOT_SIZE,
    direction,
    signal,
    highestPrice: best.premium,
    stopLossPrice,
    trailGapPct,
    hardStopPct,
    milestoneStep,
    isFarOTM,
    lastMilestoneLevel: 0,
    executedAt: Date.now(),
    capitalAtEntry: paperCapital,
    tickHistory: [],
    signalFlipCount: 0,
    vixHistory: [],
    wasDeepITM: false,
    spotAtEntry: getLatestChainMetrics()?.spotPrice ?? 0,
  };

  await db.insert(paperTradesTable).values({
    id: tradeId,
    assetId: OPTION_ASSET_ID,
    assetSymbol: best.symbol,
    direction,
    signal,
    strike: String(best.strike),
    quantity: best.lots * NIFTY_LOT_SIZE,
    entryPrice: String(best.premium),
    status: "open",
    stopLossPrice: String(stopLossPrice),
    highestPriceReached: String(best.premium),
    trailGapPct: String(trailGapPct),
    exitStrategy: isFarOTM ? "trailing_ratchet_far_otm" : "trailing_ratchet",
    capitalAtEntry: String(paperCapital),
    notes: JSON.stringify({
      deltaEstimate: best.deltaEstimate,
      isFarOTM,
      hardStopPct,
      trailGapPct,
      milestoneStep,
      lastMilestoneLevel: 0,
    }),
  });

  logger.info({
    tradeId, symbol: best.symbol, strike: best.strike, premium: best.premium,
    lots: best.lots, quantity: best.lots * NIFTY_LOT_SIZE, signal, capital: paperCapital,
  }, "paper-trade: entered virtual trade");

  pushTradeNotification("paper", "entry", `Entered ${signal === "BUY_CALL" ? "Call (CE)" : "Put (PE)"} paper trade: ${best.symbol} at ₹${best.premium.toFixed(2)} × ${best.lots} lots (${best.lots * NIFTY_LOT_SIZE} qty). Capital deployed: ₹${(best.premium * best.lots * NIFTY_LOT_SIZE).toFixed(0)}.`, { tradeId, symbol: best.symbol, strike: best.strike, premium: best.premium, lots: best.lots, signal });

  void broadcastState();
}

async function exitPaperTrade(reason: string, exitPrice: number): Promise<void> {
  if (!activeState || !activeTradeId) return;

  const pnl = (exitPrice - activeState.entryPrice) * activeState.quantity;
  paperCapital = activeState.capitalAtEntry + pnl;

  pushTradeNotification("paper", "exit", `Exited paper trade ${activeState.symbol} at ₹${exitPrice.toFixed(2)} — P&L: ${pnl >= 0 ? "+" : ""}₹${pnl.toFixed(2)}. Reason: ${humanizeExitReason(reason)}.`, { symbol: activeState.symbol, exitPrice, pnl, reason });

  await db
    .update(paperTradesTable)
    .set({
      status: "closed",
      exitPrice: String(exitPrice),
      realisedPnl: String(pnl.toFixed(2)),
      exitReason: reason,
      closedAt: new Date(),
    })
    .where(eq(paperTradesTable.id, activeTradeId));

  logger.info({
    tradeId: activeTradeId, symbol: activeState.symbol, exitPrice, pnl: pnl.toFixed(2),
    reason, capital: paperCapital,
  }, "paper-trade: exited virtual trade");

  activeTradeId = null;
  activeState = null;
  lastExitAt = Date.now();
  lastOptionSide = "NO_TRADE";
  void broadcastState();
}

async function monitorPaperTrade(currentSignal: "BUY_CALL" | "BUY_PUT" | "NO_TRADE"): Promise<void> {
  if (!activeState) return;

  const ltp = getLtpBySymbol(activeState.symbol);
  if (!ltp || ltp <= 0) return;

  if (ltp > activeState.highestPrice) {
    activeState.highestPrice = ltp;
  }

  // Track tick history for momentum reversal (5-min rolling window)
  activeState.tickHistory.push({ ts: Date.now(), price: ltp });
  const momentumCutoff = Date.now() - MOMENTUM_WINDOW_MS;
  activeState.tickHistory = activeState.tickHistory.filter((t) => t.ts >= momentumCutoff);

  // ── Exit 1: EOD square off (3:15 PM IST) ──────────────────────────────────
  // Matches broker MIS auto-squareoff. Paper must mirror real trading.
  const now = new Date();
  const istMin = (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % (24 * 60);
  if (istMin >= EOD_SQUAREOFF_IST_MIN) {
    await exitPaperTrade("eod_squareoff", ltp);
    return;
  }

  // ── Exit 2: Signal flip (AI direction reversed) ───────────────────────────
  // If the signal that triggered our entry has now flipped against us, exit.
  // Requires 2 consecutive flipped ticks to avoid noise.
  const isSignalFlipped =
    (activeState.signal === "BUY_CALL" && currentSignal === "BUY_PUT") ||
    (activeState.signal === "BUY_PUT" && currentSignal === "BUY_CALL");
  if (isSignalFlipped) {
    activeState.signalFlipCount++;
  } else {
    activeState.signalFlipCount = 0;
  }
  if (activeState.signalFlipCount >= SIGNAL_FLIP_CONFIRM_TICKS) {
    await exitPaperTrade("signal_flip", ltp);
    return;
  }

  // ── Exit 3: Momentum reversal (fast adverse move) ─────────────────────────
  // If premium dropped ≥8% from its window-peak within 5 minutes, exit.
  // This catches velocity, not just level — a slow drift is handled by trailing stop.
  // Guard: must have held the trade for ≥120s — don't fire on the first few ticks
  // since high-premium ATM options can easily drop 8% on a single bid/ask bounce.
  const holdMs = Date.now() - activeState.executedAt;
  if (holdMs >= MOMENTUM_MIN_HOLD_MS && activeState.tickHistory.length >= 5) {
    const peakInWindow = Math.max(...activeState.tickHistory.map((t) => t.price));
    const dropPct = ((peakInWindow - ltp) / peakInWindow) * 100;
    if (dropPct >= MOMENTUM_DROPPCT) {
      await exitPaperTrade("momentum_reversal", ltp);
      return;
    }
  }

  // ── Exit 4: Spot proximity / delta risk ───────────────────────────────────
  // If spot is within 50pts of our strike (approaching from ITM side), exit.
  // The option is about to go ATM→OTM and gamma will crush the premium.
  //
  // Guards:
  //   (a) Must have held the trade for ≥60s — don't fire on the entry tick.
  //   (b) Must have been deep ITM (>80pts) at some point — only exit when spot
  //       is APPROACHING the strike from deep ITM, not when the trade starts
  //       near the strike (which is normal for ATM option buying).
  const metrics = getLatestChainMetrics();
  const spot = metrics?.spotPrice ?? 0;
  if (spot > 0 && activeState.strike > 0) {
    const holdMs = Date.now() - activeState.executedAt;
    const itmDistance = activeState.signal === "BUY_CALL"
      ? spot - activeState.strike
      : activeState.strike - spot;

    // Track if trade was ever deep ITM
    if (itmDistance > SPOT_PROXIMITY_DEEP_ITM_THRESHOLD) {
      activeState.wasDeepITM = true;
    }

    if (holdMs >= SPOT_PROXIMITY_MIN_HOLD_MS && activeState.wasDeepITM && itmDistance >= 0 && itmDistance <= SPOT_PROXIMITY_THRESHOLD) {
      await exitPaperTrade("spot_proximity", ltp);
      return;
    }
  }

  // ── Exit 5: VIX spike ─────────────────────────────────────────────────────
  // If VIX spikes 20%+ above its 15-min baseline, a volatility event is underway.
  // Throttled to every 30s to avoid DB queries on every tick.
  if (Date.now() - lastVixCheckAt >= VIX_CHECK_THROTTLE_MS) {
    lastVixCheckAt = Date.now();
    const regime = await getLatestRegime();
    if (regime?.vixLevel) {
      activeState.vixHistory.push({ ts: Date.now(), vix: regime.vixLevel });
      const vixCutoff = Date.now() - VIX_BASELINE_WINDOW_MS;
      activeState.vixHistory = activeState.vixHistory.filter((v) => v.ts >= vixCutoff);
      if (activeState.vixHistory.length >= 3) {
        const baseline = activeState.vixHistory.reduce((sum, v) => sum + v.vix, 0) / activeState.vixHistory.length;
        const spikePct = ((regime.vixLevel - baseline) / baseline) * 100;
        if (spikePct >= VIX_SPIKE_PCT) {
          await exitPaperTrade("vix_spike", ltp);
          return;
        }
      }
    }
  }

  // ── Exit 6: Adaptive trailing stop + floor lock (enhanced existing) ────────
  // Trail gap now scales with profit level instead of fixed 8%.
  const profitPct = ((activeState.highestPrice - activeState.entryPrice) / activeState.entryPrice) * 100;
  const adaptiveGap = adaptiveTrailGap(profitPct, activeState.isFarOTM);
  const { stopPrice, milestoneLevel } = computeRatchetStop(
    activeState.entryPrice,
    activeState.highestPrice,
    adaptiveGap,
    activeState.hardStopPct,
    activeState.milestoneStep,
    activeState.lastMilestoneLevel,
  );

  if (milestoneLevel > activeState.lastMilestoneLevel) {
    activeState.lastMilestoneLevel = milestoneLevel;
    activeState.stopLossPrice = stopPrice;
  }

  let shouldExit = false;
  let exitReason = "";

  if (ltp <= activeState.stopLossPrice) {
    shouldExit = true;
    exitReason = activeState.lastMilestoneLevel > 0 ? "trailing_stop" : "stop_loss";
  }

  // Existing: far-OTM time stop (unchanged)
  if (activeState.isFarOTM) {
    const elapsed = Date.now() - activeState.executedAt;
    if (elapsed >= FAR_OTM_TIME_STOP_MS) {
      const gainPct = ((activeState.highestPrice - activeState.entryPrice) / activeState.entryPrice) * 100;
      if (gainPct < FAR_OTM_MIN_GAIN_PCT) {
        shouldExit = true;
        exitReason = "time_stop";
      }
    }
  }

  if (shouldExit) {
    await exitPaperTrade(exitReason, ltp);
  } else {
    await db
      .update(paperTradesTable)
      .set({
        highestPriceReached: String(activeState.highestPrice),
        stopLossPrice: String(activeState.stopLossPrice),
        notes: JSON.stringify({
          deltaEstimate: 0,
          isFarOTM: activeState.isFarOTM,
          hardStopPct: activeState.hardStopPct,
          trailGapPct: adaptiveGap,
          milestoneStep: activeState.milestoneStep,
          lastMilestoneLevel: activeState.lastMilestoneLevel,
        }),
      })
      .where(eq(paperTradesTable.id, activeState.id));

    void broadcastState();
  }
}

async function evaluatePaperTrade(): Promise<void> {
  const optionSide = computeLiveOptionSide(OPTION_ASSET_ID).signal;

  if (optionSide !== lastOptionSide) {
    logger.info({ from: lastOptionSide, to: optionSide }, "paper-trade: option side transition");
    lastOptionSide = optionSide;
  }

  // Entry: check on both transitions AND same-direction re-entry.
  // If no active trade and cooldown has passed, enter — regardless of whether
  // the signal just changed or has been the same for a while.
  if ((optionSide === "BUY_CALL" || optionSide === "BUY_PUT") && activeState === null) {
    if (lastExitAt > 0 && Date.now() - lastExitAt < REENTRY_COOLDOWN_MS) {
      const remainingMs = REENTRY_COOLDOWN_MS - (Date.now() - lastExitAt);
      logger.info({ cooldownMs: remainingMs }, "paper-trade: re-entry cooldown active, skipping");
      pushTradeNotification("paper", "skip", `Signal to enter a trade was generated, but the engine is in a ${Math.ceil(remainingMs / 1000)}s cooldown period after the last exit. This prevents rapid re-entry and trade churn.`, { cooldownMs: remainingMs });
    } else {
      await enterPaperTrade(optionSide);
    }
  }

  await monitorPaperTrade(optionSide);
}

async function broadcastState(): Promise<void> {
  const currentPrice = activeState ? getLtpBySymbol(activeState.symbol) : null;
  const unrealizedPnl = activeState && currentPrice
    ? (currentPrice - activeState.entryPrice) * activeState.quantity
    : null;

  const trades = await db
    .select()
    .from(paperTradesTable)
    .orderBy(desc(paperTradesTable.executedAt))
    .limit(100);

  const closedTrades = trades.filter((t) => t.status === "closed");
  const totalPnl = closedTrades.reduce((sum, t) => sum + Number(t.realisedPnl ?? 0), 0);
  const winningTrades = closedTrades.filter((t) => Number(t.realisedPnl ?? 0) > 0).length;

  broadcastPaperTrading({
    capital: paperCapital,
    initialCapital: PAPER_CAPITAL_INITIAL,
    activeTrade: activeState ? {
      id: activeState.id,
      symbol: activeState.symbol,
      strike: activeState.strike,
      entryPrice: activeState.entryPrice,
      currentPrice: currentPrice ?? null,
      quantity: activeState.quantity,
      signal: activeState.signal,
      direction: activeState.direction,
      highestPrice: activeState.highestPrice,
      stopLossPrice: activeState.stopLossPrice,
      unrealizedPnl: unrealizedPnl !== null ? Number(unrealizedPnl.toFixed(2)) : null,
      isFarOTM: activeState.isFarOTM,
      executedAt: new Date(activeState.executedAt).toISOString(),
    } : null,
    trades,
    totalPnl,
    totalTrades: closedTrades.length,
    winningTrades,
  });
}

const EVAL_THROTTLE_MS = 1_000;
let lastEvalAt = 0;

function isTradingOpen(): boolean {
  const now = new Date();
  const istMin = (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % (24 * 60);
  const istDay = new Date(now.getTime() + 330 * 60 * 1000).getUTCDay();
  if (istDay === 0 || istDay === 6) return false;
  return istMin >= 570 && istMin < 930;
}

export function startPaperTradeEngine(): void {
  if (started) return;
  started = true;
  logger.info("paper-trade: starting virtual trading engine (Rs 1L compounding)");

  void loadStateFromDb().then(() => {
    void broadcastState();
  });

  marketTicker.on("tick", () => {
    const now = Date.now();
    if (now - lastEvalAt < EVAL_THROTTLE_MS) return;
    lastEvalAt = now;
    if (!isTradingOpen()) return;
    void evaluatePaperTrade();
  });
}

export async function getPaperTradingState(): Promise<{
  capital: number;
  initialCapital: number;
  activeTrade: any | null;
  trades: any[];
  totalPnl: number;
  totalTrades: number;
  winningTrades: number;
}> {
  const trades = await db
    .select()
    .from(paperTradesTable)
    .orderBy(desc(paperTradesTable.executedAt))
    .limit(100);

  const closedTrades = trades.filter((t) => t.status === "closed");
  const totalPnl = closedTrades.reduce((sum, t) => sum + Number(t.realisedPnl ?? 0), 0);
  const winningTrades = closedTrades.filter((t) => Number(t.realisedPnl ?? 0) > 0).length;

  const currentPrice = activeState ? getLtpBySymbol(activeState.symbol) : null;
  const unrealizedPnl = activeState && currentPrice
    ? (currentPrice - activeState.entryPrice) * activeState.quantity
    : null;

  return {
    capital: paperCapital,
    initialCapital: PAPER_CAPITAL_INITIAL,
    activeTrade: activeState ? {
      id: activeState.id,
      symbol: activeState.symbol,
      strike: activeState.strike,
      entryPrice: activeState.entryPrice,
      currentPrice: currentPrice ?? null,
      quantity: activeState.quantity,
      signal: activeState.signal,
      direction: activeState.direction,
      highestPrice: activeState.highestPrice,
      stopLossPrice: activeState.stopLossPrice,
      unrealizedPnl: unrealizedPnl !== null ? Number(unrealizedPnl.toFixed(2)) : null,
      isFarOTM: activeState.isFarOTM,
      executedAt: new Date(activeState.executedAt).toISOString(),
    } : null,
    trades: trades.map((t) => ({
      ...t,
      entryPrice: Number(t.entryPrice),
      exitPrice: t.exitPrice ? Number(t.exitPrice) : null,
      realisedPnl: t.realisedPnl ? Number(t.realisedPnl) : null,
      strike: t.strike ? Number(t.strike) : null,
      stopLossPrice: t.stopLossPrice ? Number(t.stopLossPrice) : null,
      highestPriceReached: t.highestPriceReached ? Number(t.highestPriceReached) : null,
      capitalAtEntry: Number(t.capitalAtEntry),
    })),
    totalPnl,
    totalTrades: closedTrades.length,
    winningTrades,
  };
}

import { db, paperTradesTable, marketSnapshotsTable } from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import { logger } from "../../lib/logger.js";
import { getLatestChainMetrics, getLtpBySymbol, marketTicker } from "./market-ticker.js";
import { computeLiveOptionSide, quoteCandidatesFromTicks, buildStrikeCandidates, selectBestOption } from "./signal-executor.js";
import { getNearestExpiry } from "./kite-option-chain.js";
import { broadcastPaperTrading } from "../../lib/ws-hub.js";
import { randomUUID } from "crypto";

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

const OPTION_ASSET_ID = "nifty50";

let started = false;
let lastOptionSide: "BUY_CALL" | "BUY_PUT" | "NO_TRADE" = "NO_TRADE";
let paperCapital: number = PAPER_CAPITAL_INITIAL;
let activeTradeId: string | null = null;

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
}

let activeState: ActiveTradeState | null = null;

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

async function enterPaperTrade(signal: "BUY_CALL" | "BUY_PUT"): Promise<void> {
  if (activeState !== null) return;

  const metrics = getLatestChainMetrics();
  const spot = metrics?.spotPrice ?? 0;
  if (spot <= 0) return;

  const atmStrike = Math.round(spot / 50) * 50;
  const expiry = await getNearestExpiry();
  const candidates = buildStrikeCandidates(atmStrike, signal, expiry);

  let quotes = quoteCandidatesFromTicks(candidates);
  if (quotes.length === 0) return;

  const best = selectBestOption(quotes, paperCapital);
  if (!best) {
    logger.info({ signal, capital: paperCapital }, "paper-trade: no affordable option found");
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

  void broadcastState();
}

async function exitPaperTrade(reason: string, exitPrice: number): Promise<void> {
  if (!activeState || !activeTradeId) return;

  const pnl = (exitPrice - activeState.entryPrice) * activeState.quantity;
  paperCapital = activeState.capitalAtEntry + pnl;

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
  void broadcastState();
}

async function monitorPaperTrade(): Promise<void> {
  if (!activeState) return;

  const ltp = getLtpBySymbol(activeState.symbol);
  if (!ltp || ltp <= 0) return;

  if (ltp > activeState.highestPrice) {
    activeState.highestPrice = ltp;
  }

  const { stopPrice, milestoneLevel } = computeRatchetStop(
    activeState.entryPrice,
    activeState.highestPrice,
    activeState.trailGapPct,
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
          trailGapPct: activeState.trailGapPct,
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

    if (optionSide === "BUY_CALL" || optionSide === "BUY_PUT") {
      if (activeState === null) {
        await enterPaperTrade(optionSide);
      }
    }
  }

  await monitorPaperTrade();
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
  return istMin >= 555 && istMin < 930;
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

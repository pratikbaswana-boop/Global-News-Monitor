import { db, brokerAccountsTable, brokerOrdersTable, brokerPositionsTable, signalExecutionsTable, marketSnapshotsTable, userTradePreferencesTable } from "@workspace/db";
import { eq, desc, and, gt, or } from "drizzle-orm";
import { logger } from "../../lib/logger.js";
import { placeOrder, type PlaceOrderParams } from "./orders.js";
import { getMargins, syncPortfolio } from "./portfolio.js";
import { getKiteClientForUser } from "./kite-client.js";
import { getNearestExpiry } from "./kite-option-chain.js";
import type { IntradaySignal } from "../market/tier3-signal.js";
import { randomUUID } from "crypto";

// Asset symbol → Kite trading symbol mapping
const ASSET_KITE_MAP: Record<string, { tradingsymbol: string; exchange: string }> = {
  nifty50: { tradingsymbol: "NIFTY 50", exchange: "NSE" },
  sensex: { tradingsymbol: "SENSEX", exchange: "BSE" },
  reliance: { tradingsymbol: "RELIANCE", exchange: "NSE" },
  tcs: { tradingsymbol: "TCS", exchange: "NSE" },
  "hdfc-bank": { tradingsymbol: "HDFCBANK", exchange: "NSE" },
};

interface ExecutionResult {
  executed: boolean;
  orderId?: string;
  reason?: string;
}

// ── Option Trading Constants ────────────────────────────────────────────────
const NIFTY_LOT_SIZE = 75;
const MIN_OPTION_PREMIUM = 5;
const MAX_OPTION_PREMIUM = 400;
const MAX_OPTION_LOTS = 20;
const OPTION_HARD_STOP_PCT = 30; // entry framework hard stop
const OPTION_TRAIL_GAP_PCT = 15; // entry framework trail gap
const NIFTY_STRIKE_INTERVAL = 50;

function getNearestWeeklyExpiry(): Date {
  const today = new Date();
  const day = today.getDay(); // 0=Sun, 1=Mon, ..., 4=Thu
  let daysUntilThursday = (4 - day + 7) % 7;
  const expiry = new Date(today);
  expiry.setDate(today.getDate() + daysUntilThursday);
  // If today is Thursday and after market close (~15:30 IST), use next Thursday
  const istHour = today.getUTCHours() + 5;
  const istMin = today.getUTCMinutes() + 30;
  if (day === 4 && (istHour > 15 || (istHour === 15 && istMin >= 30))) {
    expiry.setDate(today.getDate() + 7);
  }
  return expiry;
}

function formatExpiryForSymbol(expiry: Date): string {
  // Kite format: YY + M (no zero-pad) + DD (e.g. 26707 for 2026-07-07)
  const yy = String(expiry.getFullYear()).slice(-2);
  const mm = String(expiry.getMonth() + 1); // no zero-pad for month
  const dd = String(expiry.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

function buildOptionSymbol(
  underlying: string,
  expiry: Date,
  strike: number,
  type: "CE" | "PE"
): string {
  return `${underlying}${formatExpiryForSymbol(expiry)}${strike}${type}`;
}

interface OptionCandidate {
  symbol: string;
  strike: number;
  deltaEstimate: number;
  premium: number;
  lots: number;
}

/**
 * Build 5 strike candidates around the suggested ATM strike.
 * For CALLs: lower strike = ITM. For PUTs: higher strike = ITM.
 */
function buildStrikeCandidates(
  suggestedStrike: number,
  signal: "BUY_CALL" | "BUY_PUT",
  expiry: Date
): { symbol: string; strike: number; deltaEstimate: number }[] {
  const type = signal === "BUY_CALL" ? "CE" : "PE";
  const candidates: { symbol: string; strike: number; deltaEstimate: number }[] = [];

  // Expanded to ±10 strikes so we can find affordable options even with low capital.
  // Delta estimates decay with distance from ATM.
  const offsets = [0, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500];
  const deltas  = [0.50, 0.35, 0.20, 0.12, 0.08, 0.05, 0.03, 0.02, 0.015, 0.01, 0.008];

  if (signal === "BUY_CALL") {
    // ITM calls (lower strike) + OTM calls (higher strike)
    candidates.push({ symbol: buildOptionSymbol("NIFTY", expiry, suggestedStrike - 100, type), strike: suggestedStrike - 100, deltaEstimate: 0.80 }); // 2 ITM
    candidates.push({ symbol: buildOptionSymbol("NIFTY", expiry, suggestedStrike - 50,  type), strike: suggestedStrike - 50,  deltaEstimate: 0.65 }); // 1 ITM
    for (let i = 0; i < offsets.length; i++) {
      candidates.push({ symbol: buildOptionSymbol("NIFTY", expiry, suggestedStrike + offsets[i]!, type), strike: suggestedStrike + offsets[i]!, deltaEstimate: deltas[i]! });
    }
  } else {
    // ITM puts (higher strike) + OTM puts (lower strike)
    candidates.push({ symbol: buildOptionSymbol("NIFTY", expiry, suggestedStrike + 100, type), strike: suggestedStrike + 100, deltaEstimate: 0.80 }); // 2 ITM
    candidates.push({ symbol: buildOptionSymbol("NIFTY", expiry, suggestedStrike + 50,  type), strike: suggestedStrike + 50,  deltaEstimate: 0.65 }); // 1 ITM
    for (let i = 0; i < offsets.length; i++) {
      candidates.push({ symbol: buildOptionSymbol("NIFTY", expiry, suggestedStrike - offsets[i]!, type), strike: suggestedStrike - offsets[i]!, deltaEstimate: deltas[i]! });
    }
  }
  return candidates;
}

/**
 * Fetch LTP for candidate option symbols via Kite.
 * Returns only valid quotes with non-zero premium.
 */
async function fetchOptionQuotes(
  userId: string,
  candidates: { symbol: string; strike: number; deltaEstimate: number }[]
): Promise<OptionCandidate[]> {
  const kite = await getKiteClientForUser(userId);
  if (!kite) {
    logger.warn({ userId, count: candidates.length }, "signal-executor: no Kite client for fetchOptionQuotes");
    return [];
  }

  const instruments = candidates.map((c) => `NFO:${c.symbol}`);
  logger.info({ userId, instruments }, "signal-executor: fetching option quotes");
  const quotes = await kite.getQuote(instruments);
  logger.info({ userId, quoteKeys: Object.keys(quotes as Record<string, unknown>) }, "signal-executor: received quotes");

  const results: OptionCandidate[] = [];
  for (const c of candidates) {
    const key = `NFO:${c.symbol}`;
    const quote = (quotes as Record<string, unknown>)[key];
    if (!quote) continue;
    const lastPrice = Number((quote as Record<string, unknown>).last_price ?? 0);
    if (lastPrice <= 0) continue;
    results.push({
      symbol: c.symbol,
      strike: c.strike,
      deltaEstimate: c.deltaEstimate,
      premium: lastPrice,
      lots: 0,
    });
  }
  return results;
}

/**
 * Select the best option candidate based on capital and score = lots × delta.
 * High capital (≥₹50k): only delta >= 0.50. Low capital: all valid.
 */
function selectBestOption(
  candidates: OptionCandidate[],
  maxCapital: number
): OptionCandidate | null {
  const costPerLot = (c: OptionCandidate) => c.premium * NIFTY_LOT_SIZE;

  const scored = candidates
    .filter((c) => c.premium >= MIN_OPTION_PREMIUM && c.premium <= MAX_OPTION_PREMIUM)
    .map((c) => {
      const lots = Math.min(
        Math.floor(maxCapital / costPerLot(c)),
        MAX_OPTION_LOTS
      );
      return { ...c, lots };
    })
    .filter((c) => c.lots >= 1);

  if (scored.length === 0) return null;

  // High capital filter: prefer quality strikes (delta >= 0.50)
  const highCapital = maxCapital >= 50000;
  const eligible = highCapital ? scored.filter((c) => c.deltaEstimate >= 0.50) : scored;
  if (eligible.length === 0 && highCapital) return null;

  const pool = eligible.length > 0 ? eligible : scored;
  pool.sort((a, b) => (b.lots * b.deltaEstimate) - (a.lots * a.deltaEstimate));
  return pool[0];
}

/**
 * Base option signal (BUY_CALL / BUY_PUT / NO_TRADE) from snapshot tier-3 data.
 * Mirrors deriveOptionSignal in intelligence.ts but only returns signal + strike.
 * The Tier-3 microstructure gate (deriveOptionSignalFromSnapshot) is layered on top.
 */
function deriveBaseOptionSignal(
  snapshot: typeof marketSnapshotsTable.$inferSelect
): { signal: "BUY_CALL" | "BUY_PUT" | "NO_TRADE"; suggestedStrike: number | null; reason: string } {
  const aiDirection = (snapshot.predictedDirection === "uncertain" ? "neutral" : snapshot.predictedDirection) as "up" | "down" | "neutral";
  const aiConfidence = snapshot.predictedConfidence as "high" | "medium" | "low";
  const maxPainDistancePct = snapshot.maxPainDistancePct;
  const shortCoveringSignal = (snapshot.shortCoveringSignal ?? "none") as "none" | "covering" | "unwinding";
  const sgxNiftyChangePct = snapshot.sgxNiftyChangePct;
  const tier3Json = snapshot.tier3Evidence ? JSON.parse(snapshot.tier3Evidence) as Record<string, unknown> : {};
  const putCallRatio = typeof tier3Json.putCallRatio === "number" ? tier3Json.putCallRatio : null;
  const realPrice = snapshot.realPriceAtSnapshot ? parseFloat(snapshot.realPriceAtSnapshot) : null;

  const hasMaxPain = maxPainDistancePct !== null;
  const hasPcr = putCallRatio !== null;
  const hasSgx = sgxNiftyChangePct !== null;

  if (!hasMaxPain && !hasPcr && !hasSgx) {
    return { signal: "NO_TRADE", reason: "Insufficient options data", suggestedStrike: null };
  }

  const suggestedStrike = realPrice ? Math.round(realPrice / NIFTY_STRIKE_INTERVAL) * NIFTY_STRIKE_INTERVAL : null;

  // Reversal: Max Pain stretch
  if (hasMaxPain && maxPainDistancePct! > 1.5) {
    return { signal: "BUY_PUT", reason: `Max pain stretch +${maxPainDistancePct!.toFixed(1)}%`, suggestedStrike };
  }
  if (hasMaxPain && maxPainDistancePct! < -1.5) {
    return { signal: "BUY_CALL", reason: `Max pain stretch ${maxPainDistancePct!.toFixed(1)}%`, suggestedStrike };
  }

  // Reversal: PCR extremes
  if (hasPcr && putCallRatio! < 0.65) {
    return { signal: "BUY_PUT", reason: `PCR ${putCallRatio!.toFixed(2)} too bullish`, suggestedStrike };
  }
  if (hasPcr && putCallRatio! > 1.35) {
    return { signal: "BUY_CALL", reason: `PCR ${putCallRatio!.toFixed(2)} too bearish`, suggestedStrike };
  }

  // Trend: Short covering
  if (shortCoveringSignal === "covering") {
    return { signal: "BUY_CALL", reason: "Short covering active", suggestedStrike };
  }
  if (shortCoveringSignal === "unwinding") {
    return { signal: "BUY_PUT", reason: "Fresh shorts entering", suggestedStrike };
  }

  // SGX divergence
  if (hasSgx && aiDirection === "up" && sgxNiftyChangePct! < -0.8) {
    return { signal: "NO_TRADE", reason: `SGX divergence ${sgxNiftyChangePct!.toFixed(1)}%`, suggestedStrike: null };
  }
  if (hasSgx && aiDirection === "down" && sgxNiftyChangePct! > 0.8) {
    return { signal: "NO_TRADE", reason: `SGX divergence +${sgxNiftyChangePct!.toFixed(1)}%`, suggestedStrike: null };
  }

  // Mild max pain conflict
  if (hasMaxPain && Math.abs(maxPainDistancePct!) > 1.0) {
    return { signal: "NO_TRADE", reason: `Mild max pain conflict ${maxPainDistancePct!.toFixed(1)}%`, suggestedStrike: null };
  }

  // Default to AI direction
  if (aiDirection === "up") {
    return { signal: "BUY_CALL", reason: "AI bullish + tier-3 neutral", suggestedStrike };
  }
  if (aiDirection === "down") {
    return { signal: "BUY_PUT", reason: "AI bearish + tier-3 neutral", suggestedStrike };
  }

  return { signal: "NO_TRADE", reason: "AI direction neutral", suggestedStrike: null };
}

/**
 * Derive the option signal, then GATE it with the Tier-3 intraday microstructure
 * verdict (computed by the 30s scheduler refresh and persisted on tier3Evidence).
 *
 * The base AI/heuristic side is kept; the microstructure formula must independently
 * agree (same side, ready, non-NONE) or the trade is suppressed. While the engine is
 * still warming up (ready === false) or no verdict is present, the base signal passes
 * through unchanged so we don't block the whole session on a cold buffer.
 */
function deriveOptionSignalFromSnapshot(
  snapshot: typeof marketSnapshotsTable.$inferSelect
): { signal: "BUY_CALL" | "BUY_PUT" | "NO_TRADE"; suggestedStrike: number | null; reason: string } {
  const base = deriveBaseOptionSignal(snapshot);
  if (base.signal === "NO_TRADE") return base;

  const tier3Json = snapshot.tier3Evidence
    ? (JSON.parse(snapshot.tier3Evidence) as Record<string, unknown>)
    : {};
  const intraday = tier3Json.intradaySignal as IntradaySignal | undefined;

  // No verdict yet, or engine still warming up → let the base signal through.
  if (!intraday || !intraday.ready) {
    return { ...base, reason: `${base.reason} (tier-3 gate: ${intraday?.regime ?? "no-data"}, pass-through)` };
  }

  const wantSide = base.signal === "BUY_CALL" ? "CALL" : "PUT";
  const detail = `D=${intraday.D.toFixed(2)} P=${intraday.P.toFixed(2)} ${intraday.regime} → ${intraday.signal}`;

  // Only block when tier-3 ACTIVELY disagrees (opposite signal). Let NONE pass through
  // so the AI signal isn't blocked just because microstructure is neutral.
  const oppositeSide = wantSide === "CALL" ? "PUT" : "CALL";
  if (intraday.signal === oppositeSide) {
    return {
      signal: "NO_TRADE",
      suggestedStrike: null,
      reason: `Tier-3 microstructure gate blocked ${base.signal} (${detail})`,
    };
  }

  return { ...base, reason: `${base.reason} ✓ tier-3 gate (${detail})` };
}

/**
 * Process a market snapshot for auto-trading.
 * Called after a new/updated market snapshot is generated.
 */
const CONFIDENCE_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

export async function processSignalForAutoTrade(snapshotId: string): Promise<void> {
  const snapshotRows = await db
    .select()
    .from(marketSnapshotsTable)
    .where(eq(marketSnapshotsTable.id, snapshotId))
    .limit(1);

  if (!snapshotRows.length) {
    logger.warn({ snapshotId }, "signal-executor: snapshot not found");
    return;
  }

  const snapshot = snapshotRows[0];
  const direction = snapshot.predictedDirection;

  // Only trade high/medium confidence (checked per-user later too)
  if (snapshot.predictedConfidence === "low") {
    logger.info({ snapshotId, confidence: snapshot.predictedConfidence }, "signal-executor: low confidence, skipping");
    return;
  }

  // Find all users with auto-trade enabled and active broker accounts
  const activeAccounts = await db
    .select()
    .from(brokerAccountsTable)
    .where(and(
      eq(brokerAccountsTable.isActive, true),
      eq(brokerAccountsTable.autoTradeEnabled, true)
    ));

  if (!activeAccounts.length) {
    logger.info("signal-executor: no active auto-trade accounts");
    return;
  }

  const kiteSymbol = ASSET_KITE_MAP[snapshot.assetId];
  if (!kiteSymbol) {
    logger.warn({ assetId: snapshot.assetId }, "signal-executor: no Kite symbol mapping for asset");
    return;
  }

  for (const account of activeAccounts) {
    try {
      const result = await executeSignalForUser(
        account.userId,
        account,
        snapshot,
        kiteSymbol.tradingsymbol,
        kiteSymbol.exchange,
        direction as "up" | "down"
      );

      if (result.executed) {
        logger.info({
          userId: account.userId,
          snapshotId,
          orderId: result.orderId,
          symbol: kiteSymbol.tradingsymbol,
          direction,
        }, "signal-executor: auto-trade executed");
      } else {
        logger.info({
          userId: account.userId,
          snapshotId,
          reason: result.reason,
        }, "signal-executor: auto-trade skipped");
      }
    } catch (err) {
      logger.error({ userId: account.userId, snapshotId, err }, "signal-executor: auto-trade failed");
    }
  }
}

async function getUserTradePreference(
  userId: string,
  assetId: string
): Promise<typeof userTradePreferencesTable.$inferSelect | null> {
  const rows = await db
    .select()
    .from(userTradePreferencesTable)
    .where(and(
      eq(userTradePreferencesTable.userId, userId),
      eq(userTradePreferencesTable.assetId, assetId)
    ))
    .limit(1);
  return rows[0] ?? null;
}

async function executeSpotSignalForUser(
  userId: string,
  account: typeof brokerAccountsTable.$inferSelect,
  snapshot: typeof marketSnapshotsTable.$inferSelect,
  tradingsymbol: string,
  exchange: string,
  direction: "up" | "down"
): Promise<ExecutionResult> {
  // Spot trades require a clear directional signal
  if (direction !== "up" && direction !== "down") {
    return { executed: false, reason: `Non-directional signal (${direction}) — spot trading requires up/down` };
  }

  // 1. Check if user has enabled this asset for auto-trade
  const pref = await getUserTradePreference(userId, snapshot.assetId);

  if (!pref) {
    return { executed: false, reason: `Asset ${snapshot.assetId} not configured for auto-trade` };
  }

  if (!pref.enabled) {
    return { executed: false, reason: `Auto-trade disabled for ${snapshot.assetId}` };
  }

  // 2. Check per-asset confidence threshold
  const signalConfidenceRank = CONFIDENCE_RANK[snapshot.predictedConfidence] ?? 0;
  const requiredConfidenceRank = CONFIDENCE_RANK[pref.minConfidence] ?? 1;
  if (signalConfidenceRank < requiredConfidenceRank) {
    return { executed: false, reason: `Signal confidence ${snapshot.predictedConfidence} below threshold ${pref.minConfidence}` };
  }

  // 3. Check intraday-only setting
  if (pref.onlyIntraday && snapshot.timeframe !== "intraday") {
    return { executed: false, reason: `Only intraday trades enabled, got ${snapshot.timeframe}` };
  }

  // Check if user already has an open position or pending order for this symbol
  const existingOrders = await db
    .select()
    .from(brokerOrdersTable)
    .where(and(
      eq(brokerOrdersTable.userId, userId),
      eq(brokerOrdersTable.tradingsymbol, tradingsymbol),
      eq(brokerOrdersTable.exchange, exchange),
      eq(brokerOrdersTable.status, "OPEN")
    ))
    .limit(1);

  if (existingOrders.length > 0) {
    return { executed: false, reason: "Pending order already exists for this symbol" };
  }

  // Check existing position
  const existingPositions = await db
    .select()
    .from(brokerPositionsTable)
    .where(and(
      eq(brokerPositionsTable.userId, userId),
      eq(brokerPositionsTable.tradingsymbol, tradingsymbol),
      eq(brokerPositionsTable.exchange, exchange),
    ))
    .limit(1);

  const hasPosition = existingPositions.length > 0 && existingPositions[0].quantity > 0;
  const transactionType = direction === "up" ? "BUY" : "SELL";

  // For SELL signals, only sell if we have a position
  if (direction === "down" && !hasPosition) {
    return { executed: false, reason: "No position to sell" };
  }

  // For BUY signals, skip if already holding
  if (direction === "up" && hasPosition) {
    return { executed: false, reason: "Already holding position" };
  }

  // Get margins to compute order size
  const margins = await getMargins(userId);
  if (!margins) {
    return { executed: false, reason: "Could not fetch margins" };
  }

  const availableCash = margins.equity?.available?.cash ?? 0;
  // Use per-asset risk setting if configured, else global account setting
  const riskPct = pref.maxRiskPerTradePct ?? account.maxRiskPerTradePct;
  const maxRiskAmount = availableCash * (riskPct / 100);

  if (maxRiskAmount <= 0) {
    return { executed: false, reason: "Insufficient available cash" };
  }

  // Determine quantity
  let quantity = 1;
  const realPrice = snapshot.realPriceAtSnapshot ? parseFloat(snapshot.realPriceAtSnapshot) : 0;

  // Use custom quantity if user set a fixed override
  if (pref.customQuantity && pref.customQuantity > 0) {
    quantity = pref.customQuantity;
  } else if (realPrice > 0) {
    // Conservative: assume we want to risk maxRiskAmount at ~2% stop loss
    const stopLossPct = 0.02;
    const riskPerUnit = realPrice * stopLossPct;
    quantity = Math.floor(maxRiskAmount / riskPerUnit);
  }

  if (quantity < 1) quantity = 1;

  // Use per-asset product/order type overrides if set
  const product = (pref.defaultProduct ?? account.defaultProduct) as "CNC" | "MIS" | "NRML";
  const orderType = (pref.defaultOrderType ?? account.defaultOrderType) as "MARKET" | "LIMIT" | "SL" | "SL-M";

  // Place order
  const orderParams: PlaceOrderParams = {
    exchange,
    tradingsymbol,
    transactionType: transactionType as "BUY" | "SELL",
    quantity,
    orderType,
    product,
    tag: `auto-signal-${snapshot.assetId}-${snapshot.id}`,
  };

  // For LIMIT orders, set price near current price
  if (orderParams.orderType === "LIMIT" && realPrice > 0) {
    orderParams.price = direction === "up"
      ? Math.round(realPrice * 1.001 * 100) / 100
      : Math.round(realPrice * 0.999 * 100) / 100;
  }

  const orderResult = await placeOrder(userId, orderParams);

  // Compute target/stop from per-asset settings
  const exitStrategy = pref.exitStrategy ?? "trailing_ratchet";
  const targetPctVal = pref.targetPct ? parseFloat(pref.targetPct) : 1.2;
  const stopLossPctVal = pref.stopLossPct ? parseFloat(pref.stopLossPct) : 2.0;
  const trailGapPctVal = pref.trailGapPct ? parseFloat(pref.trailGapPct) : 15;

  // Record the signal execution
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const execValues: any = {
    id: randomUUID(),
    signalSnapshotId: snapshot.id,
    userId,
    brokerAccountId: account.id,
    brokerOrderId: orderResult.kiteOrderId,
    assetId: snapshot.assetId,
    assetSymbol: snapshot.assetSymbol,
    direction,
    quantity,
    entryPrice: realPrice > 0 ? String(realPrice) : null,
    status: "open",
    exitStrategy,
    product,
    trailGapPct: String(trailGapPctVal),
    highestPriceReached: realPrice > 0 ? String(realPrice) : null,
    executedAt: new Date(),
  };

  if (exitStrategy === "fixed_target") {
    execValues.targetPrice = realPrice > 0 ? String(realPrice * (direction === "up" ? 1 + targetPctVal / 100 : 1 - targetPctVal / 100)) : null;
    execValues.stopLossPrice = realPrice > 0 ? String(realPrice * (direction === "up" ? 1 - stopLossPctVal / 100 : 1 + stopLossPctVal / 100)) : null;
  } else {
    // trailing_ratchet: no fixed target; initial hard stop only
    execValues.targetPrice = null;
    execValues.stopLossPrice = realPrice > 0 ? String(realPrice * (direction === "up" ? 1 - stopLossPctVal / 100 : 1 + stopLossPctVal / 100)) : null;
  }

  await db.insert(signalExecutionsTable).values(execValues);

  // Sync portfolio in background so we have latest positions
  void syncPortfolio(userId);

  return { executed: true, orderId: orderResult.kiteOrderId };
}

/**
 * Execute an option (F&O) signal for a user.
 * Uses 5-strike search, quote fetching, and score-based selection.
 */
async function executeOptionSignalForUser(
  userId: string,
  account: typeof brokerAccountsTable.$inferSelect,
  snapshot: typeof marketSnapshotsTable.$inferSelect
): Promise<ExecutionResult> {
  const pref = await getUserTradePreference(userId, snapshot.assetId);
  if (!pref) {
    return { executed: false, reason: `Asset ${snapshot.assetId} not configured for auto-trade` };
  }

  if (!pref.enabled) {
    return { executed: false, reason: `Auto-trade disabled for ${snapshot.assetId}` };
  }

  // Confidence check
  const signalConfidenceRank = CONFIDENCE_RANK[snapshot.predictedConfidence] ?? 0;
  const requiredConfidenceRank = CONFIDENCE_RANK[pref.minConfidence] ?? 1;
  if (signalConfidenceRank < requiredConfidenceRank) {
    return { executed: false, reason: `Signal confidence ${snapshot.predictedConfidence} below threshold ${pref.minConfidence}` };
  }

  // Intraday check
  if (pref.onlyIntraday && snapshot.timeframe !== "intraday") {
    return { executed: false, reason: `Only intraday trades enabled, got ${snapshot.timeframe}` };
  }

  // Derive option signal from snapshot tier-3 data
  const optionSig = deriveOptionSignalFromSnapshot(snapshot);
  if (optionSig.signal === "NO_TRADE" || optionSig.suggestedStrike === null) {
    return { executed: false, reason: optionSig.reason };
  }

  // Build 5 strike candidates — use real Kite expiry, not computed Thursday
  const expiry = await getNearestExpiry();
  const candidates = buildStrikeCandidates(optionSig.suggestedStrike, optionSig.signal, expiry);

  // Fetch live premiums
  const quotes = await fetchOptionQuotes(userId, candidates);
  if (quotes.length === 0) {
    return { executed: false, reason: "Could not fetch option quotes" };
  }

  // Determine capital to deploy
  const margins = await getMargins(userId);
  if (!margins) {
    return { executed: false, reason: "Could not fetch margins" };
  }
  const availableCash = margins.equity?.available?.cash ?? 0;
  const maxCapital = pref.maxCapitalPerTrade
    ? parseFloat(pref.maxCapitalPerTrade)
    : availableCash;

  if (maxCapital <= 0) {
    return { executed: false, reason: "No capital allocated for trade" };
  }

  // Select best strike
  const best = selectBestOption(quotes, maxCapital);
  if (!best) {
    return { executed: false, reason: "No affordable option strike found" };
  }

  const optionSymbol = best.symbol;
  const exchange = "NFO";
  const premium = best.premium;
  const lots = best.lots;
  const quantity = lots * NIFTY_LOT_SIZE;

  // Check existing orders/positions on this option symbol
  const existingOrders = await db
    .select()
    .from(brokerOrdersTable)
    .where(and(
      eq(brokerOrdersTable.userId, userId),
      eq(brokerOrdersTable.tradingsymbol, optionSymbol),
      eq(brokerOrdersTable.exchange, exchange),
      eq(brokerOrdersTable.status, "OPEN")
    ))
    .limit(1);

  if (existingOrders.length > 0) {
    return { executed: false, reason: "Pending order already exists for this option" };
  }

  const existingPositions = await db
    .select()
    .from(brokerPositionsTable)
    .where(and(
      eq(brokerPositionsTable.userId, userId),
      eq(brokerPositionsTable.tradingsymbol, optionSymbol),
      eq(brokerPositionsTable.exchange, exchange),
    ))
    .limit(1);

  const hasPosition = existingPositions.length > 0 && existingPositions[0].quantity > 0;
  if (hasPosition) {
    return { executed: false, reason: "Already holding option position" };
  }

  // Product/order type — use LIMIT for options (Kite API doesn't allow MARKET
  // orders without market protection for options)
  const product = (pref.defaultProduct ?? account.defaultProduct ?? "MIS") as "CNC" | "MIS" | "NRML";
  const orderType: "MARKET" | "LIMIT" | "SL" | "SL-M" = "LIMIT";

  // Place order — LIMIT at slight premium above LTP to ensure fill
  const orderParams: PlaceOrderParams = {
    exchange,
    tradingsymbol: optionSymbol,
    transactionType: "BUY",
    quantity,
    orderType,
    product,
    tag: `auto-${snapshot.assetId.slice(0, 3)}`,
  };

  if (premium > 0) {
    // Place limit order 1% above LTP for quick fill
    orderParams.price = Math.round(premium * 1.01 * 100) / 100;
  }

  const orderResult = await placeOrder(userId, orderParams);

  // Record execution — for options we are always LONG, so direction = "up"
  const direction = "up";
  const execValues: any = {
    id: randomUUID(),
    signalSnapshotId: snapshot.id,
    userId,
    brokerAccountId: account.id,
    brokerOrderId: orderResult.kiteOrderId,
    assetId: snapshot.assetId,
    assetSymbol: optionSymbol,
    direction,
    quantity,
    entryPrice: String(premium),
    status: "open",
    exitStrategy: "trailing_ratchet",
    product,
    trailGapPct: String(OPTION_TRAIL_GAP_PCT),
    highestPriceReached: String(premium),
    executedAt: new Date(),
    targetPrice: null,
    stopLossPrice: String(premium * (1 - OPTION_HARD_STOP_PCT / 100)),
  };

  await db.insert(signalExecutionsTable).values(execValues);
  void syncPortfolio(userId);

  logger.info({
    userId,
    snapshotId: snapshot.id,
    orderId: orderResult.kiteOrderId,
    optionSymbol,
    premium,
    lots,
    quantity,
    signal: optionSig.signal,
    reason: optionSig.reason,
  }, "signal-executor: option auto-trade executed");

  return { executed: true, orderId: orderResult.kiteOrderId };
}

/**
 * Dispatcher: route to spot or option execution based on user preference.
 */
async function executeSignalForUser(
  userId: string,
  account: typeof brokerAccountsTable.$inferSelect,
  snapshot: typeof marketSnapshotsTable.$inferSelect,
  tradingsymbol: string,
  exchange: string,
  direction: "up" | "down"
): Promise<ExecutionResult> {
  const pref = await getUserTradePreference(userId, snapshot.assetId);
  // Index assets (nifty50, sensex) can only be traded via options — force options path.
  const isIndexAsset = snapshot.assetId === "nifty50" || snapshot.assetId === "sensex";
  if (pref?.useOptions || isIndexAsset) {
    return executeOptionSignalForUser(userId, account, snapshot);
  }
  return executeSpotSignalForUser(userId, account, snapshot, tradingsymbol, exchange, direction);
}

/**
 * Scan for recent snapshots that haven't been processed for auto-trade.
 * Called by the scheduler periodically.
 */
export async function scanAndExecutePendingSignals(): Promise<void> {
  // Find snapshots from the last 30 minutes that haven't been auto-traded
  const cutoff = new Date(Date.now() - 30 * 60 * 1000);

  const snapshots = await db
    .select()
    .from(marketSnapshotsTable)
    .where(and(
      gt(marketSnapshotsTable.snapshotAt, cutoff),
      or(
        eq(marketSnapshotsTable.predictedDirection, "up"),
        eq(marketSnapshotsTable.predictedDirection, "down"),
        eq(marketSnapshotsTable.predictedDirection, "neutral")
      )
    ))
    .orderBy(desc(marketSnapshotsTable.snapshotAt));

  for (const snapshot of snapshots) {
    // Check if this snapshot has already been executed for any user
    const executions = await db
      .select({ id: signalExecutionsTable.id })
      .from(signalExecutionsTable)
      .where(eq(signalExecutionsTable.signalSnapshotId, snapshot.id))
      .limit(1);

    if (executions.length === 0) {
      await processSignalForAutoTrade(snapshot.id);
    }
  }
}


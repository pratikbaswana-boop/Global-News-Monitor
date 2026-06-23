import { db, brokerAccountsTable, brokerOrdersTable, brokerPositionsTable, signalExecutionsTable, marketSnapshotsTable, userTradePreferencesTable } from "@workspace/db";
import { eq, desc, and, gt, or } from "drizzle-orm";
import { logger } from "../../lib/logger.js";
import { placeOrder, type PlaceOrderParams } from "./orders.js";
import { getMargins, syncPortfolio } from "./portfolio.js";
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

  // Only trade on clear directional signals
  if (direction !== "up" && direction !== "down") {
    logger.info({ snapshotId, direction }, "signal-executor: non-directional signal, skipping auto-trade");
    return;
  }

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

async function executeSignalForUser(
  userId: string,
  account: typeof brokerAccountsTable.$inferSelect,
  snapshot: typeof marketSnapshotsTable.$inferSelect,
  tradingsymbol: string,
  exchange: string,
  direction: "up" | "down"
): Promise<ExecutionResult> {
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
  const targetPctVal = pref.targetPct ? parseFloat(pref.targetPct) : 1.2;
  const stopLossPctVal = pref.stopLossPct ? parseFloat(pref.stopLossPct) : 2.0;

  // Record the signal execution
  await db.insert(signalExecutionsTable).values({
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
    targetPrice: realPrice > 0 ? String(realPrice * (direction === "up" ? 1 + targetPctVal / 100 : 1 - targetPctVal / 100)) : null,
    stopLossPrice: realPrice > 0 ? String(realPrice * (direction === "up" ? 1 - stopLossPctVal / 100 : 1 + stopLossPctVal / 100)) : null,
    executedAt: new Date(),
  });

  // Sync portfolio in background so we have latest positions
  void syncPortfolio(userId);

  return { executed: true, orderId: orderResult.kiteOrderId };
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
        eq(marketSnapshotsTable.predictedDirection, "down")
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


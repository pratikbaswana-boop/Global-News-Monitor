import { db, signalExecutionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../../lib/logger.js";
import { placeOrder } from "./orders.js";
import { getPositions } from "./portfolio.js";

// Asset symbol -> exchange mapping (mirrored from signal-executor.ts)
const ASSET_EXCHANGE_MAP: Record<string, string> = {
  nifty50: "NSE",
  sensex: "BSE",
  reliance: "NSE",
  tcs: "NSE",
  "hdfc-bank": "NSE",
};

/**
 * Compute the ratchet floor/ceiling for a given execution.
 *
 * Milestones every 10% of profit from entry.
 * Floor = milestone_price * (1 - trailGapPct/100) for longs.
 * Ceiling = milestone_price * (1 + trailGapPct/100) for shorts.
 * Before first +10% milestone, uses the hard stopLossPct from entry.
 */
function computeRatchetStop(
  entryPrice: number,
  peakPrice: number,
  direction: "up" | "down",
  trailGapPct: number,
  hardStopPct: number
): { stopPrice: number; milestoneLevel: number } {
  const profitPct =
    direction === "up"
      ? ((peakPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - peakPrice) / entryPrice) * 100;

  const milestoneLevel = Math.max(0, Math.floor(profitPct / 10) * 10);

  let stopPrice: number;
  if (milestoneLevel === 0) {
    // Hard stop before any milestone is reached
    stopPrice =
      direction === "up"
        ? entryPrice * (1 - hardStopPct / 100)
        : entryPrice * (1 + hardStopPct / 100);
  } else {
    const milestonePrice =
      direction === "up"
        ? entryPrice * (1 + milestoneLevel / 100)
        : entryPrice * (1 - milestoneLevel / 100);
    stopPrice =
      direction === "up"
        ? milestonePrice * (1 - trailGapPct / 100)
        : milestonePrice * (1 + trailGapPct / 100);
    // Breakeven cap: never give back below entry price
    stopPrice =
      direction === "up"
        ? Math.max(stopPrice, entryPrice)
        : Math.min(stopPrice, entryPrice);
  }

  return { stopPrice, milestoneLevel };
}

/**
 * Monitor all open signal executions with trailing_ratchet strategy,
 * update highestPriceReached, and exit positions when the ratchet stop
 * is breached.
 */
export async function monitorOpenPositions(): Promise<void> {
  const openExecs = await db
    .select()
    .from(signalExecutionsTable)
    .where(eq(signalExecutionsTable.status, "open"));

  if (openExecs.length === 0) {
    return;
  }

  logger.info({ count: openExecs.length }, "position-monitor: checking open positions");

  // Group executions by userId to batch position fetches
  const byUser = new Map<string, typeof openExecs>();
  for (const exec of openExecs) {
    if (!byUser.has(exec.userId)) byUser.set(exec.userId, []);
    byUser.get(exec.userId)!.push(exec);
  }

  for (const [userId, execs] of byUser) {
    try {
      const positions = await getPositions(userId);
      const allPositions = [...positions.net, ...positions.day];

      for (const exec of execs) {
        try {
          // Detect option symbols (NFO) vs spot symbols (NSE/BSE)
          const isOption =
            exec.assetSymbol.startsWith("NIFTY") &&
            (exec.assetSymbol.endsWith("CE") || exec.assetSymbol.endsWith("PE"));
          const exchange = isOption ? "NFO" : (ASSET_EXCHANGE_MAP[exec.assetId] ?? "NSE");

          const pos = allPositions.find((p: any) => {
            return (
              String(p.tradingsymbol ?? "") === exec.assetSymbol &&
              String(p.exchange ?? "") === exchange
            );
          });

          if (!pos) {
            // Position may have been manually squared off; close the execution record
            logger.info(
              { userId, execId: exec.id, symbol: exec.assetSymbol },
              "position-monitor: position no longer exists, marking execution closed"
            );
            await db
              .update(signalExecutionsTable)
              .set({
                status: "closed",
                exitReason: "manual",
                closedAt: new Date(),
              })
              .where(eq(signalExecutionsTable.id, exec.id));
            continue;
          }

          const posQty = Number((pos as any).quantity ?? 0);
          if (posQty === 0) {
            logger.info(
              { userId, execId: exec.id, symbol: exec.assetSymbol },
              "position-monitor: position quantity is zero, marking execution closed"
            );
            await db
              .update(signalExecutionsTable)
              .set({
                status: "closed",
                exitReason: "manual",
                closedAt: new Date(),
              })
              .where(eq(signalExecutionsTable.id, exec.id));
            continue;
          }

          const currentPrice = Number((pos as any).last_price ?? 0);
          if (currentPrice <= 0 || Number.isNaN(currentPrice)) {
            logger.warn(
              { userId, execId: exec.id, lastPrice: (pos as any).last_price },
              "position-monitor: invalid last_price"
            );
            continue;
          }

          const entryPrice = Number(exec.entryPrice ?? 0);
          if (entryPrice <= 0) {
            logger.warn({ execId: exec.id }, "position-monitor: missing entryPrice");
            continue;
          }

          const direction = exec.direction as "up" | "down";
          const trailGapPct = Number(exec.trailGapPct ?? 15);
          const hardStopPct = Number(exec.stopLossPrice && exec.entryPrice
            ? (Math.abs(entryPrice - Number(exec.stopLossPrice)) / entryPrice) * 100
            : 2.0);

          // Update peak price (most favorable since entry)
          let peakPrice = Number(exec.highestPriceReached ?? entryPrice);
          if (direction === "up") {
            peakPrice = Math.max(peakPrice, currentPrice);
          } else {
            peakPrice = Math.min(peakPrice, currentPrice);
          }

          if (peakPrice !== Number(exec.highestPriceReached ?? entryPrice)) {
            await db
              .update(signalExecutionsTable)
              .set({ highestPriceReached: String(peakPrice) })
              .where(eq(signalExecutionsTable.id, exec.id));
          }

          const { stopPrice, milestoneLevel } = computeRatchetStop(
            entryPrice,
            peakPrice,
            direction,
            trailGapPct,
            hardStopPct
          );

          logger.info({
            userId,
            symbol: exec.assetSymbol,
            ltp: currentPrice,
            entry: entryPrice,
            peak: peakPrice,
            stop: stopPrice.toFixed(2),
            milestone: milestoneLevel,
          }, "position-monitor: position checked");

          const shouldExit =
            direction === "up"
              ? currentPrice <= stopPrice
              : currentPrice >= stopPrice;

          if (shouldExit) {
            logger.info(
              {
                userId,
                execId: exec.id,
                symbol: exec.assetSymbol,
                currentPrice,
                stopPrice,
                milestoneLevel,
                direction,
              },
              "position-monitor: ratchet stop hit, placing exit order"
            );

            await placeOrder(userId, {
              exchange,
              tradingsymbol: exec.assetSymbol,
              transactionType: direction === "up" ? "SELL" : "BUY",
              quantity: exec.quantity,
              orderType: "MARKET",
              product: (exec.product ?? "MIS") as "CNC" | "MIS" | "NRML",
              tag: `trailing-exit-${exec.id.slice(0, 8)}`,
            });

            const realisedPnl =
              direction === "up"
                ? (currentPrice - entryPrice) * exec.quantity
                : (entryPrice - currentPrice) * exec.quantity;

            await db
              .update(signalExecutionsTable)
              .set({
                status: "closed",
                exitPrice: String(currentPrice),
                exitReason: "trailing_stop",
                closedAt: new Date(),
                realisedPnl: String(realisedPnl.toFixed(2)),
              })
              .where(eq(signalExecutionsTable.id, exec.id));

            logger.info(
              { userId, execId: exec.id, exitPrice: currentPrice, realisedPnl },
              "position-monitor: execution closed via trailing ratchet"
            );
          }
        } catch (innerErr) {
          logger.error(
            { userId, execId: exec.id, err: innerErr },
            "position-monitor: failed to process execution"
          );
        }
      }
    } catch (err) {
      logger.error({ userId, err }, "position-monitor: failed to fetch positions");
    }
  }
}

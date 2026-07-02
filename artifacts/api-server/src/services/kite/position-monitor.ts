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
 * Milestones every `milestoneStep`% of profit from entry (10% for ATM/ITM,
 * 5% for far OTM).
 * Floor = milestone_price * (1 - trailGapPct/100) for longs.
 * Ceiling = milestone_price * (1 + trailGapPct/100) for shorts.
 * Before first milestone, uses the hard stopLossPct from entry.
 */
function computeRatchetStop(
  entryPrice: number,
  peakPrice: number,
  direction: "up" | "down",
  trailGapPct: number,
  hardStopPct: number,
  milestoneStep: number = 10
): { stopPrice: number; milestoneLevel: number } {
  const profitPct =
    direction === "up"
      ? ((peakPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - peakPrice) / entryPrice) * 100;

  const milestoneLevel = Math.max(0, Math.floor(profitPct / milestoneStep) * milestoneStep);

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
            // Position is gone — either our exit order filled or user manually squared off
            let exitReason = "manual";
            let exitPrice: number | null = null;
            let realisedPnl: number | null = null;
            try {
              if (exec.notes) {
                const n = JSON.parse(exec.notes as string);
                if (n.exitReason) exitReason = n.exitReason;
                if (n.exitOrderPrice) exitPrice = n.exitOrderPrice;
              }
            } catch {}
            if (exitPrice !== null) {
              realisedPnl = direction === "up"
                ? (exitPrice - entryPrice) * exec.quantity
                : (entryPrice - exitPrice) * exec.quantity;
            }

            logger.info(
              { userId, execId: exec.id, symbol: exec.assetSymbol, exitReason, exitPrice, realisedPnl },
              "position-monitor: position quantity is zero, marking execution closed"
            );
            await db
              .update(signalExecutionsTable)
              .set({
                status: "closed",
                exitReason,
                exitPrice: exitPrice !== null ? String(exitPrice) : undefined,
                realisedPnl: realisedPnl !== null ? String(realisedPnl.toFixed(2)) : undefined,
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

          // Parse far OTM config from notes (if present)
          let milestoneStep = 10;
          let timeStopMs: number | null = null;
          let minGainPct: number | null = null;
          let isFarOTM = false;
          try {
            if (exec.notes) {
              const cfg = JSON.parse(exec.notes as string);
              milestoneStep = cfg.milestoneStep ?? 10;
              timeStopMs = cfg.timeStopMs ?? null;
              minGainPct = cfg.minGainPct ?? null;
              isFarOTM = cfg.isFarOTM ?? false;
            }
          } catch {
            // notes might not be JSON for older executions
          }

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
            hardStopPct,
            milestoneStep
          );

          // ── Time-based stop for far OTM ──────────────────────────────────────
          // If the option hasn't reached minGainPct within timeStopMs, exit.
          // Theta decay silently kills far OTM premiums.
          let timeStopHit = false;
          if (timeStopMs !== null && minGainPct !== null) {
            const elapsedMs = Date.now() - new Date(exec.executedAt).getTime();
            const profitPct = direction === "up"
              ? ((peakPrice - entryPrice) / entryPrice) * 100
              : ((entryPrice - peakPrice) / entryPrice) * 100;
            if (elapsedMs >= timeStopMs && profitPct < minGainPct) {
              timeStopHit = true;
            }
          }

          logger.info({
            userId,
            symbol: exec.assetSymbol,
            ltp: currentPrice,
            entry: entryPrice,
            peak: peakPrice,
            stop: stopPrice.toFixed(2),
            milestone: milestoneLevel,
            isFarOTM,
            timeStopHit,
          }, "position-monitor: position checked");

          const shouldExit = timeStopHit ||
            (direction === "up"
              ? currentPrice <= stopPrice
              : currentPrice >= stopPrice);

          if (shouldExit) {
            const exitReason = timeStopHit ? "time_stop" : "trailing_stop";

            // Check if we already placed an exit order that hasn't filled yet
            let existingNotes: any = {};
            try {
              existingNotes = exec.notes ? JSON.parse(exec.notes as string) : {};
            } catch {}

            const alreadyPlacedExit = existingNotes.exitOrderId !== undefined;
            const exitAttempts = (existingNotes.exitAttempts ?? 0) as number;

            if (alreadyPlacedExit) {
              // Previous exit order didn't fill — cancel it and place a more aggressive one
              logger.info(
                { userId, execId: exec.id, symbol: exec.assetSymbol, prevOrderId: existingNotes.exitOrderId, attempt: exitAttempts + 1 },
                "position-monitor: previous exit order unfilled, retrying with aggressive price"
              );

              // Cancel old order
              try {
                const { cancelOrder } = await import("./orders.js");
                await cancelOrder(userId, existingNotes.exitOrderId);
              } catch (err) {
                logger.warn({ userId, orderId: existingNotes.exitOrderId, err }, "position-monitor: cancel old exit order failed, placing new anyway");
              }
            } else {
              logger.info(
                { userId, execId: exec.id, symbol: exec.assetSymbol, currentPrice, stopPrice, milestoneLevel, direction, exitReason },
                "position-monitor: stop hit, placing exit order"
              );
            }

            // Use progressively more aggressive price: 1% below LTP on first attempt,
            // 3% below on second, 5% below on third+, rounded to tick size 0.05
            const discountPct = exitAttempts === 0 ? 0.01 : exitAttempts === 1 ? 0.03 : 0.05;
            const exitLimitPrice = Math.round((currentPrice * (1 - discountPct)) / 0.05) * 0.05;

            const exitOrderResult = await placeOrder(userId, {
              exchange,
              tradingsymbol: exec.assetSymbol,
              transactionType: direction === "up" ? "SELL" : "BUY",
              quantity: exec.quantity,
              orderType: "LIMIT",
              price: exitLimitPrice,
              product: (exec.product ?? "MIS") as "CNC" | "MIS" | "NRML",
              tag: `exit-${exec.id.slice(0, 14)}`,
            });

            // Update notes with exit order info — DON'T close execution yet.
            // The monitor will close it when Kite position qty reaches 0.
            const updatedNotes = {
              ...existingNotes,
              exitOrderId: exitOrderResult.kiteOrderId,
              exitOrderPrice: exitLimitPrice,
              exitAttempts: exitAttempts + 1,
              exitReason,
            };

            await db
              .update(signalExecutionsTable)
              .set({ notes: JSON.stringify(updatedNotes) })
              .where(eq(signalExecutionsTable.id, exec.id));

            logger.info(
              { userId, execId: exec.id, exitOrderId: exitOrderResult.kiteOrderId, exitLimitPrice, attempt: exitAttempts + 1, exitReason },
              "position-monitor: exit order placed, waiting for fill"
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

import { db, signalExecutionsTable, brokerOrdersTable } from "@workspace/db";
import { eq, desc, and, or } from "drizzle-orm";
import { logger } from "../../lib/logger.js";
import { broadcastExecutions, broadcastOrders, getConnectedClientCount } from "../../lib/ws-hub.js";
import { getGlobalKiteClient } from "./kite-option-chain.js";
import { getLtpBySymbol } from "./market-ticker.js";

const BROADCAST_INTERVAL_MS = 3_000;
let started = false;
let lastBroadcastAt = 0;

async function broadcastUserExecutions(userId: string): Promise<void> {
  try {
    const execs = await db
      .select()
      .from(signalExecutionsTable)
      .where(eq(signalExecutionsTable.userId, userId))
      .orderBy(desc(signalExecutionsTable.executedAt))
      .limit(50);

    const openExecs = execs.filter((e) => e.status === "open");
    const quotesMap: Record<string, number> = {};

    for (const e of openExecs) {
      const ltp = getLtpBySymbol(e.assetSymbol);
      if (ltp !== null) {
        quotesMap[e.assetSymbol] = ltp;
      }
    }

    if (openExecs.length > 0 && Object.keys(quotesMap).length < openExecs.length) {
      try {
        const kite = await getGlobalKiteClient();
        if (kite) {
          const missing = openExecs.filter((e) => !(e.assetSymbol in quotesMap));
          const quoteKeys = missing.map((e) => {
            const isOption = e.assetSymbol.startsWith("NIFTY") &&
              (e.assetSymbol.endsWith("CE") || e.assetSymbol.endsWith("PE"));
            const exchange = isOption ? "NFO" : "NSE";
            return `${exchange}:${e.assetSymbol}`;
          });
          if (quoteKeys.length > 0) {
            const quotes = await Promise.race([
              kite.getQuote(quoteKeys) as Promise<Record<string, any>>,
              new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
            ]);
            if (quotes) {
              for (const e of missing) {
                const isOption = e.assetSymbol.startsWith("NIFTY") &&
                  (e.assetSymbol.endsWith("CE") || e.assetSymbol.endsWith("PE"));
                const exchange = isOption ? "NFO" : "NSE";
                const key = `${exchange}:${e.assetSymbol}`;
                const q = quotes[key];
                if (q) quotesMap[e.assetSymbol] = Number(q.last_price ?? 0);
              }
            }
          }
        }
      } catch {
        // ignore quote fetch errors
      }
    }

    const enriched = execs.map((e) => {
      const entryPrice = Number(e.entryPrice ?? 0);
      const currentPrice = quotesMap[e.assetSymbol] ?? 0;
      const qty = e.quantity;
      let unrealizedPnl: number | null = null;
      if (currentPrice > 0 && entryPrice > 0) {
        unrealizedPnl = e.direction === "up"
          ? (currentPrice - entryPrice) * qty
          : (entryPrice - currentPrice) * qty;
      }
      return {
        ...e,
        entryPrice,
        currentPrice: currentPrice > 0 ? currentPrice : null,
        unrealizedPnl: unrealizedPnl !== null ? Number(unrealizedPnl.toFixed(2)) : null,
        realisedPnl: e.realisedPnl ? Number(e.realisedPnl) : null,
        highestPriceReached: e.highestPriceReached ? Number(e.highestPriceReached) : null,
        stopLossPrice: e.stopLossPrice ? Number(e.stopLossPrice) : null,
        exitPrice: e.exitPrice ? Number(e.exitPrice) : null,
      };
    });

    broadcastExecutions(userId, { executions: enriched });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err, userId }, "ws-broadcaster: executions broadcast failed");
  }
}

async function broadcastUserOrders(userId: string): Promise<void> {
  try {
    const orders = await db
      .select()
      .from(brokerOrdersTable)
      .where(eq(brokerOrdersTable.userId, userId))
      .orderBy(desc(brokerOrdersTable.placedAt))
      .limit(20);

    broadcastOrders(userId, { orders });
  } catch {
    // ignore
  }
}

async function broadcastAll(): Promise<void> {
  if (getConnectedClientCount() === 0) return;

  const openExecs = await db
    .select({ userId: signalExecutionsTable.userId })
    .from(signalExecutionsTable)
    .where(eq(signalExecutionsTable.status, "open"));

  const recentOrderUsers = await db
    .select({ userId: brokerOrdersTable.userId })
    .from(brokerOrdersTable)
    .where(eq(brokerOrdersTable.status, "OPEN"))
    .limit(50);

  const userIds = new Set<string>();
  for (const e of openExecs) userIds.add(e.userId);
  for (const o of recentOrderUsers) userIds.add(o.userId);

  for (const userId of userIds) {
    await broadcastUserExecutions(userId);
    await broadcastUserOrders(userId);
  }
}

export function startWsBroadcaster(): void {
  if (started) return;
  started = true;
  logger.info("ws-broadcaster: starting (periodic execution/order push)");

  setInterval(() => {
    const now = Date.now();
    if (now - lastBroadcastAt < BROADCAST_INTERVAL_MS) return;
    lastBroadcastAt = now;
    void broadcastAll();
  }, BROADCAST_INTERVAL_MS);
}

export { broadcastUserExecutions };

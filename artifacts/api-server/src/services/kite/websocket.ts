import { KiteTicker } from "kiteconnect";
import { db, brokerOrdersTable, brokerAccountsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../../lib/logger.js";

const KITE_API_KEY = process.env["KITE_API_KEY"] ?? "";

interface TickerConnection {
  userId: string;
  ticker: KiteTicker;
  subscribedTokens: number[];
}

const activeConnections = new Map<string, TickerConnection>();

export async function connectTickerForUser(userId: string): Promise<boolean> {
  try {
    // Check if already connected
    if (activeConnections.has(userId)) {
      return true;
    }

    const rows = await db
      .select({ accessToken: brokerAccountsTable.accessToken })
      .from(brokerAccountsTable)
      .where(eq(brokerAccountsTable.userId, userId))
      .limit(1);

    const token = rows[0]?.accessToken;
    if (!token) {
      logger.warn({ userId }, "kite-websocket: no access token for user");
      return false;
    }

    const ticker = new KiteTicker({
      api_key: KITE_API_KEY,
      access_token: token,
    });

    ticker.connect();

    ticker.on("ticks", (ticks: unknown[]) => {
      // Process quote ticks
      for (const tick of ticks) {
        const t = tick as Record<string, unknown>;
        logger.debug(
          { userId, instrumentToken: t.instrument_token, ltp: t.last_price },
          "kite-websocket: tick received"
        );
      }
    });

    ticker.on("connect", () => {
      logger.info({ userId }, "kite-websocket: connected");
    });

    ticker.on("disconnect", () => {
      logger.info({ userId }, "kite-websocket: disconnected");
      activeConnections.delete(userId);
    });

    ticker.on("error", (err: unknown) => {
      logger.error({ userId, err }, "kite-websocket: error");
    });

    // Listen for order postbacks
    ticker.on("order_update", async (data: unknown) => {
      const update = data as Record<string, unknown>;
      const kiteOrderId = String(update.order_id ?? "");
      const status = String(update.status ?? "");

      if (!kiteOrderId) return;

      logger.info({ userId, kiteOrderId, status }, "kite-websocket: order postback received");

      try {
        await db
          .update(brokerOrdersTable)
          .set({
            status: status.toUpperCase(),
            filledQty: update.filled_quantity ? Number(update.filled_quantity) : undefined,
            pendingQty: update.pending_quantity ? Number(update.pending_quantity) : undefined,
            averagePrice: update.average_price ? String(update.average_price) : undefined,
            updatedAt: new Date(),
          })
          .where(eq(brokerOrdersTable.kiteOrderId, kiteOrderId));
      } catch (err) {
        logger.error({ userId, kiteOrderId, err }, "kite-websocket: failed to update order from postback");
      }
    });

    activeConnections.set(userId, { userId, ticker, subscribedTokens: [] });
    return true;
  } catch (err) {
    logger.error({ userId, err }, "kite-websocket: failed to connect ticker");
    return false;
  }
}

export function disconnectTickerForUser(userId: string): void {
  const conn = activeConnections.get(userId);
  if (conn) {
    try {
      conn.ticker.disconnect();
    } catch {
      // ignore
    }
    activeConnections.delete(userId);
    logger.info({ userId }, "kite-websocket: ticker disconnected");
  }
}

export function subscribeTokens(userId: string, tokens: number[]): void {
  const conn = activeConnections.get(userId);
  if (conn) {
    conn.ticker.subscribe(tokens);
    conn.ticker.setMode(conn.ticker.modeFull, tokens);
    conn.subscribedTokens.push(...tokens);
    logger.info({ userId, tokens }, "kite-websocket: subscribed to tokens");
  }
}

export function getActiveConnections(): string[] {
  return Array.from(activeConnections.keys());
}

import { db, brokerOrdersTable, brokerAccountsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { logger } from "../../lib/logger.js";
import { getKiteClientForUser } from "./kite-client.js";
import { enqueueAudit } from "../../lib/audit-queue.js";
import { runKiteLimited } from "../../lib/kite-rate-limiter.js";
import { randomUUID } from "crypto";

export interface PlaceOrderParams {
  exchange: string;
  tradingsymbol: string;
  transactionType: "BUY" | "SELL";
  quantity: number;
  orderType: "MARKET" | "LIMIT" | "SL" | "SL-M";
  product: "CNC" | "MIS" | "NRML";
  price?: number;
  triggerPrice?: number;
  variety?: "regular" | "amo" | "co" | "iceberg" | "auction";
  tag?: string;
  disclosedQuantity?: number;
  marketProtection?: number;
}

export async function placeOrder(
  appUserId: string,
  params: PlaceOrderParams
): Promise<{ kiteOrderId: string; status: string }> {
  const kite = await getKiteClientForUser(appUserId);
  if (!kite) {
    throw new Error("Broker not connected or token expired");
  }

  const accountRows = await db
    .select({ id: brokerAccountsTable.id })
    .from(brokerAccountsTable)
    .where(eq(brokerAccountsTable.userId, appUserId))
    .limit(1);

  const brokerAccountId = accountRows[0]?.id;
  if (!brokerAccountId) {
    throw new Error("Broker account not found");
  }

  const orderParams: Record<string, unknown> = {
    exchange: params.exchange,
    tradingsymbol: params.tradingsymbol,
    transaction_type: params.transactionType,
    quantity: params.quantity,
    order_type: params.orderType,
    product: params.product,
    variety: params.variety ?? "regular",
  };

  if (params.price !== undefined && params.price > 0) {
    orderParams.price = params.price;
  }
  if (params.triggerPrice !== undefined && params.triggerPrice > 0) {
    orderParams.trigger_price = params.triggerPrice;
  }
  if (params.tag) {
    orderParams.tag = params.tag;
  }
  if (params.disclosedQuantity) {
    orderParams.disclosed_quantity = params.disclosedQuantity;
  }
  if (params.marketProtection !== undefined) {
    orderParams.market_protection = params.marketProtection;
  }

  logger.info(
    { appUserId, tradingsymbol: params.tradingsymbol, transactionType: params.transactionType },
    "Placing Kite order"
  );

  const response = await runKiteLimited(() => kite.placeOrder(params.variety ?? "regular", orderParams));
  const kiteOrderId = String(response.order_id ?? response);

  // Persist the order record write-behind — the broker call above already happened;
  // the DB row is audit and must not delay the caller (R4).
  enqueueAudit("broker-order-insert", async () => {
    await db.insert(brokerOrdersTable).values({
      id: randomUUID(),
      userId: appUserId,
      brokerAccountId,
      kiteOrderId,
      variety: params.variety ?? "regular",
      exchange: params.exchange,
      tradingsymbol: params.tradingsymbol,
      transactionType: params.transactionType,
      orderType: params.orderType,
      product: params.product,
      quantity: params.quantity,
      price: params.price ? String(params.price) : null,
      triggerPrice: params.triggerPrice ? String(params.triggerPrice) : null,
      status: "OPEN",
      tag: params.tag ?? null,
      placedAt: new Date(),
      updatedAt: new Date(),
    });
  });

  return { kiteOrderId, status: "OPEN" };
}

// The resting protective stop is a stop-loss LIMIT (SL), not SL-M: NSE discontinued
// SL-M for options in Sept 2021 and Kite rejects SL-M for index options, so an SL-M
// backstop would never actually exist on the exchange. An SL order triggers at
// `triggerPrice` and then rests as a LIMIT at `limitPrice`, which we set a few percent
// BELOW the trigger so it is marketable the moment it fires (a stop that only fills at
// the trigger price can be skipped past in a fast move — the whole point of the backstop
// is that it fills).
export const SL_LIMIT_OFFSET_PCT = 4; // limit sits this % below the SELL trigger

/** Round a price to the NSE options tick size (₹0.05). */
export function roundToTick(price: number): number {
  return Math.round(price / 0.05) * 0.05;
}

/**
 * Derive the SL limit price for a SELL stop at `triggerPrice`: `SL_LIMIT_OFFSET_PCT`
 * below the trigger (floored at one tick so it never goes ≤ 0).
 */
export function slLimitPriceForTrigger(triggerPrice: number): number {
  return Math.max(0.05, roundToTick(triggerPrice * (1 - SL_LIMIT_OFFSET_PCT / 100)));
}

/**
 * Place an exchange-side protective stop (SL SELL) as a backstop for an open long
 * option/equity position (R5). It rests at the exchange and fires natively at the
 * trigger, so exit latency leaves the polling path and a dead process never leaves the
 * position naked. The limit price defaults to `SL_LIMIT_OFFSET_PCT` below the trigger.
 * Returns the resting order id and the limit price actually used.
 */
export async function placeProtectiveStop(
  appUserId: string,
  params: {
    exchange: string;
    tradingsymbol: string;
    quantity: number;
    triggerPrice: number;
    limitPrice?: number;
    product: "CNC" | "MIS" | "NRML";
    tag?: string;
  }
): Promise<{ kiteOrderId: string; limitPrice: number }> {
  const limitPrice = params.limitPrice ?? slLimitPriceForTrigger(params.triggerPrice);
  const res = await placeOrder(appUserId, {
    exchange: params.exchange,
    tradingsymbol: params.tradingsymbol,
    transactionType: "SELL",
    quantity: params.quantity,
    orderType: "SL",
    triggerPrice: params.triggerPrice,
    price: limitPrice,
    product: params.product,
    tag: params.tag,
  });
  return { kiteOrderId: res.kiteOrderId, limitPrice };
}

export async function cancelOrder(
  appUserId: string,
  kiteOrderId: string,
  variety: string = "regular"
): Promise<void> {
  const kite = await getKiteClientForUser(appUserId);
  if (!kite) {
    throw new Error("Broker not connected or token expired");
  }

  await kite.cancelOrder(variety, kiteOrderId);

  await db
    .update(brokerOrdersTable)
    .set({ status: "CANCELLED", updatedAt: new Date() })
    .where(eq(brokerOrdersTable.kiteOrderId, kiteOrderId));

  logger.info({ appUserId, kiteOrderId }, "Cancelled Kite order");
}

export async function modifyOrder(
  appUserId: string,
  kiteOrderId: string,
  variety: string,
  updates: { quantity?: number; price?: number; triggerPrice?: number; orderType?: string }
): Promise<void> {
  const kite = await getKiteClientForUser(appUserId);
  if (!kite) {
    throw new Error("Broker not connected or token expired");
  }

  const params: Record<string, unknown> = {};
  if (updates.quantity !== undefined) params.quantity = updates.quantity;
  if (updates.price !== undefined) params.price = updates.price;
  if (updates.triggerPrice !== undefined) params.trigger_price = updates.triggerPrice;
  if (updates.orderType) params.order_type = updates.orderType;

  await kite.modifyOrder(variety, kiteOrderId, params);
  logger.info({ appUserId, kiteOrderId, updates }, "Modified Kite order");
}

export async function getOrders(appUserId: string): Promise<unknown[]> {
  const kite = await getKiteClientForUser(appUserId);
  if (!kite) {
    throw new Error("Broker not connected or token expired");
  }

  const orders = await kite.getOrders();
  return Array.isArray(orders) ? orders : [];
}

export async function getOrderHistory(appUserId: string, kiteOrderId: string): Promise<unknown[]> {
  const kite = await getKiteClientForUser(appUserId);
  if (!kite) {
    throw new Error("Broker not connected or token expired");
  }

  const history = await kite.getOrderHistory(kiteOrderId);
  return Array.isArray(history) ? history : [];
}

export async function getTrades(appUserId: string): Promise<unknown[]> {
  const kite = await getKiteClientForUser(appUserId);
  if (!kite) {
    throw new Error("Broker not connected or token expired");
  }

  const trades = await kite.getTrades();
  return Array.isArray(trades) ? trades : [];
}

export async function syncOrderStatus(appUserId: string, kiteOrderId: string): Promise<void> {
  try {
    const history = await getOrderHistory(appUserId, kiteOrderId);
    if (!history.length) return;

    const latest = history[history.length - 1] as Record<string, unknown>;
    const status = String(latest["status"] ?? "UNKNOWN");
    const filledQty = Number(latest["filled_quantity"] ?? 0);
    const pendingQty = Number(latest["pending_quantity"] ?? 0);
    const cancelledQty = Number(latest["cancelled_quantity"] ?? 0);
    const avgPrice = latest["average_price"] ? String(latest["average_price"]) : null;
    const statusMessage = latest["status_message"] ? String(latest["status_message"]) : null;

    await db
      .update(brokerOrdersTable)
      .set({
        status,
        filledQty,
        pendingQty,
        cancelledQty,
        averagePrice: avgPrice,
        statusMessage: statusMessage ?? null,
        updatedAt: new Date(),
      })
      .where(eq(brokerOrdersTable.kiteOrderId, kiteOrderId));
  } catch (err) {
    logger.error({ appUserId, kiteOrderId, err }, "Failed to sync order status");
  }
}

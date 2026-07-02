import { db, brokerPositionsTable, brokerHoldingsTable, brokerAccountsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../../lib/logger.js";
import { getKiteClientForUser } from "./kite-client.js";
import { randomUUID } from "crypto";

export interface MarginsSummary {
  equity: {
    net: number;
    available: { cash: number; collateral: number; intradayPayin: number; liveBalance: number; openingBalance: number };
    used: { m2mRealised: number; m2mUnrealised: number; span: number; exposure: number; optionPremium: number; holdingSales: number };
  };
  commodity?: Record<string, unknown>;
}

export async function getMargins(appUserId: string): Promise<MarginsSummary | null> {
  const kite = await getKiteClientForUser(appUserId);
  if (!kite) return null;

  const margins = await kite.getMargins();
  return margins as MarginsSummary;
}

export async function getHoldings(appUserId: string): Promise<unknown[]> {
  const kite = await getKiteClientForUser(appUserId);
  if (!kite) return [];

  const holdings = await kite.getHoldings();
  return Array.isArray(holdings) ? holdings : [];
}

export async function getPositions(appUserId: string): Promise<{ day: unknown[]; net: unknown[] }> {
  const kite = await getKiteClientForUser(appUserId);
  if (!kite) return { day: [], net: [] };

  const positions = await kite.getPositions();
  const data = (positions as { day?: unknown[]; net?: unknown[] }) ?? {};
  return {
    day: Array.isArray(data.day) ? data.day : [],
    net: Array.isArray(data.net) ? data.net : [],
  };
}

export async function syncPortfolio(appUserId: string): Promise<void> {
  const accountRows = await db
    .select({ id: brokerAccountsTable.id })
    .from(brokerAccountsTable)
    .where(eq(brokerAccountsTable.userId, appUserId))
    .limit(1);

  const brokerAccountId = accountRows[0]?.id;
  if (!brokerAccountId) {
    logger.warn({ appUserId }, "Cannot sync portfolio — broker account not found");
    return;
  }

  try {
    // Sync holdings
    const holdings = await getHoldings(appUserId);
    if (holdings.length > 0) {
      // Clear old holdings
      await db.delete(brokerHoldingsTable).where(eq(brokerHoldingsTable.brokerAccountId, brokerAccountId));

      for (const h of holdings) {
        const item = h as Record<string, unknown>;
        await db.insert(brokerHoldingsTable).values({
          id: randomUUID(),
          userId: appUserId,
          brokerAccountId,
          tradingsymbol: String(item["tradingsymbol"] ?? ""),
          exchange: String(item["exchange"] ?? ""),
          instrumentToken: item["instrument_token"] ? String(item["instrument_token"]) : null,
          isin: item["isin"] ? String(item["isin"]) : null,
          quantity: Number(item["quantity"] ?? 0),
          t1Quantity: Number(item["t1_quantity"] ?? 0),
          averagePrice: String(item["average_price"] ?? 0),
          lastPrice: item["last_price"] ? String(item["last_price"]) : null,
          closePrice: item["close_price"] ? String(item["close_price"]) : null,
          pnl: item["pnl"] ? String(item["pnl"]) : null,
          dayChange: item["day_change"] ? String(item["day_change"]) : null,
          dayChangePercentage: item["day_change_percentage"] ? String(item["day_change_percentage"]) : null,
          updatedAt: new Date(),
        });
      }
    }

    // Sync positions
    const positions = await getPositions(appUserId);
    const allPositions = [...positions.net, ...positions.day];
    if (allPositions.length > 0) {
      await db.delete(brokerPositionsTable).where(eq(brokerPositionsTable.brokerAccountId, brokerAccountId));

      const seen = new Set<string>();
      for (const p of allPositions) {
        const item = p as Record<string, unknown>;
        const key = `${item["tradingsymbol"]}-${item["product"]}`;
        if (seen.has(key)) continue;
        seen.add(key);

        await db.insert(brokerPositionsTable).values({
          id: randomUUID(),
          userId: appUserId,
          brokerAccountId,
          tradingsymbol: String(item["tradingsymbol"] ?? ""),
          exchange: String(item["exchange"] ?? ""),
          instrumentToken: item["instrument_token"] ? String(item["instrument_token"]) : null,
          product: String(item["product"] ?? ""),
          quantity: Number(item["quantity"] ?? 0),
          dayQuantity: Number(item["day_quantity"] ?? 0),
          averagePrice: String(item["average_price"] ?? 0),
          lastPrice: item["last_price"] ? String(item["last_price"]) : null,
          closePrice: item["close_price"] ? String(item["close_price"]) : null,
          pnl: item["pnl"] ? String(item["pnl"]) : null,
          m2m: item["m2m"] ? String(item["m2m"]) : null,
          unrealised: item["unrealised"] ? String(item["unrealised"]) : null,
          realised: item["realised"] ? String(item["realised"]) : null,
          buyQuantity: item["buy_quantity"] ? Number(item["buy_quantity"]) : null,
          buyPrice: item["buy_price"] ? String(item["buy_price"]) : null,
          sellQuantity: item["sell_quantity"] ? Number(item["sell_quantity"]) : null,
          sellPrice: item["sell_price"] ? String(item["sell_price"]) : null,
          value: item["value"] ? String(item["value"]) : null,
          updatedAt: new Date(),
        });
      }
    }

    logger.info({ appUserId, holdings: holdings.length, positions: allPositions.length }, "Portfolio synced");
  } catch (err) {
    logger.error({ appUserId, err }, "Portfolio sync failed");
  }
}

export async function checkOrderMargin(
  appUserId: string,
  params: {
    exchange: string;
    tradingsymbol: string;
    transactionType: string;
    quantity: number;
    orderType: string;
    product: string;
    price?: number;
    triggerPrice?: number;
  }
): Promise<unknown> {
  const kite = await getKiteClientForUser(appUserId);
  if (!kite) {
    throw new Error("Broker not connected or token expired");
  }

  const margin = await kite.orderMargins([
    {
      exchange: params.exchange,
      tradingsymbol: params.tradingsymbol,
      transaction_type: params.transactionType,
      quantity: params.quantity,
      order_type: params.orderType,
      product: params.product,
      price: params.price,
      trigger_price: params.triggerPrice,
    },
  ]);

  return Array.isArray(margin) ? margin[0] : margin;
}

import { db, userTradePreferencesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { logger } from "../../lib/logger.js";
import { randomUUID } from "crypto";

// Assets available for auto-trade
export const TRADEABLE_ASSETS = [
  { id: "nifty50", symbol: "NIFTY", name: "NIFTY 50" },
  { id: "sensex", symbol: "SENSEX", name: "BSE SENSEX" },
  { id: "reliance", symbol: "RELIANCE", name: "Reliance Industries" },
  { id: "tcs", symbol: "TCS", name: "Tata Consultancy Services" },
  { id: "hdfc-bank", symbol: "HDFCBANK", name: "HDFC Bank" },
] as const;

export type TradeableAssetId = (typeof TRADEABLE_ASSETS)[number]["id"];

export async function getUserTradePreferences(userId: string): Promise<typeof userTradePreferencesTable.$inferSelect[]> {
  return db
    .select()
    .from(userTradePreferencesTable)
    .where(eq(userTradePreferencesTable.userId, userId));
}

export async function setTradePreference(
  userId: string,
  assetId: string,
  settings: {
    enabled?: boolean;
    maxRiskPerTradePct?: number;
    defaultProduct?: string;
    defaultOrderType?: string;
    customQuantity?: number;
    targetPct?: string;
    stopLossPct?: string;
    useGttBracket?: boolean;
    minConfidence?: string;
    onlyIntraday?: boolean;
  }
): Promise<void> {
  const existing = await db
    .select({ id: userTradePreferencesTable.id })
    .from(userTradePreferencesTable)
    .where(and(
      eq(userTradePreferencesTable.userId, userId),
      eq(userTradePreferencesTable.assetId, assetId)
    ))
    .limit(1);

  const asset = TRADEABLE_ASSETS.find(a => a.id === assetId);
  const symbol = asset?.symbol ?? assetId.toUpperCase();

  if (existing.length > 0) {
    await db
      .update(userTradePreferencesTable)
      .set({
        ...(settings.enabled !== undefined ? { enabled: settings.enabled } : {}),
        ...(settings.maxRiskPerTradePct !== undefined ? { maxRiskPerTradePct: settings.maxRiskPerTradePct } : {}),
        ...(settings.defaultProduct !== undefined ? { defaultProduct: settings.defaultProduct } : {}),
        ...(settings.defaultOrderType !== undefined ? { defaultOrderType: settings.defaultOrderType } : {}),
        ...(settings.customQuantity !== undefined ? { customQuantity: settings.customQuantity } : {}),
        ...(settings.targetPct !== undefined ? { targetPct: settings.targetPct } : {}),
        ...(settings.stopLossPct !== undefined ? { stopLossPct: settings.stopLossPct } : {}),
        ...(settings.useGttBracket !== undefined ? { useGttBracket: settings.useGttBracket } : {}),
        ...(settings.minConfidence !== undefined ? { minConfidence: settings.minConfidence } : {}),
        ...(settings.onlyIntraday !== undefined ? { onlyIntraday: settings.onlyIntraday } : {}),
        updatedAt: new Date(),
      })
      .where(eq(userTradePreferencesTable.id, existing[0].id));
  } else {
    await db.insert(userTradePreferencesTable).values({
      id: randomUUID(),
      userId,
      assetId,
      assetSymbol: symbol,
      enabled: settings.enabled ?? false,
      maxRiskPerTradePct: settings.maxRiskPerTradePct ?? null,
      defaultProduct: settings.defaultProduct ?? null,
      defaultOrderType: settings.defaultOrderType ?? null,
      customQuantity: settings.customQuantity ?? null,
      targetPct: settings.targetPct ?? null,
      stopLossPct: settings.stopLossPct ?? null,
      useGttBracket: settings.useGttBracket ?? true,
      minConfidence: settings.minConfidence ?? "medium",
      onlyIntraday: settings.onlyIntraday ?? true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  logger.info({ userId, assetId, settings }, "trade-preferences: updated");
}

export async function deleteTradePreference(userId: string, assetId: string): Promise<void> {
  await db
    .delete(userTradePreferencesTable)
    .where(and(
      eq(userTradePreferencesTable.userId, userId),
      eq(userTradePreferencesTable.assetId, assetId)
    ));

  logger.info({ userId, assetId }, "trade-preferences: deleted");
}

export async function ensureDefaultPreferences(userId: string): Promise<void> {
  const existing = await getUserTradePreferences(userId);
  const existingIds = new Set(existing.map(p => p.assetId));

  for (const asset of TRADEABLE_ASSETS) {
    if (!existingIds.has(asset.id)) {
      await db.insert(userTradePreferencesTable).values({
        id: randomUUID(),
        userId,
        assetId: asset.id,
        assetSymbol: asset.symbol,
        enabled: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
  }
}

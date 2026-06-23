import { db, brokerAccountsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../../lib/logger.js";
import { createKiteClient, getApiSecret } from "./kite-client.js";
import { randomUUID } from "crypto";

export interface KiteSession {
  accessToken: string;
  refreshToken?: string;
  publicToken?: string;
  userId: string; // Kite user ID (not our DB userId)
  userName: string;
  userShortName: string;
  email: string;
  userType: string;
  broker: string;
  exchanges: string[];
  products: string[];
  orderTypes: string[];
  avatarUrl?: string;
}

export async function exchangeRequestToken(
  requestToken: string,
  apiKey: string,
  apiSecret: string
): Promise<KiteSession> {
  const kite = createKiteClient({ apiKey });

  if (!apiSecret) {
    throw new Error("Kite API secret is required");
  }

  const session = await kite.generateSession(requestToken, apiSecret);

  const data = session as Record<string, unknown>;
  const profile = (data["data"] as Record<string, unknown> | undefined) ?? data;

  return {
    accessToken: String(profile["access_token"] ?? ""),
    refreshToken: profile["refresh_token"] ? String(profile["refresh_token"]) : undefined,
    publicToken: profile["public_token"] ? String(profile["public_token"]) : undefined,
    userId: String(profile["user_id"] ?? ""),
    userName: String(profile["user_name"] ?? ""),
    userShortName: String(profile["user_shortname"] ?? ""),
    email: String(profile["email"] ?? ""),
    userType: String(profile["user_type"] ?? ""),
    broker: String(profile["broker"] ?? ""),
    exchanges: Array.isArray(profile["exchanges"]) ? profile["exchanges"] as string[] : [],
    products: Array.isArray(profile["products"]) ? profile["products"] as string[] : [],
    orderTypes: Array.isArray(profile["order_types"]) ? profile["order_types"] as string[] : [],
    avatarUrl: profile["avatar_url"] ? String(profile["avatar_url"]) : undefined,
  };
}

export async function saveBrokerAccount(
  appUserId: string,
  session: KiteSession,
  apiKey: string,
  apiSecret: string
): Promise<string> {
  // Check if account already exists
  const existing = await db
    .select({ id: brokerAccountsTable.id })
    .from(brokerAccountsTable)
    .where(eq(brokerAccountsTable.userId, appUserId))
    .limit(1);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // ~1 day

  if (existing.length > 0) {
    await db
      .update(brokerAccountsTable)
      .set({
        apiKey,
        apiSecret,
        accessToken: session.accessToken,
        refreshToken: session.refreshToken ?? null,
        publicToken: session.publicToken ?? null,
        expiresAt,
        isActive: true,
        updatedAt: now,
      })
      .where(eq(brokerAccountsTable.id, existing[0].id));

    logger.info({ appUserId, kiteUserId: session.userId }, "Updated broker account");
    return existing[0].id;
  }

  const id = randomUUID();
  await db.insert(brokerAccountsTable).values({
    id,
    userId: appUserId,
    brokerName: session.broker || "zerodha",
    apiKey,
    apiSecret,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken ?? null,
    publicToken: session.publicToken ?? null,
    expiresAt,
    isActive: true,
    autoTradeEnabled: false,
    createdAt: now,
    updatedAt: now,
  });

  logger.info({ appUserId, kiteUserId: session.userId, accountId: id }, "Created broker account");
  return id;
}

export async function disconnectBrokerAccount(appUserId: string): Promise<void> {
  await db
    .update(brokerAccountsTable)
    .set({
      isActive: false,
      accessToken: null,
      refreshToken: null,
      publicToken: null,
      updatedAt: new Date(),
    })
    .where(eq(brokerAccountsTable.userId, appUserId));

  logger.info({ appUserId }, "Disconnected broker account");
}

export async function getBrokerAccountStatus(appUserId: string): Promise<{
  connected: boolean;
  autoTradeEnabled: boolean;
  brokerName: string;
  expiresAt: string | null;
}> {
  const rows = await db
    .select({
      isActive: brokerAccountsTable.isActive,
      autoTradeEnabled: brokerAccountsTable.autoTradeEnabled,
      brokerName: brokerAccountsTable.brokerName,
      expiresAt: brokerAccountsTable.expiresAt,
    })
    .from(brokerAccountsTable)
    .where(eq(brokerAccountsTable.userId, appUserId))
    .limit(1);

  if (!rows.length) {
    return { connected: false, autoTradeEnabled: false, brokerName: "", expiresAt: null };
  }

  const r = rows[0];
  const expired = r.expiresAt ? new Date() > r.expiresAt : false;

  return {
    connected: r.isActive && !expired,
    autoTradeEnabled: r.autoTradeEnabled,
    brokerName: r.brokerName,
    expiresAt: r.expiresAt?.toISOString() ?? null,
  };
}

export async function updateAutoTradeSettings(
  appUserId: string,
  settings: {
    autoTradeEnabled?: boolean;
    maxRiskPerTradePct?: number;
    defaultProduct?: string;
    defaultOrderType?: string;
  }
): Promise<void> {
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (settings.autoTradeEnabled !== undefined) update.autoTradeEnabled = settings.autoTradeEnabled;
  if (settings.maxRiskPerTradePct !== undefined) update.maxRiskPerTradePct = settings.maxRiskPerTradePct;
  if (settings.defaultProduct !== undefined) update.defaultProduct = settings.defaultProduct;
  if (settings.defaultOrderType !== undefined) update.defaultOrderType = settings.defaultOrderType;

  await db
    .update(brokerAccountsTable)
    .set(update as typeof brokerAccountsTable.$inferInsert)
    .where(eq(brokerAccountsTable.userId, appUserId));

  logger.info({ appUserId, settings }, "Updated auto-trade settings");
}

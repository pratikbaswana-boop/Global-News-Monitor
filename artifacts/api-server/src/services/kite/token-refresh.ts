import { db, brokerAccountsTable } from "@workspace/db";
import { eq, lt } from "drizzle-orm";
import { logger } from "../../lib/logger.js";
import { createKiteClient, getApiSecret } from "./kite-client.js";

const REFRESH_WINDOW_MS = 6 * 60 * 60 * 1000; // Refresh tokens expiring within 6h

export async function refreshExpiringTokens(): Promise<void> {
  const cutoff = new Date(Date.now() + REFRESH_WINDOW_MS);

  const accounts = await db
    .select()
    .from(brokerAccountsTable)
    .where(eq(brokerAccountsTable.isActive, true));

  const expiring = accounts.filter(
    (a) => a.expiresAt !== null && a.expiresAt <= cutoff && a.refreshToken
  );

  if (!expiring.length) {
    logger.debug("token-refresh: no tokens need refresh");
    return;
  }

  logger.info({ count: expiring.length }, "token-refresh: refreshing expiring tokens");

  for (const account of expiring) {
    try {
      await refreshSingleToken(account);
    } catch (err) {
      logger.error(
        { userId: account.userId, err: err instanceof Error ? err.message : err },
        "token-refresh: failed to refresh token"
      );
    }
  }
}

async function refreshSingleToken(account: typeof brokerAccountsTable.$inferSelect): Promise<void> {
  if (!account.refreshToken || !account.apiKey) {
    logger.warn({ userId: account.userId }, "token-refresh: missing refreshToken or apiKey");
    return;
  }

  const apiSecret = account.apiSecret;
  if (!apiSecret) {
    logger.warn({ userId: account.userId }, "token-refresh: no apiSecret for account, trying global fallback");
    // fallback handled by getApiSecret below
  }

  const kite = createKiteClient({ apiKey: account.apiKey, apiSecret: account.apiSecret ?? undefined, accessToken: account.accessToken ?? undefined });
  const resolvedSecret = getApiSecret({ apiSecret: account.apiSecret ?? undefined });
  const result = await kite.renewAccessToken(account.refreshToken, resolvedSecret);

  const data = result as Record<string, unknown>;
  const newAccessToken = String(data["access_token"] ?? "");
  const newRefreshToken = data["refresh_token"] ? String(data["refresh_token"]) : account.refreshToken;

  if (!newAccessToken) {
    throw new Error("Kite renewAccessToken did not return access_token");
  }

  // Kite tokens typically valid for ~1 day
  const newExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await db
    .update(brokerAccountsTable)
    .set({
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      expiresAt: newExpiresAt,
      updatedAt: new Date(),
    })
    .where(eq(brokerAccountsTable.id, account.id));

  logger.info(
    { userId: account.userId, accountId: account.id, expiresAt: newExpiresAt.toISOString() },
    "token-refresh: token renewed"
  );
}

export async function refreshTokenForUser(userId: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(brokerAccountsTable)
    .where(eq(brokerAccountsTable.userId, userId))
    .limit(1);

  if (!rows.length || !rows[0].isActive) {
    return false;
  }

  try {
    await refreshSingleToken(rows[0]);
    return true;
  } catch {
    return false;
  }
}

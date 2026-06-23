import { KiteConnect } from "kiteconnect";
import { db, brokerAccountsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../../lib/logger.js";

const KITE_API_KEY = process.env["KITE_API_KEY"] ?? "";
const KITE_API_SECRET = process.env["KITE_API_SECRET"] ?? "";

if (!KITE_API_KEY || !KITE_API_SECRET) {
  logger.warn("KITE_API_KEY or KITE_API_SECRET not set — broker integration will not work");
}

export interface KiteCredentials {
  apiKey: string;
  accessToken?: string;
}

export function createKiteClient(creds?: KiteCredentials): KiteConnect {
  const key = creds?.apiKey ?? KITE_API_KEY;
  const token = creds?.accessToken;

  if (!key) {
    throw new Error("Kite API key is required");
  }

  const client = new KiteConnect({ api_key: key });
  if (token) {
    client.setAccessToken(token);
  }
  return client;
}

export async function getKiteClientForUser(userId: string): Promise<KiteConnect | null> {
  try {
    const rows = await db
      .select()
      .from(brokerAccountsTable)
      .where(eq(brokerAccountsTable.userId, userId))
      .limit(1);

    const account = rows[0];
    if (!account || !account.isActive || !account.accessToken) {
      return null;
    }

    // Check expiry
    if (account.expiresAt && new Date() > account.expiresAt) {
      logger.warn({ userId }, "Kite access token expired for user");
      return null;
    }

    return createKiteClient({
      apiKey: account.apiKey ?? KITE_API_KEY,
      accessToken: account.accessToken,
    });
  } catch (err) {
    logger.error({ userId, err }, "Failed to create Kite client for user");
    return null;
  }
}

export function getKiteLoginUrl(): string {
  if (!KITE_API_KEY) {
    throw new Error("KITE_API_KEY not configured");
  }
  const kite = createKiteClient();
  return kite.getLoginURL();
}

export function getKiteApiKey(): string {
  return KITE_API_KEY;
}

export function getKiteApiSecret(): string {
  return KITE_API_SECRET;
}

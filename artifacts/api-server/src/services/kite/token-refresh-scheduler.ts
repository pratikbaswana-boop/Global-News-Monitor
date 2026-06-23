import { logger } from "../../lib/logger.js";
import { refreshExpiringTokens } from "./token-refresh.js";

const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

async function runRefresh(): Promise<void> {
  try {
    await refreshExpiringTokens();
  } catch (err) {
    logger.error({ err }, "token-refresh-scheduler: refresh cycle failed");
  }
}

export function startTokenRefreshScheduler(): void {
  logger.info({ intervalMs: REFRESH_INTERVAL_MS }, "token-refresh-scheduler: starting");

  // Run immediately on startup
  void runRefresh();

  // Then every 6 hours
  setInterval(() => {
    void runRefresh();
  }, REFRESH_INTERVAL_MS);
}

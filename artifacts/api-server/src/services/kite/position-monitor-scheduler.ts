import { logger } from "../../lib/logger.js";
import { monitorOpenPositions } from "./position-monitor.js";

// ── IST market helpers (mirrored from signal-executor-scheduler.ts) ─────────

function isWeekend(): boolean {
  const now = new Date();
  const istDay = new Date(now.getTime() + 330 * 60 * 1000).getUTCDay();
  return istDay === 0 || istDay === 6;
}

function currentWindow(): "pre-market" | "open" | "closed" {
  const now = new Date();
  const istMin = (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % (24 * 60);
  const istDay = new Date(now.getTime() + 330 * 60 * 1000).getUTCDay();
  if (istDay === 0 || istDay === 6) return "closed";
  if (istMin >= 525 && istMin < 555) return "pre-market"; // 08:45–09:15
  if (istMin >= 555 && istMin < 930) return "open";       // 09:15–15:30
  return "closed";
}

const CHECK_INTERVAL_MS = 5_000; // 5 seconds — options move fast, money at stake

async function runCheck(): Promise<void> {
  const window = currentWindow();
  if (window === "closed") {
    logger.debug("position-monitor-scheduler: market closed, skipping");
    return;
  }

  if (isWeekend()) {
    logger.debug("position-monitor-scheduler: weekend, skipping");
    return;
  }

  try {
    await monitorOpenPositions();
  } catch (err) {
    logger.error({ err }, "position-monitor-scheduler: check failed");
  }
}

export function startPositionMonitorScheduler(): void {
  logger.info("position-monitor-scheduler: starting");

  // Run immediately on startup (if market is open)
  void runCheck();

  // Then every 2 minutes
  setInterval(() => {
    void runCheck();
  }, CHECK_INTERVAL_MS);
}

// Market signal snapshot scheduler — generates daily directional predictions at 09:00 IST.
// Skips weekends. Uses the same endpoint logic as the manual GET /intelligence/market-signals.

import { logger } from "../../lib/logger.js";

function getISTMinutes(): number {
  const now = new Date();
  return (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % (24 * 60);
}

function isWeekend(): boolean {
  const now = new Date();
  const istDay = new Date(now.getTime() + 330 * 60 * 1000).getUTCDay();
  return istDay === 0 || istDay === 6;
}

function msUntil9AM_IST(): number {
  const now = new Date();
  // 09:00 IST = 03:30 UTC. Target is today at 03:30 UTC.
  const target = new Date(now);
  target.setUTCHours(3, 30, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  // Skip weekends
  while (true) {
    const targetISTDay = new Date(target.getTime() + 330 * 60 * 1000).getUTCDay();
    if (targetISTDay !== 0 && targetISTDay !== 6) break;
    target.setUTCDate(target.getUTCDate() + 1);
    target.setUTCHours(3, 30, 0, 0);
  }
  return target.getTime() - now.getTime();
}

async function runDailySignalSnapshot(): Promise<void> {
  if (isWeekend()) {
    logger.info("market-signal-scheduler: weekend — skipping snapshot");
    return;
  }

  try {
    const port = process.env["PORT"] ?? "3000";
    const baseUrl = `http://localhost:${port}`;
    const res = await fetch(`${baseUrl}/api/intelligence/market-signals`, {
      signal: AbortSignal.timeout(60_000),
    });
    if (res.ok) {
      logger.info("market-signal-scheduler: daily snapshot generated at 09:00 IST");
    } else {
      logger.warn({ status: res.status }, "market-signal-scheduler: snapshot request failed");
    }
  } catch (err) {
    logger.warn({ err }, "market-signal-scheduler: snapshot generation failed");
  }
}

export function startMarketSignalScheduler(): void {
  const delay = msUntil9AM_IST();
  logger.info({ delayMs: delay }, "market-signal-scheduler: registering (first run at 09:00 IST)");

  setTimeout(() => {
    void runDailySignalSnapshot();
    // Repeat every 24h — weekends will be skipped by the check inside
    setInterval(() => { void runDailySignalSnapshot(); }, 24 * 60 * 60 * 1000);
  }, delay);
}

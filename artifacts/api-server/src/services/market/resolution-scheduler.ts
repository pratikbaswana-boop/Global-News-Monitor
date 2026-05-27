// Market resolution scheduler — resolves all pending daily snapshots at 15:30 IST.
// Fetches real NSE prices from Yahoo Finance and marks predictions correct/incorrect
// based on actual price movement (not new AI prediction direction).

import { logger } from "../../lib/logger.js";
import { db, marketSnapshotsTable } from "@workspace/db";
import { eq, isNull, lt, and } from "drizzle-orm";

function getISTMinutes(): number {
  const now = new Date();
  return (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % (24 * 60);
}

function isWeekend(): boolean {
  const now = new Date();
  const istDay = new Date(now.getTime() + 330 * 60 * 1000).getUTCDay();
  return istDay === 0 || istDay === 6;
}

function msUntil330PM_IST(): number {
  const now = new Date();
  // 15:30 IST = 10:00 UTC. Set UTC hours directly on `now` — no shift dance.
  const target = new Date(now);
  target.setUTCHours(10, 0, 0, 0);
  let targetMs = target.getTime();

  if (targetMs <= now.getTime()) {
    targetMs += 24 * 60 * 60 * 1000; // next day
  }
  // Skip weekends
  while (true) {
    const targetISTDay = new Date(targetMs + 330 * 60 * 1000).getUTCDay();
    if (targetISTDay !== 0 && targetISTDay !== 6) break;
    targetMs += 24 * 60 * 60 * 1000;
  }

  return targetMs - now.getTime();
}

// Yahoo Finance ticker map
const YAHOO_TICKERS: Record<string, string> = {
  nifty50:  "^NSEI",
  sensex:   "^BSESN",
  reliance: "RELIANCE.NS",
  tcs:      "TCS.NS",
  hdfcbank: "HDFCBANK.NS",
};

async function fetchRealPrice(assetId: string): Promise<number | null> {
  const ticker = YAHOO_TICKERS[assetId];
  if (!ticker) return null;
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return null;
    const json = await resp.json() as {
      chart?: { result?: Array<{ meta?: { regularMarketPrice?: number } }> };
    };
    const price = json.chart?.result?.[0]?.meta?.regularMarketPrice;
    return typeof price === "number" ? price : null;
  } catch {
    return null;
  }
}

async function resolveAllPendingSnapshots(): Promise<void> {
  if (isWeekend()) {
    logger.info("market-resolution-scheduler: weekend — skipping resolution");
    return;
  }

  try {
    const now = new Date();
    const pending = await db
      .select()
      .from(marketSnapshotsTable)
      .where(
        and(
          isNull(marketSnapshotsTable.resolvedAt),
          lt(marketSnapshotsTable.resolveAfter, now)
        )
      );

    if (pending.length === 0) {
      logger.info("market-resolution-scheduler: no pending snapshots to resolve");
      return;
    }

    logger.info({ count: pending.length }, "market-resolution-scheduler: resolving snapshots");

    for (const snapshot of pending) {
      try {
        const realPrice = await fetchRealPrice(snapshot.assetId);

        let actualDirection = "neutral";
        let priceChangePct: string | undefined;

        if (realPrice !== null && snapshot.realPriceAtSnapshot !== null) {
          const snapPrice = parseFloat(snapshot.realPriceAtSnapshot);
          const pctChange = ((realPrice - snapPrice) / Math.max(snapPrice, 0.01)) * 100;
          priceChangePct = pctChange.toFixed(2);

          if (pctChange > 0.1) actualDirection = "up";
          else if (pctChange < -0.1) actualDirection = "down";
          else actualDirection = "neutral";
        } else {
          actualDirection = "unknown";
        }

        const isCorrect = actualDirection === "unknown" ? null : snapshot.predictedDirection === actualDirection;

        let notes: string;
        let lessons: string | undefined;

        if (actualDirection === "unknown") {
          notes = `Could not resolve — no price data available at resolution time.`;
        } else if (isCorrect) {
          notes = `Prediction CORRECT. Predicted ${snapshot.predictedDirection.toUpperCase()} and market moved ${actualDirection.toUpperCase()} (${priceChangePct}%).`;
          if (realPrice !== null && priceChangePct !== undefined) {
            notes += ` Price: ${snapshot.realPriceAtSnapshot} → ${realPrice.toFixed(2)}.`;
          }
        } else {
          notes = `Prediction INCORRECT. Predicted ${snapshot.predictedDirection.toUpperCase()} but market moved ${actualDirection.toUpperCase()} (${priceChangePct}%).`;
          if (realPrice !== null && priceChangePct !== undefined) {
            notes += ` Price: ${snapshot.realPriceAtSnapshot} → ${realPrice.toFixed(2)}.`;
          }
          lessons = `Predicted ${snapshot.predictedDirection.toUpperCase()} based on: "${snapshot.dominantNarrative}". ` +
            `Actual outcome: ${actualDirection.toUpperCase()}. ` +
            `Next time weigh counter-signals more heavily when ${snapshot.dominantNarrative.slice(0, 100)} is mixed.`;
        }

        await db
          .update(marketSnapshotsTable)
          .set({
            resolvedAt: now,
            resolutionDirection: actualDirection,
            isCorrect,
            resolutionNotes: notes,
            ...(realPrice !== null ? { realPriceAtResolution: realPrice.toString() } : {}),
            ...(priceChangePct !== undefined ? { priceChangePct } : {}),
            ...(lessons !== undefined ? { lessonsLearned: lessons } : {}),
          })
          .where(eq(marketSnapshotsTable.id, snapshot.id));
      } catch (err) {
        logger.warn({ snapshotId: snapshot.id, err }, "market-resolution-scheduler: single snapshot resolution failed");
      }
    }

    logger.info({ count: pending.length }, "market-resolution-scheduler: resolution cycle complete");
  } catch (err) {
    logger.error({ err }, "market-resolution-scheduler: resolution cycle failed");
  }
}

export function startMarketResolutionScheduler(): void {
  const delay = msUntil330PM_IST();
  logger.info({ delayMs: delay }, "market-resolution-scheduler: registering (first run at 15:30 IST)");

  setTimeout(() => {
    void resolveAllPendingSnapshots();
    setInterval(() => { void resolveAllPendingSnapshots(); }, 24 * 60 * 60 * 1000);
  }, delay);
}

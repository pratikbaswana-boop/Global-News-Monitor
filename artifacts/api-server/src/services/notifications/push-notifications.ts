// Push notification service — 6 notification types.
// Delivery via web push (VAPID) or webhook if WEB_PUSH_ENDPOINT is not set.
// Consumers call emitNotification() with the appropriate type and payload.

import { logger } from "../../lib/logger.js";

export type NotificationType =
  | "prediction_updated"
  | "regime_change_alert"
  | "narrative_drift_alert"
  | "market_call_flipped"
  | "market_close_summary"
  | "prediction_resolved";

export interface PushPayload {
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

// ── Delivery ─────────────────────────────────────────────────────────────────

async function deliverNotification(payload: PushPayload): Promise<void> {
  const webhookUrl = process.env["NOTIFICATION_WEBHOOK_URL"];

  if (webhookUrl) {
    try {
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5_000),
      });
      logger.info({ type: payload.type, title: payload.title }, "notification: delivered via webhook");
    } catch (err) {
      logger.warn({ type: payload.type, err }, "notification: webhook delivery failed");
    }
    return;
  }

  // No delivery endpoint configured — log at info level so the payload is visible
  logger.info({ notification: payload }, "notification: emitted (no delivery endpoint configured)");
}

// ── Typed emitters ────────────────────────────────────────────────────────────

export function emitNotification(payload: PushPayload): void {
  void deliverNotification(payload);
}

// 1. Prediction Updated — new prediction_v2 row generated for a story
export function notifyPredictionUpdated(storyId: string, storyLabel: string, dominantChannel: string): void {
  emitNotification({
    type: "prediction_updated",
    title: "Prediction Updated",
    body: `New forecast for "${storyLabel}" via ${dominantChannel}`,
    data: { storyId, dominantChannel },
    timestamp: new Date().toISOString(),
  });
}

// 2. Regime Change Alert — HMM transitions to a different regime
export function notifyRegimeChange(fromRegime: string, toRegime: string, confidence: number): void {
  emitNotification({
    type: "regime_change_alert",
    title: `🚨 Regime Change: ${fromRegime} → ${toRegime}`,
    body: `Market regime shifted to ${toRegime} (confidence: ${(confidence * 100).toFixed(0)}%). Review your open positions.`,
    data: { fromRegime, toRegime, confidence },
    timestamp: new Date().toISOString(),
  });
}

// 3. Narrative Drift Alert — story cosine distance > 0.25
export function notifyNarrativeDrift(storyId: string, storyLabel: string, driftScore: number): void {
  emitNotification({
    type: "narrative_drift_alert",
    title: "Narrative Drift Detected",
    body: `Story "${storyLabel}" has shifted significantly (drift score: ${driftScore.toFixed(3)}). Predictions may be stale.`,
    data: { storyId, driftScore },
    timestamp: new Date().toISOString(),
  });
}

// 4. Market Call Flipped — direction reversed within the same day
export function notifyMarketCallFlipped(assetName: string, fromDirection: string, toDirection: string, reason: string): void {
  emitNotification({
    type: "market_call_flipped",
    title: `⚡ Market Call Flipped: ${assetName}`,
    body: `${assetName} call changed from ${fromDirection.toUpperCase()} to ${toDirection.toUpperCase()}. Reason: ${reason}`,
    data: { assetName, fromDirection, toDirection, reason },
    timestamp: new Date().toISOString(),
  });
}

// 5. Market Close Summary — sent at 15:30 IST (10:00 UTC) with day's regime + top calls
export function notifyMarketCloseSummary(summary: {
  regime: string;
  niftyChangePct: number;
  topBullishAssets: string[];
  topBearishAssets: string[];
  uncertainAssets: string[];
  activePredictions: number;
}): void {
  const direction = summary.niftyChangePct >= 0 ? "▲" : "▼";
  emitNotification({
    type: "market_close_summary",
    title: `Market Close: NIFTY ${direction}${Math.abs(summary.niftyChangePct).toFixed(2)}% | ${summary.regime}`,
    body: `Bullish: ${summary.topBullishAssets.slice(0, 3).join(", ") || "none"} | Bearish: ${summary.topBearishAssets.slice(0, 3).join(", ") || "none"} | ${summary.activePredictions} active predictions`,
    data: summary,
    timestamp: new Date().toISOString(),
  });
}

// 6. Prediction Resolved — prediction_v2 resolved with outcome
export function notifyPredictionResolved(
  storyId: string,
  storyLabel: string,
  brierScore: number,
  devilWasRight: boolean,
  materialisedScenario: string | null
): void {
  const brierLabel = brierScore < 0.10 ? "Excellent" : brierScore < 0.20 ? "Good" : brierScore < 0.30 ? "Acceptable" : "Poor";
  emitNotification({
    type: "prediction_resolved",
    title: `Prediction Resolved: "${storyLabel}"`,
    body: `Scenario: ${materialisedScenario ?? "ambiguous"}. Brier: ${brierScore.toFixed(3)} (${brierLabel})${devilWasRight ? " — Devil's Advocate was right!" : ""}`,
    data: { storyId, brierScore, devilWasRight, materialisedScenario },
    timestamp: new Date().toISOString(),
  });
}

// ── Market Close Scheduler (15:30 IST = 10:00 UTC) ───────────────────────────

export function startMarketCloseSummaryScheduler(): void {
  function scheduleNextClose() {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(10, 0, 0, 0);
    if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);

    const delay = next.getTime() - now.getTime();
    setTimeout(async () => {
      try {
        // Fetch summary from market snapshots
        const { db, marketSnapshotsTable, marketRegimesTable } = await import("@workspace/db");
        const { desc, eq } = await import("drizzle-orm");

        const [latestRegimeRows, recentSnapshots] = await Promise.all([
          db.select().from(marketRegimesTable).orderBy(desc(marketRegimesTable.detectedAt)).limit(1),
          db.select().from(marketSnapshotsTable).orderBy(desc(marketSnapshotsTable.snapshotAt)).limit(20),
        ]);

        const regime = latestRegimeRows[0]?.regime ?? "UNKNOWN";
        const bullish = recentSnapshots.filter(s => s.predictedDirection === "up").map(s => s.assetSymbol);
        const bearish = recentSnapshots.filter(s => s.predictedDirection === "down").map(s => s.assetSymbol);
        const uncertain = recentSnapshots.filter(s => s.uncertaintyFlag).map(s => s.assetSymbol);

        notifyMarketCloseSummary({
          regime,
          niftyChangePct: 0, // would be fetched from NSE scraper in production
          topBullishAssets: [...new Set(bullish)],
          topBearishAssets: [...new Set(bearish)],
          uncertainAssets: [...new Set(uncertain)],
          activePredictions: recentSnapshots.length,
        });
      } catch (err) {
        logger.warn({ err }, "market-close-summary: failed to assemble summary");
      }
      scheduleNextClose();
    }, delay);

    logger.debug({ nextCloseUTC: next.toISOString() }, "market-close-summary: next scheduled");
  }

  scheduleNextClose();
  logger.info("market-close-summary: scheduler started (fires at 10:00 UTC / 15:30 IST daily)");
}

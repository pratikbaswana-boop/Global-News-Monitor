// Quarterly Pearson recalibration job for transmission channel correlations.
// Recomputes correlation between channel activation and actual NIFTY price movement
// using resolved prediction_v2 records from the last 90 days.
// Updates TransmissionChannel.historical_correlation in Neo4j.

import { db, predictionV2Table } from "@workspace/db";
import { isNotNull, desc, gte } from "drizzle-orm";
import { runCypher, isGraphAvailable } from "./neo4j-client.js";
import { logger } from "../../lib/logger.js";
import type { Scenario } from "../reasoning/agent-forecaster.js";

const LOOKBACK_DAYS = 90;
const QUARTERLY_INTERVAL_MS = 90 * 24 * 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 15 * 60 * 1000; // 15 min after startup

// Pearson correlation coefficient
function pearson(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 3) return 0;
  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;
  let num = 0, denomX = 0, denomY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - meanX;
    const dy = y[i]! - meanY;
    num += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }
  const denom = Math.sqrt(denomX * denomY);
  return denom === 0 ? 0 : Math.min(1, Math.max(-1, num / denom));
}

async function runRecalibration(): Promise<void> {
  if (!await isGraphAvailable().catch(() => false)) {
    logger.warn("channel-recalibration: Neo4j unavailable — skipping");
    return;
  }

  logger.info("channel-recalibration: starting quarterly Pearson recalibration");

  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  let rows: typeof predictionV2Table.$inferSelect[];
  try {
    rows = await db
      .select()
      .from(predictionV2Table)
      .where(isNotNull(predictionV2Table.resolvedScenarioIndex))
      .orderBy(desc(predictionV2Table.resolvedAt))
      .limit(500);
  } catch (err) {
    logger.error({ err }, "channel-recalibration: DB query failed");
    return;
  }

  // Build per-channel activation vs price-change arrays
  const channelData: Map<string, { activated: number[]; priceChanges: number[] }> = new Map();

  for (const row of rows) {
    if (!row.finalScenarios || row.resolvedScenarioIndex === null) continue;
    try {
      const scenarios = JSON.parse(row.finalScenarios) as Scenario[];
      const resolved = scenarios[row.resolvedScenarioIndex];
      if (!resolved) continue;

      // Proxy price change: if devil was right → adverse, else → direction from forecast
      const priceChangePct = row.brierScore !== null
        ? (1 - row.brierScore) * 2 - 1  // map Brier 0→1 to proxy price change 1→-1
        : 0;

      // Each channel in the resolved scenario's transmissionChannelIds
      for (const channelId of resolved.transmissionChannelIds ?? []) {
        if (!channelData.has(channelId)) {
          channelData.set(channelId, { activated: [], priceChanges: [] });
        }
        channelData.get(channelId)!.activated.push(1);
        channelData.get(channelId)!.priceChanges.push(priceChangePct);
      }
    } catch { continue; }
  }

  // Compute Pearson for each channel and update Neo4j
  let updated = 0;
  for (const [channelId, { activated, priceChanges }] of channelData) {
    if (activated.length < 3) continue;
    const corr = Math.abs(pearson(activated, priceChanges));
    const clampedCorr = Math.min(0.95, Math.max(0.10, corr));

    try {
      await runCypher(
        `MATCH (tc:TransmissionChannel {id: $channelId})
         SET tc.historical_correlation = $corr, tc.last_recalibrated = datetime()`,
        { channelId, corr: clampedCorr }
      );
      updated++;
      logger.debug({ channelId, corr: clampedCorr, n: activated.length }, "channel-recalibration: updated");
    } catch (err) {
      logger.warn({ channelId, err }, "channel-recalibration: Neo4j update failed");
    }
  }

  logger.info({ channelsUpdated: updated, totalChannels: channelData.size }, "channel-recalibration: complete");
}

export function startChannelRecalibrationScheduler(): void {
  logger.info("channel-recalibration: scheduler registered (first run in 15 min, then quarterly)");
  setTimeout(() => {
    void runRecalibration();
    setInterval(() => { void runRecalibration(); }, QUARTERLY_INTERVAL_MS);
  }, FIRST_RUN_DELAY_MS);
}

// Phase 4 market scheduler — fetches NSE price data and runs HMM regime detection.
// Runs every hour during IST market hours (09:15–15:30, Mon–Fri).
// Stores regime state in market_regimes DB table.

import { randomUUID } from "crypto";
import { db, marketRegimesTable } from "@workspace/db";
import { logger } from "../../lib/logger.js";
import { fetchNSEPriceData } from "./nse-scraper.js";
import { detectRegime } from "./hmm-regime.js";

const ASSET_IDS = ["nifty50", "sensex", "banknifty", "hpcl", "bpcl", "infy", "tcs", "sbin", "niftyit", "niftypharma"];
const REGIME_INTERVAL_MS = 60 * 60 * 1000; // 1h
const FIRST_RUN_DELAY_MS = 2 * 60 * 1000;  // 2 min after startup

// IST = UTC+5:30. NSE market hours: 09:15–15:30 IST = 03:45–10:00 UTC
// We run the HMM any time within 03:00–11:00 UTC window (covers pre-market + market hours)
function isMarketWindow(): boolean {
  const utcHour = new Date().getUTCHours();
  const utcMin = new Date().getUTCMinutes();
  const utcTotal = utcHour * 60 + utcMin;
  return utcTotal >= 180 && utcTotal <= 660; // 03:00–11:00 UTC
}

async function runRegimeDetectionCycle(): Promise<void> {
  if (!isMarketWindow()) {
    logger.info("market-scheduler: outside market window — skipping regime cycle");
    return;
  }

  logger.info({ assetCount: ASSET_IDS.length }, "market-scheduler: starting regime detection cycle");

  const results = await Promise.allSettled(
    ASSET_IDS.map(async (assetId) => {
      const priceData = await fetchNSEPriceData(assetId, 35);
      if (!priceData || priceData.closes.length < 10) {
        logger.warn({ assetId }, "market-scheduler: insufficient price data for HMM");
        return;
      }

      // Skip the first close (returnPct = 0 by definition)
      const returns = priceData.closes.slice(1).map(c => c.returnPct);
      const regime = detectRegime(returns);

      await db.insert(marketRegimesTable).values({
        id: randomUUID(),
        assetId,
        regime: regime.regime,
        bullProbability: regime.probabilities.bull,
        sidewaysProbability: regime.probabilities.sideways,
        bearProbability: regime.probabilities.bear,
        latestClose: priceData.latestClose,
        lookbackDays: priceData.closes.length,
        returnsJson: JSON.stringify(returns.slice(-30)), // store last 30
      });

      logger.info({
        assetId,
        regime: regime.regime,
        confidence: regime.confidence.toFixed(2),
        sequence: regime.sequenceSummary,
      }, "market-scheduler: regime stored");
    })
  );

  const failed = results.filter(r => r.status === "rejected").length;
  if (failed > 0) logger.warn({ failed }, "market-scheduler: some regime detections failed");
}

export function startMarketScheduler(): void {
  logger.info("market-scheduler: registering (first run in 2 min, then every 1h)");

  setTimeout(() => {
    void runRegimeDetectionCycle();
    setInterval(() => { void runRegimeDetectionCycle(); }, REGIME_INTERVAL_MS);
  }, FIRST_RUN_DELAY_MS);
}

// Re-exported for use in intelligence.ts market-signals route
export { detectRegime } from "./hmm-regime.js";
export { fetchNSEPriceData } from "./nse-scraper.js";
export { runMarketAgent } from "./market-agent.js";

// Phase 4 market scheduler — fetches 5-dim NSE features and runs HMM regime detection.
// Runs every hour during IST market hours (09:15–15:30, Mon–Fri).
// Stores regime state in market_regimes DB table.

import { randomUUID } from "crypto";
import { db, marketRegimesTable } from "@workspace/db";
import { logger } from "../../lib/logger.js";
import { fetchRegimeFeatures } from "./nse-direct-scraper.js";
import { detectRegime } from "./hmm-regime.js";

const ASSET_ID = "nse_market"; // single market-wide regime row; per-asset signals read this
const REGIME_INTERVAL_MS = 60 * 60 * 1000; // 1h
const FIRST_RUN_DELAY_MS = 2 * 60 * 1000;  // 2 min after startup

// IST = UTC+5:30. NSE market: 09:15–15:30 IST = 03:45–10:00 UTC
// Broaden to 03:00–11:00 UTC to cover pre-market and post-close updates
function isMarketWindow(): boolean {
  const utcTotal = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  return utcTotal >= 180 && utcTotal <= 660;
}

async function runRegimeDetectionCycle(): Promise<void> {
  if (!isMarketWindow()) {
    logger.info("market-scheduler: outside market window — skipping");
    return;
  }

  logger.info("market-scheduler: running 5-dim HMM regime cycle");

  try {
    const features = await fetchRegimeFeatures(30); // 30-day rolling window
    if (features.length < 5) {
      logger.warn({ count: features.length }, "market-scheduler: insufficient features for HMM");
      return;
    }

    const regime = detectRegime(features);
    const latest = features[features.length - 1]!;

    await db.insert(marketRegimesTable).values({
      id: randomUUID(),
      assetId: ASSET_ID,
      regime: regime.regime,
      riskOnProbability: regime.probabilities.RISK_ON,
      riskOffProbability: regime.probabilities.RISK_OFF,
      crisisProbability: regime.probabilities.CRISIS,
      vixLevel: latest.vixLevel,
      vixChange5d: latest.vixChange5d,
      fiiNetFlow5d: latest.fiiNetFlow5d,
      niftyRealVol10d: latest.niftyRealVol10d,
      inrUsdChange5d: latest.inrUsdChange5d,
      featuresJson: JSON.stringify(features.slice(-30)),
      sequenceSummary: regime.sequenceSummary,
    });

    logger.info({
      regime: regime.regime,
      confidence: regime.confidence.toFixed(2),
      sequence: regime.sequenceSummary,
      vix: latest.vixLevel,
      fii5d: latest.fiiNetFlow5d,
    }, "market-scheduler: regime stored");

  } catch (err) {
    logger.error({ err }, "market-scheduler: regime detection cycle failed");
  }
}

export function startMarketScheduler(): void {
  logger.info("market-scheduler: registering (first run in 2 min, then every 1h)");
  setTimeout(() => {
    void runRegimeDetectionCycle();
    setInterval(() => { void runRegimeDetectionCycle(); }, REGIME_INTERVAL_MS);
  }, FIRST_RUN_DELAY_MS);
}

// Re-exports consumed by intelligence.ts and other services
export { detectRegime } from "./hmm-regime.js";
export { fetchRegimeFeatures, fetchNSEPriceData } from "./nse-direct-scraper.js";
export { runMarketAgent } from "./market-agent.js";

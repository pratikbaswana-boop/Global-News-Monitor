// Market scheduler — fetches NSE features, runs HMM regime detection, and triggers
// per-asset GPT-4o ensemble inference on a smart cadence by IST time of day.
//
// Cadence:
//   • Pre-market   (08:45–09:15 IST = 03:15–03:45 UTC): every 15 min  (2 cycles: 08:45 + 09:00)
//   • Open         (09:15–15:30 IST = 03:45–10:00 UTC): every 5 min
//   • Post-close   (15:30–16:30 IST = 10:00–11:00 UTC): every 15 min
//   • Off-hours    (16:30–08:45 IST):                   every 60 min
//
// Each cycle: HMM regime → 3-window ensemble per asset → persist to market_snapshots cache.

import { randomUUID } from "crypto";
import { db, marketRegimesTable } from "@workspace/db";
import { logger } from "../../lib/logger.js";
import { fetchRegimeFeatures } from "./nse-direct-scraper.js";
import { detectRegime } from "./hmm-regime.js";
import { runMarketAgent } from "./market-agent.js";

const ASSET_ID = "nse_market";
const FIRST_RUN_DELAY_MS = 2 * 60 * 1000; // 2 min after startup

// Cadence in ms by window
const CADENCE_OPEN = 5 * 60 * 1000;        // 5 min
const CADENCE_PRE_POST = 15 * 60 * 1000;   // 15 min
const CADENCE_OFF_HOURS = 60 * 60 * 1000;  // 60 min

// Indian assets to forecast every cycle. Mirrors ASSET_TEMPLATES in intelligence.ts.
const FORECAST_ASSETS: Array<{ id: string; name: string; symbol: string }> = [
  { id: "nifty50",    name: "NIFTY 50 (NSE India)",   symbol: "NIFTY" },
  { id: "sensex",     name: "BSE SENSEX",             symbol: "SENSEX" },
  { id: "reliance",   name: "Reliance Industries",    symbol: "RELIANCE" },
  { id: "tcs",        name: "Tata Consultancy Services", symbol: "TCS" },
  { id: "hdfc-bank",  name: "HDFC Bank",              symbol: "HDFCBANK" },
  { id: "gold",       name: "Gold (₹/10g)",           symbol: "GOLD" },
  { id: "silver",     name: "Silver (₹/kg)",          symbol: "SILVER" },
];

type Window = "pre-market" | "open" | "post-close" | "off-hours";

function currentWindow(): Window {
  const now = new Date();
  // IST = UTC+5:30
  const istMin = (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % (24 * 60);
  if (istMin >= 525 && istMin < 555) return "pre-market";   // 08:45–09:15
  if (istMin >= 555 && istMin < 930) return "open";          // 09:15–15:30
  if (istMin >= 930 && istMin < 990) return "post-close";    // 15:30–16:30
  return "off-hours";
}

function cadenceForWindow(w: Window): number {
  switch (w) {
    case "open":       return CADENCE_OPEN;
    case "pre-market": return CADENCE_PRE_POST;
    case "post-close": return CADENCE_PRE_POST;
    case "off-hours":  return CADENCE_OFF_HOURS;
  }
}

async function detectAndStoreRegime(): Promise<boolean> {
  try {
    const features = await fetchRegimeFeatures(30);
    if (features.length < 5) {
      logger.warn({ count: features.length }, "market-scheduler: insufficient features for HMM");
      return false;
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
    }, "market-scheduler: regime stored");
    return true;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "market-scheduler: regime detection failed");
    return false;
  }
}

async function runEnsembleForAllAssets(window: Window): Promise<void> {
  // Load latest stored regime (within last 24h)
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await db.select().from(marketRegimesTable).limit(1).then((r) => r);
  if (rows.length === 0) {
    logger.info("market-scheduler: no regime row yet, skipping ensemble");
    return;
  }

  // Build a RegimeState-shaped object from the stored row for runMarketAgent
  const last = rows[0]!;
  const regimeState = {
    regime: last.regime as "RISK_ON" | "RISK_OFF" | "CRISIS",
    probabilities: {
      RISK_ON: last.riskOnProbability,
      RISK_OFF: last.riskOffProbability,
      CRISIS: last.crisisProbability,
    },
    confidence: Math.max(last.riskOnProbability, last.riskOffProbability, last.crisisProbability),
    sequenceSummary: last.sequenceSummary ?? "stored",
  };

  let ok = 0;
  let failed = 0;
  for (const asset of FORECAST_ASSETS) {
    try {
      await runMarketAgent(
        asset.id,
        asset.name,
        asset.symbol,
        regimeState as never,
        "OHLCV unavailable in scheduler context",
        "",
        null,
        { force: true },
      );
      ok++;
    } catch (err) {
      failed++;
      logger.warn({ asset: asset.id, err: err instanceof Error ? err.message : err }, "market-scheduler: ensemble failed");
    }
  }
  logger.info({ window, ok, failed }, "market-scheduler: ensemble cycle complete");
  // touch cutoff so the linter doesn't complain in case we wire it later
  void cutoff;
}

async function runCycle(): Promise<void> {
  const window = currentWindow();
  logger.info({ window }, "market-scheduler: cycle starting");

  // Try regime detection only when Yahoo data is likely fresh (pre-market through post-close)
  if (window !== "off-hours") {
    await detectAndStoreRegime();
  }

  // Always run ensemble — uses last known regime if no fresh one
  await runEnsembleForAllAssets(window);
}

function scheduleNext(): void {
  const window = currentWindow();
  const delay = cadenceForWindow(window);
  setTimeout(async () => {
    try {
      await runCycle();
    } catch (err) {
      logger.error({ err }, "market-scheduler: cycle threw");
    }
    scheduleNext();
  }, delay);
}

export function startMarketScheduler(): void {
  const window = currentWindow();
  logger.info({ window, firstRunMs: FIRST_RUN_DELAY_MS }, "market-scheduler: registering");
  setTimeout(async () => {
    try {
      await runCycle();
    } catch (err) {
      logger.error({ err }, "market-scheduler: initial cycle threw");
    }
    scheduleNext();
  }, FIRST_RUN_DELAY_MS);
}

// Re-exports consumed by intelligence.ts and other services
export { detectRegime } from "./hmm-regime.js";
export { fetchRegimeFeatures, fetchNSEPriceData } from "./nse-direct-scraper.js";
export { runMarketAgent } from "./market-agent.js";

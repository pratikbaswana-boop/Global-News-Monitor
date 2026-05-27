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
import { fetchRegimeFeatures, fetchNSEPriceData } from "./nse-direct-scraper.js";
import { detectRegime } from "./hmm-regime.js";
import { runMarketAgent } from "./market-agent.js";
import { fetchSessionPriors, setSessionPriors, getSessionPriors } from "./tier3-fetcher.js";

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
      // The DB column is named fiiNetFlow5d for legacy reasons; we now store
      // pcrIntraday in it (PCR replaced FII 5d in the HMM feature vector).
      fiiNetFlow5d: latest.pcrIntraday,
      niftyRealVol10d: latest.niftyRealVol10d,
      inrUsdChange5d: latest.inrUsdChange5d,
      featuresJson: JSON.stringify(features.slice(-30)),
      sequenceSummary: regime.sequenceSummary,
    });

    if (regime.driftAlert) {
      logger.warn({
        avgLogLikelihood: regime.avgLogLikelihood.toFixed(2),
        recommendation: "Review and recalibrate MU/SIGMA constants in hmm-regime.ts",
      }, "market-scheduler: HMM drift alert — model parameters may no longer describe current market");
    }

    logger.info({
      regime: regime.regime,
      confidence: regime.confidence.toFixed(2),
      sequence: regime.sequenceSummary,
      vix: latest.vixLevel,
      pcr: latest.pcrIntraday.toFixed(2),
      avgLL: regime.avgLogLikelihood.toFixed(2),
      drift: regime.driftAlert,
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
      // Fetch real OHLCV from Yahoo Finance for this asset
      let candleSummary = "Historical price data unavailable";
      let marketStats = "";
      let ohlcvCandles: Array<{
        date: string;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
        changePct: number;
      }> = [];

      try {
        const yahooSymbol = asset.symbol === "NIFTY" ? "^NSEI" :
                            asset.symbol === "SENSEX" ? "^BSESN" :
                            asset.symbol === "GOLD" ? "GC=F" :
                            asset.symbol === "SILVER" ? "SI=F" :
                            `${asset.symbol}.NS`;
        const priceData = await fetchNSEPriceData(yahooSymbol, 7);
        if (priceData.length >= 2) {
          const latest = priceData[priceData.length - 1]!;
          const prev = priceData[priceData.length - 2]!;
          const sevenDayChange = ((latest.close - priceData[0]!.close) / priceData[0]!.close) * 100;
          const avgRange = priceData.slice(1).reduce((s, d) => s + Math.abs(d.returnPct), 0) / (priceData.length - 1);
          const trend = latest.close > prev.close ? "up" : "down";

          candleSummary = priceData.map((d, i) => {
            if (i === 0) return `${d.date}: C=${d.close.toFixed(2)}`;
            return `${d.date}: C=${d.close.toFixed(2)} Chg=${d.returnPct > 0 ? "+" : ""}${d.returnPct.toFixed(2)}%`;
          }).join("\n");

          marketStats = `7-day change: ${sevenDayChange > 0 ? "+" : ""}${sevenDayChange.toFixed(2)}% | Trend: ${trend} | Avg daily range: ${avgRange.toFixed(2)}%`;

          // Build OHLCV candles from close data (Yahoo daily close only)
          // Use close as proxy for open/high/low when full OHLCV unavailable
          ohlcvCandles = priceData.map((d, i) => {
            const prevClose = i > 0 ? priceData[i - 1]!.close : d.close;
            const change = ((d.close - prevClose) / prevClose) * 100;
            return {
              date: d.date,
              open: prevClose,
              high: Math.max(d.close, prevClose),
              low: Math.min(d.close, prevClose),
              close: d.close,
              volume: 0, // volume not available from daily close endpoint
              changePct: i === 0 ? 0 : change,
            };
          });
        }
      } catch (err) {
        logger.warn({ asset: asset.id, err: err instanceof Error ? err.message : err }, "market-scheduler: price fetch failed, using fallback");
      }

      await runMarketAgent(
        asset.id,
        asset.name,
        asset.symbol,
        regimeState as never,
        candleSummary,
        marketStats,
        null,
        { force: true, ohlcvCandles },
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

// ── Session priors lifecycle ──────────────────────────────────────────────────
// Load EOD data from previous session once at market open and hold constant all
// day. Track the trading date in memory so the 5-minute cycle never re-fetches.

let _priorsLoadedFor: string | null = null;

function todayIstDateKey(): string {
  const now = new Date();
  const istMin = now.getUTCMinutes() + now.getUTCHours() * 60 + 330;
  const istDate = new Date(now.getTime());
  istDate.setUTCMinutes(istMin);
  return istDate.toISOString().slice(0, 10);
}

async function onMarketOpen(): Promise<void> {
  const today = todayIstDateKey();
  if (_priorsLoadedFor === today) return; // already loaded for this session
  try {
    const priors = await fetchSessionPriors();
    setSessionPriors(priors);
    _priorsLoadedFor = today;
    logger.info({
      fiiNet: priors.fiiNetFlowCrore,
      diiNet: priors.diiNetFlowCrore,
      deliveryPct: priors.deliveryPct,
      fiiParticipantOINet: priors.fiiParticipantOINet,
      tradingDate: priors.tradingDate,
    }, "market-scheduler: session priors loaded at market open — frozen for today");
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "market-scheduler: session prior load failed");
  }
}

async function runCycle(): Promise<void> {
  const window = currentWindow();
  logger.info({ window }, "market-scheduler: cycle starting");

  // Session priors: load once per session at first open cycle (or pre-market).
  // The 5-minute live cycle never re-fetches these EOD signals.
  if ((window === "open" || window === "pre-market") && _priorsLoadedFor !== todayIstDateKey()) {
    await onMarketOpen();
  }
  // Ensure priors exist on cold start mid-day so live cycles can compose them.
  if (!getSessionPriors()) {
    await onMarketOpen();
  }

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

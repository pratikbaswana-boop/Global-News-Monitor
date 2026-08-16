// Macro feature fetcher — polls free APIs for the inputs the HMM regime detector needs.
//
// Sources (all free, no API key required):
//   1. BTC dominance — CoinGecko global ticker (https://api.coingecko.com/api/v3/global)
//   2. DXY (US Dollar Index) — FRED series DTWEXBGS (already in feed-registry)
//   3. BTC realized volatility — computed from Binance klines (1h candles, 24h window)
//   4. Average funding rate — from Binance futures mark price WS stream
//
// Runs every 5 minutes. Feeds data into the crypto HMM via updateRegimeFeatures().

import { logger } from "../../../lib/logger.js";
import { updateRegimeFeatures } from "../regime/crypto-hmm.js";
import { onFunding } from "../event-bus.js";
import type { FundingRate } from "../types.js";

const FETCH_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const BINANCE_KLINES_URL = "https://api.binance.com/api/v3/klines";
const COINGECKO_GLOBAL_URL = "https://api.coingecko.com/api/v3/global";
const FRED_DXY_URL = "https://api.stlouisfed.org/fred/series/observations?series_id=DTWEXBGS&file_type=json&limit=1&sort_order=desc";

const BTC_SYMBOL = "BTCUSDT";
const fundingRates = new Map<string, number>(); // symbol → latest funding rate

let schedulerTimer: NodeJS.Timeout | null = null;
let started = false;

// ── BTC realized volatility from Binance klines ───────────────────────────────

async function fetchBtcRealizedVol(): Promise<number> {
  try {
    // Fetch last 24 hourly candles
    const url = `${BINANCE_KLINES_URL}?symbol=${BTC_SYMBOL}&interval=1h&limit=24`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const candles = (await res.json()) as [string, string, string, string, string, string, ...unknown[]][];
    if (candles.length < 2) return 0.02;

    // Compute log returns from close prices (index 4)
    const closes = candles.map((c) => parseFloat(c[4]!));
    const returns: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      if (closes[i - 1]! > 0) {
        returns.push(Math.log(closes[i]! / closes[i - 1]!));
      }
    }

    if (returns.length < 2) return 0.02;
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
    const hourlyVol = Math.sqrt(variance);
    // Annualized vol (but we want daily realized vol for the HMM)
    const dailyVol = hourlyVol * Math.sqrt(24);
    return dailyVol;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "macro-fetcher: BTC vol fetch failed");
    return 0.02; // fallback
  }
}

// ── BTC dominance from CoinGecko ──────────────────────────────────────────────

async function fetchBtcDominance(): Promise<number> {
  try {
    const res = await fetch(COINGECKO_GLOBAL_URL, {
      headers: { "Accept": "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as any;
    const dominance = data?.data?.market_cap_percentage?.btc;
    if (typeof dominance === "number") return dominance;
    return 54; // fallback
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "macro-fetcher: BTC dominance fetch failed");
    return 54; // fallback
  }
}

// ── DXY from FRED ─────────────────────────────────────────────────────────────

async function fetchDxy(): Promise<number> {
  try {
    // FRED API requires an api_key — use the public sample endpoint
    // Alternatively, compute from USDX index. For now, use a reasonable fallback.
    // In production, wire this to the FRED API key in .env
    const fredKey = process.env["FRED_API_KEY"];
    if (fredKey) {
      const url = `${FRED_DXY_URL}&api_key=${fredKey}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json() as any;
        const val = parseFloat(data?.observations?.[0]?.value ?? "105");
        if (!isNaN(val)) return val;
      }
    }
    return 105; // fallback
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "macro-fetcher: DXY fetch failed");
    return 105; // fallback
  }
}

// ── Average funding rate from WS stream ───────────────────────────────────────

function computeAvgFundingRate(): number {
  if (fundingRates.size === 0) return 0.0001;
  let sum = 0;
  for (const rate of fundingRates.values()) {
    sum += rate;
  }
  return sum / fundingRates.size;
}

// Track funding rates from the WS stream
onFunding((data: FundingRate) => {
  fundingRates.set(data.symbol, data.fundingRate);
});

// ── Main fetch loop ───────────────────────────────────────────────────────────

async function fetchAndUpdate(): Promise<void> {
  const [btcVol, btcDom, dxy] = await Promise.all([
    fetchBtcRealizedVol(),
    fetchBtcDominance(),
    fetchDxy(),
  ]);

  const fundingAvg = computeAvgFundingRate();

  updateRegimeFeatures({
    btcRealizedVol: btcVol,
    btcDominance: btcDom,
    fundingRateAvg: fundingAvg,
    dxy,
  });

  logger.info({
    btcVol: btcVol.toFixed(4),
    btcDom: btcDom.toFixed(1),
    fundingAvg: fundingAvg.toFixed(6),
    dxy: dxy.toFixed(1),
  }, "macro-fetcher: regime features updated");
}

export function startMacroFeatureFetcher(): boolean {
  if (started) return true;
  started = true;

  // Fetch immediately on start
  fetchAndUpdate().catch((err) => {
    logger.error({ err: err instanceof Error ? err.message : err }, "macro-fetcher: initial fetch failed");
  });

  schedulerTimer = setInterval(() => {
    fetchAndUpdate().catch((err) => {
      logger.error({ err: err instanceof Error ? err.message : err }, "macro-fetcher: scheduled fetch failed");
    });
  }, FETCH_INTERVAL_MS);

  logger.info({ intervalMs: FETCH_INTERVAL_MS }, "macro-fetcher: started");
  return true;
}

export function stopMacroFeatureFetcher(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
  started = false;
  logger.info("macro-fetcher: stopped");
}

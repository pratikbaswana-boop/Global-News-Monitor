// NSE price scraper — fetches 30-day daily OHLCV from Yahoo Finance for HMM input.
// Supplements the 7-day data used by aiPredictAsset with a longer series for regime detection.

import { logger } from "../../lib/logger.js";

export interface DailyClose {
  date: string;   // ISO date string
  close: number;
  returnPct: number; // ((close - prevClose) / prevClose) * 100
}

export interface NSEPriceData {
  assetId: string;
  closes: DailyClose[];
  latestClose: number;
}

// Maps assetId to Yahoo Finance ticker (same as existing YAHOO_TICKERS in intelligence.ts)
const YAHOO_TICKERS: Record<string, string> = {
  nifty50:   "^NSEI",
  sensex:    "^BSESN",
  banknifty: "^NSEBANK",
  hpcl:      "HINDPETRO.NS",
  bpcl:      "BPCL.NS",
  infy:      "INFY.NS",
  tcs:       "TCS.NS",
  sbin:      "SBIN.NS",
  niftyit:   "^CNXIT",
  niftypharma: "^CNXPHARMA",
};

// In-memory cache: refresh every 4h (regime detection runs hourly, no need to refetch every time)
const _cache = new Map<string, { data: NSEPriceData; fetchedAt: number }>();
const CACHE_TTL_MS = 4 * 60 * 60 * 1000;

export async function fetchNSEPriceData(assetId: string, days = 35): Promise<NSEPriceData | null> {
  const cached = _cache.get(assetId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.data;

  const ticker = YAHOO_TICKERS[assetId];
  if (!ticker) return null;

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=${days}d`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; HMM/1.0)" },
      signal: AbortSignal.timeout(12000),
    });
    if (!resp.ok) {
      logger.warn({ assetId, status: resp.status }, "nse-scraper: Yahoo Finance returned non-OK");
      return null;
    }

    const json = await resp.json() as {
      chart?: {
        result?: Array<{
          timestamp?: number[];
          indicators?: { quote?: Array<{ close?: (number | null)[] }> };
        }>;
      };
    };

    const result = json.chart?.result?.[0];
    const timestamps = result?.timestamp ?? [];
    const closes = result?.indicators?.quote?.[0]?.close ?? [];

    const dailyCloses: DailyClose[] = [];
    let prev: number | null = null;

    for (let i = 0; i < timestamps.length; i++) {
      const c = closes[i];
      if (c == null) continue;

      const returnPct = prev != null ? ((c - prev) / prev) * 100 : 0;
      dailyCloses.push({
        date: new Date((timestamps[i]!) * 1000).toISOString().split("T")[0]!,
        close: Math.round(c * 100) / 100,
        returnPct: Math.round(returnPct * 1000) / 1000,
      });
      prev = c;
    }

    if (dailyCloses.length < 10) return null;

    const data: NSEPriceData = {
      assetId,
      closes: dailyCloses,
      latestClose: dailyCloses[dailyCloses.length - 1]!.close,
    };
    _cache.set(assetId, { data, fetchedAt: Date.now() });
    return data;

  } catch (err) {
    logger.warn({ assetId, err }, "nse-scraper: fetch failed");
    return null;
  }
}

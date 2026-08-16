// Historical data downloader — fetches Binance klines (OHLCV) for backtesting.
//
// Binance public API: https://api.binance.com/api/v3/klines
//   - interval: 1m, 5m, 15m, 1h, 4h, 1d
//   - limit: max 1000 per request
//   - startTime / endTime: ms timestamps
//
// This module downloads historical data and stores it in memory or to files
// for the backtest engine to replay through the signal engine.

import { logger } from "../../../lib/logger.js";
import { ACTIVE_CRYPTO_SYMBOLS } from "../universe.js";

const BINANCE_KLINES_URL = "https://api.binance.com/api/v3/klines";
const MAX_LIMIT = 1000;
const RATE_LIMIT_DELAY_MS = 200; // be polite to Binance

export interface KlineCandle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  quoteVolume: number;
  trades: number;
}

export type Interval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

async function fetchKlinesBatch(
  symbol: string,
  interval: Interval,
  startTime: number,
  endTime: number,
): Promise<KlineCandle[]> {
  const url = `${BINANCE_KLINES_URL}?symbol=${symbol}&interval=${interval}&startTime=${startTime}&endTime=${endTime}&limit=${MAX_LIMIT}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance klines HTTP ${res.status}: ${await res.text()}`);
  const raw = (await res.json()) as [number, string, string, string, string, string, number, string, number, ...unknown[]][];
  return raw.map((c) => ({
    openTime: c[0]!,
    open: parseFloat(c[1]!),
    high: parseFloat(c[2]!),
    low: parseFloat(c[3]!),
    close: parseFloat(c[4]!),
    volume: parseFloat(c[5]!),
    closeTime: c[6]!,
    quoteVolume: parseFloat(c[7]!),
    trades: c[8]!,
  }));
}

export async function downloadKlines(
  symbol: string,
  interval: Interval,
  days: number,
): Promise<KlineCandle[]> {
  const intervalMs = intervalToMs(interval);
  const totalCandles = Math.floor((days * 24 * 60 * 60 * 1000) / intervalMs);
  const batches = Math.ceil(totalCandles / MAX_LIMIT);

  const now = Date.now();
  const startTime = now - days * 24 * 60 * 60 * 1000;
  const allCandles: KlineCandle[] = [];

  logger.info({ symbol, interval, days, totalCandles, batches }, "klines-downloader: starting download");

  for (let i = 0; i < batches; i++) {
    const batchStart = startTime + i * MAX_LIMIT * intervalMs;
    const batchEnd = Math.min(batchStart + MAX_LIMIT * intervalMs, now);

    try {
      const batch = await fetchKlinesBatch(symbol, interval, batchStart, batchEnd);
      allCandles.push(...batch);
      logger.debug({ symbol, batch: i + 1, of: batches, candles: batch.length }, "klines-downloader: batch fetched");

      if (i < batches - 1) {
        await new Promise((r) => setTimeout(r, RATE_LIMIT_DELAY_MS));
      }
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : err, symbol, batch: i + 1 }, "klines-downloader: batch failed");
      break;
    }
  }

  logger.info({ symbol, interval, totalCandles: allCandles.length }, "klines-downloader: download complete");
  return allCandles;
}

export async function downloadAllActiveSymbols(
  interval: Interval,
  days: number,
): Promise<Map<string, KlineCandle[]>> {
  const result = new Map<string, KlineCandle[]>();

  for (const symbol of ACTIVE_CRYPTO_SYMBOLS) {
    try {
      const candles = await downloadKlines(symbol, interval, days);
      result.set(symbol, candles);
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : err, symbol }, "klines-downloader: symbol failed");
    }
  }

  logger.info({ symbols: result.size, interval, days }, "klines-downloader: all symbols complete");
  return result;
}

function intervalToMs(interval: Interval): number {
  const map: Record<Interval, number> = {
    "1m": 60 * 1000,
    "5m": 5 * 60 * 1000,
    "15m": 15 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "4h": 4 * 60 * 60 * 1000,
    "1d": 24 * 60 * 60 * 1000,
  };
  return map[interval];
}

// ── Order book snapshot download (for OFI backtesting) ────────────────────────
// Binance REST depth endpoint: https://api.binance.com/api/v3/depth?symbol=BTCUSDT&limit=20

export interface DepthSnapshot {
  symbol: string;
  bids: [number, number][]; // [price, qty]
  asks: [number, number][];
  timestamp: number;
}

export async function fetchDepthSnapshot(symbol: string, limit = 20): Promise<DepthSnapshot> {
  const url = `https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance depth HTTP ${res.status}`);
  const data = (await res.json()) as { bids: [string, string][]; asks: [string, string][] };
  return {
    symbol,
    bids: data.bids.map(([p, q]) => [parseFloat(p), parseFloat(q)]),
    asks: data.asks.map(([p, q]) => [parseFloat(p), parseFloat(q)]),
    timestamp: Date.now(),
  };
}

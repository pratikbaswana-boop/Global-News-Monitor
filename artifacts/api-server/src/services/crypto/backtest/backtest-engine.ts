// Backtest engine — replays historical kline data through the signal engine
// to compute strategy performance metrics.
//
// Approach:
//   1. Download historical klines (OHLCV) for each symbol
//   2. Simulate order book features from candle data (approximate OFI from volume + price action)
//   3. Feed each candle as a "tick" into the signal engine
//   4. Track virtual positions with the same risk rules as live trading
//   5. Compute Sharpe ratio, win rate, max drawdown, total P&L
//
// Limitations:
//   - OFI is approximated from candle data (real OFI needs L2 order book)
//   - No funding rate data in backtest (set to neutral)
//   - No liquidation data in backtest
//   - Slippage modeled as a fixed bps cost

import { logger } from "../../../lib/logger.js";
import { downloadKlines, type KlineCandle, type Interval } from "./klines-downloader.js";
import { ACTIVE_CRYPTO_ASSETS, CRYPTO_BY_SYMBOL } from "../universe.js";

const MAKER_FEE_BPS = 1;     // 0.01% maker fee (Binance VIP0)
const TAKER_FEE_BPS = 10;    // 0.10% taker fee
const SLIPPAGE_BPS = 2;      // 0.02% slippage on entry/exit

interface BacktestTrade {
  symbol: string;
  assetId: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  exitPrice: number;
  entryTime: number;
  exitTime: number;
  quantity: number;
  pnl: number;
  pnlPct: number;
  fees: number;
  reason: string;
}

interface BacktestResult {
  symbol: string;
  assetId: string;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnl: number;
  totalFees: number;
  netPnl: number;
  maxDrawdown: number;
  sharpeRatio: number;
  avgHoldTimeMin: number;
  bestTrade: number;
  worstTrade: number;
  trades: BacktestTrade[];
}

// ── EMA-based momentum (same as signal engine) ────────────────────────────────

function computeEma(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  let ema = values[0]!;
  for (let i = 1; i < Math.min(values.length, period); i++) {
    ema = values[i]! * k + ema * (1 - k);
  }
  return ema;
}

function computeReturns(prices: number[]): number[] {
  const rets: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1]! > 0) rets.push(Math.log(prices[i]! / prices[i - 1]!));
  }
  return rets;
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

// ── Approximate OFI from candle data ──────────────────────────────────────────
// In real trading, OFI comes from L2 order book. In backtest, we approximate it
// from price action: bullish candles (close > open) with high volume → positive OFI.

function approximateOfi(candle: KlineCandle, prevCandle: KlineCandle | null): number {
  if (!prevCandle) return 0;
  const priceChange = candle.close - prevCandle.close;
  const bodySize = Math.abs(candle.close - candle.open);
  const range = candle.high - candle.low;
  if (range === 0) return 0;

  // Body ratio (how decisive was the move)
  const bodyRatio = bodySize / range;
  // Direction
  const direction = candle.close > candle.open ? 1 : -1;
  // Volume weight (higher volume = more conviction)
  const volWeight = Math.min(candle.volume / (prevCandle.volume || 1), 3);

  return direction * bodyRatio * volWeight * 0.3; // scaled to ~-1..1 range
}

// ── Single-symbol backtest ────────────────────────────────────────────────────

function backtestSymbol(
  symbol: string,
  assetId: string,
  candles: KlineCandle[],
  capital: number,
): BacktestResult {
  const trades: BacktestTrade[] = [];
  let currentTrade: {
    direction: "LONG" | "SHORT";
    entryPrice: number;
    entryTime: number;
    quantity: number;
    stopLoss: number;
    takeProfit: number;
  } | null = null;

  const closes: number[] = [];
  let equity = capital;
  let peakEquity = capital;
  let maxDrawdown = 0;
  const equityCurve: number[] = [];

  const SHORT_EMA = 5;   // 5 candles
  const MED_EMA = 30;    // 30 candles
  const LONG_EMA = 60;   // 60 candles

  for (let i = 1; i < candles.length; i++) {
    const candle = candles[i]!;
    const prev = candles[i - 1]!;
    closes.push(candle.close);

    // Check exit conditions for open trade
    if (currentTrade) {
      let exit = false;
      let exitPrice = candle.close;
      let reason = "";

      if (currentTrade.direction === "LONG") {
        if (candle.low <= currentTrade.stopLoss) {
          exit = true;
          exitPrice = currentTrade.stopLoss;
          reason = "stop loss";
        } else if (candle.high >= currentTrade.takeProfit) {
          exit = true;
          exitPrice = currentTrade.takeProfit;
          reason = "take profit";
        }
      } else {
        if (candle.high >= currentTrade.stopLoss) {
          exit = true;
          exitPrice = currentTrade.stopLoss;
          reason = "stop loss";
        } else if (candle.low <= currentTrade.takeProfit) {
          exit = true;
          exitPrice = currentTrade.takeProfit;
          reason = "take profit";
        }
      }

      if (exit) {
        const grossPnl = currentTrade.direction === "LONG"
          ? (exitPrice - currentTrade.entryPrice) * currentTrade.quantity
          : (currentTrade.entryPrice - exitPrice) * currentTrade.quantity;

        const entryFee = currentTrade.entryPrice * currentTrade.quantity * (TAKER_FEE_BPS / 10000);
        const exitFee = exitPrice * currentTrade.quantity * (TAKER_FEE_BPS / 10000);
        const slippage = (currentTrade.entryPrice + exitPrice) * currentTrade.quantity * (SLIPPAGE_BPS / 10000);
        const fees = entryFee + exitFee + slippage;
        const netPnl = grossPnl - fees;

        equity += netPnl;
        peakEquity = Math.max(peakEquity, equity);
        maxDrawdown = Math.max(maxDrawdown, (peakEquity - equity) / peakEquity);

        trades.push({
          symbol,
          assetId,
          direction: currentTrade.direction,
          entryPrice: currentTrade.entryPrice,
          exitPrice,
          entryTime: currentTrade.entryTime,
          exitTime: candle.closeTime,
          quantity: currentTrade.quantity,
          pnl: netPnl,
          pnlPct: (netPnl / (currentTrade.entryPrice * currentTrade.quantity)) * 100,
          fees,
          reason,
        });

        currentTrade = null;
      }
    }

    // Check entry conditions (only if no open trade)
    if (!currentTrade && closes.length >= LONG_EMA) {
      const shortEma = computeEma(closes.slice(-SHORT_EMA), SHORT_EMA);
      const medEma = computeEma(closes.slice(-MED_EMA), MED_EMA);
      const longEma = computeEma(closes.slice(-LONG_EMA), LONG_EMA);
      const ofi = approximateOfi(candle, prev);

      const rets = computeReturns(closes.slice(-60));
      const realizedVol = stdDev(rets) || 1;

      // Momentum score
      const momentum = (shortEma - longEma) / longEma / (realizedVol * Math.sqrt(1440));
      const fusedScore = 0.4 * ofi + 0.4 * Math.max(-1, Math.min(1, momentum)) + 0.2 * ((shortEma - medEma) / medEma / (realizedVol || 1));

      const THRESHOLD = 0.35;
      const DEADZONE = 0.08;

      if (Math.abs(fusedScore) > THRESHOLD) {
        const direction = fusedScore > 0 ? "LONG" : "SHORT";
        const entryPrice = candle.close;
        const positionSize = equity * 0.05; // 5% of equity per trade
        const quantity = positionSize / entryPrice;
        const slDistance = entryPrice * 0.005; // 0.5% stop
        const tpDistance = entryPrice * 0.015; // 1.5% target (3:1 RR)

        currentTrade = {
          direction,
          entryPrice,
          entryTime: candle.closeTime,
          quantity,
          stopLoss: direction === "LONG" ? entryPrice - slDistance : entryPrice + slDistance,
          takeProfit: direction === "LONG" ? entryPrice + tpDistance : entryPrice - tpDistance,
        };
      }
    }

    equityCurve.push(equity);
  }

  // Close any remaining trade at the last candle
  if (currentTrade && candles.length > 0) {
    const lastCandle = candles[candles.length - 1]!;
    const exitPrice = lastCandle.close;
    const grossPnl = currentTrade.direction === "LONG"
      ? (exitPrice - currentTrade.entryPrice) * currentTrade.quantity
      : (currentTrade.entryPrice - exitPrice) * currentTrade.quantity;
    const fees = (currentTrade.entryPrice + exitPrice) * currentTrade.quantity * ((TAKER_FEE_BPS + SLIPPAGE_BPS) / 10000);
    const netPnl = grossPnl - fees;
    equity += netPnl;

    trades.push({
      symbol,
      assetId,
      direction: currentTrade.direction,
      entryPrice: currentTrade.entryPrice,
      exitPrice,
      entryTime: currentTrade.entryTime,
      exitTime: lastCandle.closeTime,
      quantity: currentTrade.quantity,
      pnl: netPnl,
      pnlPct: (netPnl / (currentTrade.entryPrice * currentTrade.quantity)) * 100,
      fees,
      reason: "end of data",
    });
  }

  // Compute metrics
  const winningTrades = trades.filter((t) => t.pnl > 0).length;
  const losingTrades = trades.filter((t) => t.pnl <= 0).length;
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const totalFees = trades.reduce((s, t) => s + t.fees, 0);
  const netPnl = totalPnl;
  const winRate = trades.length > 0 ? winningTrades / trades.length : 0;

  // Sharpe ratio (annualized, assuming 1h candles)
  const tradeReturns = trades.map((t) => t.pnlPct / 100);
  const avgReturn = tradeReturns.length > 0 ? tradeReturns.reduce((a, b) => a + b, 0) / tradeReturns.length : 0;
  const returnStd = stdDev(tradeReturns);
  const sharpeRatio = returnStd > 0 ? (avgReturn / returnStd) * Math.sqrt(365 * 24) : 0;

  const avgHoldTimeMin = trades.length > 0
    ? trades.reduce((s, t) => s + (t.exitTime - t.entryTime) / 60000, 0) / trades.length
    : 0;

  const bestTrade = trades.length > 0 ? Math.max(...trades.map((t) => t.pnl)) : 0;
  const worstTrade = trades.length > 0 ? Math.min(...trades.map((t) => t.pnl)) : 0;

  return {
    symbol,
    assetId,
    totalTrades: trades.length,
    winningTrades,
    losingTrades,
    winRate,
    totalPnl,
    totalFees,
    netPnl,
    maxDrawdown,
    sharpeRatio,
    avgHoldTimeMin,
    bestTrade,
    worstTrade,
    trades,
  };
}

// ── Full backtest runner ──────────────────────────────────────────────────────

export async function runBacktest(
  interval: Interval = "1h",
  days: number = 30,
  capital: number = 10000,
): Promise<BacktestResult[]> {
  logger.info({ interval, days, capital, symbols: ACTIVE_CRYPTO_ASSETS.length }, "backtest: starting");

  const results: BacktestResult[] = [];

  for (const asset of ACTIVE_CRYPTO_ASSETS) {
    try {
      const candles = await downloadKlines(asset.symbol, interval, days);
      if (candles.length < 60) {
        logger.warn({ symbol: asset.symbol, candles: candles.length }, "backtest: not enough candles, skipping");
        continue;
      }
      const result = backtestSymbol(asset.symbol, asset.assetId, candles, capital);
      results.push(result);

      logger.info({
        symbol: asset.symbol,
        trades: result.totalTrades,
        winRate: (result.winRate * 100).toFixed(1) + "%",
        netPnl: result.netPnl.toFixed(2),
        sharpe: result.sharpeRatio.toFixed(2),
        maxDD: (result.maxDrawdown * 100).toFixed(1) + "%",
      }, "backtest: symbol complete");
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : err, symbol: asset.symbol }, "backtest: symbol failed");
    }
  }

  // Summary
  const totalNetPnl = results.reduce((s, r) => s + r.netPnl, 0);
  const totalTrades = results.reduce((s, r) => s + r.totalTrades, 0);
  const avgWinRate = results.length > 0 ? results.reduce((s, r) => s + r.winRate, 0) / results.length : 0;

  logger.info({
    symbols: results.length,
    totalTrades,
    totalNetPnl: totalNetPnl.toFixed(2),
    avgWinRate: (avgWinRate * 100).toFixed(1) + "%",
  }, "backtest: complete");

  return results;
}

export type { BacktestResult, BacktestTrade };

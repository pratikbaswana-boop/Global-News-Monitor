// Crypto API routes — REST endpoints for the frontend to view crypto trading state.
//
// Endpoints:
//   GET  /crypto/status           — module status (enabled, paper mode, kill switch)
//   GET  /crypto/positions         — open positions
//   GET  /crypto/signals           — recent signals
//   GET  /crypto/regime            — current market regime
//   GET  /crypto/risk              — risk engine status
//   GET  /crypto/balance           — exchange balance (if configured)
//   POST /crypto/backtest          — run a backtest
//   GET  /crypto/performance       — performance metrics

import { Router } from "express";
import { logger } from "../lib/logger.js";
import { isCryptoEnabled, isPaperMode, isCryptoStarted } from "../services/crypto/index.js";
import { getOpenPositions } from "../services/crypto/execution/position-manager.js";
import { getRiskStatus } from "../services/crypto/risk/crypto-risk-engine.js";
import { isBinanceConfigured, getCryptoAccountBalances } from "../services/crypto/exchanges/binance-rest.js";
import { runBacktest, type BacktestResult } from "../services/crypto/backtest/backtest-engine.js";
import { getSignalState } from "../services/crypto/signals/crypto-signal-engine.js";
import { ACTIVE_CRYPTO_ASSETS } from "../services/crypto/universe.js";

const router = Router();

// GET /crypto/status — module status
router.get("/crypto/status", (_req, res) => {
  res.json({
    enabled: isCryptoEnabled(),
    started: isCryptoStarted(),
    paperMode: isPaperMode(),
    binanceConfigured: isBinanceConfigured(),
    activeAssets: ACTIVE_CRYPTO_ASSETS.map((a) => ({ symbol: a.symbol, assetId: a.assetId, name: a.name })),
  });
});

// GET /crypto/positions — open positions
router.get("/crypto/positions", (_req, res) => {
  try {
    const positions = getOpenPositions().map((p) => ({
      symbol: p.symbol,
      assetId: p.assetId,
      side: p.side,
      entryPrice: p.entryPrice,
      quantity: p.quantity,
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit,
      trailingHigh: p.trailingHigh,
      openedAt: p.openedAt,
      signalId: p.signalId,
    }));
    res.json({ positions });
  } catch (err) {
    logger.error({ err }, "crypto-routes: positions fetch failed");
    res.status(500).json({ error: "Failed to fetch positions" });
  }
});

// GET /crypto/signals — recent signal state per symbol
router.get("/crypto/signals", (_req, res) => {
  try {
    const signals = ACTIVE_CRYPTO_ASSETS.map((asset) => {
      const state = getSignalState(asset.symbol);
      return {
        symbol: asset.symbol,
        assetId: asset.assetId,
        name: asset.name,
        priceBuffer: state?.prices.length ?? 0,
        lastFunding: state?.lastFunding ?? null,
        newsBias: state?.newsBias ?? 0,
      };
    });
    res.json({ signals });
  } catch (err) {
    logger.error({ err }, "crypto-routes: signals fetch failed");
    res.status(500).json({ error: "Failed to fetch signals" });
  }
});

// GET /crypto/risk — risk engine status
router.get("/crypto/risk", (_req, res) => {
  res.json(getRiskStatus());
});

// GET /crypto/balance — exchange balance (if configured)
router.get("/crypto/balance", async (_req, res): Promise<void> => {
  if (!isBinanceConfigured()) {
    res.json({ error: "Binance not configured", balances: [] });
    return;
  }
  try {
    const balances = await getCryptoAccountBalances("spot");
    const nonZero = balances.filter((b) => b.free > 0 || b.locked > 0);
    res.json({ balances: nonZero });
  } catch (err) {
    logger.error({ err }, "crypto-routes: balance fetch failed");
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to fetch balance" });
  }
});

// POST /crypto/backtest — run a backtest
router.post("/crypto/backtest", async (req, res): Promise<void> => {
  try {
    const interval = (req.body?.interval ?? "1h") as "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
    const days = parseInt(req.body?.days ?? "30", 10);
    const capital = parseFloat(req.body?.capital ?? "10000");

    if (days > 90) {
      res.status(400).json({ error: "Max 90 days for backtest" });
      return;
    }

    res.json({ status: "started", interval, days, capital });

    // Run backtest in background — results are logged
    const results = await runBacktest(interval, days, capital);
    logger.info({
      symbols: results.length,
      totalTrades: results.reduce((s, r) => s + r.totalTrades, 0),
      totalNetPnl: results.reduce((s, r) => s + r.netPnl, 0).toFixed(2),
    }, "crypto-routes: backtest complete");
  } catch (err) {
    logger.error({ err }, "crypto-routes: backtest failed");
    res.status(500).json({ error: err instanceof Error ? err.message : "Backtest failed" });
  }
});

// GET /crypto/performance — aggregate performance metrics from open positions
router.get("/crypto/performance", (_req, res) => {
  const positions = getOpenPositions();
  const risk = getRiskStatus();

  res.json({
    openPositions: positions.length,
    killSwitch: risk.killSwitch,
    dailyPnl: risk.dailyPnl,
    maxDrawdown: risk.maxDrawdown,
    maxConcurrent: risk.maxConcurrent,
    paperMode: isPaperMode(),
  });
});

export default router;

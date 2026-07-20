// AMF (Aumorphic Future Maker) — Portfolio dashboard API.
//
// Completely additive: doesn't modify any existing route or engine.
// Aggregates data from condor engine, market snapshots, and live stock prices
// to provide a unified portfolio view.

import { Router } from "express";
import { logger } from "../lib/logger.js";
import { db, marketSnapshotsTable, condorPositionsTable, signalExecutionsTable } from "@workspace/db";
import { eq, desc, and, gte } from "drizzle-orm";
import { getCondorState } from "../services/kite/condor-paper-engine.js";
import { getAllAmfStockPrices, getLatestChainMetrics } from "../services/kite/market-ticker.js";
import { AMF_STOCKS, AMF_STOCKS_BY_SECTOR, AMF_SECTORS } from "../services/kite/amf-stock-universe.js";

const router = Router();

// GET /amf/portfolio — Unified portfolio state
router.get("/amf/portfolio", async (_req, res) => {
  try {
    // 1. Condor engine state
    const condorState = await getCondorState();

    // 2. Live stock prices for all AMF stocks
    const stockPrices = getAllAmfStockPrices();
    const stockUniverse = AMF_STOCKS.map((s) => {
      const priceEntry = stockPrices.get(s.symbol);
      return {
        symbol: s.symbol,
        assetId: s.assetId,
        name: s.name,
        sector: s.sector,
        ltp: priceEntry?.ltp ?? null,
        lastTickAt: priceEntry?.lastTickAt ?? null,
        stale: priceEntry ? (Date.now() - priceEntry.lastTickAt > 30_000) : true,
      };
    });

    // 3. NIFTY spot for market context
    const chainMetrics = getLatestChainMetrics();
    const niftySpot = chainMetrics?.spotPrice ?? null;

    // 4. Recent AI signals for AMF stocks (last 24h)
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const amfAssetIds = AMF_STOCKS.map((s) => s.assetId);
    const recentSignals = await db
      .select()
      .from(marketSnapshotsTable)
      .where(and(
        gte(marketSnapshotsTable.snapshotAt, twentyFourHoursAgo),
      ))
      .orderBy(desc(marketSnapshotsTable.snapshotAt))
      .limit(100);

    // Filter to AMF stock assets + nifty50 for market regime
    const amfSignals = recentSignals.filter(
      (s) => amfAssetIds.includes(s.assetId) || s.assetId === "nifty50"
    );

    // Group signals by asset — take latest per asset
    const latestSignalPerAsset = new Map<string, typeof amfSignals[0]>();
    for (const sig of amfSignals) {
      if (!latestSignalPerAsset.has(sig.assetId)) {
        latestSignalPerAsset.set(sig.assetId, sig);
      }
    }

    // 5. Open stock swing positions (from signal_executions)
    const openPositions = await db
      .select()
      .from(signalExecutionsTable)
      .where(eq(signalExecutionsTable.status, "open"))
      .orderBy(desc(signalExecutionsTable.executedAt))
      .limit(50);

    // 6. Calculate portfolio summary
    const condorCapital = 50000; // placeholder — will be dynamic
    const stockCapital = 50000;
    const totalCapital = condorCapital + stockCapital;

    const condorPnl = condorState.totalPnl;
    const stockPnl = openPositions.reduce((sum, p) => {
      const entry = Number(p.entryPrice ?? 0);
      const ltp = stockPrices.get(p.assetSymbol)?.ltp ?? 0;
      if (entry > 0 && ltp > 0) {
        return sum + (p.direction === "up" ? (ltp - entry) : (entry - ltp)) * p.quantity;
      }
      return sum;
    }, 0);

    const totalPnl = condorPnl + stockPnl;
    const totalPnlPct = (totalPnl / totalCapital) * 100;
    const monthlyTargetPct = (totalPnlPct / 10) * 100; // progress toward 10% monthly target

    res.json({
      portfolio: {
        totalCapital,
        totalPnl: Number(totalPnl.toFixed(2)),
        totalPnlPct: Number(totalPnlPct.toFixed(2)),
        monthlyTargetPct: Number(Math.min(monthlyTargetPct, 100).toFixed(1)),
        condor: {
          allocatedCapital: condorCapital,
          pnl: Number(condorPnl.toFixed(2)),
          winRate: condorState.totalPositions > 0
            ? (condorState.winningPositions / condorState.totalPositions) * 100
            : 0,
          totalPositions: condorState.totalPositions,
          winningPositions: condorState.winningPositions,
          active: condorState.active,
        },
        stocks: {
          allocatedCapital: stockCapital,
          pnl: Number(stockPnl.toFixed(2)),
          openPositions: openPositions.length,
        },
      },
      niftySpot,
      stockUniverse,
      sectors: AMF_SECTORS,
      stocksBySector: Object.fromEntries(
        Object.entries(AMF_STOCKS_BY_SECTOR).map(([sector, stocks]) => [
          sector,
          stocks.map((s) => ({
            symbol: s.symbol,
            name: s.name,
            ltp: stockPrices.get(s.symbol)?.ltp ?? null,
          })),
        ])
      ),
      signals: [...latestSignalPerAsset.values()].map((sig) => ({
        assetId: sig.assetId,
        direction: sig.predictedDirection,
        confidence: sig.predictedConfidence === "high" ? 90 : sig.predictedConfidence === "medium" ? 65 : sig.predictedConfidence === "low" ? 40 : 50,
        magnitude: sig.predictedMagnitude,
        narrative: sig.dominantNarrative,
        bullScore: Number(sig.bullScore ?? 0),
        bearScore: Number(sig.bearScore ?? 0),
        regime: sig.regimeAtSnapshot,
        createdAt: sig.snapshotAt,
      })),
      openPositions: openPositions.map((p) => ({
        id: p.id,
        assetSymbol: p.assetSymbol,
        direction: p.direction,
        quantity: p.quantity,
        entryPrice: Number(p.entryPrice ?? 0),
        currentPrice: stockPrices.get(p.assetSymbol)?.ltp ?? null,
        unrealizedPnl: (() => {
          const ltp = stockPrices.get(p.assetSymbol)?.ltp ?? 0;
          const entry = Number(p.entryPrice ?? 0);
          if (ltp > 0 && entry > 0) {
            return Number(((p.direction === "up" ? (ltp - entry) : (entry - ltp)) * p.quantity).toFixed(2));
          }
          return null;
        })(),
        executedAt: p.executedAt,
      })),
      condorHistory: condorState.history,
    });
  } catch (err) {
    logger.error({ err }, "amf: portfolio fetch failed");
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to fetch AMF portfolio" });
  }
});

// GET /amf/stocks — Live prices for all AMF stocks
router.get("/amf/stocks", async (_req, res) => {
  try {
    const stockPrices = getAllAmfStockPrices();
    const stocks = AMF_STOCKS.map((s) => {
      const entry = stockPrices.get(s.symbol);
      return {
        symbol: s.symbol,
        assetId: s.assetId,
        name: s.name,
        sector: s.sector,
        ltp: entry?.ltp ?? null,
        lastTickAt: entry?.lastTickAt ?? null,
        stale: entry ? (Date.now() - entry.lastTickAt > 30_000) : true,
      };
    });
    res.json({ stocks });
  } catch (err) {
    logger.error({ err }, "amf: stocks fetch failed");
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to fetch AMF stocks" });
  }
});

// GET /amf/signals — Recent AI signals for AMF stocks
router.get("/amf/signals", async (req, res) => {
  try {
    const hours = Number(req.query.hours ?? 24);
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const amfAssetIds = AMF_STOCKS.map((s) => s.assetId);

    const signals = await db
      .select()
      .from(marketSnapshotsTable)
      .where(and(
        gte(marketSnapshotsTable.snapshotAt, since),
      ))
      .orderBy(desc(marketSnapshotsTable.snapshotAt))
      .limit(200);

    const amfSignals = signals.filter((s) => amfAssetIds.includes(s.assetId));

    // Latest signal per asset
    const latestPerAsset = new Map<string, typeof amfSignals[0]>();
    for (const sig of amfSignals) {
      if (!latestPerAsset.has(sig.assetId)) {
        latestPerAsset.set(sig.assetId, sig);
      }
    }

    res.json({
      signals: [...latestPerAsset.values()].map((sig) => ({
        assetId: sig.assetId,
        direction: sig.predictedDirection,
        confidence: sig.predictedConfidence === "high" ? 90 : sig.predictedConfidence === "medium" ? 65 : sig.predictedConfidence === "low" ? 40 : 50,
        magnitude: sig.predictedMagnitude,
        narrative: sig.dominantNarrative,
        bullScore: Number(sig.bullScore ?? 0),
        bearScore: Number(sig.bearScore ?? 0),
        regime: sig.regimeAtSnapshot,
        priceImpactEstimate: sig.priceImpactEstimate,
        createdAt: sig.snapshotAt,
      })),
    });
  } catch (err) {
    logger.error({ err }, "amf: signals fetch failed");
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to fetch AMF signals" });
  }
});

export default router;

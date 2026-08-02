import { Router } from "express";
import { logger } from "../lib/logger.js";
import { db, condorPositionsTable } from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import { getCondorState } from "../services/kite/condor-paper-engine.js";

const router = Router();

// GET /condor/state — Iron Condor paper trading state (legs, P&L, history)
router.get("/condor/state", async (_req, res) => {
  try {
    const state = await getCondorState();
    res.json(state);
  } catch (err) {
    logger.error({ err }, "condor: state fetch failed");
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to fetch condor state" });
  }
});

// GET /condor/user-positions?userId=xxx — Per-user real condor positions
router.get("/condor/user-positions", async (req, res) => {
  try {
    const userId = req.query.userId as string;
    if (!userId) {
      res.status(400).json({ error: "userId query param is required" });
      return;
    }

    const rows = await db
      .select()
      .from(condorPositionsTable)
      .where(and(
        eq(condorPositionsTable.mode, "real"),
        eq(condorPositionsTable.userId, userId),
      ))
      .orderBy(desc(condorPositionsTable.executedAt))
      .limit(50);

    const enriched = rows.map((r) => ({
      ...r,
      spotAtEntry: Number(r.spotAtEntry),
      netPremium: Number(r.netPremium),
      maxLoss: Number(r.maxLoss),
      maxProfit: Number(r.maxProfit),
      capitalAtEntry: Number(r.capitalAtEntry),
      marginBlocked: r.marginBlocked ? Number(r.marginBlocked) : null,
      realisedPnl: r.realisedPnl ? Number(r.realisedPnl) : null,
      legs: JSON.parse(r.legsJson),
    }));

    res.json({ positions: enriched });
  } catch (err) {
    logger.error({ err }, "condor: user positions fetch failed");
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to fetch user condor positions" });
  }
});

export default router;

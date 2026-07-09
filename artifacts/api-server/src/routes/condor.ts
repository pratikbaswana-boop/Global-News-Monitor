import { Router } from "express";
import { logger } from "../lib/logger.js";
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

export default router;

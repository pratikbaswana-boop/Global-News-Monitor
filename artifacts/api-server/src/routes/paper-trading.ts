import { Router } from "express";
import { logger } from "../lib/logger.js";
import { getPaperTradingState } from "../services/kite/paper-trade-engine.js";

const router = Router();

// GET /paper-trading/state — Get paper trading state (capital, active trade, trade history)
router.get("/paper-trading/state", async (_req, res) => {
  try {
    const state = await getPaperTradingState();
    res.json(state);
  } catch (err) {
    logger.error({ err }, "paper-trading: state fetch failed");
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to fetch paper trading state" });
  }
});

export default router;

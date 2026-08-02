import { Router } from "express";
import { logger } from "../lib/logger.js";
import { getPaperTradingState } from "../services/kite/paper-trade-engine.js";
import { getTradeNotifications, clearTradeNotifications } from "../lib/trade-notifications.js";

const router = Router();

const PAPER_TRADING_ALLOWED_EMAILS = new Set([
  "test@example.com",
  "pratikjat2811@gmail.com",
  "pratikbaswana@gmail.com",
  "vishwakarmaadarsh77@gmail.com",
  "consistenthasher@gmail.com",
  "amarkelotra@gmail.com",
  "abcd.asdfg12@gmail.com",
  "ayushlearning22@gmail.com",
  "pranjal4uyar@gmail.com",
  "itachixoxoxo@gmail.com",
  "k2923149@gmail.com",
  "ayaabalkhi@gmail.com",
]);

router.use("/paper-trading", (req, res, next) => {
  const email = req.headers["x-user-email"] as string | undefined;
  if (!email || !PAPER_TRADING_ALLOWED_EMAILS.has(email.toLowerCase())) {
    return res.status(403).json({ error: "Access denied" });
  }
  return next();
});

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

// GET /paper-trading/notifications — Get recent trade skip/entry/exit notifications
router.get("/paper-trading/notifications", (req, res) => {
  const limit = Math.min(parseInt(req.query["limit"] as string) || 50, 100);
  res.json({ notifications: getTradeNotifications(limit) });
});

// DELETE /paper-trading/notifications — Clear all notifications
router.delete("/paper-trading/notifications", (_req, res) => {
  clearTradeNotifications();
  res.json({ ok: true });
});

export default router;

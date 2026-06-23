import { Router } from "express";
import { logger } from "../lib/logger.js";
import {
  placeOrder,
  cancelOrder,
  modifyOrder,
  getOrders,
  getOrderHistory,
  getTrades,
  syncOrderStatus,
} from "../services/kite/orders.js";
import {
  getMargins,
  getHoldings,
  getPositions,
  syncPortfolio,
  checkOrderMargin,
} from "../services/kite/portfolio.js";

const router = Router();

// POST /trading/orders — Place a new order
router.post("/trading/orders", async (req, res) => {
  try {
    const { userId, exchange, tradingsymbol, transactionType, quantity, orderType, product, price, triggerPrice, variety, tag } = req.body;

    if (!userId || !exchange || !tradingsymbol || !transactionType || !quantity || !orderType || !product) {
      res.status(400).json({ error: "Missing required order parameters" });
      return;
    }

    const result = await placeOrder(userId, {
      exchange,
      tradingsymbol,
      transactionType,
      quantity,
      orderType,
      product,
      price,
      triggerPrice,
      variety,
      tag,
    });

    res.json(result);
  } catch (err) {
    logger.error({ err }, "place order failed");
    res.status(500).json({ error: err instanceof Error ? err.message : "Order placement failed" });
  }
});

// DELETE /trading/orders/:orderId — Cancel an order
router.delete("/trading/orders/:orderId", async (req, res) => {
  try {
    const { userId, variety } = req.body;
    const { orderId } = req.params;

    if (!userId) {
      res.status(400).json({ error: "userId is required" });
      return;
    }

    await cancelOrder(userId, orderId, variety ?? "regular");
    res.json({ success: true });
  } catch (err) {
    logger.error({ err, orderId: req.params.orderId }, "cancel order failed");
    res.status(500).json({ error: err instanceof Error ? err.message : "Cancel failed" });
  }
});

// PUT /trading/orders/:orderId — Modify an order
router.put("/trading/orders/:orderId", async (req, res) => {
  try {
    const { userId, variety, quantity, price, triggerPrice, orderType } = req.body;
    const { orderId } = req.params;

    if (!userId || !variety) {
      res.status(400).json({ error: "userId and variety are required" });
      return;
    }

    await modifyOrder(userId, orderId, variety, { quantity, price, triggerPrice, orderType });
    res.json({ success: true });
  } catch (err) {
    logger.error({ err, orderId: req.params.orderId }, "modify order failed");
    res.status(500).json({ error: err instanceof Error ? err.message : "Modify failed" });
  }
});

// GET /trading/orders — List all orders for user
router.get("/trading/orders", async (req, res) => {
  try {
    const userId = req.query.userId as string;
    if (!userId) {
      res.status(400).json({ error: "userId query param is required" });
      return;
    }

    const orders = await getOrders(userId);
    res.json({ orders });
  } catch (err) {
    logger.error({ err }, "get orders failed");
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to fetch orders" });
  }
});

// GET /trading/orders/:orderId/history — Order status history
router.get("/trading/orders/:orderId/history", async (req, res) => {
  try {
    const userId = req.query.userId as string;
    const { orderId } = req.params;

    if (!userId) {
      res.status(400).json({ error: "userId query param is required" });
      return;
    }

    const history = await getOrderHistory(userId, orderId);
    res.json({ history });
  } catch (err) {
    logger.error({ err, orderId: req.params.orderId }, "get order history failed");
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to fetch order history" });
  }
});

// GET /trading/trades — List all trades for user
router.get("/trading/trades", async (req, res) => {
  try {
    const userId = req.query.userId as string;
    if (!userId) {
      res.status(400).json({ error: "userId query param is required" });
      return;
    }

    const trades = await getTrades(userId);
    res.json({ trades });
  } catch (err) {
    logger.error({ err }, "get trades failed");
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to fetch trades" });
  }
});

// POST /trading/orders/:orderId/sync — Manually sync order status from Kite
router.post("/trading/orders/:orderId/sync", async (req, res) => {
  try {
    const userId = req.body.userId as string;
    const { orderId } = req.params;

    if (!userId) {
      res.status(400).json({ error: "userId is required" });
      return;
    }

    await syncOrderStatus(userId, orderId);
    res.json({ success: true });
  } catch (err) {
    logger.error({ err, orderId: req.params.orderId }, "sync order status failed");
    res.status(500).json({ error: err instanceof Error ? err.message : "Sync failed" });
  }
});

// GET /trading/margins — Get user's margins/funds
router.get("/trading/margins", async (req, res) => {
  try {
    const userId = req.query.userId as string;
    if (!userId) {
      res.status(400).json({ error: "userId query param is required" });
      return;
    }

    const margins = await getMargins(userId);
    res.json({ margins });
  } catch (err) {
    logger.error({ err }, "get margins failed");
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to fetch margins" });
  }
});

// GET /trading/holdings — Get user's holdings
router.get("/trading/holdings", async (req, res) => {
  try {
    const userId = req.query.userId as string;
    if (!userId) {
      res.status(400).json({ error: "userId query param is required" });
      return;
    }

    const holdings = await getHoldings(userId);
    res.json({ holdings });
  } catch (err) {
    logger.error({ err }, "get holdings failed");
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to fetch holdings" });
  }
});

// GET /trading/positions — Get user's positions
router.get("/trading/positions", async (req, res) => {
  try {
    const userId = req.query.userId as string;
    if (!userId) {
      res.status(400).json({ error: "userId query param is required" });
      return;
    }

    const positions = await getPositions(userId);
    res.json({ positions });
  } catch (err) {
    logger.error({ err }, "get positions failed");
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to fetch positions" });
  }
});

// POST /trading/portfolio/sync — Sync portfolio (holdings + positions) from Kite
router.post("/trading/portfolio/sync", async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) {
      res.status(400).json({ error: "userId is required" });
      return;
    }

    await syncPortfolio(userId);
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "portfolio sync failed");
    res.status(500).json({ error: err instanceof Error ? err.message : "Portfolio sync failed" });
  }
});

// POST /trading/margins/check — Check margin required for an order before placing
router.post("/trading/margins/check", async (req, res) => {
  try {
    const { userId, exchange, tradingsymbol, transactionType, quantity, orderType, product, price, triggerPrice } = req.body;

    if (!userId || !exchange || !tradingsymbol || !transactionType || !quantity || !orderType || !product) {
      res.status(400).json({ error: "Missing required parameters" });
      return;
    }

    const margin = await checkOrderMargin(userId, {
      exchange,
      tradingsymbol,
      transactionType,
      quantity,
      orderType,
      product,
      price,
      triggerPrice,
    });

    res.json({ margin });
  } catch (err) {
    logger.error({ err }, "margin check failed");
    res.status(500).json({ error: err instanceof Error ? err.message : "Margin check failed" });
  }
});

export default router;

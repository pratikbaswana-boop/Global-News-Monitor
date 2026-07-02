import { Router } from "express";
import { logger } from "../lib/logger.js";
import { db, signalExecutionsTable } from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
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
import { fetchKiteOptionChain, getGlobalKiteClient } from "../services/kite/kite-option-chain.js";
import { getKiteClientForUser } from "../services/kite/kite-client.js";

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

// GET /trading/market-data — NIFTY spot, IV, OI, PCR from global paid Kite client
router.get("/trading/market-data", async (_req, res) => {
  try {
    const chain = await fetchKiteOptionChain();
    if (!chain) {
      res.status(503).json({ error: "Market data unavailable" });
      return;
    }
    res.json(chain);
  } catch (err) {
    logger.error({ err }, "market-data fetch failed");
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to fetch market data" });
  }
});

// GET /trading/executions — User's signal executions with current premium and PnL
router.get("/trading/executions", async (req, res) => {
  try {
    const userId = req.query.userId as string;
    const status = (req.query.status as string) || "all";

    if (!userId) {
      res.status(400).json({ error: "userId query param is required" });
      return;
    }

    const conditions = [eq(signalExecutionsTable.userId, userId)];
    if (status === "open") {
      conditions.push(eq(signalExecutionsTable.status, "open"));
    } else if (status === "closed") {
      conditions.push(eq(signalExecutionsTable.status, "closed"));
    }

    const execs = await db
      .select()
      .from(signalExecutionsTable)
      .where(and(...conditions))
      .orderBy(desc(signalExecutionsTable.executedAt))
      .limit(50);

    // Fetch current LTP for open positions via global client
    let quotesMap: Record<string, number> = {};
    const openExecs = execs.filter((e) => e.status === "open");
    if (openExecs.length > 0) {
      try {
        const kite = await getGlobalKiteClient();
        if (kite) {
          const quoteKeys = openExecs.map((e) => {
            const isOption = e.assetSymbol.startsWith("NIFTY") &&
              (e.assetSymbol.endsWith("CE") || e.assetSymbol.endsWith("PE"));
            const exchange = isOption ? "NFO" : "NSE";
            return `${exchange}:${e.assetSymbol}`;
          });
          const quotes = await Promise.race([
            kite.getQuote(quoteKeys) as Promise<Record<string, any>>,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
          ]);
          if (quotes) {
            for (const e of openExecs) {
              const isOption = e.assetSymbol.startsWith("NIFTY") &&
                (e.assetSymbol.endsWith("CE") || e.assetSymbol.endsWith("PE"));
              const exchange = isOption ? "NFO" : "NSE";
              const key = `${exchange}:${e.assetSymbol}`;
              const q = quotes[key];
              if (q) quotesMap[e.assetSymbol] = Number(q.last_price ?? 0);
            }
          }
        }
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : err }, "executions: quote fetch failed");
      }
    }

    // Enrich executions with current price and unrealized PnL
    const enriched = execs.map((e) => {
      const entryPrice = Number(e.entryPrice ?? 0);
      const currentPrice = quotesMap[e.assetSymbol] ?? 0;
      const qty = e.quantity;
      let unrealizedPnl: number | null = null;
      if (currentPrice > 0 && entryPrice > 0) {
        unrealizedPnl = e.direction === "up"
          ? (currentPrice - entryPrice) * qty
          : (entryPrice - currentPrice) * qty;
      }
      return {
        ...e,
        entryPrice: entryPrice,
        currentPrice: currentPrice > 0 ? currentPrice : null,
        unrealizedPnl: unrealizedPnl !== null ? Number(unrealizedPnl.toFixed(2)) : null,
        realisedPnl: e.realisedPnl ? Number(e.realisedPnl) : null,
        highestPriceReached: e.highestPriceReached ? Number(e.highestPriceReached) : null,
        stopLossPrice: e.stopLossPrice ? Number(e.stopLossPrice) : null,
        exitPrice: e.exitPrice ? Number(e.exitPrice) : null,
      };
    });

    res.json({ executions: enriched });
  } catch (err) {
    logger.error({ err }, "get executions failed");
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to fetch executions" });
  }
});

export default router;

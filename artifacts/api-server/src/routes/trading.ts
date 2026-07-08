import { Router } from "express";
import { logger } from "../lib/logger.js";
import { db, signalExecutionsTable, brokerOrdersTable } from "@workspace/db";
import { eq, desc, and, inArray } from "drizzle-orm";
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
import { getLtpBySymbol } from "../services/kite/market-ticker.js";
import { broadcastUserExecutions } from "../services/kite/ws-broadcaster.js";

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

    const orders = await Promise.race([
      getOrders(userId),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 10000)),
    ]);
    if (!orders) {
      res.status(503).json({ error: "Orders fetch timed out" });
      return;
    }
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
    const chain = await Promise.race([
      fetchKiteOptionChain(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 10000)),
    ]);
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

// POST /trading/executions/:execId/exit — Exit a single trade at market rate
router.post("/trading/executions/:execId/exit", async (req, res) => {
  try {
    const { execId } = req.params;
    const { userId } = req.body;

    if (!userId) {
      res.status(400).json({ error: "userId is required" });
      return;
    }

    const execs = await db
      .select()
      .from(signalExecutionsTable)
      .where(and(
        eq(signalExecutionsTable.id, execId),
        eq(signalExecutionsTable.userId, userId),
        eq(signalExecutionsTable.status, "open"),
      ))
      .limit(1);

    if (execs.length === 0) {
      res.status(404).json({ error: "Open execution not found" });
      return;
    }

    const exec = execs[0];

    // Get current LTP from tick map or REST quote
    let currentPrice = getLtpBySymbol(exec.assetSymbol);
    if (!currentPrice || currentPrice <= 0) {
      try {
        const kite = await getGlobalKiteClient();
        if (kite) {
          const isOption = exec.assetSymbol.startsWith("NIFTY") &&
            (exec.assetSymbol.endsWith("CE") || exec.assetSymbol.endsWith("PE"));
          const exchange = isOption ? "NFO" : "NSE";
          const quotes = await kite.getQuote([`${exchange}:${exec.assetSymbol}`]) as Record<string, any>;
          const q = quotes[`${exchange}:${exec.assetSymbol}`];
          if (q) currentPrice = Number(q.last_price ?? 0);
        }
      } catch {
        // ignore
      }
    }

    if (!currentPrice || currentPrice <= 0) {
      res.status(400).json({ error: "Could not determine current price" });
      return;
    }

    const isOption = exec.assetSymbol.startsWith("NIFTY") &&
      (exec.assetSymbol.endsWith("CE") || exec.assetSymbol.endsWith("PE"));
    const exchange = isOption ? "NFO" : "NSE";
    const direction = exec.direction ?? "up";

    // Place SELL (for long) / BUY (for short) at LIMIT slightly below LTP for aggressive fill
    const discountPct = 0.02; // 2% below LTP
    const exitLimitPrice = Math.round((currentPrice * (direction === "up" ? 1 - discountPct : 1 + discountPct)) / 0.05) * 0.05;

    const exitOrder = await placeOrder(userId, {
      exchange,
      tradingsymbol: exec.assetSymbol,
      transactionType: direction === "up" ? "SELL" : "BUY",
      quantity: exec.quantity,
      orderType: "LIMIT",
      price: exitLimitPrice,
      product: (exec.product ?? "MIS") as "CNC" | "MIS" | "NRML",
      tag: `manual-exit-${exec.id.slice(0, 14)}`,
    });

    // Cancel any resting protective SL order for this execution
    const slOrders = await db
      .select()
      .from(brokerOrdersTable)
      .where(and(
        eq(brokerOrdersTable.userId, userId),
        eq(brokerOrdersTable.tradingsymbol, exec.assetSymbol),
        eq(brokerOrdersTable.transactionType, "SELL"),
        eq(brokerOrdersTable.status, "OPEN"),
      ));

    for (const slOrder of slOrders) {
      try {
        await cancelOrder(userId, slOrder.kiteOrderId, "regular");
      } catch {
        // ignore cancel errors — the SL may have already fired
      }
    }

    // Mark execution as closed with provisional exit price
    const entryPrice = Number(exec.entryPrice ?? 0);
    const realisedPnl = direction === "up"
      ? (exitLimitPrice - entryPrice) * exec.quantity
      : (entryPrice - exitLimitPrice) * exec.quantity;

    await db
      .update(signalExecutionsTable)
      .set({
        status: "closed",
        exitPrice: String(exitLimitPrice),
        realisedPnl: String(realisedPnl.toFixed(2)),
        exitReason: "manual",
        closedAt: new Date(),
      })
      .where(eq(signalExecutionsTable.id, execId));

    // Broadcast updated executions via WebSocket
    void broadcastUserExecutions(userId);

    logger.info({ userId, execId, exitOrderId: exitOrder.kiteOrderId, exitLimitPrice, currentPrice }, "trading: manual exit placed");

    res.json({
      success: true,
      orderId: exitOrder.kiteOrderId,
      exitPrice: exitLimitPrice,
      message: "Exit order placed at market rate",
    });
  } catch (err) {
    logger.error({ err, execId: req.params.execId }, "trading: manual exit failed");
    res.status(500).json({ error: err instanceof Error ? err.message : "Exit failed" });
  }
});

// POST /trading/executions/exit-all — Exit all open trades at market rate
router.post("/trading/executions/exit-all", async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      res.status(400).json({ error: "userId is required" });
      return;
    }

    const openExecs = await db
      .select()
      .from(signalExecutionsTable)
      .where(and(
        eq(signalExecutionsTable.userId, userId),
        eq(signalExecutionsTable.status, "open"),
      ));

    if (openExecs.length === 0) {
      res.json({ success: true, message: "No open trades to exit", exited: 0 });
      return;
    }

    const results: Array<{ execId: string; symbol: string; success: boolean; error?: string }> = [];

    for (const exec of openExecs) {
      try {
        let currentPrice = getLtpBySymbol(exec.assetSymbol);
        if (!currentPrice || currentPrice <= 0) {
          try {
            const kite = await getGlobalKiteClient();
            if (kite) {
              const isOption = exec.assetSymbol.startsWith("NIFTY") &&
                (exec.assetSymbol.endsWith("CE") || exec.assetSymbol.endsWith("PE"));
              const exchange = isOption ? "NFO" : "NSE";
              const quotes = await kite.getQuote([`${exchange}:${exec.assetSymbol}`]) as Record<string, any>;
              const q = quotes[`${exchange}:${exec.assetSymbol}`];
              if (q) currentPrice = Number(q.last_price ?? 0);
            }
          } catch {
            // ignore
          }
        }

        if (!currentPrice || currentPrice <= 0) {
          results.push({ execId: exec.id, symbol: exec.assetSymbol, success: false, error: "No price" });
          continue;
        }

        const isOption = exec.assetSymbol.startsWith("NIFTY") &&
          (exec.assetSymbol.endsWith("CE") || exec.assetSymbol.endsWith("PE"));
        const exchange = isOption ? "NFO" : "NSE";
        const direction = exec.direction ?? "up";
        const discountPct = 0.02;
        const exitLimitPrice = Math.round((currentPrice * (direction === "up" ? 1 - discountPct : 1 + discountPct)) / 0.05) * 0.05;

        await placeOrder(userId, {
          exchange,
          tradingsymbol: exec.assetSymbol,
          transactionType: direction === "up" ? "SELL" : "BUY",
          quantity: exec.quantity,
          orderType: "LIMIT",
          price: exitLimitPrice,
          product: (exec.product ?? "MIS") as "CNC" | "MIS" | "NRML",
          tag: `exit-all-${exec.id.slice(0, 14)}`,
        });

        // Cancel resting SL orders
        const slOrders = await db
          .select()
          .from(brokerOrdersTable)
          .where(and(
            eq(brokerOrdersTable.userId, userId),
            eq(brokerOrdersTable.tradingsymbol, exec.assetSymbol),
            eq(brokerOrdersTable.transactionType, "SELL"),
            eq(brokerOrdersTable.status, "OPEN"),
          ));

        for (const slOrder of slOrders) {
          try {
            await cancelOrder(userId, slOrder.kiteOrderId, "regular");
          } catch {
            // ignore
          }
        }

        const entryPrice = Number(exec.entryPrice ?? 0);
        const realisedPnl = direction === "up"
          ? (exitLimitPrice - entryPrice) * exec.quantity
          : (entryPrice - exitLimitPrice) * exec.quantity;

        await db
          .update(signalExecutionsTable)
          .set({
            status: "closed",
            exitPrice: String(exitLimitPrice),
            realisedPnl: String(realisedPnl.toFixed(2)),
            exitReason: "manual_exit_all",
            closedAt: new Date(),
          })
          .where(eq(signalExecutionsTable.id, exec.id));

        results.push({ execId: exec.id, symbol: exec.assetSymbol, success: true });
      } catch (err) {
        results.push({ execId: exec.id, symbol: exec.assetSymbol, success: false, error: err instanceof Error ? err.message : "Failed" });
      }
    }

    // Broadcast updated executions via WebSocket
    void broadcastUserExecutions(userId);

    const succeeded = results.filter((r) => r.success).length;
    logger.info({ userId, total: openExecs.length, succeeded }, "trading: exit-all completed");

    res.json({
      success: true,
      exited: succeeded,
      total: openExecs.length,
      results,
    });
  } catch (err) {
    logger.error({ err }, "trading: exit-all failed");
    res.status(500).json({ error: err instanceof Error ? err.message : "Exit all failed" });
  }
});

export default router;

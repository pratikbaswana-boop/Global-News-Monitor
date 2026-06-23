import { Router } from "express";
import { logger } from "../lib/logger.js";
import {
  getKiteLoginUrl,
  getKiteApiKey,
} from "../services/kite/kite-client.js";
import {
  exchangeRequestToken,
  saveBrokerAccount,
  disconnectBrokerAccount,
  getBrokerAccountStatus,
  updateAutoTradeSettings,
} from "../services/kite/auth.js";
import { connectTickerForUser } from "../services/kite/websocket.js";
import {
  getUserTradePreferences,
  setTradePreference,
  deleteTradePreference,
  ensureDefaultPreferences,
  TRADEABLE_ASSETS,
} from "../services/kite/trade-preferences.js";

const router = Router();

// GET /broker/login-url — Return Kite Connect OAuth URL
router.get("/broker/login-url", (_req, res) => {
  try {
    const url = getKiteLoginUrl();
    res.json({ loginUrl: url, apiKey: getKiteApiKey() });
  } catch (err) {
    logger.error({ err }, "broker login-url failed");
    res.status(500).json({ error: "Kite API not configured" });
  }
});

// POST /broker/callback — Exchange request token for session
router.post("/broker/callback", async (req, res) => {
  try {
    const { requestToken, userId } = req.body;

    if (!requestToken || !userId) {
      res.status(400).json({ error: "requestToken and userId are required" });
      return;
    }

    const session = await exchangeRequestToken(requestToken);
    const apiKey = getKiteApiKey();
    const accountId = await saveBrokerAccount(userId, session, apiKey);

    // Connect WebSocket for real-time order updates
    void connectTickerForUser(userId);

    res.json({
      success: true,
      accountId,
      kiteUserId: session.userId,
      userName: session.userName,
      exchanges: session.exchanges,
      products: session.products,
    });
  } catch (err) {
    logger.error({ err }, "broker callback failed");
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to exchange request token",
    });
  }
});

// POST /broker/disconnect — Disconnect broker account
router.post("/broker/disconnect", async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) {
      res.status(400).json({ error: "userId is required" });
      return;
    }

    await disconnectBrokerAccount(userId);
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "broker disconnect failed");
    res.status(500).json({ error: "Failed to disconnect broker" });
  }
});

// GET /broker/status — Check broker connection status
router.get("/broker/status", async (req, res) => {
  try {
    const userId = req.query.userId as string;
    if (!userId) {
      res.status(400).json({ error: "userId query param is required" });
      return;
    }

    const status = await getBrokerAccountStatus(userId);
    res.json(status);
  } catch (err) {
    logger.error({ err }, "broker status failed");
    res.status(500).json({ error: "Failed to get broker status" });
  }
});

// POST /broker/settings — Update auto-trade settings
router.post("/broker/settings", async (req, res) => {
  try {
    const { userId, autoTradeEnabled, maxRiskPerTradePct, defaultProduct, defaultOrderType } = req.body;
    if (!userId) {
      res.status(400).json({ error: "userId is required" });
      return;
    }

    await updateAutoTradeSettings(userId, {
      autoTradeEnabled,
      maxRiskPerTradePct,
      defaultProduct,
      defaultOrderType,
    });

    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "broker settings update failed");
    res.status(500).json({ error: "Failed to update settings" });
  }
});

// ── Trade Preferences ────────────────────────────────────────────────────────

// GET /broker/trade-preferences — List user's trade preferences for all assets
router.get("/broker/trade-preferences", async (req, res) => {
  try {
    const userId = req.query.userId as string;
    if (!userId) {
      res.status(400).json({ error: "userId query param is required" });
      return;
    }

    // Ensure defaults exist so the user always sees all assets
    await ensureDefaultPreferences(userId);

    const prefs = await getUserTradePreferences(userId);
    res.json({
      assets: TRADEABLE_ASSETS,
      preferences: prefs,
    });
  } catch (err) {
    logger.error({ err }, "broker trade-preferences get failed");
    res.status(500).json({ error: "Failed to fetch trade preferences" });
  }
});

// POST /broker/trade-preferences — Set preference for an asset
router.post("/broker/trade-preferences", async (req, res) => {
  try {
    const {
      userId,
      assetId,
      enabled,
      maxRiskPerTradePct,
      defaultProduct,
      defaultOrderType,
      customQuantity,
      targetPct,
      stopLossPct,
      useGttBracket,
      minConfidence,
      onlyIntraday,
    } = req.body;

    if (!userId || !assetId) {
      res.status(400).json({ error: "userId and assetId are required" });
      return;
    }

    await setTradePreference(userId, assetId, {
      enabled,
      maxRiskPerTradePct,
      defaultProduct,
      defaultOrderType,
      customQuantity,
      targetPct,
      stopLossPct,
      useGttBracket,
      minConfidence,
      onlyIntraday,
    });

    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "broker trade-preferences set failed");
    res.status(500).json({ error: "Failed to set trade preference" });
  }
});

// DELETE /broker/trade-preferences/:assetId — Remove preference (reset to defaults)
router.delete("/broker/trade-preferences/:assetId", async (req, res) => {
  try {
    const userId = req.query.userId as string;
    const { assetId } = req.params;

    if (!userId) {
      res.status(400).json({ error: "userId query param is required" });
      return;
    }

    await deleteTradePreference(userId, assetId);
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "broker trade-preferences delete failed");
    res.status(500).json({ error: "Failed to delete trade preference" });
  }
});

export default router;

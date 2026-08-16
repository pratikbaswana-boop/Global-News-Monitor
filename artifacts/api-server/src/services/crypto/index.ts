// Crypto module index — orchestrates all crypto trading components.
//
// This is the entry point for the crypto trading system. It starts:
//   1. Binance WebSocket feed (order book + trades + funding + liquidations)
//   2. Order book feed normalizer (computes OFI, spread, depth features)
//   3. Crypto signal engine (fuses microstructure + news signals)
//   4. Crypto HMM regime detector (market regime classification)
//   5. Position manager (trailing stops, take profit, exit management)
//
// The crypto module is completely independent of the NSE/Kite system.
// It can be enabled/disabled via the CRYPTO_TRADING_ENABLED env var.

import { logger } from "../../lib/logger.js";
import { startBinanceWs, stopBinanceWs } from "./exchanges/binance-ws.js";
import { startOrderBookFeed } from "./feeds/orderbook-feed.js";
import { startCryptoSignalEngine } from "./signals/crypto-signal-engine.js";
import { startCryptoRegimeDetector, stopCryptoRegimeDetector } from "./regime/crypto-hmm.js";
import { startPositionManager } from "./execution/position-manager.js";
import { isBinanceConfigured } from "./exchanges/binance-rest.js";
import { onSignal, publish } from "./event-bus.js";
import { computePositionSize, buildOrderRequest, canOpenPosition, recordDataEvent } from "./risk/crypto-risk-engine.js";
import { openPosition } from "./execution/position-manager.js";
import { placeCryptoOrder } from "./exchanges/binance-rest.js";
import { startMacroFeatureFetcher, stopMacroFeatureFetcher } from "./feeds/macro-fetcher.js";
import { startNewsBiasBridge, stopNewsBiasBridge } from "./feeds/news-bias-bridge.js";
import { startCryptoBroadcaster } from "./crypto-ws-broadcaster.js";
import type { CryptoSignal } from "./types.js";

const CRYPTO_ENABLED = process.env["CRYPTO_TRADING_ENABLED"] === "true";
const CRYPTO_PAPER_MODE = process.env["CRYPTO_PAPER_MODE"] !== "false"; // default: paper mode

let started = false;

// ── Signal → Execution bridge ─────────────────────────────────────────────────
// When a signal is emitted, the risk engine evaluates whether to trade.
// In paper mode, we just record the position. In live mode, we place the order.

async function handleSignal(signal: CryptoSignal): Promise<void> {
  recordDataEvent();

  if (signal.direction === "NO_TRADE") return;
  if (!canOpenPosition()) return;

  // Get total capital (in production, fetch from exchange balance)
  const totalCapital = parseFloat(process.env["CRYPTO_CAPITAL_USDT"] ?? "10000");

  const sizing = computePositionSize(signal, totalCapital, signal.suggestedEntryPrice ?? 0);
  if (!sizing) return;

  const orderReq = buildOrderRequest(signal, sizing.quantity, sizing.leverage);
  if (!orderReq) return;

  if (CRYPTO_PAPER_MODE) {
    // Paper trade — just open a virtual position
    openPosition(signal, sizing.quantity, signal.suggestedEntryPrice ?? 0);
    logger.info({
      symbol: signal.symbol,
      direction: signal.direction,
      mode: "PAPER",
    }, "crypto-index: paper trade opened");
  } else {
    // Live trade — place order on exchange
    try {
      const userId = process.env["CRYPTO_USER_ID"] ?? "crypto-default";
      const response = await placeCryptoOrder(userId, orderReq);
      if (response.status === "FILLED" || response.status === "NEW") {
        openPosition(signal, sizing.quantity, signal.suggestedEntryPrice ?? 0);
      }
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : err, symbol: signal.symbol }, "crypto-index: order placement failed");
    }
  }
}

export async function startCryptoModule(): Promise<boolean> {
  if (started) return true;
  if (!CRYPTO_ENABLED) {
    logger.info("crypto-index: CRYPTO_TRADING_ENABLED not set — crypto module skipped");
    return false;
  }

  logger.info({
    paperMode: CRYPTO_PAPER_MODE,
    binanceConfigured: isBinanceConfigured(),
  }, "crypto-index: starting crypto module");

  // 1. Start order book feed normalizer (subscribes to events)
  startOrderBookFeed();

  // 2. Start signal engine (subscribes to book features + funding + liquidations)
  startCryptoSignalEngine();

  // 3. Start HMM regime detector
  startCryptoRegimeDetector();

  // 4. Start macro feature fetcher (feeds DXY/BTC dominance/vol to HMM)
  startMacroFeatureFetcher();

  // 5. Start news bias bridge (GPT-4o sentiment → setNewsBias)
  startNewsBiasBridge();

  // 6. Start position manager (subscribes to book ticker for trailing stops)
  startPositionManager();

  // 7. Start WS broadcaster (pushes signals/positions to UI)
  startCryptoBroadcaster();

  // 8. Wire signal → execution bridge
  onSignal(handleSignal);

  // 9. Start Binance WebSocket feed (last — so all subscribers are ready)
  const wsStarted = await startBinanceWs({ marketType: "spot" });
  if (!wsStarted) {
    logger.warn("crypto-index: Binance WS failed to start — crypto module running without live data");
  }

  started = true;
  logger.info("crypto-index: crypto module started successfully");
  return true;
}

export function stopCryptoModule(): void {
  if (!started) return;
  stopBinanceWs();
  stopCryptoRegimeDetector();
  stopMacroFeatureFetcher();
  stopNewsBiasBridge();
  started = false;
  logger.info("crypto-index: crypto module stopped");
}

export function isCryptoStarted(): boolean {
  return started;
}

export function isCryptoEnabled(): boolean {
  return CRYPTO_ENABLED;
}

export function isPaperMode(): boolean {
  return CRYPTO_PAPER_MODE;
}

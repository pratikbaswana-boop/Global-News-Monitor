// Crypto WS broadcaster — pushes crypto signals, positions, and regime updates
// to connected UI clients via the existing ws-hub.
//
// Subscribes to the crypto event bus and forwards relevant events to the UI
// through the "crypto" WebSocket channel.

import { logger } from "../../lib/logger.js";
import { broadcastCrypto } from "../../lib/ws-hub.js";
import { onSignal, onRegime, onPositionUpdate, onOrderUpdate } from "./event-bus.js";
import type { CryptoSignal, CryptoRegimeState, CryptoPosition, CryptoOrderResponse } from "./types.js";

let started = false;

function handleSignal(signal: CryptoSignal): void {
  if (signal.direction === "NO_TRADE") return;
  broadcastCrypto({
    type: "signal",
    symbol: signal.symbol,
    assetId: signal.assetId,
    direction: signal.direction,
    confidence: signal.confidence,
    reason: signal.reason,
    entryPrice: signal.suggestedEntryPrice,
    stopLoss: signal.suggestedStopLoss,
    takeProfit: signal.suggestedTakeProfit,
    components: signal.components,
    timestamp: signal.timestamp,
  });
}

function handleRegime(regime: CryptoRegimeState): void {
  broadcastCrypto({
    type: "regime",
    regime: regime.regime,
    confidence: regime.confidence,
    btcDominance: regime.btcDominance,
    realizedVol: regime.realizedVol,
    dxy: regime.dxy,
    fundingRateAvg: regime.fundingRateAvg,
    timestamp: regime.timestamp,
  });
}

function handlePositionUpdate(pos: CryptoPosition): void {
  broadcastCrypto({
    type: "position",
    symbol: pos.symbol,
    side: pos.side,
    quantity: pos.quantity,
    entryPrice: pos.entryPrice,
    markPrice: pos.markPrice,
    unrealizedPnl: pos.unrealizedPnl,
    timestamp: pos.timestamp,
  });
}

function handleOrderUpdate(order: CryptoOrderResponse): void {
  broadcastCrypto({
    type: "order",
    orderId: order.orderId,
    symbol: order.symbol,
    side: order.side,
    status: order.status,
    executedQty: order.executedQty,
    avgPrice: order.avgPrice,
    timestamp: order.timestamp,
  });
}

export function startCryptoBroadcaster(): boolean {
  if (started) return true;
  started = true;

  onSignal(handleSignal);
  onRegime(handleRegime);
  onPositionUpdate(handlePositionUpdate);
  onOrderUpdate(handleOrderUpdate);

  logger.info("crypto-broadcaster: started");
  return true;
}

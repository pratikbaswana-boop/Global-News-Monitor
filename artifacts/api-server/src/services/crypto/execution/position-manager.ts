// Crypto position manager — trailing stop, take profit, and exit management.
//
// Adapted from the existing kite/position-monitor.ts but generalized for crypto.
// Key differences from NSE version:
//   - No EOD squareoff (crypto is 24/7)
//   - No IST trading hours checks
//   - Trailing ratchet works on tick-level price updates (not 5s poll)
//   - Stop loss and take profit are managed client-side (not exchange-side SL-M)
//     because crypto exchanges support STOP_MARKET orders but we want tighter control

import { logger } from "../../../lib/logger.js";
import { onBookTicker, onSignal } from "../event-bus.js";
import type { BookTicker, CryptoSignal, CryptoPosition } from "../types.js";
import { recordPnl, incrementOpenPositions, decrementOpenPositions, isKillSwitchActive } from "../risk/crypto-risk-engine.js";

interface ManagedPosition {
  symbol: string;
  assetId: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  quantity: number;
  stopLoss: number;
  takeProfit: number;
  trailingHigh: number;  // highest price since entry (for longs) / lowest (for shorts)
  trailingStopPct: number;
  openedAt: number;
  signalId: string;
}

const positions = new Map<string, ManagedPosition>();
const TRAILING_STOP_PCT = 0.005; // 0.5% trailing stop

function handleBookTicker(data: BookTicker): void {
  const pos = positions.get(data.symbol);
  if (!pos) return;

  const currentPrice = (data.bidPrice + data.askPrice) / 2;

  // Update trailing high/low
  if (pos.side === "LONG") {
    if (currentPrice > pos.trailingHigh) {
      pos.trailingHigh = currentPrice;
      // Ratchet up the stop loss
      const newStop = pos.trailingHigh * (1 - pos.trailingStopPct);
      if (newStop > pos.stopLoss) {
        pos.stopLoss = newStop;
        logger.debug({ symbol: pos.symbol, newStop: newStop.toFixed(2), trailingHigh: pos.trailingHigh.toFixed(2) }, "crypto-position-manager: trailing stop ratcheted up");
      }
    }

    // Check stop loss hit
    if (currentPrice <= pos.stopLoss) {
      closePosition(pos, currentPrice, "stop loss hit");
      return;
    }

    // Check take profit hit
    if (currentPrice >= pos.takeProfit) {
      closePosition(pos, currentPrice, "take profit hit");
      return;
    }
  } else {
    // SHORT
    if (currentPrice < pos.trailingHigh || pos.trailingHigh === 0) {
      pos.trailingHigh = currentPrice;
      const newStop = pos.trailingHigh * (1 + pos.trailingStopPct);
      if (pos.stopLoss === 0 || newStop < pos.stopLoss) {
        pos.stopLoss = newStop;
        logger.debug({ symbol: pos.symbol, newStop: newStop.toFixed(2), trailingLow: pos.trailingHigh.toFixed(2) }, "crypto-position-manager: trailing stop ratcheted down");
      }
    }

    // Check stop loss hit
    if (currentPrice >= pos.stopLoss) {
      closePosition(pos, currentPrice, "stop loss hit");
      return;
    }

    // Check take profit hit
    if (currentPrice <= pos.takeProfit) {
      closePosition(pos, currentPrice, "take profit hit");
      return;
    }
  }
}

function closePosition(pos: ManagedPosition, exitPrice: number, reason: string): void {
  const pnl = pos.side === "LONG"
    ? (exitPrice - pos.entryPrice) * pos.quantity
    : (pos.entryPrice - exitPrice) * pos.quantity;

  positions.delete(pos.symbol);
  decrementOpenPositions();
  recordPnl(pnl);

  logger.info({
    symbol: pos.symbol,
    side: pos.side,
    entryPrice: pos.entryPrice,
    exitPrice,
    pnl: pnl.toFixed(2),
    reason,
    heldFor: ((Date.now() - pos.openedAt) / 1000).toFixed(0) + "s",
  }, "crypto-position-manager: position closed");
}

export function openPosition(
  signal: CryptoSignal,
  quantity: number,
  entryPrice: number,
): ManagedPosition | null {
  if (isKillSwitchActive()) {
    logger.warn("crypto-position-manager: kill switch active — cannot open position");
    return null;
  }
  if (positions.has(signal.symbol)) {
    logger.warn({ symbol: signal.symbol }, "crypto-position-manager: position already open");
    return null;
  }

  const pos: ManagedPosition = {
    symbol: signal.symbol,
    assetId: signal.assetId,
    side: signal.direction === "LONG" ? "LONG" : "SHORT",
    entryPrice,
    quantity,
    stopLoss: signal.suggestedStopLoss ?? entryPrice * (1 - TRAILING_STOP_PCT),
    takeProfit: signal.suggestedTakeProfit ?? entryPrice * (1 + TRAILING_STOP_PCT * 3),
    trailingHigh: entryPrice,
    trailingStopPct: TRAILING_STOP_PCT,
    openedAt: Date.now(),
    signalId: `${signal.assetId}-${signal.timestamp}`,
  };

  positions.set(signal.symbol, pos);
  incrementOpenPositions();

  logger.info({
    symbol: pos.symbol,
    side: pos.side,
    entryPrice: pos.entryPrice,
    stopLoss: pos.stopLoss,
    takeProfit: pos.takeProfit,
    quantity,
  }, "crypto-position-manager: position opened");

  return pos;
}

export function getOpenPositions(): ManagedPosition[] {
  return [...positions.values()];
}

export function getManagedPosition(symbol: string): ManagedPosition | undefined {
  return positions.get(symbol);
}

export function startPositionManager(): boolean {
  onBookTicker(handleBookTicker);
  logger.info({ trailingStopPct: TRAILING_STOP_PCT }, "crypto-position-manager: started");
  return true;
}

// Crypto risk engine — position sizing, leverage control, daily drawdown limits.
//
// Enforces conservative risk limits before any crypto order is placed.
// All limits are configurable via environment variables with safe defaults.

import { logger } from "../../../lib/logger.js";
import type { CryptoSignal, CryptoOrderRequest } from "../types.js";

const MAX_POSITION_PCT = parseFloat(process.env["CRYPTO_MAX_POSITION_PCT"] ?? "5") / 100;
const MAX_LEVERAGE = parseInt(process.env["CRYPTO_MAX_LEVERAGE"] ?? "3", 10);
const MAX_DAILY_DRAWDOWN_PCT = parseFloat(process.env["CRYPTO_MAX_DRAWDOWN_PCT"] ?? "3") / 100;
const MAX_CONCURRENT_POSITIONS = parseInt(process.env["CRYPTO_MAX_CONCURRENT"] ?? "3", 10);
const KILL_SWITCH_TIMEOUT_MS = 30000; // halt if no data for 30s

let dailyPnl = 0;
let dailyPnlResetAt = Date.now();
let openPositionCount = 0;
let killSwitchActive = false;
let lastDataAt = Date.now();

export function resetDailyPnlIfNeeded(): void {
  const now = Date.now();
  if (now - dailyPnlResetAt > 24 * 60 * 60 * 1000) {
    dailyPnl = 0;
    dailyPnlResetAt = now;
    logger.info("crypto-risk: daily PnL reset");
  }
}

export function recordPnl(pnl: number): void {
  resetDailyPnlIfNeeded();
  dailyPnl += pnl;
  if (dailyPnl <= -MAX_DAILY_DRAWDOWN_PCT) {
    logger.error({ dailyPnl, limit: -MAX_DAILY_DRAWDOWN_PCT }, "crypto-risk: daily drawdown limit hit — kill switch activated");
    killSwitchActive = true;
  }
}

export function recordDataEvent(): void {
  lastDataAt = Date.now();
  if (killSwitchActive && Date.now() - lastDataAt < KILL_SWITCH_TIMEOUT_MS) {
    // Don't auto-reset — requires manual intervention
  }
}

export function isKillSwitchActive(): boolean {
  if (Date.now() - lastDataAt > KILL_SWITCH_TIMEOUT_MS) {
    if (!killSwitchActive) {
      logger.error("crypto-risk: data feed stall detected — kill switch activated");
      killSwitchActive = true;
    }
  }
  return killSwitchActive;
}

export function resetKillSwitch(): void {
  killSwitchActive = false;
  lastDataAt = Date.now();
  logger.info("crypto-risk: kill switch reset");
}

export function canOpenPosition(): boolean {
  if (isKillSwitchActive()) return false;
  resetDailyPnlIfNeeded();
  if (dailyPnl <= -MAX_DAILY_DRAWDOWN_PCT) return false;
  if (openPositionCount >= MAX_CONCURRENT_POSITIONS) return false;
  return true;
}

export function incrementOpenPositions(): void {
  openPositionCount++;
}

export function decrementOpenPositions(): void {
  openPositionCount = Math.max(0, openPositionCount - 1);
}

export function computePositionSize(
  signal: CryptoSignal,
  totalCapital: number,
  currentPrice: number,
): { quantity: number; leverage: number } | null {
  if (!canOpenPosition()) return null;
  if (!signal.suggestedEntryPrice) return null;

  // Base position size as percentage of capital
  const baseNotional = totalCapital * MAX_POSITION_PCT;

  // Scale by confidence (0.5x at threshold, 1.5x at high confidence)
  const confidenceMultiplier = 0.5 + signal.confidence * 1.0;
  const notional = baseNotional * confidenceMultiplier;

  // Leverage: start at 1x, scale up with confidence (capped at MAX_LEVERAGE)
  const leverage = Math.min(
    MAX_LEVERAGE,
    Math.max(1, Math.floor(1 + signal.confidence * (MAX_LEVERAGE - 1))),
  );

  // Quantity = notional / price (with leverage applied)
  const quantity = notional * leverage / currentPrice;

  logger.info({
    symbol: signal.symbol,
    direction: signal.direction,
    confidence: signal.confidence.toFixed(2),
    notional: notional.toFixed(2),
    leverage,
    quantity: quantity.toFixed(6),
    capital: totalCapital,
  }, "crypto-risk: position sized");

  return { quantity, leverage };
}

export function buildOrderRequest(
  signal: CryptoSignal,
  quantity: number,
  leverage: number,
): CryptoOrderRequest | null {
  if (signal.direction === "NO_TRADE") return null;
  if (!signal.suggestedEntryPrice) return null;

  const side = signal.direction === "LONG" ? "BUY" : "SELL";

  return {
    symbol: signal.symbol,
    side,
    type: "LIMIT",
    quantity,
    price: signal.suggestedEntryPrice,
    timeInForce: "GTX", // maker-only (post-only)
    clientOrderId: `gnm-${signal.assetId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    leverage,
    reduceOnly: false,
  };
}

export function getRiskStatus(): {
  killSwitch: boolean;
  dailyPnl: number;
  openPositions: number;
  maxDrawdown: number;
  maxConcurrent: number;
} {
  return {
    killSwitch: killSwitchActive,
    dailyPnl,
    openPositions: openPositionCount,
    maxDrawdown: MAX_DAILY_DRAWDOWN_PCT,
    maxConcurrent: MAX_CONCURRENT_POSITIONS,
  };
}

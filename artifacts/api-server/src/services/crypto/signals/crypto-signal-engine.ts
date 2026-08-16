// Crypto signal engine — fuses microstructure signals with news intelligence.
//
// This is the crypto-native replacement for tier3-signal.ts. Instead of option
// chain OI/IV/gamma, it uses:
//   - Order Flow Imbalance (OFI) from the order book feed
//   - Momentum (5/30/60-min EMA) — reuses the direction EMA concept from tier3
//   - Funding rate bias (perps) — replaces PCR as sentiment
//   - Liquidation pressure — crypto-unique
//   - News bias — from the existing news intelligence pipeline
//
// Fusion logic: microstructure and news must agree for high-confidence trades.
// When they disagree → NO_TRADE. When they agree → high conviction.
//
// Research basis:
//   - OFI is the most consistent predictor across crypto assets (Frontiers 2026)
//   - Momentum (5/30/60-min) is statistically significant at minute frequency
//   - Maker-only execution is mandatory — taker fees kill the edge

import { logger } from "../../../lib/logger.js";
import { onBookFeatures, type BookFeatureSnapshot } from "../feeds/orderbook-feed.js";
import { onFunding, onLiquidation } from "../event-bus.js";
import { publish } from "../event-bus.js";
import type {
  CryptoSignal,
  CryptoSignalDirection,
  FundingRate,
  LiquidationEvent,
  CryptoRegime,
} from "../types.js";
import { ACTIVE_CRYPTO_ASSETS, CRYPTO_BY_SYMBOL } from "../universe.js";

// ── Config ────────────────────────────────────────────────────────────────────

const SIGNAL_INTERVAL_MS = 5000;    // compute signals every 5s per symbol
const MOMENTUM_SHORT_MS = 5 * 60 * 1000;   // 5 min
const MOMENTUM_MED_MS = 30 * 60 * 1000;    // 30 min
const MOMENTUM_LONG_MS = 60 * 60 * 1000;   // 60 min
const PRICE_BUFFER_SIZE = 500;             // rolling price history per symbol

const OFI_WEIGHT = 0.30;
const MOMENTUM_WEIGHT = 0.25;
const FUNDING_WEIGHT = 0.10;
const LIQUIDATION_WEIGHT = 0.10;
const NEWS_WEIGHT = 0.15;
const REGIME_WEIGHT = 0.10;

const CONFIDENCE_THRESHOLD = 0.45;  // minimum fused score to emit a trade signal
const DEADZONE = 0.08;              // below this → NO_TRADE (noise filter)

// ── Per-symbol state ──────────────────────────────────────────────────────────

interface SymbolState {
  symbol: string;
  assetId: string;
  prices: { price: number; ts: number }[];
  lastFunding: FundingRate | null;
  liquidationVolume: { buy: number; sell: number; ts: number };
  lastSignalAt: number;
  newsBias: number;  // set externally by news fusion gate
}

const states = new Map<string, SymbolState>();
let currentRegime: CryptoRegime = "unknown";
let regimeConfidence = 0;

// ── Momentum computation (reuses direction EMA concept from tier3-signal.ts) ──

function computeMomentum(prices: { price: number; ts: number }[], now: number): number {
  if (prices.length < 10) return 0;

  // Short-term EMA (5 min)
  const shortPrices = prices.filter((p) => p.ts > now - MOMENTUM_SHORT_MS);
  // Medium-term EMA (30 min)
  const medPrices = prices.filter((p) => p.ts > now - MOMENTUM_MED_MS);
  // Long-term EMA (60 min)
  const longPrices = prices.filter((p) => p.ts > now - MOMENTUM_LONG_MS);

  if (shortPrices.length < 3 || medPrices.length < 5) return 0;

  const shortEma = computeEma(shortPrices.map((p) => p.price));
  const medEma = computeEma(medPrices.map((p) => p.price));
  const longEma = longPrices.length >= 5 ? computeEma(longPrices.map((p) => p.price)) : medEma;

  // Direction: short EMA above long EMA → bullish, below → bearish
  // Scale by realized volatility to normalize across assets
  const rets = computeReturns(prices.map((p) => p.price));
  const realizedVol = stdDev(rets) || 1;
  const rawScore = (shortEma - longEma) / longEma;
  const volScaled = rawScore / (realizedVol * Math.sqrt(1440)); // daily vol scaling

  // Blend: 50% short-vs-long, 30% short-vs-med, 20% med-vs-long
  const blend = 0.5 * clamp(volScaled, -1, 1) +
                0.3 * clamp((shortEma - medEma) / medEma / (realizedVol || 1), -1, 1) +
                0.2 * clamp((medEma - longEma) / longEma / (realizedVol || 1), -1, 1);

  return clamp(blend, -1, 1);
}

function computeEma(values: number[]): number {
  if (values.length === 0) return 0;
  const k = 2 / (values.length + 1);
  let ema = values[0]!;
  for (let i = 1; i < values.length; i++) {
    ema = values[i]! * k + ema * (1 - k);
  }
  return ema;
}

function computeReturns(prices: number[]): number[] {
  const rets: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1]! > 0) {
      rets.push(Math.log(prices[i]! / prices[i - 1]!));
    }
  }
  return rets;
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

// ── Funding rate signal ───────────────────────────────────────────────────────

function computeFundingBias(funding: FundingRate | null): number {
  if (!funding) return 0;
  // Positive funding (longs pay shorts) → contrarian bearish bias
  // Negative funding (shorts pay longs) → contrarian bullish bias
  // Scale: 0.01% per 8h = neutral, 0.1%+ = extreme
  const rate = funding.fundingRate;
  const scaled = clamp(-rate * 1000, -1, 1); // invert: high positive funding → bearish
  return scaled;
}

// ── Liquidation pressure ──────────────────────────────────────────────────────

function computeLiquidationPressure(state: SymbolState, now: number): number {
  // Prune old liquidations (older than 5 min)
  const cutoff = now - 5 * 60 * 1000;
  if (state.liquidationVolume.ts < cutoff) {
    state.liquidationVolume = { buy: 0, sell: 0, ts: now };
  }

  const total = state.liquidationVolume.buy + state.liquidationVolume.sell;
  if (total === 0) return 0;

  // BUY liquidations = longs getting liquidated → bearish
  // SELL liquidations = shorts getting liquidated → bullish
  return clamp((state.liquidationVolume.sell - state.liquidationVolume.buy) / total, -1, 1);
}

// ── Regime adjustment ─────────────────────────────────────────────────────────

function regimeAdjustment(score: number): number {
  // In trending regimes, amplify momentum signals
  // In ranging regime, dampen them (mean-reversion more likely)
  // In volatile regime, reduce confidence (risk-off)
  switch (currentRegime) {
    case "trending_bull":
      return score * 1.2;
    case "trending_bear":
      return score * 1.2;
    case "ranging":
      return score * 0.6;
    case "volatile":
      return score * 0.4;
    default:
      return score;
  }
}

// ── Signal computation ────────────────────────────────────────────────────────

function computeSignal(state: SymbolState, features: BookFeatureSnapshot): CryptoSignal {
  const now = Date.now();
  const momentum = computeMomentum(state.prices, now);
  const fundingBias = computeFundingBias(state.lastFunding);
  const liquidationPressure = computeLiquidationPressure(state, now);
  const newsBias = state.newsBias;
  const ofi = features.ofi;

  // Weighted fusion
  let fusedScore =
    OFI_WEIGHT * ofi +
    MOMENTUM_WEIGHT * momentum +
    FUNDING_WEIGHT * fundingBias +
    LIQUIDATION_WEIGHT * liquidationPressure +
    NEWS_WEIGHT * newsBias +
    REGIME_WEIGHT * (currentRegime === "trending_bull" ? 0.3 : currentRegime === "trending_bear" ? -0.3 : 0);

  fusedScore = regimeAdjustment(fusedScore);

  // Determine direction
  let direction: CryptoSignalDirection = "NO_TRADE";
  let confidence = Math.abs(fusedScore);
  let reason = "no signal";

  if (Math.abs(fusedScore) < DEADZONE) {
    direction = "NO_TRADE";
    reason = `below deadzone (${fusedScore.toFixed(3)})`;
  } else if (fusedScore > CONFIDENCE_THRESHOLD) {
    direction = "LONG";
    confidence = clamp(fusedScore, 0, 1);
    reason = `fused score ${fusedScore.toFixed(3)} > threshold ${CONFIDENCE_THRESHOLD}`;
  } else if (fusedScore < -CONFIDENCE_THRESHOLD) {
    direction = "SHORT";
    confidence = clamp(-fusedScore, 0, 1);
    reason = `fused score ${fusedScore.toFixed(3)} < -threshold ${CONFIDENCE_THRESHOLD}`;
  } else {
    direction = "NO_TRADE";
    reason = `score ${fusedScore.toFixed(3)} below threshold ${CONFIDENCE_THRESHOLD}`;
  }

  // News-microstructure disagreement check (fusion gate)
  if (direction !== "NO_TRADE" && Math.abs(newsBias) > 0.2) {
    const newsDir = newsBias > 0 ? "LONG" : "SHORT";
    if (newsDir !== direction) {
      direction = "NO_TRADE";
      reason = `fusion gate: news bias (${newsBias.toFixed(2)}) disagrees with microstructure (${fusedScore.toFixed(2)})`;
      confidence = 0;
    }
  }

  // Compute entry/SL/TP from current mid price
  const entryPrice = features.midPrice;
  const slDistance = entryPrice * 0.005; // 0.5% stop loss
  const tpDistance = entryPrice * 0.015; // 1.5% take profit (3:1 RR)

  return {
    symbol: state.symbol,
    assetId: state.assetId,
    direction,
    confidence,
    reason,
    components: {
      ofi,
      momentum,
      fundingBias,
      liquidationPressure,
      newsBias,
      regime: currentRegime,
    },
    suggestedEntryPrice: direction !== "NO_TRADE" ? entryPrice : null,
    suggestedStopLoss: direction === "LONG" ? entryPrice - slDistance :
                       direction === "SHORT" ? entryPrice + slDistance : null,
    suggestedTakeProfit: direction === "LONG" ? entryPrice + tpDistance :
                         direction === "SHORT" ? entryPrice - tpDistance : null,
    timestamp: now,
  };
}

// ── Event handlers ────────────────────────────────────────────────────────────

function handleFeatures(snapshot: BookFeatureSnapshot): void {
  let state = states.get(snapshot.symbol);
  if (!state) return;

  // Add price to rolling buffer
  state.prices.push({ price: snapshot.midPrice, ts: snapshot.timestamp });
  if (state.prices.length > PRICE_BUFFER_SIZE) {
    state.prices.shift();
  }

  // Throttle signal computation
  const now = Date.now();
  if (now - state.lastSignalAt < SIGNAL_INTERVAL_MS) return;
  state.lastSignalAt = now;

  const signal = computeSignal(state, snapshot);
  if (signal.direction !== "NO_TRADE") {
    logger.info({
      symbol: signal.symbol,
      direction: signal.direction,
      confidence: signal.confidence.toFixed(2),
      reason: signal.reason,
    }, "crypto-signal: emitted");
  }

  publish({ type: "signal", data: signal });
}

function handleFunding(data: FundingRate): void {
  const state = states.get(data.symbol);
  if (state) {
    state.lastFunding = data;
  }
}

function handleLiquidation(data: LiquidationEvent): void {
  const state = states.get(data.symbol);
  if (!state) return;
  const now = Date.now();
  // Prune if stale
  if (now - state.liquidationVolume.ts > 5 * 60 * 1000) {
    state.liquidationVolume = { buy: 0, sell: 0, ts: now };
  }
  if (data.side === "BUY") {
    state.liquidationVolume.buy += data.quantity;
  } else {
    state.liquidationVolume.sell += data.quantity;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function startCryptoSignalEngine(): boolean {
  for (const asset of ACTIVE_CRYPTO_ASSETS) {
    states.set(asset.symbol, {
      symbol: asset.symbol,
      assetId: asset.assetId,
      prices: [],
      lastFunding: null,
      liquidationVolume: { buy: 0, sell: 0, ts: 0 },
      lastSignalAt: 0,
      newsBias: 0,
    });
  }

  onBookFeatures(handleFeatures);
  onFunding(handleFunding);
  onLiquidation(handleLiquidation);

  logger.info({ symbols: ACTIVE_CRYPTO_ASSETS.length }, "crypto-signal-engine: started");
  return true;
}

export function setNewsBias(symbol: string, bias: number): void {
  const state = states.get(symbol);
  if (state) {
    state.newsBias = clamp(bias, -1, 1);
  }
}

export function setRegime(regime: CryptoRegime, confidence: number): void {
  currentRegime = regime;
  regimeConfidence = confidence;
  logger.info({ regime, confidence: confidence.toFixed(2) }, "crypto-signal-engine: regime updated");
}

export function getSignalState(symbol: string): SymbolState | undefined {
  return states.get(symbol);
}

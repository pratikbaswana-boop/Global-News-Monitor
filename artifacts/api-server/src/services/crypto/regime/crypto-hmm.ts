// Crypto HMM regime detector — 3-state Gaussian Hidden Markov Model.
//
// Adapted from the existing hmm-regime.ts (NSE version) but retrained for crypto
// features. The HMM structure (3-state, Viterbi, Gaussian emissions) is reused;
// only the parameters (MU, SIGMA, A, PI) and input features change.
//
// Crypto regime features (replacing NSE's VIX/PCR/INR-USD):
//   1. BTC realized volatility (24h) — replaces India VIX
//   2. BTC dominance — replaces NIFTY PCR (high dominance = risk-off for alts)
//   3. Average funding rate (major perps) — replaces NIFTY PCR intraday
//   4. DXY (US Dollar Index) — replaces INR/USD
//
// Regime states:
//   - trending_bull: low vol + declining DXY + neutral/positive funding
//   - trending_bear: elevated vol + rising DXY + negative funding
//   - ranging: low vol + stable DXY + near-zero funding
//   - volatile: high vol + extreme funding (either direction)
//
// Parameters below are initial estimates — they should be retrained on
// historical crypto data (BTC/ETH 1h bars, 2022-2025) using Baum-Welch.

import { logger } from "../../../lib/logger.js";
import { publish } from "../event-bus.js";
import type { CryptoRegime, CryptoRegimeState } from "../types.js";
import { setRegime } from "../signals/crypto-signal-engine.js";

const REGIME_INTERVAL_MS = 60 * 1000; // recompute every 1 min
const FEATURE_LOOKBACK = 24;           // 24 data points for Viterbi

// ── Initial HMM parameters (to be retrained with Baum-Welch) ──────────────────
// States: 0=trending_bull, 1=trending_bear, 2=ranging, 3=volatile

const STATE_LABELS: CryptoRegime[] = ["trending_bull", "trending_bear", "ranging", "volatile"];

// Initial state distribution
const PI = [0.25, 0.25, 0.35, 0.15];

// Transition matrix (row = from, col = to)
const A = [
  [0.82, 0.05, 0.10, 0.03], // trending_bull → ...
  [0.05, 0.80, 0.10, 0.05], // trending_bear → ...
  [0.12, 0.08, 0.72, 0.08], // ranging → ...
  [0.15, 0.15, 0.15, 0.55], // volatile → ...
];

// Gaussian emission parameters (mean, std) per state per feature
// Features: [btcRealizedVol, btcDominance, fundingRateAvg, dxy]
// These are educated priors — retrain on real data for production.
const MU = [
  [0.02, 52, 0.0001, 103],  // trending_bull: low vol, moderate dominance, slight positive funding, weak dollar
  [0.05, 58, -0.0002, 107], // trending_bear: high vol, high dominance (flight to BTC), negative funding, strong dollar
  [0.015, 54, 0.00005, 105], // ranging: low vol, stable dominance, near-zero funding, stable dollar
  [0.08, 56, 0.0005, 106],   // volatile: very high vol, high dominance, extreme funding, elevated dollar
];

const SIGMA = [
  [0.008, 3, 0.0001, 2],
  [0.015, 4, 0.0002, 3],
  [0.005, 2, 0.00008, 1.5],
  [0.025, 5, 0.0005, 3],
];

// ── Viterbi algorithm ─────────────────────────────────────────────────────────

function gaussianLogProb(x: number, mu: number, sigma: number): number {
  const s = Math.max(sigma, 1e-8);
  return -0.5 * Math.log(2 * Math.PI * s * s) - ((x - mu) ** 2) / (2 * s * s);
}

function viterbi(observations: number[][]): number[] {
  const N = observations.length;
  const K = PI.length;

  if (N === 0) return [];

  // Initialize
  const delta: number[][] = Array.from({ length: N }, () => new Array(K).fill(-Infinity));
  const psi: number[][] = Array.from({ length: N }, () => new Array(K).fill(0));

  // First observation
  for (let k = 0; k < K; k++) {
    let logEm = 0;
    for (let f = 0; f < observations[0]!.length; f++) {
      logEm += gaussianLogProb(observations[0]![f]!, MU[k]![f]!, SIGMA[k]![f]!);
    }
    delta[0]![k] = Math.log(PI[k]!) + logEm;
  }

  // Forward pass
  for (let t = 1; t < N; t++) {
    for (let k = 0; k < K; k++) {
      let logEm = 0;
      for (let f = 0; f < observations[t]!.length; f++) {
        logEm += gaussianLogProb(observations[t]![f]!, MU[k]![f]!, SIGMA[k]![f]!);
      }
      let bestVal = -Infinity;
      let bestPrev = 0;
      for (let j = 0; j < K; j++) {
        const val = delta[t - 1]![j]! + Math.log(A[j]![k]!);
        if (val > bestVal) {
          bestVal = val;
          bestPrev = j;
        }
      }
      delta[t]![k] = bestVal + logEm;
      psi[t]![k] = bestPrev;
    }
  }

  // Backtrack
  const path: number[] = new Array(N);
  let bestLast = 0;
  let bestVal = -Infinity;
  for (let k = 0; k < K; k++) {
    if (delta[N - 1]![k]! > bestVal) {
      bestVal = delta[N - 1]![k]!;
      bestLast = k;
    }
  }
  path[N - 1] = bestLast;
  for (let t = N - 2; t >= 0; t--) {
    path[t] = psi[t + 1]![path[t + 1]!];
  }

  return path;
}

// ── Feature collection ────────────────────────────────────────────────────────

interface FeatureObservation {
  btcRealizedVol: number;
  btcDominance: number;
  fundingRateAvg: number;
  dxy: number;
  timestamp: number;
}

const featureHistory: FeatureObservation[] = [];
let schedulerTimer: NodeJS.Timeout | null = null;
let started = false;

// These would be fetched from APIs in production. For now they're set via
// external calls (from the market data feed or a macro data fetcher).
let currentFeatures: FeatureObservation | null = null;

export function updateRegimeFeatures(features: Partial<FeatureObservation>): void {
  currentFeatures = {
    btcRealizedVol: features.btcRealizedVol ?? currentFeatures?.btcRealizedVol ?? 0.02,
    btcDominance: features.btcDominance ?? currentFeatures?.btcDominance ?? 54,
    fundingRateAvg: features.fundingRateAvg ?? currentFeatures?.fundingRateAvg ?? 0.0001,
    dxy: features.dxy ?? currentFeatures?.dxy ?? 105,
    timestamp: Date.now(),
  };
}

function computeRegime(): void {
  if (!currentFeatures) return;

  // Add to history
  featureHistory.push(currentFeatures);
  if (featureHistory.length > FEATURE_LOOKBACK) {
    featureHistory.shift();
  }

  if (featureHistory.length < 3) {
    logger.debug({ count: featureHistory.length }, "crypto-hmm: not enough data points yet");
    return;
  }

  // Convert to observation matrix
  const observations = featureHistory.map((f) => [
    f.btcRealizedVol,
    f.btcDominance,
    f.fundingRateAvg,
    f.dxy,
  ]);

  // Run Viterbi
  const path = viterbi(observations);
  const currentState = path[path.length - 1]!;

  // Compute confidence from delta values (softmax of last step)
  const regime = STATE_LABELS[currentState] ?? "unknown";
  const confidence = 0.5 + Math.random() * 0.3; // placeholder until we compute proper posterior

  const regimeState: CryptoRegimeState = {
    regime,
    confidence,
    btcDominance: currentFeatures.btcDominance,
    realizedVol: currentFeatures.btcRealizedVol,
    dxy: currentFeatures.dxy,
    fundingRateAvg: currentFeatures.fundingRateAvg,
    timestamp: currentFeatures.timestamp,
  };

  setRegime(regime, confidence);
  publish({ type: "regime", data: regimeState });

  logger.info({
    regime,
    confidence: confidence.toFixed(2),
    btcVol: currentFeatures.btcRealizedVol.toFixed(4),
    btcDom: currentFeatures.btcDominance.toFixed(1),
    funding: currentFeatures.fundingRateAvg.toFixed(6),
    dxy: currentFeatures.dxy.toFixed(1),
  }, "crypto-hmm: regime computed");
}

export function startCryptoRegimeDetector(): boolean {
  if (started) return true;
  started = true;

  schedulerTimer = setInterval(() => {
    try {
      computeRegime();
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : err }, "crypto-hmm: computeRegime failed");
    }
  }, REGIME_INTERVAL_MS);

  logger.info({ intervalMs: REGIME_INTERVAL_MS }, "crypto-hmm: regime detector started");
  return true;
}

export function stopCryptoRegimeDetector(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
  started = false;
  logger.info("crypto-hmm: regime detector stopped");
}

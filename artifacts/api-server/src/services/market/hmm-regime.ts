// 3-state Gaussian HMM regime detector for Indian equity markets.
// States: 0=RISK_ON, 1=RISK_OFF, 2=CRISIS
//
// Feature vector (5-dim): [vixLevel, vixChange5d, pcrIntraday, niftyRealVol10d, inrUsdChange5d]
// pcrIntraday replaces the previous fiiNetFlow5d feature because FII cash flow is EOD-only
// and was frozen during market hours — the HMM re-ran Viterbi on identical observations
// every 5 minutes. PCR moves continuously with option chain OI and captures the same
// institutional sentiment in real time.
// Each dimension has independent Gaussian emissions per state.
// Viterbi decodes most likely state sequence; forward algorithm gives P(state | all obs).

export type Regime = "RISK_ON" | "RISK_OFF" | "CRISIS";

export interface RegimeFeatures {
  vixLevel: number;         // India VIX current level (e.g. 14.5)
  vixChange5d: number;      // India VIX 5-day change in points
  pcrIntraday: number;      // NIFTY put/call ratio by OI (live every 5min). <0.8=bullish, >1.2=bearish hedge
  niftyRealVol10d: number;  // NIFTY 10-day realized volatility (annualised %)
  inrUsdChange5d: number;   // INR/USD 5-day % change (positive = INR depreciation)
}

export interface RegimeState {
  regime: Regime;
  probabilities: { RISK_ON: number; RISK_OFF: number; CRISIS: number };
  confidence: number;
  sequenceSummary: string;       // last 10 regimes as "O/F/C" string
  avgLogLikelihood: number;      // average log-likelihood of the trailing window — for drift detection
  driftAlert: boolean;           // true when avg log-likelihood drops below DRIFT_THRESHOLD
}

// ── HMM parameters calibrated for NSE (2010-2024) ─────────────────────────────
// dim order: [vixLevel, vixChange5d, pcrIntraday, niftyRealVol10d, inrUsdChange5d]
// The pcrIntraday column replaces the older fiiNetFlow5d dimension; the other four
// dimensions retain their original NSE-calibrated values. PCR ranges per regime
// are derived from option-chain regularities: complacent calls in RISK_ON,
// protective puts in RISK_OFF, panic puts in CRISIS.

const MU: number[][] = [
  [13.5,  -0.5,  0.85,  11.0,  -0.05],  // RISK_ON:  low VIX, falling, complacent calls (PCR low), low vol, stable INR
  [19.0,   1.5,  1.15,  18.0,   0.25],  // RISK_OFF: elevated VIX, rising, protective puts (PCR elevated), higher vol, INR weak
  [28.0,   5.0,  1.45,  30.0,   1.20],  // CRISIS:   high VIX, spike, panic puts (PCR very high), very high vol, INR crash
];

const SIGMA: number[][] = [
  [3.0,  1.0,  0.15,  3.5,  0.20],  // RISK_ON
  [4.0,  1.5,  0.20,  5.0,  0.35],  // RISK_OFF
  [6.0,  3.0,  0.30,  8.0,  0.80],  // CRISIS
];

// Transition matrix A[i][j] = P(regime_j | regime_i)
const A: number[][] = [
  [0.88, 0.10, 0.02], // from RISK_ON
  [0.08, 0.84, 0.08], // from RISK_OFF
  [0.03, 0.15, 0.82], // from CRISIS
];

// Initial state prior — NSE is in RISK_ON ~55% of the time historically
const PI = [0.55, 0.30, 0.15];

const STATES = 3;
const DIMS = 5;

// ── Emission log-probability: log P(obs | state k) — diagonal Gaussian ────────

function logEmit(obs: number[], state: number): number {
  let logP = 0;
  for (let d = 0; d < DIMS; d++) {
    const mu = MU[state]![d]!;
    const sigma = SIGMA[state]![d]!;
    const z = (obs[d]! - mu) / sigma;
    logP += -0.5 * Math.log(2 * Math.PI) - Math.log(sigma) - 0.5 * z * z;
  }
  return logP;
}

// ── Viterbi algorithm ─────────────────────────────────────────────────────────

function viterbi(observations: number[][]): number[] {
  const T = observations.length;
  const delta: number[][] = Array.from({ length: T }, () => new Array(STATES).fill(-Infinity));
  const psi: number[][] = Array.from({ length: T }, () => new Array(STATES).fill(0));

  for (let k = 0; k < STATES; k++) {
    delta[0]![k] = Math.log(PI[k]!) + logEmit(observations[0]!, k);
  }

  for (let t = 1; t < T; t++) {
    for (let j = 0; j < STATES; j++) {
      let best = -Infinity;
      let bestK = 0;
      for (let k = 0; k < STATES; k++) {
        const v = delta[t - 1]![k]! + Math.log(A[k]![j]!);
        if (v > best) { best = v; bestK = k; }
      }
      delta[t]![j] = best + logEmit(observations[t]!, j);
      psi[t]![j] = bestK;
    }
  }

  const path: number[] = new Array(T).fill(0);
  path[T - 1] = delta[T - 1]!.indexOf(Math.max(...delta[T - 1]!));
  for (let t = T - 2; t >= 0; t--) {
    path[t] = psi[t + 1]![path[t + 1]!]!;
  }
  return path;
}

// ── Forward algorithm — P(state | all observations) ──────────────────────────

function forwardProbabilities(observations: number[][]): number[] {
  let alpha: number[] = PI.map((pi, k) => pi * Math.exp(logEmit(observations[0]!, k)));

  const scale = (arr: number[]) => {
    const s = arr.reduce((a, b) => a + b, 0);
    return s > 0 ? arr.map(v => v / s) : arr;
  };
  alpha = scale(alpha);

  for (let t = 1; t < observations.length; t++) {
    const next: number[] = new Array(STATES).fill(0);
    for (let j = 0; j < STATES; j++) {
      let sum = 0;
      for (let k = 0; k < STATES; k++) sum += alpha[k]! * A[k]![j]!;
      next[j] = sum * Math.exp(logEmit(observations[t]!, j));
    }
    alpha = scale(next);
  }

  return alpha;
}

// ── Drift detection ───────────────────────────────────────────────────────────
// If the trailing-window average log-likelihood drops below this threshold, the
// MU/SIGMA constants no longer describe the current market well — emit an alert.
const DRIFT_THRESHOLD = -12.0;
const DRIFT_WINDOW = 5;

export function checkHMMDrift(logLikelihoods: number[]): { drift: boolean; avg: number } {
  if (logLikelihoods.length < DRIFT_WINDOW) {
    const avg = logLikelihoods.length
      ? logLikelihoods.reduce((a, b) => a + b, 0) / logLikelihoods.length
      : 0;
    return { drift: false, avg };
  }
  const recent = logLikelihoods.slice(-DRIFT_WINDOW);
  const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
  return { drift: avg < DRIFT_THRESHOLD, avg };
}

// ── Public API ─────────────────────────────────────────────────────────────────

const REGIME_LABELS: Regime[] = ["RISK_ON", "RISK_OFF", "CRISIS"];
const LABEL_CHARS = ["O", "F", "C"];

export function detectRegime(features: RegimeFeatures[]): RegimeState {
  if (features.length < 5) {
    return {
      regime: "RISK_OFF",
      probabilities: { RISK_ON: 0.33, RISK_OFF: 0.34, CRISIS: 0.33 },
      confidence: 0.34,
      sequenceSummary: "???",
      avgLogLikelihood: 0,
      driftAlert: false,
    };
  }

  const obs = features.map(f => [f.vixLevel, f.vixChange5d, f.pcrIntraday, f.niftyRealVol10d, f.inrUsdChange5d]);
  const path = viterbi(obs);
  const probs = forwardProbabilities(obs);

  const currentStateIdx = path[path.length - 1]!;
  const regime = REGIME_LABELS[currentStateIdx]!;

  const riskOnP  = Math.round(probs[0]! * 1000) / 1000;
  const riskOffP = Math.round(probs[1]! * 1000) / 1000;
  const crisisP  = Math.round(Math.max(0, 1 - riskOnP - riskOffP) * 1000) / 1000;
  const confidence = Math.max(riskOnP, riskOffP, crisisP);

  const last10 = path.slice(-10).map(k => LABEL_CHARS[k] ?? "?").join("");

  // Trailing-window log-likelihood under the decoded path — used for drift detection.
  const trailing = obs.slice(-DRIFT_WINDOW);
  const pathTail = path.slice(-DRIFT_WINDOW);
  const lls = trailing.map((o, i) => logEmit(o, pathTail[i]!));
  const { drift, avg } = checkHMMDrift(lls);

  return {
    regime,
    probabilities: { RISK_ON: riskOnP, RISK_OFF: riskOffP, CRISIS: crisisP },
    confidence,
    sequenceSummary: last10,
    avgLogLikelihood: avg,
    driftAlert: drift,
  };
}

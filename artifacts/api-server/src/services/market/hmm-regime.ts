// 3-state Gaussian HMM regime detector for Indian equity markets.
// States: 0=bull, 1=sideways, 2=bear
//
// Emission model: N(μ_k, σ_k) per state, calibrated for NSE daily returns.
// Viterbi decodes most likely state sequence; forward algorithm gives P(state | all returns).

export type Regime = "bull" | "sideways" | "bear";

export interface RegimeState {
  regime: Regime;
  probabilities: { bull: number; sideways: number; bear: number };
  confidence: number; // max probability among the three states
  sequenceSummary: string; // last 10 regimes as "B/S/R" string
}

// ── HMM parameters calibrated for NSE (daily % returns, 2010-2024 history) ───

// Emission: μ and σ per state
const MU = [0.28, 0.01, -0.32];   // [bull, sideways, bear]
const SIGMA = [0.65, 0.90, 1.35]; // [bull, sideways, bear]

// Transition matrix A[i][j] = P(state_j | state_i)
const A: number[][] = [
  [0.88, 0.09, 0.03], // from bull
  [0.06, 0.86, 0.08], // from sideways
  [0.04, 0.10, 0.86], // from bear
];

// Initial state distribution (prior — long-term NSE market is slightly bull-biased)
const PI = [0.45, 0.35, 0.20];

const STATES = 3;

function gaussianLogPdf(x: number, mu: number, sigma: number): number {
  const z = (x - mu) / sigma;
  return -0.5 * Math.log(2 * Math.PI) - Math.log(sigma) - 0.5 * z * z;
}

// Emission log-probability: log P(obs | state k)
function logEmit(obs: number, state: number): number {
  return gaussianLogPdf(obs, MU[state]!, SIGMA[state]!);
}

// ── Viterbi algorithm — O(T·K²) ───────────────────────────────────────────────

function viterbi(returns: number[]): number[] {
  const T = returns.length;
  const delta: number[][] = Array.from({ length: T }, () => new Array(STATES).fill(-Infinity));
  const psi: number[][] = Array.from({ length: T }, () => new Array(STATES).fill(0));

  // Initialise
  for (let k = 0; k < STATES; k++) {
    delta[0]![k] = Math.log(PI[k]!) + logEmit(returns[0]!, k);
  }

  // Recursion
  for (let t = 1; t < T; t++) {
    for (let j = 0; j < STATES; j++) {
      let best = -Infinity;
      let bestK = 0;
      for (let k = 0; k < STATES; k++) {
        const v = delta[t - 1]![k]! + Math.log(A[k]![j]!);
        if (v > best) { best = v; bestK = k; }
      }
      delta[t]![j] = best + logEmit(returns[t]!, j);
      psi[t]![j] = bestK;
    }
  }

  // Backtrack
  const path: number[] = new Array(T).fill(0);
  path[T - 1] = delta[T - 1]!.indexOf(Math.max(...delta[T - 1]!));
  for (let t = T - 2; t >= 0; t--) {
    path[t] = psi[t + 1]![path[t + 1]!]!;
  }
  return path;
}

// ── Forward algorithm — P(state | all observations) ──────────────────────────

function forwardProbabilities(returns: number[]): number[] {
  const T = returns.length;
  // alpha[k] = P(o_1..o_t, state_k) — we only need the last column
  let alpha: number[] = PI.map((pi, k) => pi * Math.exp(logEmit(returns[0]!, k)));

  // Scale to prevent underflow
  const scale = (arr: number[]) => {
    const s = arr.reduce((a, b) => a + b, 0);
    return s > 0 ? arr.map(v => v / s) : arr;
  };
  alpha = scale(alpha);

  for (let t = 1; t < T; t++) {
    const nextAlpha: number[] = new Array(STATES).fill(0);
    for (let j = 0; j < STATES; j++) {
      let sum = 0;
      for (let k = 0; k < STATES; k++) sum += alpha[k]! * A[k]![j]!;
      nextAlpha[j] = sum * Math.exp(logEmit(returns[t]!, j));
    }
    alpha = scale(nextAlpha);
  }

  return alpha;
}

// ── Public API ─────────────────────────────────────────────────────────────────

const REGIME_LABELS: Regime[] = ["bull", "sideways", "bear"];

export function detectRegime(returnsPct: number[]): RegimeState {
  if (returnsPct.length < 5) {
    return { regime: "sideways", probabilities: { bull: 0.33, sideways: 0.34, bear: 0.33 }, confidence: 0.34, sequenceSummary: "???" };
  }

  const path = viterbi(returnsPct);
  const probs = forwardProbabilities(returnsPct);

  const currentStateIdx = path[path.length - 1]!;
  const regime = REGIME_LABELS[currentStateIdx]!;

  const bullP = Math.round((probs[0]!) * 1000) / 1000;
  const sidewaysP = Math.round((probs[1]!) * 1000) / 1000;
  const bearP = Math.round(Math.max(0, 1 - bullP - sidewaysP) * 1000) / 1000;
  const confidence = Math.max(bullP, sidewaysP, bearP);

  // Summarise last 10 regime labels as "B/S/R" string
  const labelChar = ["B", "S", "R"];
  const last10 = path.slice(-10).map(k => labelChar[k] ?? "?").join("");

  return {
    regime,
    probabilities: { bull: bullP, sideways: sidewaysP, bear: bearP },
    confidence,
    sequenceSummary: last10,
  };
}

// Tier-3 intraday microstructure signal engine.
//
// Implements the direction-score / power-score / regime-switch formula that turns
// a rolling buffer of 30-second option-chain observations into a BUY_CALL / BUY_PUT /
// no-trade verdict. The engine is self-contained (module-level state, no DB): the
// scheduler feeds it one observation per 30s refresh via recordObservation(), and the
// signal executor reads the latest verdict (persisted on the snapshot's tier3Evidence)
// to GATE the AI-derived option side.
//
// Data cadence: 30s ticks → a 600s direction window is ~20 samples and the 20-min
// power/scale window is ~40 samples. Gamma is not in the NSE feed, so the caller passes
// a Black-Scholes ATM gamma (see bsGamma below); only its ratio to the 20-min average
// matters here.

// ── Tunables (from the spec) ──────────────────────────────────────────────────
const WINDOW_MS = 300_000;        // direction window n = 300s (5min)
const IV_WINDOW_MS = 150_000;     // IV confirmation lookback = 2.5min
const LONG_WINDOW_MS = 600_000;   // 10-min averages / Do scale percentile
const BUFFER_MAX_MS = 750_000;    // keep ~12.5min of ticks
const EMA_SPAN = 5;               // span = window/4 ≈ 5 ticks @ 30s
const READY_FRACTION = 0.5;       // buffer must span ≥ 50% of WINDOW_MS to fire
const DO_SCALE_FALLBACK = 0.02;   // Do normaliser before percentile history warms up
const DO_SCALE_MIN_SAMPLES = 10;  // need this many Do_raw points for a real percentile

const THETA_D = 0.30;
const THETA_P_LOW = 0.30;
const THETA_P_HIGH = 0.55;
const K_FADE = 0.5;
const TAU = 0.18;                 // deadzone

// ── Public types ──────────────────────────────────────────────────────────────

export interface Tier3Observation {
  t: number;            // epoch ms
  price: number;        // underlying spot (NIFTY)
  callOI: number;       // total CE open interest
  putOI: number;        // total PE open interest
  optionVolume: number; // cumulative-for-day total traded volume (CE+PE)
  atmIV: number;        // ATM implied volatility (%, as the feed reports it)
  atmGamma: number;     // Black-Scholes ATM gamma
}

export type IntradayRegime = "fade" | "tilt_on_power" | "aligned" | "warmup";

export interface IntradaySignal {
  signal: "CALL" | "PUT" | "NONE";
  signalRaw: number;
  D: number;
  P: number;
  regime: IntradayRegime;
  tilt: -1 | 0 | 1;
  ready: boolean;
  samples: number;
}

// ── Module state ──────────────────────────────────────────────────────────────

let buf: Tier3Observation[] = [];
let emaD: number | null = null;
let doRawHistory: { t: number; val: number }[] = [];

/** Reset all rolling state (call at session open). */
export function resetSignalState(): void {
  buf = [];
  emaD = null;
  doRawHistory = [];
}

/** Push one observation; drop anything older than the buffer horizon. */
export function recordObservation(obs: Tier3Observation): void {
  buf.push(obs);
  const cutoff = obs.t - BUFFER_MAX_MS;
  while (buf.length && buf[0]!.t < cutoff) buf.shift();
  const histCutoff = obs.t - LONG_WINDOW_MS;
  while (doRawHistory.length && doRawHistory[0]!.t < histCutoff) doRawHistory.shift();
  // eslint-disable-next-line no-console
  console.log(`[tier3-signal] recordObservation: buf.length=${buf.length}, t=${obs.t}, price=${obs.price}, callOI=${obs.callOI}, putOI=${obs.putOI}`);
}

// ── Math helpers ──────────────────────────────────────────────────────────────

function clip(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function sign(v: number): -1 | 0 | 1 {
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** 90th-percentile (linear interpolation) of a numeric array. */
function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = clip(p, 0, 1) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

/** Standard normal pdf φ(x). */
function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Black-Scholes gamma for an ATM-ish option. sigma is a decimal vol (e.g. 0.14),
 * Tyears is time to expiry in years. Exported so the fetcher can compute it where the
 * spot/strike/IV/expiry are available.
 */
export function bsGamma(S: number, K: number, sigma: number, Tyears: number, r = 0.065): number {
  if (S <= 0 || K <= 0 || sigma <= 0 || Tyears <= 0) return 0;
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * Tyears) / (sigma * Math.sqrt(Tyears));
  return normPdf(d1) / (S * sigma * Math.sqrt(Tyears));
}

// ── Buffer lookups ────────────────────────────────────────────────────────────

/** Observation whose timestamp is closest to targetT. */
function nearest(targetT: number): Tier3Observation | null {
  if (buf.length === 0) return null;
  let best = buf[0]!;
  let bestDiff = Math.abs(best.t - targetT);
  for (const o of buf) {
    const d = Math.abs(o.t - targetT);
    if (d < bestDiff) {
      bestDiff = d;
      best = o;
    }
  }
  return best;
}

const WARMUP: IntradaySignal = {
  signal: "NONE", signalRaw: 0, D: 0, P: 0, regime: "warmup", tilt: 0, ready: false, samples: 0,
};

// ── Core formula ──────────────────────────────────────────────────────────────

export function computeIntradaySignal(): IntradaySignal {
  if (buf.length < 3) return { ...WARMUP, samples: buf.length };

  const latest = buf[buf.length - 1]!;
  const prev = buf[buf.length - 2]!;
  const oldest = buf[0]!;

  // Warmup: buffer must cover (most of) the direction window.
  if (latest.t - oldest.t < WINDOW_MS * READY_FRACTION) {
    return { ...WARMUP, samples: buf.length };
  }

  const past = nearest(latest.t - WINDOW_MS);
  if (!past || past.t >= latest.t) return { ...WARMUP, samples: buf.length };

  // ── 1. Direction score D ────────────────────────────────────────────────────
  // Price momentum: log return over the window normalised by realized vol.
  const windowSamples = buf.filter((o) => o.t >= past.t);
  const logRets: number[] = [];
  for (let i = 1; i < windowSamples.length; i++) {
    const a = windowSamples[i - 1]!.price;
    const b = windowSamples[i]!.price;
    if (a > 0 && b > 0) logRets.push(Math.log(b / a));
  }
  const ret = past.price > 0 ? Math.log(latest.price / past.price) : 0;
  const realizedVol = Math.sqrt(logRets.reduce((s, r) => s + r * r, 0));
  const Dp = clip(realizedVol > 0 ? ret / realizedVol : 0, -1, 1);

  // OI positioning, weighted continuously by price direction.
  const priceWeight = Math.tanh(3 * Dp);
  const dCall = latest.callOI - past.callOI;
  const dPut = latest.putOI - past.putOI;
  const totalOI = latest.callOI + latest.putOI;
  const doRaw = totalOI > 0 ? ((dCall - dPut) * priceWeight) / totalOI : 0;

  // Record |doRaw| for the rolling 90th-percentile scale.
  doRawHistory.push({ t: latest.t, val: Math.abs(doRaw) });
  const histVals = doRawHistory.map((h) => h.val);
  const doScale = histVals.length >= DO_SCALE_MIN_SAMPLES
    ? Math.max(percentile(histVals, 0.9), 1e-9)
    : DO_SCALE_FALLBACK;
  const Do = clip(doRaw / doScale, -1, 1);

  const dInst = 0.4 * Dp + 0.6 * Do;
  const alpha = 2 / (EMA_SPAN + 1);
  emaD = emaD === null ? dInst : emaD + alpha * (dInst - emaD);
  const D = emaD;

  // ── 2. Power score P ────────────────────────────────────────────────────────
  const longSamples = buf.filter((o) => o.t >= latest.t - LONG_WINDOW_MS);

  // Per-tick volume velocity (cumulative feed → difference) vs 20-min average velocity.
  const volDeltas: number[] = [];
  const oiDeltas: number[] = [];
  for (let i = 1; i < longSamples.length; i++) {
    const dv = longSamples[i]!.optionVolume - longSamples[i - 1]!.optionVolume;
    if (dv >= 0) volDeltas.push(dv); // ignore day-rollover resets
    const doi = Math.abs(
      (longSamples[i]!.callOI + longSamples[i]!.putOI) -
      (longSamples[i - 1]!.callOI + longSamples[i - 1]!.putOI)
    );
    oiDeltas.push(doi);
  }
  const volNow = Math.max(latest.optionVolume - prev.optionVolume, 0);
  const oiNow = Math.abs((latest.callOI + latest.putOI) - (prev.callOI + prev.putOI));
  const meanVol = mean(volDeltas);
  const meanOi = mean(oiDeltas);
  const meanGamma = mean(longSamples.map((o) => o.atmGamma));

  const Pv = meanVol > 0 ? Math.min(volNow / meanVol, 2) / 2 : 0;
  const Poi = meanOi > 0 ? Math.min(oiNow / meanOi, 2) / 2 : 0;
  const Pg = meanGamma > 0 ? Math.min(latest.atmGamma / meanGamma, 2) / 2 : 0;
  const pRaw = 0.4 * Pv + 0.4 * Poi + 0.2 * Pg;

  // IV confirmation gate (multiplicative).
  const pastIv = nearest(latest.t - IV_WINDOW_MS);
  const ivThen = pastIv?.atmIV ?? 0;
  const deltaIvPct = ivThen > 0 ? latest.atmIV / ivThen - 1 : 0;
  const gate = 0.45 + 0.55 * clip(deltaIvPct / 0.08, 0, 1);

  // OI-skew disagreement check.
  const tilt = sign(dCall - dPut);
  const disagree = tilt !== 0 && sign(D) !== 0 && tilt !== sign(D);
  const P = pRaw * gate * (disagree ? 0.8 : 1);

  // ── 3. Regime switch ────────────────────────────────────────────────────────
  let signalRaw: number;
  let regime: IntradayRegime;
  if (Math.abs(D) > THETA_D && P < THETA_P_LOW) {
    signalRaw = -D * K_FADE;     // fade an unsupported move
    regime = "fade";
  } else if (Math.abs(D) <= THETA_D && P > THETA_P_HIGH) {
    signalRaw = tilt * P;        // ride positioning when power is high but direction flat
    regime = "tilt_on_power";
  } else {
    signalRaw = D * P;           // aligned
    regime = "aligned";
  }

  // ── 4. Deadzone output ──────────────────────────────────────────────────────
  let signal: IntradaySignal["signal"] = "NONE";
  if (signalRaw > TAU) signal = "CALL";
  else if (signalRaw < -TAU) signal = "PUT";

  return { signal, signalRaw, D, P, regime, tilt, ready: true, samples: buf.length };
}

/** Read-only snapshot of buffer depth (diagnostics). */
export function getSignalBufferSize(): number {
  return buf.length;
}

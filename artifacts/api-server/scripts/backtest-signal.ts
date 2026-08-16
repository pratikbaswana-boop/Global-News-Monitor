// Backtest the tier-3 intraday signal engine on historical Kite data.
//
// Usage:
//   npx tsx scripts/backtest-signal.ts --file=scripts/data/nifty-historical-<date>.json
//
// Replays 1-minute observations through recordObservation() + computeIntradaySignal()
// and tracks signal accuracy vs actual price movement.

import * as fs from "fs";
import * as path from "path";

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const fileArg = args.find((a) => a.startsWith("--file="));
const inputFile = fileArg?.split("=")[1];

if (!inputFile || !fs.existsSync(inputFile)) {
  console.error("Usage: npx tsx scripts/backtest-signal.ts --file=scripts/data/nifty-historical-<date>.json");
  process.exit(1);
}

// ── Black-Scholes (for IV computation) ────────────────────────────────────────

function normCdf(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function bsCallPrice(S: number, K: number, sigma: number, T: number, r = 0.065): number {
  if (T <= 0 || sigma <= 0) return Math.max(S - K, 0);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
}

function bsGamma(S: number, K: number, sigma: number, T: number, r = 0.065): number {
  if (S <= 0 || K <= 0 || sigma <= 0 || T <= 0) return 0;
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  return normPdf(d1) / (S * sigma * Math.sqrt(T));
}

function solveIV(marketPrice: number, S: number, K: number, T: number, r = 0.065, isCall = true): number {
  if (marketPrice <= 0 || T <= 0) return 0;
  let sigma = 0.2;
  for (let i = 0; i < 50; i++) {
    const price = isCall ? bsCallPrice(S, K, sigma, T, r) : bsCallPrice(S, K, sigma, T, r) - S + K * Math.exp(-r * T);
    const diff = price - marketPrice;
    if (Math.abs(diff) < 1e-4) return sigma;
    const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
    const vega = S * Math.sqrt(T) * normPdf(d1);
    if (vega < 1e-8) break;
    sigma = Math.max(0.01, Math.min(5.0, sigma - diff / vega));
  }
  return sigma;
}

// ── Signal engine (inlined to avoid import issues) ────────────────────────────

const WINDOW_MS = 300_000;
const IV_WINDOW_MS = 150_000;
const LONG_WINDOW_MS = 600_000;
const BUFFER_MAX_MS = 750_000;
const EMA_SPAN = 30;
const READY_FRACTION = 0.5;
const DO_SCALE_FALLBACK = 0.02;
const DO_SCALE_MIN_SAMPLES = 10;
const THETA_D = 0.15;
const THETA_P_LOW = 0.20;
const THETA_P_HIGH = 0.40;
const K_FADE = 0.5;
const TAU = 0.05;

interface Tier3Observation {
  t: number;
  price: number;
  callOI: number;
  putOI: number;
  optionVolume: number;
  atmIV: number;
  atmGamma: number;
}

interface IntradaySignal {
  signal: "CALL" | "PUT" | "NONE";
  signalRaw: number;
  D: number;
  P: number;
  regime: string;
  tilt: number;
  ready: boolean;
  samples: number;
}

let buf: Tier3Observation[] = [];
let emaD: number | null = null;
let doRawHistory: { t: number; val: number }[] = [];

function resetSignalState(): void {
  buf = [];
  emaD = null;
  doRawHistory = [];
}

function clip(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function sign(v: number): number {
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = clip(p, 0, 1) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

function nearest(targetT: number): Tier3Observation | null {
  if (buf.length === 0) return null;
  let best = buf[0]!;
  let bestDiff = Math.abs(best.t - targetT);
  for (const o of buf) {
    const d = Math.abs(o.t - targetT);
    if (d < bestDiff) { bestDiff = d; best = o; }
  }
  return best;
}

function recordObservation(obs: Tier3Observation): void {
  buf.push(obs);
  const cutoff = obs.t - BUFFER_MAX_MS;
  while (buf.length && buf[0]!.t < cutoff) buf.shift();
  const histCutoff = obs.t - LONG_WINDOW_MS;
  while (doRawHistory.length && doRawHistory[0]!.t < histCutoff) doRawHistory.shift();
}

function computeIntradaySignal(): IntradaySignal {
  if (buf.length < 3) return { signal: "NONE", signalRaw: 0, D: 0, P: 0, regime: "warmup", tilt: 0, ready: false, samples: buf.length };
  const latest = buf[buf.length - 1]!;
  const prev = buf[buf.length - 2]!;
  const oldest = buf[0]!;
  if (latest.t - oldest.t < WINDOW_MS * READY_FRACTION) {
    return { signal: "NONE", signalRaw: 0, D: 0, P: 0, regime: "warmup", tilt: 0, ready: false, samples: buf.length };
  }
  const past = nearest(latest.t - WINDOW_MS);
  if (!past || past.t >= latest.t) return { signal: "NONE", signalRaw: 0, D: 0, P: 0, regime: "warmup", tilt: 0, ready: false, samples: buf.length };

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

  const priceWeight = Math.tanh(3 * Dp);
  const dCall = latest.callOI - past.callOI;
  const dPut = latest.putOI - past.putOI;
  const totalOI = latest.callOI + latest.putOI;
  const doRaw = totalOI > 0 ? ((dCall - dPut) * priceWeight) / totalOI : 0;

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

  const longSamples = buf.filter((o) => o.t >= latest.t - LONG_WINDOW_MS);
  const volDeltas: number[] = [];
  const oiDeltas: number[] = [];
  for (let i = 1; i < longSamples.length; i++) {
    const dv = longSamples[i]!.optionVolume - longSamples[i - 1]!.optionVolume;
    if (dv >= 0) volDeltas.push(dv);
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

  const pastIv = nearest(latest.t - IV_WINDOW_MS);
  const ivThen = pastIv?.atmIV ?? 0;
  const deltaIvPct = ivThen > 0 ? latest.atmIV / ivThen - 1 : 0;
  const gate = 0.45 + 0.55 * clip(deltaIvPct / 0.08, 0, 1);

  const tilt = sign(dCall - dPut);
  const disagree = tilt !== 0 && sign(D) !== 0 && tilt !== sign(D);
  const P = pRaw * gate * (disagree ? 0.8 : 1);

  let signalRaw: number;
  let regime: string;
  if (Math.abs(D) > THETA_D && P < THETA_P_LOW) {
    signalRaw = -D * K_FADE;
    regime = "fade";
  } else if (Math.abs(D) <= THETA_D && P > THETA_P_HIGH) {
    signalRaw = tilt * P;
    regime = "tilt_on_power";
  } else {
    signalRaw = D * P;
    regime = "aligned";
  }

  let signal: "CALL" | "PUT" | "NONE" = "NONE";
  if (signalRaw > TAU) signal = "CALL";
  else if (signalRaw < -TAU) signal = "PUT";

  return { signal, signalRaw, D, P, regime, tilt, ready: true, samples: buf.length };
}

// ── Data types ────────────────────────────────────────────────────────────────

interface Candle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  oi?: number;
}

interface DayData {
  date: string;
  niftyCandles: Candle[];
  optionData: Array<{
    strike: number;
    type: "CE" | "PE";
    tradingsymbol: string;
    candles: Candle[];
  }>;
  atmStrike: number;
}

interface BacktestResult {
  date: string;
  signals: Array<{
    time: string;
    signal: string;
    signalRaw: number;
    D: number;
    P: number;
    regime: string;
    price: number;
  }>;
  firstSignalTime: string | null;
  firstSignalType: string | null;
  firstSignalPrice: number;
  endPrice: number;
  priceChangePct: number;
  correct: boolean | null; // true if CALL and price went up, PUT and price went down
  totalSignals: number;
  callSignals: number;
  putSignals: number;
  noneSignals: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function yearsToExpiry(dayDate: Date): number {
  const day = dayDate.getUTCDay();
  let daysUntilThu = (4 - day + 7) % 7;
  if (daysUntilThu === 0) daysUntilThu = 0;
  const ms = daysUntilThu * 24 * 60 * 60 * 1000;
  return Math.max(ms, 2 * 60 * 60 * 1000) / (365 * 24 * 60 * 60 * 1000);
}

function buildMinuteMap(
  day: DayData
): Map<number, {
  price: number;
  callOI: number;
  putOI: number;
  optionVolume: number;
  atmCallLtp: number;
  atmPutLtp: number;
}> {
  // Build a map: timestamp → aggregated data
  const minuteMap = new Map<number, {
    price: number;
    callOI: number;
    putOI: number;
    optionVolume: number;
    atmCallLtp: number;
    atmPutLtp: number;
  }>();

  // Index option candles by timestamp
  const optionCandleMap = new Map<string, Map<number, Candle>>();
  for (const opt of day.optionData) {
    const key = `${opt.strike}-${opt.type}`;
    const m = new Map<number, Candle>();
    for (const c of opt.candles) {
      m.set(new Date(c.date).getTime(), c);
    }
    optionCandleMap.set(key, m);
  }

  for (const nc of day.niftyCandles) {
    const t = new Date(nc.date).getTime();
    let callOI = 0;
    let putOI = 0;
    let optionVolume = 0;
    let atmCallLtp = 0;
    let atmPutLtp = 0;

    for (const opt of day.optionData) {
      const key = `${opt.strike}-${opt.type}`;
      const candleMap = optionCandleMap.get(key);
      const candle = candleMap?.get(t);
      if (!candle) continue;

      if (opt.type === "CE") {
        callOI += candle.oi ?? 0;
        optionVolume += candle.volume ?? 0;
        if (opt.strike === day.atmStrike) atmCallLtp = candle.close;
      } else {
        putOI += candle.oi ?? 0;
        optionVolume += candle.volume ?? 0;
        if (opt.strike === day.atmStrike) atmPutLtp = candle.close;
      }
    }

    minuteMap.set(t, {
      price: nc.close,
      callOI,
      putOI,
      optionVolume,
      atmCallLtp,
      atmPutLtp,
    });
  }

  return minuteMap;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  console.log(`Loading data from ${inputFile}...`);
  const raw = fs.readFileSync(inputFile, "utf-8");
  const parsed = JSON.parse(raw) as { data: DayData[] };

  console.log(`Loaded ${parsed.data.length} trading days\n`);
  console.log("=".repeat(120));
  console.log("TIER-3 INTRADAY SIGNAL BACKTEST");
  console.log("=".repeat(120));

  const results: BacktestResult[] = [];

  for (const day of parsed.data) {
    resetSignalState();

    const minuteMap = buildMinuteMap(day);
    const timestamps = Array.from(minuteMap.keys()).sort((a, b) => a - b);

    const dayDate = new Date(day.date + "T09:15:00+05:30");
    const T = yearsToExpiry(dayDate);

    const signals: BacktestResult["signals"] = [];
    let callCount = 0, putCount = 0, noneCount = 0;

    for (const t of timestamps) {
      const m = minuteMap.get(t)!;

      // Compute ATM IV from call LTP
      let atmIV = 0;
      if (m.atmCallLtp > 0) {
        const iv = solveIV(m.atmCallLtp, m.price, day.atmStrike, T, 0.065, true);
        atmIV = iv * 100;
      }
      const atmGamma = atmIV > 0 ? bsGamma(m.price, day.atmStrike, atmIV / 100, T) : 0;

      recordObservation({
        t,
        price: m.price,
        callOI: m.callOI,
        putOI: m.putOI,
        optionVolume: m.optionVolume,
        atmIV,
        atmGamma,
      });

      const sig = computeIntradaySignal();

      if (sig.ready) {
        signals.push({
          time: new Date(t).toISOString().slice(11, 19),
          signal: sig.signal,
          signalRaw: sig.signalRaw,
          D: sig.D,
          P: sig.P,
          regime: sig.regime,
          price: m.price,
        });

        if (sig.signal === "CALL") callCount++;
        else if (sig.signal === "PUT") putCount++;
        else noneCount++;
      }
    }

    // Find first non-NONE signal
    const firstSignal = signals.find((s) => s.signal !== "NONE");
    const firstSignalTime = firstSignal?.time ?? null;
    const firstSignalType = firstSignal?.signal ?? null;
    const firstSignalPrice = firstSignal?.price ?? 0;

    const endPrice = timestamps.length > 0 ? minuteMap.get(timestamps[timestamps.length - 1]!)!.price : 0;
    const priceChangePct = firstSignalPrice > 0 ? ((endPrice - firstSignalPrice) / firstSignalPrice) * 100 : 0;

    let correct: boolean | null = null;
    if (firstSignalType === "CALL") correct = priceChangePct > 0;
    else if (firstSignalType === "PUT") correct = priceChangePct < 0;

    const result: BacktestResult = {
      date: day.date,
      signals,
      firstSignalTime,
      firstSignalType,
      firstSignalPrice,
      endPrice,
      priceChangePct,
      correct,
      totalSignals: signals.length,
      callSignals: callCount,
      putSignals: putCount,
      noneSignals: noneCount,
    };
    results.push(result);

    // Print per-day summary
    const status = correct === null ? "—" : correct ? "✓ WIN" : "✗ LOSS";
    const sigType = firstSignalType ?? "NONE";
    console.log(
      `${day.date} | ATM=${day.atmStrike} | ` +
      `First: ${firstSignalTime ?? "N/A"} ${sigType} @ ${firstSignalPrice.toFixed(2)} | ` +
      `End: ${endPrice.toFixed(2)} | Δ=${priceChangePct >= 0 ? "+" : ""}${priceChangePct.toFixed(2)}% | ` +
      `Calls=${callCount} Puts=${putCount} None=${noneCount} | ${status}`
    );
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(120));
  console.log("SUMMARY");
  console.log("=".repeat(120));

  const daysWithSignals = results.filter((r) => r.firstSignalType !== null);
  const wins = daysWithSignals.filter((r) => r.correct === true);
  const losses = daysWithSignals.filter((r) => r.correct === false);
  const noSignalDays = results.filter((r) => r.firstSignalType === null);

  console.log(`Total trading days:     ${results.length}`);
  console.log(`Days with signals:      ${daysWithSignals.length}`);
  console.log(`Days with no signal:    ${noSignalDays.length}`);
  console.log(`Wins:                   ${wins.length}`);
  console.log(`Losses:                 ${losses.length}`);
  console.log(`Win rate:               ${daysWithSignals.length > 0 ? ((wins.length / daysWithSignals.length) * 100).toFixed(1) : 0}%`);
  console.log(`Avg price change:       ${daysWithSignals.length > 0 ? (daysWithSignals.reduce((s, r) => s + r.priceChangePct, 0) / daysWithSignals.length).toFixed(2) : 0}%`);

  console.log("\nSignal distribution:");
  const totalCalls = results.reduce((s, r) => s + r.callSignals, 0);
  const totalPuts = results.reduce((s, r) => s + r.putSignals, 0);
  const totalNones = results.reduce((s, r) => s + r.noneSignals, 0);
  console.log(`  CALL: ${totalCalls}  PUT: ${totalPuts}  NONE: ${totalNones}`);

  // Regime distribution
  const regimeCounts: Record<string, number> = {};
  for (const r of results) {
    for (const s of r.signals) {
      regimeCounts[s.regime] = (regimeCounts[s.regime] ?? 0) + 1;
    }
  }
  console.log("\nRegime distribution:");
  for (const [regime, count] of Object.entries(regimeCounts)) {
    console.log(`  ${regime}: ${count}`);
  }

  // Save detailed results
  const outputFile = inputFile.replace(".json", "-backtest.json");
  fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
  console.log(`\nDetailed results saved to ${outputFile}`);
}

main();

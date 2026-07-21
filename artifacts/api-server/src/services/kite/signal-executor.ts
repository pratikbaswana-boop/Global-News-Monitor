import { db, brokerAccountsTable, brokerOrdersTable, brokerPositionsTable, signalExecutionsTable, marketSnapshotsTable, userTradePreferencesTable } from "@workspace/db";
import { eq, desc, and, gt } from "drizzle-orm";
import { logger } from "../../lib/logger.js";
import { placeOrder, cancelOrder, type PlaceOrderParams } from "./orders.js";
import { getMargins, syncPortfolio } from "./portfolio.js";
import { getGlobalKiteClient, getNearestExpiry } from "./kite-option-chain.js";
import { computeIntradaySignal, type IntradaySignal } from "../market/tier3-signal.js";
import { getHotContext } from "../market/hot-context.js";
import { getLatestChainMetrics, getLtpBySymbol, getNiftySpotMovePct, getNiftySpotPersistence, getNiftySpotIntradayRange } from "./market-ticker.js";
import { enqueueAudit } from "../../lib/audit-queue.js";
import {
  canEnter,
  markPendingEntry,
  markOpen,
  markFlat,
  markPendingExit,
  getPositionState,
  getAllPositionStates,
} from "./position-state.js";
import { trackEntryOrder } from "./entry-tracker.js";
import { broadcastUserExecutions } from "./ws-broadcaster.js";
import { randomUUID } from "crypto";

// Asset symbol → Kite trading symbol mapping
const ASSET_KITE_MAP: Record<string, { tradingsymbol: string; exchange: string }> = {
  nifty50: { tradingsymbol: "NIFTY 50", exchange: "NSE" },
  sensex: { tradingsymbol: "SENSEX", exchange: "BSE" },
  reliance: { tradingsymbol: "RELIANCE", exchange: "NSE" },
  tcs: { tradingsymbol: "TCS", exchange: "NSE" },
  "hdfc-bank": { tradingsymbol: "HDFCBANK", exchange: "NSE" },
  // AMF Stock Universe
  ongc: { tradingsymbol: "ONGC", exchange: "NSE" },
  ntpc: { tradingsymbol: "NTPC", exchange: "NSE" },
  powergrid: { tradingsymbol: "POWERGRID", exchange: "NSE" },
  infosys: { tradingsymbol: "INFY", exchange: "NSE" },
  wipro: { tradingsymbol: "WIPRO", exchange: "NSE" },
  hcltech: { tradingsymbol: "HCLTECH", exchange: "NSE" },
  techm: { tradingsymbol: "TECHM", exchange: "NSE" },
  "icici-bank": { tradingsymbol: "ICICIBANK", exchange: "NSE" },
  sbin: { tradingsymbol: "SBIN", exchange: "NSE" },
  "axis-bank": { tradingsymbol: "AXISBANK", exchange: "NSE" },
  "kotak-bank": { tradingsymbol: "KOTAKBANK", exchange: "NSE" },
  maruti: { tradingsymbol: "MARUTI", exchange: "NSE" },
  "tata-motors": { tradingsymbol: "TATAMOTORS", exchange: "NSE" },
  "m-and-m": { tradingsymbol: "M&M", exchange: "NSE" },
  hindunilvr: { tradingsymbol: "HINDUNILVR", exchange: "NSE" },
  itc: { tradingsymbol: "ITC", exchange: "NSE" },
  nestleind: { tradingsymbol: "NESTLEIND", exchange: "NSE" },
  sunpharma: { tradingsymbol: "SUNPHARMA", exchange: "NSE" },
  drreddy: { tradingsymbol: "DRREDDY", exchange: "NSE" },
  cipla: { tradingsymbol: "CIPLA", exchange: "NSE" },
  "tata-steel": { tradingsymbol: "TATASTEEL", exchange: "NSE" },
  hindalco: { tradingsymbol: "HINDALCO", exchange: "NSE" },
  "jsw-steel": { tradingsymbol: "JSWSTEEL", exchange: "NSE" },
  lt: { tradingsymbol: "LT", exchange: "NSE" },
  ultracemco: { tradingsymbol: "ULTRACEMCO", exchange: "NSE" },
  "bharti-artl": { tradingsymbol: "BHARTIARTL", exchange: "NSE" },
};

interface ExecutionResult {
  executed: boolean;
  orderId?: string;
  reason?: string;
}

// ── Option Trading Constants ────────────────────────────────────────────────
const NIFTY_LOT_SIZE = 65;
const MIN_OPTION_PREMIUM = 5;
const MAX_OPTION_PREMIUM = 400;
const MAX_OPTION_LOTS = 20;
// ── Stop-loss parameters by option moneyness ──────────────────────────────────
// Far OTM options (delta < 0.15) move asymmetrically: slow on upside, fast on
// downside due to theta decay. They need tighter stops and time-based exits.
const OPTION_HARD_STOP_PCT = 15;       // ATM/ITM hard stop (15%)
const OPTION_TRAIL_GAP_PCT = 8;        // ATM/ITM trail gap (8% below peak)
const OPTION_MILESTONE_STEP = 10;      // ATM/ITM milestone step (10%)

const FAR_OTM_HARD_STOP_PCT = 15;      // Far OTM hard stop (15%)
const FAR_OTM_TRAIL_GAP_PCT = 8;       // Far OTM trail gap (8%)
const FAR_OTM_MILESTONE_STEP = 5;      // Far OTM milestone step (5%)
const FAR_OTM_TIME_STOP_MS = 15 * 60 * 1000; // 15-min time stop for far OTM
const FAR_OTM_DELTA_THRESHOLD = 0.15;  // delta < this → far OTM
const FAR_OTM_MIN_GAIN_PCT = 5;        // must reach +5% within time stop window
const NIFTY_STRIKE_INTERVAL = 50;

function getNearestWeeklyExpiry(): Date {
  const today = new Date();
  const day = today.getDay(); // 0=Sun, 1=Mon, ..., 4=Thu
  let daysUntilThursday = (4 - day + 7) % 7;
  const expiry = new Date(today);
  expiry.setDate(today.getDate() + daysUntilThursday);
  // If today is Thursday and after market close (~15:30 IST), use next Thursday
  const istHour = today.getUTCHours() + 5;
  const istMin = today.getUTCMinutes() + 30;
  if (day === 4 && (istHour > 15 || (istHour === 15 && istMin >= 30))) {
    expiry.setDate(today.getDate() + 7);
  }
  return expiry;
}

function formatExpiryForSymbol(expiry: Date): string {
  // Kite format: YY + M (no zero-pad) + DD (e.g. 26707 for 2026-07-07)
  const yy = String(expiry.getFullYear()).slice(-2);
  const mm = String(expiry.getMonth() + 1); // no zero-pad for month
  const dd = String(expiry.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

function buildOptionSymbol(
  underlying: string,
  expiry: Date,
  strike: number,
  type: "CE" | "PE"
): string {
  return `${underlying}${formatExpiryForSymbol(expiry)}${strike}${type}`;
}

interface OptionCandidate {
  symbol: string;
  strike: number;
  deltaEstimate: number;
  premium: number;
  lots: number;
}

/**
 * Build 5 strike candidates around the suggested ATM strike.
 * For CALLs: lower strike = ITM. For PUTs: higher strike = ITM.
 */
export function buildStrikeCandidates(
  suggestedStrike: number,
  signal: "BUY_CALL" | "BUY_PUT",
  expiry: Date
): { symbol: string; strike: number; deltaEstimate: number }[] {
  const type = signal === "BUY_CALL" ? "CE" : "PE";
  const candidates: { symbol: string; strike: number; deltaEstimate: number }[] = [];

  // Expanded to ±10 strikes so we can find affordable options even with low capital.
  // Delta estimates decay with distance from ATM.
  const offsets = [0, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500];
  const deltas  = [0.50, 0.35, 0.20, 0.12, 0.08, 0.05, 0.03, 0.02, 0.015, 0.01, 0.008];

  if (signal === "BUY_CALL") {
    // ITM calls (lower strike) + OTM calls (higher strike)
    candidates.push({ symbol: buildOptionSymbol("NIFTY", expiry, suggestedStrike - 100, type), strike: suggestedStrike - 100, deltaEstimate: 0.80 }); // 2 ITM
    candidates.push({ symbol: buildOptionSymbol("NIFTY", expiry, suggestedStrike - 50,  type), strike: suggestedStrike - 50,  deltaEstimate: 0.65 }); // 1 ITM
    for (let i = 0; i < offsets.length; i++) {
      candidates.push({ symbol: buildOptionSymbol("NIFTY", expiry, suggestedStrike + offsets[i]!, type), strike: suggestedStrike + offsets[i]!, deltaEstimate: deltas[i]! });
    }
  } else {
    // ITM puts (higher strike) + OTM puts (lower strike)
    candidates.push({ symbol: buildOptionSymbol("NIFTY", expiry, suggestedStrike + 100, type), strike: suggestedStrike + 100, deltaEstimate: 0.80 }); // 2 ITM
    candidates.push({ symbol: buildOptionSymbol("NIFTY", expiry, suggestedStrike + 50,  type), strike: suggestedStrike + 50,  deltaEstimate: 0.65 }); // 1 ITM
    for (let i = 0; i < offsets.length; i++) {
      candidates.push({ symbol: buildOptionSymbol("NIFTY", expiry, suggestedStrike - offsets[i]!, type), strike: suggestedStrike - offsets[i]!, deltaEstimate: deltas[i]! });
    }
  }
  return candidates;
}

/**
 * Fetch LTP for candidate option symbols via Kite.
 * Returns only valid quotes with non-zero premium.
 */
async function fetchOptionQuotes(
  userId: string,
  candidates: { symbol: string; strike: number; deltaEstimate: number }[]
): Promise<OptionCandidate[]> {
  // Use global (paid) Kite client for market data — user's own client may be
  // a free Personal app that doesn't have quote permissions.
  const kite = await getGlobalKiteClient();
  if (!kite) {
    logger.warn({ userId, count: candidates.length }, "signal-executor: no global Kite client for fetchOptionQuotes");
    return [];
  }

  const instruments = candidates.map((c) => `NFO:${c.symbol}`);
  logger.info({ userId, instruments }, "signal-executor: fetching option quotes");
  const quotes = await kite.getQuote(instruments);
  logger.info({ userId, quoteKeys: Object.keys(quotes as Record<string, unknown>) }, "signal-executor: received quotes");

  const results: OptionCandidate[] = [];
  for (const c of candidates) {
    const key = `NFO:${c.symbol}`;
    const quote = (quotes as Record<string, unknown>)[key];
    if (!quote) continue;
    const lastPrice = Number((quote as Record<string, unknown>).last_price ?? 0);
    if (lastPrice <= 0) continue;
    results.push({
      symbol: c.symbol,
      strike: c.strike,
      deltaEstimate: c.deltaEstimate,
      premium: lastPrice,
      lots: 0,
    });
  }
  return results;
}

/**
 * Select candidate premiums straight from the in-memory KiteTicker tick map (#2). The
 * candidates (ATM-100 … ATM+500 → within ±10 strikes) sit inside the ±15 chain we already
 * subscribe in full mode, so their LTP is streaming — no REST getQuote on the order hot
 * path. Returns only candidates with a live premium; the caller falls back to REST if the
 * feed hasn't populated them yet.
 */
export function quoteCandidatesFromTicks(
  candidates: { symbol: string; strike: number; deltaEstimate: number }[]
): OptionCandidate[] {
  const results: OptionCandidate[] = [];
  for (const c of candidates) {
    const ltp = getLtpBySymbol(c.symbol);
    if (ltp === null || ltp <= 0) continue;
    results.push({ symbol: c.symbol, strike: c.strike, deltaEstimate: c.deltaEstimate, premium: ltp, lots: 0 });
  }
  return results;
}

/**
 * Select the best option candidate based on capital and score = lots × delta.
 * High capital (≥₹50k): only delta >= 0.50. Low capital: all valid.
 */
export function selectBestOption(
  candidates: OptionCandidate[],
  maxCapital: number
): OptionCandidate | null {
  const costPerLot = (c: OptionCandidate) => c.premium * NIFTY_LOT_SIZE;

  const scored = candidates
    .filter((c) => c.premium >= MIN_OPTION_PREMIUM && c.premium <= MAX_OPTION_PREMIUM)
    .map((c) => {
      const lots = Math.min(
        Math.floor(maxCapital / costPerLot(c)),
        MAX_OPTION_LOTS
      );
      return { ...c, lots };
    })
    .filter((c) => c.lots >= 1);

  if (scored.length === 0) return null;

  // High capital filter: prefer quality strikes (delta >= 0.50)
  const highCapital = maxCapital >= 50000;
  const eligible = highCapital ? scored.filter((c) => c.deltaEstimate >= 0.50) : scored;
  if (eligible.length === 0 && highCapital) return null;

  const pool = eligible.length > 0 ? eligible : scored;
  pool.sort((a, b) => (b.lots * b.deltaEstimate) - (a.lots * a.deltaEstimate));
  return pool[0];
}

/**
 * Base option signal (BUY_CALL / BUY_PUT / NO_TRADE) from snapshot tier-3 data.
 * Mirrors deriveOptionSignal in intelligence.ts but only returns signal + strike.
 * The Tier-3 microstructure gate (deriveOptionSignalFromSnapshot) is layered on top.
 */
interface BaseSignalInput {
  aiDirectionRaw: "up" | "down" | "neutral" | "uncertain";
  maxPainDistancePct: number | null;
  putCallRatio: number | null;
  shortCoveringSignal: "none" | "covering" | "unwinding";
  sgxNiftyChangePct: number | null;
  realPrice: number | null;
}

// ── Hysteresis state for base signal (prevents threshold flapping) ─────────────
// Hard cutoffs without hysteresis produce NO_TRADE→BUY_CALL→NO_TRADE→BUY_CALL edges
// when price oscillates around a threshold. Each edge is a real order. Hysteresis
// requires the value to cross a tighter "release" threshold before the signal clears.
interface HysteresisState {
  maxPainSignal: "BUY_CALL" | "BUY_PUT" | null;
  pcrSignal: "BUY_CALL" | "BUY_PUT" | null;
  mildConflict: boolean;
}
let hysteresis: HysteresisState = {
  maxPainSignal: null,
  pcrSignal: null,
  mildConflict: false,
};

// Hysteresis bands: enter at the trigger threshold, release at the (tighter) release threshold.
const MAX_PAIN_TRIGGER = 1.5;
const MAX_PAIN_RELEASE = 1.2;
const PCR_LOW_TRIGGER = 0.65;
const PCR_LOW_RELEASE = 0.75;
const PCR_HIGH_TRIGGER = 1.35;
const PCR_HIGH_RELEASE = 1.25;
const MILD_CONFLICT_TRIGGER = 1.0;
const MILD_CONFLICT_RELEASE = 0.8;

/**
 * Build the base-signal inputs from a persisted snapshot. Slow-path fields (direction,
 * short-covering, SGX) prefer the in-memory hot context (R2), falling back to the
 * snapshot columns before the first ensemble publish of the day.
 */
function baseInputFromSnapshot(snapshot: typeof marketSnapshotsTable.$inferSelect): BaseSignalInput {
  const ctx = getHotContext(snapshot.assetId);
  const tier3Json = snapshot.tier3Evidence ? JSON.parse(snapshot.tier3Evidence) as Record<string, unknown> : {};
  const putCallRatio = typeof tier3Json.putCallRatio === "number" ? tier3Json.putCallRatio : null;
  return {
    aiDirectionRaw: (ctx?.direction ?? snapshot.predictedDirection) as BaseSignalInput["aiDirectionRaw"],
    maxPainDistancePct: snapshot.maxPainDistancePct,
    putCallRatio,
    shortCoveringSignal: (ctx?.shortCoveringSignal ?? snapshot.shortCoveringSignal ?? "none") as "none" | "covering" | "unwinding",
    sgxNiftyChangePct: ctx?.sgxNiftyChangePct ?? snapshot.sgxNiftyChangePct,
    realPrice: snapshot.realPriceAtSnapshot ? parseFloat(snapshot.realPriceAtSnapshot) : null,
  };
}

/** Snapshot-based base signal (used by the persisted-execution path + tests). */
function deriveBaseOptionSignal(
  snapshot: typeof marketSnapshotsTable.$inferSelect
): { signal: "BUY_CALL" | "BUY_PUT" | "NO_TRADE"; suggestedStrike: number | null; reason: string } {
  return deriveBaseFromInputs(baseInputFromSnapshot(snapshot));
}

/**
 * The base AI/heuristic decision tree. Pure over its inputs — the SAME tree drives the
 * persisted-snapshot path and the live in-memory edge evaluator, so both always agree.
 */
function deriveBaseFromInputs(
  input: BaseSignalInput
): { signal: "BUY_CALL" | "BUY_PUT" | "NO_TRADE"; suggestedStrike: number | null; reason: string } {
  const aiDirection = (input.aiDirectionRaw === "uncertain" ? "neutral" : input.aiDirectionRaw) as "up" | "down" | "neutral";
  const maxPainDistancePct = input.maxPainDistancePct;
  const shortCoveringSignal = input.shortCoveringSignal;
  const sgxNiftyChangePct = input.sgxNiftyChangePct;
  const putCallRatio = input.putCallRatio;
  const realPrice = input.realPrice;

  const hasMaxPain = maxPainDistancePct !== null;
  const hasPcr = putCallRatio !== null;
  const hasSgx = sgxNiftyChangePct !== null;

  if (!hasMaxPain && !hasPcr && !hasSgx) {
    return { signal: "NO_TRADE", reason: "Insufficient options data", suggestedStrike: null };
  }

  const suggestedStrike = realPrice ? Math.round(realPrice / NIFTY_STRIKE_INTERVAL) * NIFTY_STRIKE_INTERVAL : null;

  // ── Hysteresis: update persistent state for max pain and PCR signals ────────
  // Max pain: enter at ±1.5%, release at ±1.2%.
  if (hasMaxPain) {
    const dist = maxPainDistancePct!;
    if (dist > MAX_PAIN_TRIGGER) {
      hysteresis.maxPainSignal = "BUY_PUT";
    } else if (dist < -MAX_PAIN_TRIGGER) {
      hysteresis.maxPainSignal = "BUY_CALL";
    } else if (Math.abs(dist) < MAX_PAIN_RELEASE) {
      hysteresis.maxPainSignal = null;
    }
  }

  // PCR: enter at 0.65/1.35, release at 0.75/1.25.
  if (hasPcr) {
    const pcr = putCallRatio!;
    if (pcr < PCR_LOW_TRIGGER) {
      hysteresis.pcrSignal = "BUY_PUT";
    } else if (pcr > PCR_HIGH_TRIGGER) {
      hysteresis.pcrSignal = "BUY_CALL";
    } else if (pcr > PCR_LOW_RELEASE && pcr < PCR_HIGH_RELEASE) {
      hysteresis.pcrSignal = null;
    }
  }

  // Mild max pain conflict: enter at |dist|>1.0%, release at |dist|<0.8%.
  if (hasMaxPain) {
    const absDist = Math.abs(maxPainDistancePct!);
    if (absDist > MILD_CONFLICT_TRIGGER) {
      hysteresis.mildConflict = true;
    } else if (absDist < MILD_CONFLICT_RELEASE) {
      hysteresis.mildConflict = false;
    }
  }

  // Reversal: Max Pain stretch (with hysteresis — stays active until release band)
  if (hysteresis.maxPainSignal === "BUY_PUT") {
    return { signal: "BUY_PUT", reason: `Max pain stretch +${maxPainDistancePct!.toFixed(1)}% (hysteresis)`, suggestedStrike };
  }
  if (hysteresis.maxPainSignal === "BUY_CALL") {
    return { signal: "BUY_CALL", reason: `Max pain stretch ${maxPainDistancePct!.toFixed(1)}% (hysteresis)`, suggestedStrike };
  }

  // Reversal: PCR extremes (with hysteresis)
  if (hysteresis.pcrSignal === "BUY_PUT") {
    return { signal: "BUY_PUT", reason: `PCR ${putCallRatio!.toFixed(2)} too bullish (hysteresis)`, suggestedStrike };
  }
  if (hysteresis.pcrSignal === "BUY_CALL") {
    return { signal: "BUY_CALL", reason: `PCR ${putCallRatio!.toFixed(2)} too bearish (hysteresis)`, suggestedStrike };
  }

  // Trend: Short covering
  if (shortCoveringSignal === "covering") {
    return { signal: "BUY_CALL", reason: "Short covering active", suggestedStrike };
  }
  if (shortCoveringSignal === "unwinding") {
    return { signal: "BUY_PUT", reason: "Fresh shorts entering", suggestedStrike };
  }

  // SGX divergence
  if (hasSgx && aiDirection === "up" && sgxNiftyChangePct! < -0.8) {
    return { signal: "NO_TRADE", reason: `SGX divergence ${sgxNiftyChangePct!.toFixed(1)}%`, suggestedStrike: null };
  }
  if (hasSgx && aiDirection === "down" && sgxNiftyChangePct! > 0.8) {
    return { signal: "NO_TRADE", reason: `SGX divergence +${sgxNiftyChangePct!.toFixed(1)}%`, suggestedStrike: null };
  }

  // Mild max pain conflict (with hysteresis)
  if (hysteresis.mildConflict) {
    return { signal: "NO_TRADE", reason: `Mild max pain conflict ${maxPainDistancePct!.toFixed(1)}% (hysteresis)`, suggestedStrike: null };
  }

  // Default to AI direction
  if (aiDirection === "up") {
    return { signal: "BUY_CALL", reason: "AI bullish + tier-3 neutral", suggestedStrike };
  }
  if (aiDirection === "down") {
    return { signal: "BUY_PUT", reason: "AI bearish + tier-3 neutral", suggestedStrike };
  }

  return { signal: "NO_TRADE", reason: "AI direction neutral", suggestedStrike: null };
}

/**
 * Derive the option signal, then GATE it with the Tier-3 intraday microstructure
 * verdict (computed by the 30s scheduler refresh and persisted on tier3Evidence).
 *
 * The base AI/heuristic side is kept; the microstructure formula must independently
 * agree (same side, ready, non-NONE) or the trade is suppressed. While the engine is
 * still warming up (ready === false) or no verdict is present, the base signal passes
 * through unchanged so we don't block the whole session on a cold buffer.
 */
function applyTier3Gate(
  base: { signal: "BUY_CALL" | "BUY_PUT" | "NO_TRADE"; suggestedStrike: number | null; reason: string },
  intraday: IntradaySignal | undefined
): { signal: "BUY_CALL" | "BUY_PUT" | "NO_TRADE"; suggestedStrike: number | null; reason: string } {
  if (base.signal === "NO_TRADE") return base;

  // No verdict yet, or engine still warming up → let the base signal through.
  if (!intraday || !intraday.ready) {
    return { ...base, reason: `${base.reason} (tier-3 gate: ${intraday?.regime ?? "no-data"}, pass-through)` };
  }

  const wantSide = base.signal === "BUY_CALL" ? "CALL" : "PUT";
  const detail = `D=${intraday.D.toFixed(2)} P=${intraday.P.toFixed(2)} ${intraday.regime} → ${intraday.signal}`;

  // Only block when tier-3 ACTIVELY disagrees (opposite signal). Let NONE pass through
  // so the AI signal isn't blocked just because microstructure is neutral.
  const oppositeSide = wantSide === "CALL" ? "PUT" : "CALL";
  if (intraday.signal === oppositeSide) {
    return {
      signal: "NO_TRADE",
      suggestedStrike: null,
      reason: `Tier-3 microstructure gate blocked ${base.signal} (${detail})`,
    };
  }

  return { ...base, reason: `${base.reason} ✓ tier-3 gate (${detail})` };
}

// ── Intraday range gate (NIFTY only) ───────────────────────────────────────────
// Treats the base signal's expected-move band (priceImpactEstimate) as superior
// knowledge about where NIFTY can travel today, relative to the live move from the
// previous close. A CALL is only allowed while spot still has headroom below the
// band's upper edge; a PUT only once spot has risen past the lower edge (i.e. there
// is an up-move to give back). Signed edges make this mirror automatically for a
// bearish band ("-0.5% to -1.2%") and a neutral band ("±0.3%") — no special-casing.
const OPTION_ASSET_ID = "nifty50";

/** Parse "+0.5% to +1.2%" / "-0.5% to -1.2%" / "±0.3%" into signed [lo, hi] edges. */
function parseImpactRange(s: string | null | undefined): { lo: number; hi: number } | null {
  if (!s) return null;
  if (s.includes("±")) {
    const m = s.match(/±\s*(\d+(?:\.\d+)?)/);
    if (!m) return null;
    const v = parseFloat(m[1]!);
    return Number.isFinite(v) ? { lo: -v, hi: v } : null;
  }
  const nums = s.match(/[+-]?\d+(?:\.\d+)?/g);
  if (!nums || nums.length < 2) return null;
  const a = parseFloat(nums[0]!);
  const b = parseFloat(nums[1]!);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return { lo: Math.min(a, b), hi: Math.max(a, b) };
}

/**
 * Gate the base option signal by the expected-move band vs NIFTY's live move.
 * Only ever downgrades to NO_TRADE — never flips a side — so it cannot manufacture a
 * trade the base tree didn't already want. Fails open (pass-through) when the band is
 * unparseable or the live move isn't available yet, matching the tier-3 gate warmup.
 */
function applyRangeGate(
  base: { signal: "BUY_CALL" | "BUY_PUT" | "NO_TRADE"; suggestedStrike: number | null; reason: string },
  priceImpactEstimate: string | null | undefined,
  movePct: number | null
): { signal: "BUY_CALL" | "BUY_PUT" | "NO_TRADE"; suggestedStrike: number | null; reason: string } {
  if (base.signal === "NO_TRADE") return base;

  const band = parseImpactRange(priceImpactEstimate);
  if (!band || movePct === null) {
    return { ...base, reason: `${base.reason} (range gate: ${!band ? "no band" : "no live move"}, pass-through)` };
  }

  const m = movePct;
  const detail = `move ${m >= 0 ? "+" : ""}${m.toFixed(2)}% vs [${band.lo.toFixed(1)}, ${band.hi.toFixed(1)}]`;

  // CALL needs headroom below the upper edge; PUT needs room above the lower edge.
  if (base.signal === "BUY_CALL" && !(m < band.hi)) {
    return { signal: "NO_TRADE", suggestedStrike: null, reason: `Range gate blocked CALL — ${detail} (no headroom)` };
  }
  if (base.signal === "BUY_PUT" && !(m > band.lo)) {
    return { signal: "NO_TRADE", suggestedStrike: null, reason: `Range gate blocked PUT — ${detail} (below floor)` };
  }

  return { ...base, reason: `${base.reason} ✓ range gate (${detail})` };
}

// ── Chop gate (NIFTY only) — the whipsaw guard ─────────────────────────────────
// In a no-news, oscillating market the spot ticks up-and-down with little net
// travel; entries there just bleed on stops + costs. We measure persistence
// (|net move| / total path over ~30s) and refuse to enter when it's too low —
// regardless of side. News stays the boss of DIRECTION; this only controls WHEN we
// act on it. Veto-only + fail-open: it can never start a trade, and it passes
// through on a cold buffer so it never freezes the session at the open.
const MIN_PERSISTENCE = 0.35; // below this, spot is oscillating rather than trending

function applyChopGate(
  base: { signal: "BUY_CALL" | "BUY_PUT" | "NO_TRADE"; suggestedStrike: number | null; reason: string },
  fast: { persistence: number; netPct: number; ready: boolean }
): { signal: "BUY_CALL" | "BUY_PUT" | "NO_TRADE"; suggestedStrike: number | null; reason: string } {
  if (base.signal === "NO_TRADE") return base;
  if (!fast.ready) {
    return { ...base, reason: `${base.reason} (chop gate: warming up, pass-through)` };
  }
  if (fast.persistence < MIN_PERSISTENCE) {
    return {
      signal: "NO_TRADE",
      suggestedStrike: null,
      reason: `Chop gate blocked — persistence ${fast.persistence.toFixed(2)} < ${MIN_PERSISTENCE} (oscillating, no net move)`,
    };
  }
  return { ...base, reason: `${base.reason} ✓ chop gate (persistence ${fast.persistence.toFixed(2)})` };
}

function deriveOptionSignalFromSnapshot(
  snapshot: typeof marketSnapshotsTable.$inferSelect
): { signal: "BUY_CALL" | "BUY_PUT" | "NO_TRADE"; suggestedStrike: number | null; reason: string } {
  const base = deriveBaseOptionSignal(snapshot);
  const tier3Json = snapshot.tier3Evidence
    ? (JSON.parse(snapshot.tier3Evidence) as Record<string, unknown>)
    : {};
  const intraday = tier3Json.intradaySignal as IntradaySignal | undefined;
  const gated = applyTier3Gate(base, intraday);
  if (snapshot.assetId !== OPTION_ASSET_ID) return gated;
  const ranged = applyRangeGate(gated, snapshot.priceImpactEstimate, getNiftySpotMovePct());
  return applyChopGate(ranged, getNiftySpotPersistence());
}

/**
 * Live, in-memory option side for the edge evaluator (R3). Uses the same base tree +
 * tier-3 gate as the snapshot path, but sourced entirely from memory: slow inputs from
 * the hot context, fast inputs (spot/PCR/maxPain) from the KiteTicker metrics, and the
 * microstructure verdict from the intraday signal cache. No DB read on the hot path.
 */
export function computeLiveOptionSide(
  assetId: string
): { signal: "BUY_CALL" | "BUY_PUT" | "NO_TRADE"; suggestedStrike: number | null; reason: string } {
  const ctx = getHotContext(assetId);
  const metrics = getLatestChainMetrics();
  const spot = metrics?.spotPrice ?? null;
  const maxPainDistancePct =
    metrics && metrics.maxPainStrike && spot && spot > 0
      ? ((spot - metrics.maxPainStrike) / metrics.maxPainStrike) * 100
      : null;

  // ── Spot momentum override: detect market turns when AI direction is stale ──
  // When the hot context hasn't been refreshed in >10 min and spot has reversed
  // significantly from the day's extreme, override the AI direction so the tick
  // evaluator can fire a side transition without waiting for the next ensemble.
  let aiDirection = ctx?.direction ?? "neutral";
  const ctxAgeMs = ctx ? Date.now() - ctx.publishedAt : Infinity;
  const STALE_CTX_MS = 10 * 60 * 1000; // 10 min
  const REVERSAL_THRESHOLD_PCT = 0.25; // spot reversed 0.25% from day's extreme

  if (ctxAgeMs > STALE_CTX_MS) {
    const intradayRange = getNiftySpotIntradayRange();
    if (intradayRange && intradayRange.dayHigh - intradayRange.dayLow > 20) {
      // AI says down but spot has bounced significantly from the day's low → market turning up
      if (aiDirection === "down" && intradayRange.moveFromLowPct > REVERSAL_THRESHOLD_PCT) {
        aiDirection = "up";
        logger.info({
          assetId,
          oldDir: ctx?.direction,
          newDir: "up",
          ctxAgeMin: Math.round(ctxAgeMs / 60000),
          moveFromLowPct: intradayRange.moveFromLowPct.toFixed(2),
          dayLow: intradayRange.dayLow,
          spot: intradayRange.spot,
        }, "signal-executor: spot momentum override (stale AI down → up)");
      }
      // AI says up but spot has dropped significantly from the day's high → market turning down
      else if (aiDirection === "up" && intradayRange.moveFromHighPct < -REVERSAL_THRESHOLD_PCT) {
        aiDirection = "down";
        logger.info({
          assetId,
          oldDir: ctx?.direction,
          newDir: "down",
          ctxAgeMin: Math.round(ctxAgeMs / 60000),
          moveFromHighPct: intradayRange.moveFromHighPct.toFixed(2),
          dayHigh: intradayRange.dayHigh,
          spot: intradayRange.spot,
        }, "signal-executor: spot momentum override (stale AI up → down)");
      }
    }
  }

  const base = deriveBaseFromInputs({
    aiDirectionRaw: aiDirection,
    maxPainDistancePct,
    putCallRatio: metrics?.pcr ?? null,
    shortCoveringSignal: ctx?.shortCoveringSignal ?? "none",
    sgxNiftyChangePct: ctx?.sgxNiftyChangePct ?? null,
    realPrice: spot,
  });
  // Compute the intraday verdict FRESH (not the cached value) so the edge is detected
  // against the latest buffer state — this is what turns the faster feed into faster
  // detection. computeIntradaySignal is idempotent w.r.t. redundant calls (time-based EMA).
  const gated = applyTier3Gate(base, computeIntradaySignal());
  if (assetId !== OPTION_ASSET_ID) return gated;
  const ranged = applyRangeGate(gated, ctx?.priceImpactEstimate ?? null, getNiftySpotMovePct());
  return applyChopGate(ranged, getNiftySpotPersistence());
}

/**
 * Process a market snapshot for auto-trading.
 * Called after a new/updated market snapshot is generated.
 */
const CONFIDENCE_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

export async function processSignalForAutoTrade(snapshotId: string): Promise<void> {
  const snapshotRows = await db
    .select()
    .from(marketSnapshotsTable)
    .where(eq(marketSnapshotsTable.id, snapshotId))
    .limit(1);

  if (!snapshotRows.length) {
    logger.warn({ snapshotId }, "signal-executor: snapshot not found");
    return;
  }

  const snapshot = snapshotRows[0];
  const direction = snapshot.predictedDirection;

  // Only trade high/medium confidence (checked per-user later too)
  if (snapshot.predictedConfidence === "low") {
    logger.info({ snapshotId, confidence: snapshot.predictedConfidence }, "signal-executor: low confidence, skipping");
    return;
  }

  // Find all users with auto-trade enabled and active broker accounts
  const activeAccounts = await db
    .select()
    .from(brokerAccountsTable)
    .where(and(
      eq(brokerAccountsTable.isActive, true),
      eq(brokerAccountsTable.autoTradeEnabled, true)
    ));

  if (!activeAccounts.length) {
    logger.info("signal-executor: no active auto-trade accounts");
    return;
  }

  const kiteSymbol = ASSET_KITE_MAP[snapshot.assetId];
  if (!kiteSymbol) {
    logger.warn({ assetId: snapshot.assetId }, "signal-executor: no Kite symbol mapping for asset");
    return;
  }

  for (const account of activeAccounts) {
    try {
      // Skip if this user already has an execution for this snapshot
      const existing = await db
        .select({ id: signalExecutionsTable.id })
        .from(signalExecutionsTable)
        .where(and(
          eq(signalExecutionsTable.signalSnapshotId, snapshotId),
          eq(signalExecutionsTable.userId, account.userId)
        ))
        .limit(1);
      if (existing.length > 0) continue;

      const result = await executeSignalForUser(
        account.userId,
        account,
        snapshot,
        kiteSymbol.tradingsymbol,
        kiteSymbol.exchange,
        direction as "up" | "down"
      );

      if (result.executed) {
        logger.info({
          userId: account.userId,
          snapshotId,
          orderId: result.orderId,
          symbol: kiteSymbol.tradingsymbol,
          direction,
        }, "signal-executor: auto-trade executed");
      } else {
        logger.info({
          userId: account.userId,
          snapshotId,
          reason: result.reason,
        }, "signal-executor: auto-trade skipped");
      }
    } catch (err) {
      logger.error({ userId: account.userId, snapshotId, err }, "signal-executor: auto-trade failed");
    }
  }
}

async function getUserTradePreference(
  userId: string,
  assetId: string
): Promise<typeof userTradePreferencesTable.$inferSelect | null> {
  const rows = await db
    .select()
    .from(userTradePreferencesTable)
    .where(and(
      eq(userTradePreferencesTable.userId, userId),
      eq(userTradePreferencesTable.assetId, assetId)
    ))
    .limit(1);
  return rows[0] ?? null;
}

async function executeSpotSignalForUser(
  userId: string,
  account: typeof brokerAccountsTable.$inferSelect,
  snapshot: typeof marketSnapshotsTable.$inferSelect,
  tradingsymbol: string,
  exchange: string,
  direction: "up" | "down",
  skipConfidenceCheck = false
): Promise<ExecutionResult> {
  // Spot trades require a clear directional signal
  if (direction !== "up" && direction !== "down") {
    return { executed: false, reason: `Non-directional signal (${direction}) — spot trading requires up/down` };
  }

  // 1. Check if user has enabled this asset for auto-trade
  const pref = await getUserTradePreference(userId, snapshot.assetId);

  if (!pref) {
    return { executed: false, reason: `Asset ${snapshot.assetId} not configured for auto-trade` };
  }

  if (!pref.enabled) {
    return { executed: false, reason: `Auto-trade disabled for ${snapshot.assetId}` };
  }

  // 2. Check per-asset confidence threshold — skipped for tick-driven entries
  if (!skipConfidenceCheck) {
    const signalConfidenceRank = CONFIDENCE_RANK[snapshot.predictedConfidence] ?? 0;
    const requiredConfidenceRank = CONFIDENCE_RANK[pref.minConfidence] ?? 1;
    if (signalConfidenceRank < requiredConfidenceRank) {
      return { executed: false, reason: `Signal confidence ${snapshot.predictedConfidence} below threshold ${pref.minConfidence}` };
    }
  }

  // 3. Check intraday-only setting
  if (pref.onlyIntraday && snapshot.timeframe !== "intraday") {
    return { executed: false, reason: `Only intraday trades enabled, got ${snapshot.timeframe}` };
  }

  // Check if user already has an open position or pending order for this symbol
  const existingOrders = await db
    .select()
    .from(brokerOrdersTable)
    .where(and(
      eq(brokerOrdersTable.userId, userId),
      eq(brokerOrdersTable.tradingsymbol, tradingsymbol),
      eq(brokerOrdersTable.exchange, exchange),
      eq(brokerOrdersTable.status, "OPEN")
    ))
    .limit(1);

  if (existingOrders.length > 0) {
    return { executed: false, reason: "Pending order already exists for this symbol" };
  }

  // Check existing position
  const existingPositions = await db
    .select()
    .from(brokerPositionsTable)
    .where(and(
      eq(brokerPositionsTable.userId, userId),
      eq(brokerPositionsTable.tradingsymbol, tradingsymbol),
      eq(brokerPositionsTable.exchange, exchange),
    ))
    .limit(1);

  const hasPosition = existingPositions.length > 0 && existingPositions[0].quantity > 0;
  const transactionType = direction === "up" ? "BUY" : "SELL";

  // For SELL signals, only sell if we have a position
  if (direction === "down" && !hasPosition) {
    return { executed: false, reason: "No position to sell" };
  }

  // For BUY signals, skip if already holding
  if (direction === "up" && hasPosition) {
    return { executed: false, reason: "Already holding position" };
  }

  // Get margins to compute order size — retry up to 3 times
  let margins = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    margins = await getMargins(userId);
    if (margins) break;
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  if (!margins) {
    return { executed: false, reason: "Could not fetch margins after 3 retries" };
  }

  const availableCash = margins.equity?.available?.cash || margins.equity?.available?.liveBalance || 0;
  // Use per-asset risk setting if configured, else global account setting
  const riskPct = pref.maxRiskPerTradePct ?? account.maxRiskPerTradePct;
  const maxRiskAmount = availableCash * (riskPct / 100);

  if (maxRiskAmount <= 0) {
    return { executed: false, reason: "Insufficient available cash" };
  }

  // Determine quantity
  let quantity = 1;
  const realPrice = snapshot.realPriceAtSnapshot ? parseFloat(snapshot.realPriceAtSnapshot) : 0;

  // Use custom quantity if user set a fixed override
  if (pref.customQuantity && pref.customQuantity > 0) {
    quantity = pref.customQuantity;
  } else if (realPrice > 0) {
    // Conservative: assume we want to risk maxRiskAmount at ~2% stop loss
    const stopLossPct = 0.02;
    const riskPerUnit = realPrice * stopLossPct;
    quantity = Math.floor(maxRiskAmount / riskPerUnit);
  }

  if (quantity < 1) quantity = 1;

  // Use per-asset product/order type overrides if set
  const product = (pref.defaultProduct ?? account.defaultProduct) as "CNC" | "MIS" | "NRML";
  const orderType = (pref.defaultOrderType ?? account.defaultOrderType) as "MARKET" | "LIMIT" | "SL" | "SL-M";

  // Place order
  const orderParams: PlaceOrderParams = {
    exchange,
    tradingsymbol,
    transactionType: transactionType as "BUY" | "SELL",
    quantity,
    orderType,
    product,
    tag: `auto-signal-${snapshot.assetId}-${snapshot.id}`,
  };

  // For LIMIT orders, set price near current price
  if (orderParams.orderType === "LIMIT" && realPrice > 0) {
    orderParams.price = direction === "up"
      ? Math.round(realPrice * 1.001 * 100) / 100
      : Math.round(realPrice * 0.999 * 100) / 100;
  }

  const orderResult = await placeOrder(userId, orderParams);

  // Compute target/stop from per-asset settings
  const exitStrategy = pref.exitStrategy ?? "trailing_ratchet";
  const targetPctVal = pref.targetPct ? parseFloat(pref.targetPct) : 1.2;
  const stopLossPctVal = pref.stopLossPct ? parseFloat(pref.stopLossPct) : 2.0;
  const trailGapPctVal = pref.trailGapPct ? parseFloat(pref.trailGapPct) : 15;

  // Record the signal execution
  const execId = randomUUID();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const execValues: any = {
    id: execId,
    signalSnapshotId: snapshot.id,
    userId,
    brokerAccountId: account.id,
    brokerOrderId: orderResult.kiteOrderId,
    assetId: snapshot.assetId,
    assetSymbol: snapshot.assetSymbol,
    direction,
    quantity,
    entryPrice: realPrice > 0 ? String(realPrice) : null,
    // pending_entry until a fill is confirmed (R6) — the monitor only manages `open` rows.
    status: "pending_entry",
    exitStrategy,
    product,
    trailGapPct: String(trailGapPctVal),
    highestPriceReached: realPrice > 0 ? String(realPrice) : null,
    executedAt: new Date(),
  };

  if (exitStrategy === "fixed_target") {
    execValues.targetPrice = realPrice > 0 ? String(realPrice * (direction === "up" ? 1 + targetPctVal / 100 : 1 - targetPctVal / 100)) : null;
    execValues.stopLossPrice = realPrice > 0 ? String(realPrice * (direction === "up" ? 1 - stopLossPctVal / 100 : 1 + stopLossPctVal / 100)) : null;
  } else {
    // trailing_ratchet: no fixed target; initial hard stop only
    execValues.targetPrice = null;
    execValues.stopLossPrice = realPrice > 0 ? String(realPrice * (direction === "up" ? 1 - stopLossPctVal / 100 : 1 + stopLossPctVal / 100)) : null;
  }

  enqueueAudit("signal-execution-insert", async () => {
    await db.insert(signalExecutionsTable).values(execValues);
  });

  // Confirm the fill before treating this as an open position (spot has no option side).
  trackEntryOrder({
    kiteOrderId: orderResult.kiteOrderId,
    userId,
    assetId: snapshot.assetId,
    execId,
    symbol: snapshot.assetSymbol,
    side: null,
    intendedQty: quantity,
  });

  // Sync portfolio in background so we have latest positions
  void syncPortfolio(userId);

  return { executed: true, orderId: orderResult.kiteOrderId };
}

/**
 * Execute an option (F&O) signal for a user.
 * Uses 5-strike search, quote fetching, and score-based selection.
 */
async function executeOptionSignalForUser(
  userId: string,
  account: typeof brokerAccountsTable.$inferSelect,
  snapshot: typeof marketSnapshotsTable.$inferSelect,
  skipConfidenceCheck = false
): Promise<ExecutionResult> {
  const pref = await getUserTradePreference(userId, snapshot.assetId);
  if (!pref) {
    return { executed: false, reason: `Asset ${snapshot.assetId} not configured for auto-trade` };
  }

  if (!pref.enabled) {
    return { executed: false, reason: `Auto-trade disabled for ${snapshot.assetId}` };
  }

  // Confidence check — skipped for tick-driven entries (paper engine parity)
  if (!skipConfidenceCheck) {
    const signalConfidenceRank = CONFIDENCE_RANK[snapshot.predictedConfidence] ?? 0;
    const requiredConfidenceRank = CONFIDENCE_RANK[pref.minConfidence] ?? 1;
    if (signalConfidenceRank < requiredConfidenceRank) {
      return { executed: false, reason: `Signal confidence ${snapshot.predictedConfidence} below threshold ${pref.minConfidence}` };
    }
  }

  // Intraday check
  if (pref.onlyIntraday && snapshot.timeframe !== "intraday") {
    return { executed: false, reason: `Only intraday trades enabled, got ${snapshot.timeframe}` };
  }

  // Derive option signal from snapshot tier-3 data
  const optionSig = deriveOptionSignalFromSnapshot(snapshot);
  if (optionSig.signal === "NO_TRADE" || optionSig.suggestedStrike === null) {
    return { executed: false, reason: optionSig.reason };
  }

  // Build 5 strike candidates — use real Kite expiry, not computed Thursday
  const expiry = await getNearestExpiry();
  const candidates = buildStrikeCandidates(optionSig.suggestedStrike, optionSig.signal, expiry);

  // #2: take premiums from the in-memory tick map (candidates are within the subscribed
  // chain). Fall back to a REST quote only if the feed hasn't populated them yet.
  let quotes = quoteCandidatesFromTicks(candidates);
  if (quotes.length === 0) {
    quotes = await fetchOptionQuotes(userId, candidates);
  }
  if (quotes.length === 0) {
    return { executed: false, reason: "Could not fetch option quotes" };
  }

  // Determine capital to deploy — retry up to 3 times (Kite API may not be ready at startup)
  let margins = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    margins = await getMargins(userId);
    if (margins) break;
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  if (!margins) {
    return { executed: false, reason: "Could not fetch margins after 3 retries" };
  }
  const availableCash = margins.equity?.available?.cash || margins.equity?.available?.liveBalance || 0;
  // Use 95% of available cash to leave buffer — Kite margin requirement is
 // slightly higher than premium × qty, causing "Insufficient funds" rejections
  const maxCapital = pref.maxCapitalPerTrade
    ? parseFloat(pref.maxCapitalPerTrade)
    : availableCash * 0.95;

  if (maxCapital <= 0) {
    return { executed: false, reason: "No capital allocated for trade" };
  }

  // Select best strike
  const best = selectBestOption(quotes, maxCapital);
  if (!best) {
    return { executed: false, reason: "No affordable option strike found" };
  }

  const optionSymbol = best.symbol;
  const exchange = "NFO";
  const premium = best.premium;
  const lots = best.lots;
  const quantity = lots * NIFTY_LOT_SIZE;

  // Check existing orders/positions on this option symbol
  const existingOrders = await db
    .select()
    .from(brokerOrdersTable)
    .where(and(
      eq(brokerOrdersTable.userId, userId),
      eq(brokerOrdersTable.tradingsymbol, optionSymbol),
      eq(brokerOrdersTable.exchange, exchange),
      eq(brokerOrdersTable.status, "OPEN")
    ))
    .limit(1);

  if (existingOrders.length > 0) {
    return { executed: false, reason: "Pending order already exists for this option" };
  }

  const existingPositions = await db
    .select()
    .from(brokerPositionsTable)
    .where(and(
      eq(brokerPositionsTable.userId, userId),
      eq(brokerPositionsTable.tradingsymbol, optionSymbol),
      eq(brokerPositionsTable.exchange, exchange),
    ))
    .limit(1);

  const hasPosition = existingPositions.length > 0 && existingPositions[0].quantity > 0;
  if (hasPosition) {
    return { executed: false, reason: "Already holding option position" };
  }

  // Product/order type — use LIMIT for options (Kite API doesn't allow MARKET
  // orders without market protection for options)
  const product = (pref.defaultProduct ?? account.defaultProduct ?? "MIS") as "CNC" | "MIS" | "NRML";
  const orderType: "MARKET" | "LIMIT" | "SL" | "SL-M" = "LIMIT";

  // Place order — LIMIT at slight premium above LTP to ensure fill
  const orderParams: PlaceOrderParams = {
    exchange,
    tradingsymbol: optionSymbol,
    transactionType: "BUY",
    quantity,
    orderType,
    product,
    tag: `auto-${snapshot.assetId.slice(0, 3)}`,
  };

  if (premium > 0) {
    // Place limit order 1% above LTP, rounded to nearest tick size (0.05)
    const rawPrice = premium * 1.01;
    orderParams.price = Math.round(rawPrice / 0.05) * 0.05;
  }

  const orderResult = await placeOrder(userId, orderParams);

  // Record execution — for options we are always LONG, so direction = "up"
  const direction = "up";
  // Determine if this is a far OTM option — use tighter stops if so
  const isFarOTM = best.deltaEstimate < FAR_OTM_DELTA_THRESHOLD;
  const hardStopPct = isFarOTM ? FAR_OTM_HARD_STOP_PCT : OPTION_HARD_STOP_PCT;
  const trailGapPct = isFarOTM ? FAR_OTM_TRAIL_GAP_PCT : OPTION_TRAIL_GAP_PCT;

  const execId = randomUUID();
  const execValues: any = {
    id: execId,
    signalSnapshotId: snapshot.id,
    userId,
    brokerAccountId: account.id,
    brokerOrderId: orderResult.kiteOrderId,
    assetId: snapshot.assetId,
    assetSymbol: optionSymbol,
    direction,
    quantity,
    entryPrice: String(premium), // provisional LTP; overwritten with the actual fill avg
    // Persist as pending_entry, NOT open. The position monitor only manages `open` rows,
    // so it never starts trailing / places an SL backstop against an unfilled entry. The
    // entry tracker promotes this to `open` once a fill is confirmed (R6).
    status: "pending_entry",
    exitStrategy: isFarOTM ? "trailing_ratchet_far_otm" : "trailing_ratchet",
    product,
    trailGapPct: String(trailGapPct),
    highestPriceReached: String(premium),
    executedAt: new Date(),
    targetPrice: null,
    stopLossPrice: String(premium * (1 - hardStopPct / 100)),
    notes: JSON.stringify({
      deltaEstimate: best.deltaEstimate,
      isFarOTM,
      hardStopPct,
      trailGapPct,
      milestoneStep: isFarOTM ? FAR_OTM_MILESTONE_STEP : OPTION_MILESTONE_STEP,
      timeStopMs: isFarOTM ? FAR_OTM_TIME_STOP_MS : null,
      minGainPct: isFarOTM ? FAR_OTM_MIN_GAIN_PCT : null,
    }),
  };

  enqueueAudit("signal-execution-insert", async () => {
    await db.insert(signalExecutionsTable).values(execValues);
  });

  // Gate OPEN on an actual fill: confirm via order postback (fast) or poll (backstop),
  // with a cancel-and-return-to-FLAT timeout for entries that never fill.
  trackEntryOrder({
    kiteOrderId: orderResult.kiteOrderId,
    userId,
    assetId: snapshot.assetId,
    execId,
    symbol: optionSymbol,
    side: optionSig.signal === "BUY_CALL" ? "CALL" : "PUT",
    intendedQty: quantity,
  });
  void syncPortfolio(userId);

  logger.info({
    userId,
    snapshotId: snapshot.id,
    orderId: orderResult.kiteOrderId,
    optionSymbol,
    premium,
    lots,
    quantity,
    signal: optionSig.signal,
    reason: optionSig.reason,
  }, "signal-executor: option entry order placed (awaiting fill)");

  return { executed: true, orderId: orderResult.kiteOrderId };
}

/**
 * Dispatcher: route to spot or option execution based on user preference.
 */
async function executeSignalForUser(
  userId: string,
  account: typeof brokerAccountsTable.$inferSelect,
  snapshot: typeof marketSnapshotsTable.$inferSelect,
  tradingsymbol: string,
  exchange: string,
  direction: "up" | "down",
  skipConfidenceCheck = false
): Promise<ExecutionResult> {
  const pref = await getUserTradePreference(userId, snapshot.assetId);
  // Only NIFTY supports option trading via Kite. SENSEX options use a different
  // instrument format (BFO:SENSEX) and strike interval — skip for now.
  // SENSEX also can't be spot traded (it's an index), so skip entirely.
  if (snapshot.assetId === "sensex") {
    return { executed: false, reason: "SENSEX trading not supported yet" };
  }
  const isIndexAsset = snapshot.assetId === "nifty50";
  if (pref?.useOptions || isIndexAsset) {
    return executeOptionSignalForUser(userId, account, snapshot, skipConfidenceCheck);
  }
  return executeSpotSignalForUser(userId, account, snapshot, tradingsymbol, exchange, direction, skipConfidenceCheck);
}

/**
 * Reconcile the in-memory position-state machine against open signal_executions so it
 * survives restarts and reflects position-monitor closes. States that no longer have an
 * open execution move to FLAT (with cooldown); open executions with no live state are
 * seeded to OPEN.
 */
export async function reconcilePositionStates(): Promise<void> {
  const openExecs = await db
    .select({ userId: signalExecutionsTable.userId, assetId: signalExecutionsTable.assetId })
    .from(signalExecutionsTable)
    .where(eq(signalExecutionsTable.status, "open"));

  const openSet = new Set(openExecs.map((e) => `${e.userId}::${e.assetId}`));

  // Grace window so a freshly-opened position (whose execution insert is still draining
  // through the write-behind queue, R4) is not mistaken for a closed one and flipped FLAT.
  const RECONCILE_GRACE_MS = 15_000;
  const now = Date.now();

  for (const s of getAllPositionStates()) {
    if (
      (s.state === "OPEN" || s.state === "PENDING_EXIT") &&
      !openSet.has(`${s.userId}::${s.assetId}`) &&
      now - s.updatedAt > RECONCILE_GRACE_MS
    ) {
      markFlat(s.userId, s.assetId); // position closed elsewhere → flat + cooldown
    }
  }
  for (const e of openExecs) {
    if (getPositionState(e.userId, e.assetId).state === "FLAT") {
      markOpen(e.userId, e.assetId, null); // seed after a restart
    }
  }
}

/**
 * Extract the strike price from a NIFTY option symbol (e.g. "NIFTY2671025000CE" → 25000).
 */
function extractStrikeFromSymbol(symbol: string): number | null {
  const match = symbol.match(/NIFTY\d{6}(\d+)(CE|PE)/);
  if (!match) return null;
  return parseInt(match[1]!, 10);
}

/**
 * Override strategy: if a new signal arrives while the user has an open position,
 * check if the new signal's selected strike is closer to the current spot price
 * than the existing trade's strike. If so AND the user has capital to buy it,
 * exit the current trade and enter the new one.
 *
 * Returns true if an override was performed, false otherwise.
 */
async function tryOverrideEntry(
  userId: string,
  account: typeof brokerAccountsTable.$inferSelect,
  assetId: string,
  snapshot: typeof marketSnapshotsTable.$inferSelect,
  newSide: "CALL" | "PUT" | null
): Promise<boolean> {
  // Find the user's current open option execution
  const openExecs = await db
    .select()
    .from(signalExecutionsTable)
    .where(and(
      eq(signalExecutionsTable.userId, userId),
      eq(signalExecutionsTable.status, "open"),
    ))
    .orderBy(desc(signalExecutionsTable.executedAt))
    .limit(1);

  if (openExecs.length === 0) return false;

  const currentExec = openExecs[0]!;
  const currentStrike = extractStrikeFromSymbol(currentExec.assetSymbol);
  if (currentStrike === null) return false;

  // Get current spot price
  const metrics = getLatestChainMetrics();
  const spot = metrics?.spotPrice ?? 0;
  if (spot <= 0) return false;

  // Compute the new signal's suggested strike
  const optionSig = deriveOptionSignalFromSnapshot(snapshot);
  if (optionSig.signal === "NO_TRADE" || optionSig.suggestedStrike === null) return false;

  const newStrike = optionSig.suggestedStrike;
  const currentDistance = Math.abs(currentStrike - spot);
  const newDistance = Math.abs(newStrike - spot);

  // Only override if the new strike is closer to spot
  if (newDistance >= currentDistance) {
    logger.info({
      userId, currentStrike, newStrike, spot,
      currentDistance, newDistance,
    }, "signal-executor: override skipped — new strike not closer to spot");
    return false;
  }

  // Check if user has capital to buy the new option
  const margins = await getMargins(userId);
  if (!margins) return false;
  const availableCash = margins.equity?.available?.cash || margins.equity?.available?.liveBalance || 0;

  // Build candidates for the new signal to check affordability
  const expiry = await getNearestExpiry();
  const candidates = buildStrikeCandidates(newStrike, optionSig.signal, expiry);
  let quotes = quoteCandidatesFromTicks(candidates);
  if (quotes.length === 0) {
    quotes = await fetchOptionQuotes(userId, candidates);
  }
  if (quotes.length === 0) return false;

  const pref = await getUserTradePreference(userId, assetId);
  if (!pref) return false;

  const maxCapital = pref.maxCapitalPerTrade
    ? parseFloat(pref.maxCapitalPerTrade)
    : availableCash * 0.95;

  if (maxCapital <= 0) return false;

  const best = selectBestOption(quotes, maxCapital);
  if (!best) {
    logger.info({ userId, newStrike, maxCapital }, "signal-executor: override skipped — no affordable option for new strike");
    return false;
  }

  // ── Exit the current trade at market rate ──────────────────────────────────
  const currentLtp = getLtpBySymbol(currentExec.assetSymbol);
  if (!currentLtp || currentLtp <= 0) {
    logger.warn({ userId, symbol: currentExec.assetSymbol }, "signal-executor: override skipped — no LTP for current position");
    return false;
  }

  const isOption = currentExec.assetSymbol.startsWith("NIFTY") &&
    (currentExec.assetSymbol.endsWith("CE") || currentExec.assetSymbol.endsWith("PE"));
  const exchange = isOption ? "NFO" : "NSE";
  const direction = currentExec.direction ?? "up";
  const exitDiscountPct = 0.02;
  const exitLimitPrice = Math.round((currentLtp * (direction === "up" ? 1 - exitDiscountPct : 1 + exitDiscountPct)) / 0.05) * 0.05;

  // Place SELL exit order for current position
  await placeOrder(userId, {
    exchange,
    tradingsymbol: currentExec.assetSymbol,
    transactionType: direction === "up" ? "SELL" : "BUY",
    quantity: currentExec.quantity,
    orderType: "LIMIT",
    price: exitLimitPrice,
    product: (currentExec.product ?? "MIS") as "CNC" | "MIS" | "NRML",
    tag: `override-exit-${currentExec.id.slice(0, 14)}`,
  });

  // Cancel any resting SL orders for the current position
  const slOrders = await db
    .select()
    .from(brokerOrdersTable)
    .where(and(
      eq(brokerOrdersTable.userId, userId),
      eq(brokerOrdersTable.tradingsymbol, currentExec.assetSymbol),
      eq(brokerOrdersTable.transactionType, "SELL"),
      eq(brokerOrdersTable.status, "OPEN"),
    ));

  for (const slOrder of slOrders) {
    try {
      await cancelOrder(userId, slOrder.kiteOrderId, "regular");
    } catch {
      // ignore — SL may have already fired
    }
  }

  // Close the current execution in DB
  const entryPrice = Number(currentExec.entryPrice ?? 0);
  const realisedPnl = direction === "up"
    ? (exitLimitPrice - entryPrice) * currentExec.quantity
    : (entryPrice - exitLimitPrice) * currentExec.quantity;

  await db
    .update(signalExecutionsTable)
    .set({
      status: "closed",
      exitPrice: String(exitLimitPrice),
      realisedPnl: String(realisedPnl.toFixed(2)),
      exitReason: "override",
      closedAt: new Date(),
    })
    .where(eq(signalExecutionsTable.id, currentExec.id));

  markPendingExit(userId, assetId);

  logger.info({
    userId, oldSymbol: currentExec.assetSymbol, oldStrike: currentStrike,
    newStrike, spot, oldDistance: currentDistance, newDistance,
    exitPrice: exitLimitPrice, realisedPnl: realisedPnl.toFixed(2),
  }, "signal-executor: override — exited current trade for closer strike");

  // Broadcast updated executions
  void broadcastUserExecutions(userId);

  // ── Enter the new trade ────────────────────────────────────────────────────
  // Mark flat with minimal cooldown so we can immediately re-enter
  markFlat(userId, assetId, 0);

  const optionSymbol = best.symbol;
  const premium = best.premium;
  const lots = best.lots;
  const quantity = lots * NIFTY_LOT_SIZE;
  const product = (pref.defaultProduct ?? account.defaultProduct ?? "MIS") as "CNC" | "MIS" | "NRML";

  const orderParams: PlaceOrderParams = {
    exchange: "NFO",
    tradingsymbol: optionSymbol,
    transactionType: "BUY",
    quantity,
    orderType: "LIMIT",
    product,
    tag: `auto-ovr-${assetId.slice(0, 3)}`,
  };

  if (premium > 0) {
    const rawPrice = premium * 1.01;
    orderParams.price = Math.round(rawPrice / 0.05) * 0.05;
  }

  const orderResult = await placeOrder(userId, orderParams);

  // Record the new execution
  const isFarOTM = best.deltaEstimate < FAR_OTM_DELTA_THRESHOLD;
  const hardStopPct = isFarOTM ? FAR_OTM_HARD_STOP_PCT : OPTION_HARD_STOP_PCT;
  const trailGapPct = isFarOTM ? FAR_OTM_TRAIL_GAP_PCT : OPTION_TRAIL_GAP_PCT;

  const execId = randomUUID();
  const execValues: any = {
    id: execId,
    signalSnapshotId: snapshot.id,
    userId,
    brokerAccountId: account.id,
    brokerOrderId: orderResult.kiteOrderId,
    assetId: snapshot.assetId,
    assetSymbol: optionSymbol,
    direction: "up",
    quantity,
    entryPrice: String(premium),
    status: "pending_entry",
    exitStrategy: isFarOTM ? "trailing_ratchet_far_otm" : "trailing_ratchet",
    product,
    trailGapPct: String(trailGapPct),
    highestPriceReached: String(premium),
    executedAt: new Date(),
    targetPrice: null,
    stopLossPrice: String(premium * (1 - hardStopPct / 100)),
    notes: JSON.stringify({
      deltaEstimate: best.deltaEstimate,
      isFarOTM,
      hardStopPct,
      trailGapPct,
      milestoneStep: isFarOTM ? FAR_OTM_MILESTONE_STEP : OPTION_MILESTONE_STEP,
      timeStopMs: isFarOTM ? FAR_OTM_TIME_STOP_MS : null,
      minGainPct: isFarOTM ? FAR_OTM_MIN_GAIN_PCT : null,
      override: true,
    }),
  };

  enqueueAudit("signal-execution-insert", async () => {
    await db.insert(signalExecutionsTable).values(execValues);
  });

  trackEntryOrder({
    kiteOrderId: orderResult.kiteOrderId,
    userId,
    assetId: snapshot.assetId,
    execId,
    symbol: optionSymbol,
    side: optionSig.signal === "BUY_CALL" ? "CALL" : "PUT",
    intendedQty: quantity,
  });

  markPendingEntry(userId, assetId, newSide);
  void syncPortfolio(userId);

  logger.info({
    userId, newSymbol: optionSymbol, newStrike: best.strike,
    premium, lots, quantity, signal: optionSig.signal,
  }, "signal-executor: override — new entry order placed (awaiting fill)");

  return true;
}

/**
 * Shared per-user gated dispatch (R3). Iterates active auto-trade accounts and places at
 * most one entry per user — but only when the state machine says canEnter. The state
 * machine (not a "does an execution row already exist" DB scan) is what prevents the
 * re-entry churn that produced 20 trades from a single direction. Called ONLY on a
 * signal-side transition by the tick evaluator.
 */
async function dispatchToEligibleUsers(
  assetId: string,
  sideForState: "CALL" | "PUT" | null,
  run: (
    userId: string,
    account: typeof brokerAccountsTable.$inferSelect,
    snapshot: typeof marketSnapshotsTable.$inferSelect
  ) => Promise<ExecutionResult>
): Promise<void> {
  // A recent snapshot supplies the execution-record FK + entry-price fields.
  const cutoff = new Date(Date.now() - 30 * 60 * 1000);
  const snapRows = await db
    .select()
    .from(marketSnapshotsTable)
    .where(and(eq(marketSnapshotsTable.assetId, assetId), gt(marketSnapshotsTable.snapshotAt, cutoff)))
    .orderBy(desc(marketSnapshotsTable.snapshotAt))
    .limit(1);
  if (snapRows.length === 0) {
    logger.info({ assetId }, "signal-executor: edge fired but no recent snapshot to anchor execution");
    return;
  }
  const snapshot = snapRows[0]!;

  const activeAccounts = await db
    .select()
    .from(brokerAccountsTable)
    .where(and(eq(brokerAccountsTable.isActive, true), eq(brokerAccountsTable.autoTradeEnabled, true)));
  if (activeAccounts.length === 0) return;

  // #3: fan out users in PARALLEL — their broker calls (getMargins/placeOrder) are gated
  // FIFO by the shared Kite rate limiter, so calls interleave fairly and stay under the
  // rate limit, instead of user 4 waiting behind users 1-3's full sequences.
  await Promise.all(
    activeAccounts.map(async (account) => {
      if (canEnter(account.userId, assetId)) {
        // Normal entry path — user is FLAT
        markPendingEntry(account.userId, assetId, sideForState);
        try {
          const result = await run(account.userId, account, snapshot);
          if (result.executed) {
            logger.info({ userId: account.userId, assetId, orderId: result.orderId }, "signal-executor: edge entry placed (awaiting fill)");
          } else {
            markFlat(account.userId, assetId, 0);
            logger.info({ userId: account.userId, assetId, reason: result.reason }, "signal-executor: edge entry skipped");
          }
        } catch (err) {
          markFlat(account.userId, assetId, 0);
          logger.error({ userId: account.userId, assetId, err }, "signal-executor: edge entry failed");
        }
        return;
      }

      // Override path — user is OPEN/PENDING. Check if new signal's strike is closer to spot.
      // Only applies to option trades (NIFTY) where we can compare strike proximity.
      if (assetId !== OPTION_ASSET_ID) return;

      const state = getPositionState(account.userId, assetId);
      if (state.state !== "OPEN") return;

      try {
        const overridden = await tryOverrideEntry(account.userId, account, assetId, snapshot, sideForState);
        if (overridden) {
          logger.info({ userId: account.userId, assetId }, "signal-executor: override entry completed");
        }
      } catch (err) {
        logger.error({ userId: account.userId, assetId, err }, "signal-executor: override entry failed");
      }
    })
  );
}

/** Edge-triggered OPTION entry (NIFTY) — long CALL/PUT premium chosen by the executor. */
export async function dispatchEntryForSide(assetId: string, side: "BUY_CALL" | "BUY_PUT"): Promise<void> {
  const kiteSymbol = ASSET_KITE_MAP[assetId];
  if (!kiteSymbol) {
    logger.warn({ assetId }, "signal-executor: no Kite symbol mapping for asset");
    return;
  }
  const sideShort = side === "BUY_CALL" ? "CALL" : "PUT";
  await dispatchToEligibleUsers(assetId, sideShort, (userId, account, snapshot) =>
    executeSignalForUser(userId, account, snapshot, kiteSymbol.tradingsymbol, kiteSymbol.exchange, "up", true)
  );
}

/** Edge-triggered SPOT entry (non-index equities) on an AI-direction transition. */
export async function dispatchSpotForDirection(assetId: string, direction: "up" | "down"): Promise<void> {
  const kiteSymbol = ASSET_KITE_MAP[assetId];
  if (!kiteSymbol) {
    logger.warn({ assetId }, "signal-executor: no Kite symbol mapping for asset");
    return;
  }
  await dispatchToEligibleUsers(assetId, null, (userId, account, snapshot) =>
    executeSignalForUser(userId, account, snapshot, kiteSymbol.tradingsymbol, kiteSymbol.exchange, direction, true)
  );
}


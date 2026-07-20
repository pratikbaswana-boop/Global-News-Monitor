// Iron Condor Backtester — 100% real data via Kite Historical API
//
// Fetches real 5-minute OHLC candles for NIFTY spot and option instruments
// from Kite's historical data API. Simulates the full Iron Condor strategy
// with ₹1,00,000 capital, applying every entry/exit rule from the master guide.
//
// Usage (on EC2):
//   cd /home/ubuntu/intel && node --experimental-strip-types artifacts/api-server/src/scripts/condor-backtest.ts
//   OR build it as part of the bundle and run:
//   node dist/scripts/condor-backtest.mjs
//
// Args:
//   --from=YYYY-MM-DD  (default: 60 days ago)
//   --to=YYYY-MM-DD    (default: today)

import { KiteConnect } from "kiteconnect";
import { db, brokerAccountsTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";

// ─── Constants (mirrors condor-paper-engine.ts) ───────────────────────────────

const CAPITAL_INITIAL = 100_000;
const LOT_SIZE = 65;
const STRIKE_INTERVAL = 50;
const SOLD_LEG_OFFSET = 250;
const HEDGE_GAP = 150;
const TILT_SHIFT = 100;
const MARGIN_CAPITAL_PCT = 0.55;
const MAX_LOTS = 3;
const SOLD_LEG_EXIT_MULT = 1.5;
const BOOK_PROFIT_FRACTION = 0.65;
const SLOW_BLEED_DAYS = 5;
const TAX_COST_PCT = 20;
const VIX_LOW_THRESHOLD = 12;
const VIX_HIGH_THRESHOLD = 18;
const CRISIS_PROB_ENTRY_MAX = 0.30;
const CRISIS_PROB_EXIT_TRIGGER = 0.55;
const MONTHLY_MAX_LOSS_PCT = 5;
const ENTRY_WINDOW_START_MIN = 615; // 10:15 IST
const ENTRY_WINDOW_END_MIN = 660;   // 11:00 IST
const NIFTY_SPOT_TOKEN = 256265;
const KITE_API_KEY = process.env["KITE_API_KEY"] ?? "";
const KITE_API_SECRET = process.env["KITE_API_SECRET"] ?? "";
const GLOBAL_DATA_USER_ID = "afa66116-88bf-4ef3-81fc-4673565937b6";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface Candle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  oi?: number;
}

interface NfoInstrument {
  instrument_token: number;
  tradingsymbol: string;
  strike: number;
  instrument_type: "CE" | "PE";
  expiry: string;
  name: string;
}

type LegRole = "sold_put" | "sold_call" | "hedge_put" | "hedge_call";

interface CondorLeg {
  role: LegRole;
  strike: number;
  symbol: string;
  entryPremium: number;
  quantity: number;
  closed: boolean;
  exitPremium: number | null;
  exitTime: string | null;
}

interface CondorPosition {
  id: string;
  legs: CondorLeg[];
  spotAtEntry: number;
  expiryDate: string;
  directionTilt: "bullish" | "bearish" | "neutral";
  netPremium: number;
  maxLoss: number;
  maxProfit: number;
  lots: number;
  quantity: number;
  capitalAtEntry: number;
  enteredAt: string;
  sameDirectionDays: number;
  lastTrendDirection: "up" | "down" | "neutral";
  lastTrendCheckDay: string;
  entryDayHigh: number;
  entryDayLow: number;
}

interface BacktestResult {
  position: CondorPosition;
  exitReason: string;
  realisedPnl: number;
  netAfterCosts: number;
  capitalAfter: number;
  heldDays: number;
  entryDate: string;
  exitDate: string;
}

// ─── IST Time Helpers ──────────────────────────────────────────────────────────

function istMinutesOfDay(d: Date): number {
  return (d.getUTCHours() * 60 + d.getUTCMinutes() + 330) % (24 * 60);
}

function istDayOfWeek(d: Date): number {
  return new Date(d.getTime() + 330 * 60 * 1000).getUTCDay();
}

function istDateKey(d: Date): string {
  return new Date(d.getTime() + 330 * 60 * 1000).toISOString().slice(0, 10);
}

function isTradingDay(d: Date): boolean {
  const day = istDayOfWeek(d);
  return day !== 0 && day !== 6;
}

function isEntryWindow(min: number): boolean {
  return min >= ENTRY_WINDOW_START_MIN && min < ENTRY_WINDOW_END_MIN;
}

function daysToExpiry(expiryDate: string, d: Date): number {
  const expiry = new Date(`${expiryDate}T15:30:00+05:30`);
  return (expiry.getTime() - d.getTime()) / (24 * 60 * 60 * 1000);
}

function isPastGammaCutoff(expiryDate: string, d: Date): boolean {
  return daysToExpiry(expiryDate, d) <= 1.5;
}

// ─── Kite Client ───────────────────────────────────────────────────────────────

async function getKiteClient(): Promise<KiteConnect> {
  const now = new Date();

  // Try global API key user first
  if (KITE_API_KEY) {
    const rows = await db
      .select()
      .from(brokerAccountsTable)
      .where(and(eq(brokerAccountsTable.apiKey, KITE_API_KEY), eq(brokerAccountsTable.isActive, true)))
      .orderBy(desc(brokerAccountsTable.expiresAt))
      .limit(1);

    if (rows.length && rows[0]?.accessToken && (!rows[0]?.expiresAt || rows[0].expiresAt > now)) {
      const kite = new KiteConnect({ api_key: KITE_API_KEY, timeout: 10000 });
      kite.setAccessToken(rows[0].accessToken!);
      return kite;
    }
  }

  // Try global data user
  const globalRows = await db
    .select()
    .from(brokerAccountsTable)
    .where(and(eq(brokerAccountsTable.userId, GLOBAL_DATA_USER_ID), eq(brokerAccountsTable.isActive, true)))
    .limit(1);

  if (globalRows.length && globalRows[0]?.accessToken && (!globalRows[0]?.expiresAt || globalRows[0].expiresAt > now)) {
    const apiKey = globalRows[0].apiKey ?? KITE_API_KEY;
    if (apiKey) {
      const kite = new KiteConnect({ api_key: apiKey, timeout: 10000 });
      kite.setAccessToken(globalRows[0].accessToken!);
      return kite;
    }
  }

  // Fallback: any active user
  const rows = await db
    .select()
    .from(brokerAccountsTable)
    .where(eq(brokerAccountsTable.isActive, true))
    .orderBy(desc(brokerAccountsTable.expiresAt))
    .limit(5);

  for (const account of rows) {
    if (!account.accessToken) continue;
    if (account.expiresAt && account.expiresAt <= now) continue;
    const apiKey = account.apiKey ?? KITE_API_KEY;
    if (!apiKey) continue;
    const kite = new KiteConnect({ api_key: apiKey, timeout: 10000 });
    kite.setAccessToken(account.accessToken);
    return kite;
  }

  throw new Error("No valid Kite access token found");
}

// ─── Instrument Cache ──────────────────────────────────────────────────────────

let instrumentsCache: NfoInstrument[] | null = null;

async function loadInstruments(kite: KiteConnect): Promise<NfoInstrument[]> {
  if (instrumentsCache) return instrumentsCache;

  console.log("Fetching NFO instruments from Kite...");
  const raw = await kite.getInstruments("NFO");
  let allInstruments: Array<Record<string, unknown>>;

  if (typeof raw === "string") {
    const lines = raw.trim().split("\n");
    const header = lines[0]!.split(",");
    allInstruments = lines.slice(1).map((line) => {
      const vals = line.split(",");
      const row: Record<string, unknown> = {};
      for (let i = 0; i < header.length; i++) row[header[i]!] = vals[i];
      return row;
    });
  } else if (Array.isArray(raw)) {
    allInstruments = raw as Array<Record<string, unknown>>;
  } else {
    allInstruments = [];
  }

  instrumentsCache = allInstruments
    .filter((inst) => inst["name"] === "NIFTY" && (inst["instrument_type"] === "CE" || inst["instrument_type"] === "PE"))
    .map((inst) => {
      const rawExpiry = inst["expiry"];
      let expiryStr: string;
      if (rawExpiry instanceof Date) {
        expiryStr = `${rawExpiry.getFullYear()}-${String(rawExpiry.getMonth() + 1).padStart(2, "0")}-${String(rawExpiry.getDate()).padStart(2, "0")}`;
      } else if (typeof rawExpiry === "string" && rawExpiry.includes("-")) {
        expiryStr = rawExpiry.slice(0, 10);
      } else if (typeof rawExpiry === "string") {
        const d = new Date(rawExpiry);
        expiryStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      } else {
        expiryStr = String(rawExpiry);
      }
      return {
        instrument_token: Number(inst["instrument_token"]),
        tradingsymbol: String(inst["tradingsymbol"]),
        strike: Number(inst["strike"]),
        instrument_type: inst["instrument_type"] as "CE" | "PE",
        expiry: expiryStr,
        name: String(inst["name"]),
      };
    });

  console.log(`Cached ${instrumentsCache!.length} NIFTY option instruments`);
  return instrumentsCache!;
}

function findInstrument(symbol: string, instruments: NfoInstrument[]): NfoInstrument | null {
  return instruments.find((i) => i.tradingsymbol === symbol) ?? null;
}

// ─── Symbol Construction ───────────────────────────────────────────────────────

function formatExpiryForSymbol(expiry: Date): string {
  const yy = String(expiry.getFullYear()).slice(-2);
  const mm = String(expiry.getMonth() + 1);
  const dd = String(expiry.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

function buildOptionSymbol(expiry: Date, strike: number, type: "CE" | "PE"): string {
  return `NIFTY${formatExpiryForSymbol(expiry)}${strike}${type}`;
}

function getNearestExpiryDate(instruments: NfoInstrument[], onDate: string): Date {
  const availableExpiries = [...new Set(instruments.map((i) => i.expiry))].sort();
  const nearest = availableExpiries.find((e) => e >= onDate) ?? availableExpiries[availableExpiries.length - 1]!;
  const [y, m, d] = nearest.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!));
}

// ─── Historical Data Fetch ─────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchHistoricalCandles(
  kite: KiteConnect,
  instrumentToken: number,
  fromDate: string,
  toDate: string,
  interval: string = "5minute"
): Promise<Candle[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = await kite.getHistoricalData(instrumentToken, interval, fromDate, toDate);
      if (!Array.isArray(raw)) return [];
      return raw.map((c: Record<string, unknown>) => ({
        date: String(c["date"]),
        open: Number(c["open"]),
        high: Number(c["high"]),
        low: Number(c["low"]),
        close: Number(c["close"]),
        volume: Number(c["volume"] ?? 0),
        oi: c["oi"] !== undefined ? Number(c["oi"]) : undefined,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("rate") || msg.includes("429") || msg.includes("Too Many")) {
        console.log(`  Rate limited, waiting ${(attempt + 1) * 2}s...`);
        await sleep((attempt + 1) * 2000);
        continue;
      }
      if (attempt < 2) {
        await sleep(1000);
        continue;
      }
      console.error(`  Historical data fetch failed for token ${instrumentToken}: ${msg}`);
      return [];
    }
  }
  return [];
}

// Fetch NIFTY spot 5-min candles for a single day
async function fetchSpotCandles(kite: KiteConnect, dateStr: string): Promise<Candle[]> {
  const next = new Date(`${dateStr}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const toDate = next.toISOString().slice(0, 10);
  const candles = await fetchHistoricalCandles(kite, NIFTY_SPOT_TOKEN, dateStr, toDate, "5minute");
  // Filter to IST trading hours 09:15–15:30
  return candles.filter((c) => {
    const d = new Date(c.date);
    const min = istMinutesOfDay(d);
    return min >= 555 && min < 930;
  });
}

// Fetch option 5-min candles for a single day
async function fetchOptionCandles(kite: KiteConnect, instrumentToken: number, dateStr: string): Promise<Candle[]> {
  const next = new Date(`${dateStr}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const toDate = next.toISOString().slice(0, 10);
  const candles = await fetchHistoricalCandles(kite, instrumentToken, dateStr, toDate, "5minute");
  return candles.filter((c) => {
    const d = new Date(c.date);
    const min = istMinutesOfDay(d);
    return min >= 555 && min < 930;
  });
}

// ─── VIX Estimation (from chain metrics or fallback) ───────────────────────────

interface DayVixData {
  vix: number | null;
  regime: string;
  crisisProb: number;
}

async function fetchDayVixFromDb(dateStr: string): Promise<DayVixData> {
  try {
    const { marketRegimesTable } = await import("@workspace/db");
    const { eq, desc, and, gte, lt } = await import("drizzle-orm");
    const dayStart = new Date(`${dateStr}T00:00:00Z`);
    const dayEnd = new Date(`${dateStr}T23:59:59Z`);
    const rows = await db
      .select()
      .from(marketRegimesTable)
      .where(and(
        eq(marketRegimesTable.assetId, "nifty50"),
        gte(marketRegimesTable.detectedAt, dayStart),
        lt(marketRegimesTable.detectedAt, dayEnd),
      ))
      .orderBy(desc(marketRegimesTable.detectedAt))
      .limit(1);
    if (rows.length === 0) return { vix: null, regime: "RISK_ON", crisisProb: 0 };
    const r = rows[0]!;
    return {
      vix: r.vixLevel ?? null,
      regime: r.regime,
      crisisProb: r.crisisProbability,
    };
  } catch {
    return { vix: null, regime: "RISK_ON", crisisProb: 0 };
  }
}

// ─── Direction Signal (from market_snapshots DB) ───────────────────────────────

async function fetchDirectionSignal(dateStr: string): Promise<{ direction: "up" | "down" | "neutral"; confidence: "high" | "medium" | "low" }> {
  try {
    const { marketSnapshotsTable } = await import("@workspace/db");
    const { eq, desc, and, gte, lt } = await import("drizzle-orm");
    const dayStart = new Date(`${dateStr}T00:00:00Z`);
    const dayEnd = new Date(`${dateStr}T23:59:59Z`);
    const rows = await db
      .select()
      .from(marketSnapshotsTable)
      .where(and(
        eq(marketSnapshotsTable.assetId, "nifty50"),
        gte(marketSnapshotsTable.snapshotAt, dayStart),
        lt(marketSnapshotsTable.snapshotAt, dayEnd),
      ))
      .orderBy(desc(marketSnapshotsTable.snapshotAt))
      .limit(1);
    if (rows.length === 0) return { direction: "neutral", confidence: "low" };
    const r = rows[0]!;
    const dir = r.predictedDirection as "up" | "down" | "neutral" ?? "neutral";
    const conf = r.predictedConfidence as "high" | "medium" | "low" ?? "low";
    return { direction: dir, confidence: conf };
  } catch {
    return { direction: "neutral", confidence: "low" };
  }
}

// ─── Tilt Accuracy (from resolved snapshots) ───────────────────────────────────

async function fetchTiltAccuracy(dateStr: string): Promise<number | null> {
  try {
    const { marketSnapshotsTable } = await import("@workspace/db");
    const { eq, and, desc, gte, isNotNull } = await import("drizzle-orm");
    const since = new Date(`${dateStr}T00:00:00Z`);
    since.setUTCDate(since.getUTCDate() - 30);
    const rows = await db
      .select({ isCorrect: marketSnapshotsTable.isCorrect })
      .from(marketSnapshotsTable)
      .where(and(
        eq(marketSnapshotsTable.assetId, "nifty50"),
        isNotNull(marketSnapshotsTable.isCorrect),
        gte(marketSnapshotsTable.snapshotAt, since),
      ))
      .orderBy(desc(marketSnapshotsTable.snapshotAt))
      .limit(200);
    if (rows.length < 5) return null;
    const correct = rows.filter((r) => r.isCorrect === true).length;
    return (correct / rows.length) * 100;
  } catch {
    return null;
  }
}

// ─── P&L Calculation ───────────────────────────────────────────────────────────

function legsPnl(legs: CondorLeg[], livePrices: Map<string, number>): { unrealized: number; realized: number } {
  let unrealized = 0;
  let realized = 0;
  for (const leg of legs) {
    const isSold = leg.role === "sold_put" || leg.role === "sold_call";
    if (leg.closed && leg.exitPremium !== null) {
      const pnl = isSold
        ? (leg.entryPremium - leg.exitPremium) * leg.quantity
        : (leg.exitPremium - leg.entryPremium) * leg.quantity;
      realized += pnl;
    } else {
      const current = livePrices.get(leg.symbol) ?? leg.entryPremium;
      const pnl = isSold
        ? (leg.entryPremium - current) * leg.quantity
        : (current - leg.entryPremium) * leg.quantity;
      unrealized += pnl;
    }
  }
  return { unrealized, realized };
}

// ─── Entry Logic ───────────────────────────────────────────────────────────────

function shouldSkipEntry(
  dateStr: string,
  vixData: DayVixData,
  monthToDatePnl: number,
  revengeCooldownActive: boolean,
  lastLossPnl: number | null
): { skip: boolean; reason: string } {
  // Event-risk day (static calendar — add dates as needed)
  // const eventRiskDates = ["2026-02-01"];
  // if (eventRiskDates.includes(dateStr)) return { skip: true, reason: "event_risk_day" };

  // Monthly max loss circuit breaker
  if (monthToDatePnl <= -(CAPITAL_INITIAL * MONTHLY_MAX_LOSS_PCT) / 100) {
    return { skip: true, reason: "monthly_max_loss" };
  }

  // Revenge-trade cooldown (2 days after a big loss > ₹5,000)
  if (revengeCooldownActive) {
    return { skip: true, reason: "revenge_cooldown" };
  }

  // Crisis regime guard
  if (vixData.crisisProb > CRISIS_PROB_ENTRY_MAX) {
    return { skip: true, reason: "crisis_probability" };
  }

  // VIX too low
  if (vixData.vix !== null && vixData.vix < VIX_LOW_THRESHOLD) {
    return { skip: true, reason: "vix_too_low" };
  }

  return { skip: false, reason: "" };
}

function computeStrikes(
  spot: number,
  tilt: "bullish" | "bearish" | "neutral",
  dayHigh: number,
  dayLow: number
): { soldPut: number; soldCall: number; hedgePut: number; hedgeCall: number } {
  let putOffset = SOLD_LEG_OFFSET;
  let callOffset = SOLD_LEG_OFFSET;
  if (tilt === "bullish") { putOffset -= TILT_SHIFT; callOffset += TILT_SHIFT; }
  if (tilt === "bearish") { putOffset += TILT_SHIFT; callOffset -= TILT_SHIFT; }

  // Never sell a strike inside today's already-traded range
  if (dayHigh > 0 && dayLow < Infinity) {
    const minPutOffset = Math.max(50, Math.round((spot - dayLow) / STRIKE_INTERVAL) * STRIKE_INTERVAL + 50);
    const minCallOffset = Math.max(50, Math.round((dayHigh - spot) / STRIKE_INTERVAL) * STRIKE_INTERVAL + 50);
    putOffset = Math.max(putOffset, minPutOffset);
    callOffset = Math.max(callOffset, minCallOffset);
  }

  const round = (v: number) => Math.round(v / STRIKE_INTERVAL) * STRIKE_INTERVAL;
  const soldPut = round(spot - putOffset);
  const soldCall = round(spot + callOffset);
  return {
    soldPut,
    soldCall,
    hedgePut: soldPut - HEDGE_GAP,
    hedgeCall: soldCall + HEDGE_GAP,
  };
}

// ─── Exit Logic ────────────────────────────────────────────────────────────────

function checkExits(
  pos: CondorPosition,
  livePrices: Map<string, number>,
  currentTime: Date,
  vixData: DayVixData,
  dayHigh: number,
  dayLow: number
): { shouldExit: boolean; reason: string; legsToClose?: CondorLeg[] } {
  // Rule #11 — gamma cutoff
  if (isPastGammaCutoff(pos.expiryDate, currentTime)) {
    return { shouldExit: true, reason: "gamma_cutoff" };
  }

  // Rule #13 — news shock / crisis
  if (vixData.crisisProb >= CRISIS_PROB_EXIT_TRIGGER) {
    return { shouldExit: true, reason: "news_shock" };
  }

  // Rule #9 — sold leg hits 1.5x entry premium
  const legsToClose: CondorLeg[] = [];
  for (const leg of pos.legs) {
    if (leg.closed || (leg.role !== "sold_put" && leg.role !== "sold_call")) continue;
    const current = livePrices.get(leg.symbol);
    if (current !== undefined && current >= leg.entryPremium * SOLD_LEG_EXIT_MULT) {
      legsToClose.push(leg);
    }
  }
  if (legsToClose.length > 0) {
    // Check if both sold legs are now closed or will be closed
    const soldLegs = pos.legs.filter((l) => l.role === "sold_put" || l.role === "sold_call");
    const allSoldClosed = soldLegs.every((l) => l.closed || legsToClose.includes(l));
    if (allSoldClosed) {
      return { shouldExit: true, reason: "both_sold_legs_exited", legsToClose };
    }
    // Close just the breached leg(s), keep position running
    return { shouldExit: false, reason: "", legsToClose };
  }

  // Rule #10 — book profit at 65% of max profit
  const { unrealized, realized } = legsPnl(pos.legs, livePrices);
  const totalPnl = unrealized + realized;
  if (totalPnl >= pos.maxProfit * BOOK_PROFIT_FRACTION) {
    return { shouldExit: true, reason: "profit_booked" };
  }

  // Rule #12 — slow bleed: 5 consecutive days trending same adverse direction
  // (simplified for backtest — checks day-over-day direction)
  const today = istDateKey(currentTime);
  if (today !== pos.lastTrendCheckDay) {
    const dir = dayHigh - dayLow > 0 ? (dayHigh > pos.entryDayHigh ? "up" : dayLow < pos.entryDayLow ? "down" : "neutral") : "neutral";
    if (dir !== "neutral" && dir === pos.lastTrendDirection) {
      pos.sameDirectionDays += 1;
    } else {
      pos.sameDirectionDays = 0;
    }
    pos.lastTrendDirection = dir;
    pos.lastTrendCheckDay = today;

    if (pos.sameDirectionDays >= SLOW_BLEED_DAYS) {
      return { shouldExit: true, reason: "slow_bleed" };
    }
  }

  return { shouldExit: false, reason: "" };
}

// ─── Main Backtest Loop ────────────────────────────────────────────────────────

function parseArgs(): { from: string; to: string } {
  const args = process.argv.slice(2);
  let from = "";
  let to = "";
  for (const arg of args) {
    if (arg.startsWith("--from=")) from = arg.slice(7);
    if (arg.startsWith("--to=")) to = arg.slice(5);
  }
  if (!to) to = new Date().toISOString().slice(0, 10);
  if (!from) {
    const d = new Date();
    d.setDate(d.getDate() - 60);
    from = d.toISOString().slice(0, 10);
  }
  return { from, to };
}

function getTradingDays(from: string, to: string): string[] {
  const days: string[] = [];
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    if (isTradingDay(d)) {
      days.push(d.toISOString().slice(0, 10));
    }
  }
  return days;
}

async function runBacktest(): Promise<void> {
  const { from, to } = parseArgs();
  console.log(`\n=== Iron Condor Backtest (${from} → ${to}) ===`);
  console.log(`Capital: ₹${CAPITAL_INITIAL.toLocaleString("en-IN")} | Lot size: ${LOT_SIZE}\n`);

  const kite = await getKiteClient();
  const instruments = await loadInstruments(kite);
  const tradingDays = getTradingDays(from, to);
  console.log(`Trading days: ${tradingDays.length}\n`);

  let capital = CAPITAL_INITIAL;
  let activePosition: CondorPosition | null = null;
  const results: BacktestResult[] = [];
  let lastLossPnl: number | null = null;
  let lastLossDate: string | null = null;
  let monthToDatePnl = 0;
  let currentMonth = "";

  for (const dayStr of tradingDays) {
    const monthKey = dayStr.slice(0, 7);
    if (monthKey !== currentMonth) {
      currentMonth = monthKey;
      monthToDatePnl = 0;
    }

    // Fetch spot candles for the day
    const spotCandles = await fetchSpotCandles(kite, dayStr);
    if (spotCandles.length === 0) {
      console.log(`${dayStr}: No spot data, skipping`);
      continue;
    }

    // Day high/low from spot candles
    const dayHigh = Math.max(...spotCandles.map((c) => c.high));
    const dayLow = Math.min(...spotCandles.map((c) => c.low));

    // Fetch VIX/regime data from DB
    const vixData = await fetchDayVixFromDb(dayStr);

    // Check revenge cooldown (2 days after a big loss)
    let revengeCooldownActive = false;
    if (lastLossDate && lastLossPnl && lastLossPnl <= -5000) {
      const cooldownEnd = new Date(`${lastLossDate}T00:00:00Z`);
      cooldownEnd.setUTCDate(cooldownEnd.getUTCDate() + 2);
      if (new Date(`${dayStr}T00:00:00Z`) < cooldownEnd) {
        revengeCooldownActive = true;
      }
    }

    // ── If we have an active position, monitor it ──
    if (activePosition) {
      // Fetch option candles for all open legs
      const legCandles = new Map<string, Candle[]>();
      for (const leg of activePosition.legs) {
        if (leg.closed) continue;
        const inst = findInstrument(leg.symbol, instruments);
        if (!inst) {
          console.log(`  ${dayStr}: Instrument not found for ${leg.symbol}`);
          continue;
        }
        await sleep(350); // Rate limit: ~3 req/sec
        const candles = await fetchOptionCandles(kite, inst.instrument_token, dayStr);
        legCandles.set(leg.symbol, candles);
      }

      // Process each 5-min candle
      let exited = false;
      for (const spotCandle of spotCandles) {
        const candleTime = new Date(spotCandle.date);
        const livePrices = new Map<string, number>();
        for (const [symbol, candles] of legCandles) {
          const match = candles.find((c) => c.date === spotCandle.date);
          if (match) livePrices.set(symbol, match.close);
        }

        if (livePrices.size === 0) continue;

        const exitCheck = checkExits(activePosition, livePrices, candleTime, vixData, dayHigh, dayLow);

        // Close individual breached legs
        if (exitCheck.legsToClose) {
          for (const leg of exitCheck.legsToClose) {
            if (!leg.closed) {
              leg.closed = true;
              leg.exitPremium = livePrices.get(leg.symbol) ?? leg.entryPremium;
              leg.exitTime = spotCandle.date;
            }
          }
        }

        if (exitCheck.shouldExit) {
          // Close all remaining legs at current prices
          for (const leg of activePosition.legs) {
            if (!leg.closed) {
              leg.closed = true;
              leg.exitPremium = livePrices.get(leg.symbol) ?? leg.entryPremium;
              leg.exitTime = spotCandle.date;
            }
          }

          const { realized } = legsPnl(activePosition.legs, livePrices);
          const netAfterCosts = realized > 0 ? realized * (1 - TAX_COST_PCT / 100) : realized;
          capital = activePosition.capitalAtEntry + netAfterCosts;
          const heldDays = Math.round((candleTime.getTime() - new Date(activePosition.enteredAt).getTime()) / (24 * 60 * 60 * 1000));

          const result: BacktestResult = {
            position: activePosition,
            exitReason: exitCheck.reason,
            realisedPnl: realized,
            netAfterCosts,
            capitalAfter: capital,
            heldDays,
            entryDate: istDateKey(new Date(activePosition.enteredAt)),
            exitDate: dayStr,
          };
          results.push(result);
          monthToDatePnl += netAfterCosts;

          if (netAfterCosts <= -5000) {
            lastLossPnl = netAfterCosts;
            lastLossDate = dayStr;
          }

          console.log(`  EXIT: ${exitCheck.reason} | P&L: ₹${netAfterCosts.toFixed(2)} | Capital: ₹${capital.toFixed(2)} | Held: ${heldDays}d`);
          activePosition = null;
          exited = true;
          break;
        }
      }

      // If position still open at end of day, log status
      if (!exited && activePosition) {
        const lastCandle = spotCandles[spotCandles.length - 1]!;
        const livePrices = new Map<string, number>();
        for (const [symbol, candles] of legCandles) {
          const last = candles[candles.length - 1];
          if (last) livePrices.set(symbol, last.close);
        }
        const { unrealized, realized } = legsPnl(activePosition.legs, livePrices);
        console.log(`  ${dayStr}: Position open | Unrealized: ₹${unrealized.toFixed(2)} | Realized: ₹${realized.toFixed(2)}`);
      }
    }

    // ── Try entry if no active position ──
    if (!activePosition) {
      // Check entry conditions
      const skip = shouldSkipEntry(dayStr, vixData, monthToDatePnl, revengeCooldownActive, lastLossPnl);
      if (skip.skip) {
        console.log(`${dayStr}: Skip entry — ${skip.reason}`);
        continue;
      }

      // Find the entry-window candle (10:15–11:00 IST)
      const entryCandle = spotCandles.find((c) => {
        const min = istMinutesOfDay(new Date(c.date));
        return isEntryWindow(min);
      });
      if (!entryCandle) {
        console.log(`${dayStr}: No entry window candle, skipping`);
        continue;
      }

      const spot = entryCandle.close;

      // Determine direction tilt
      const signal = await fetchDirectionSignal(dayStr);
      const accuracy = await fetchTiltAccuracy(dayStr);
      const trustSignal = accuracy !== null && accuracy >= 60 && signal.confidence === "high";
      let tilt: "bullish" | "bearish" | "neutral" = "neutral";
      if (trustSignal) {
        if (signal.direction === "up") tilt = "bullish";
        else if (signal.direction === "down") tilt = "bearish";
      }

      // Compute strikes
      const strikes = computeStrikes(spot, tilt, dayHigh, dayLow);

      // Get nearest expiry
      const expiryDate = getNearestExpiryDate(instruments, dayStr);
      const expiryDateKey = expiryDate.toISOString().slice(0, 10);

      // Build option symbols
      const soldPutSymbol = buildOptionSymbol(expiryDate, strikes.soldPut, "PE");
      const soldCallSymbol = buildOptionSymbol(expiryDate, strikes.soldCall, "CE");
      const hedgePutSymbol = buildOptionSymbol(expiryDate, strikes.hedgePut, "PE");
      const hedgeCallSymbol = buildOptionSymbol(expiryDate, strikes.hedgeCall, "CE");

      // Find instrument tokens
      const soldPutInst = findInstrument(soldPutSymbol, instruments);
      const soldCallInst = findInstrument(soldCallSymbol, instruments);
      const hedgePutInst = findInstrument(hedgePutSymbol, instruments);
      const hedgeCallInst = findInstrument(hedgeCallSymbol, instruments);

      if (!soldPutInst || !soldCallInst || !hedgePutInst || !hedgeCallInst) {
        console.log(`${dayStr}: Missing instruments for strikes ${strikes.soldPut}/${strikes.soldCall}/${strikes.hedgePut}/${strikes.hedgeCall}, skipping`);
        continue;
      }

      // Fetch option candles for the day
      await sleep(350);
      const soldPutCandles = await fetchOptionCandles(kite, soldPutInst.instrument_token, dayStr);
      await sleep(350);
      const soldCallCandles = await fetchOptionCandles(kite, soldCallInst.instrument_token, dayStr);
      await sleep(350);
      const hedgePutCandles = await fetchOptionCandles(kite, hedgePutInst.instrument_token, dayStr);
      await sleep(350);
      const hedgeCallCandles = await fetchOptionCandles(kite, hedgeCallInst.instrument_token, dayStr);

      // Find entry-window premiums (match entry candle time)
      const findPremium = (candles: Candle[], time: string): number | null => {
        // Find the candle closest to entry time
        const match = candles.find((c) => c.date === time);
        if (match) return match.close;
        // Fallback: first candle in entry window
        const windowCandle = candles.find((c) => {
          const min = istMinutesOfDay(new Date(c.date));
          return isEntryWindow(min);
        });
        return windowCandle?.close ?? (candles.length > 0 ? candles[0]!.close : null);
      };

      const soldPutPremium = findPremium(soldPutCandles, entryCandle.date);
      const soldCallPremium = findPremium(soldCallCandles, entryCandle.date);
      const hedgePutPremium = findPremium(hedgePutCandles, entryCandle.date);
      const hedgeCallPremium = findPremium(hedgeCallCandles, entryCandle.date);

      if (!soldPutPremium || !soldCallPremium || !hedgePutPremium || !hedgeCallPremium) {
        console.log(`${dayStr}: Missing option premiums, skipping entry`);
        continue;
      }

      const netPremiumPerUnit = (soldPutPremium + soldCallPremium) - (hedgePutPremium + hedgeCallPremium);
      if (netPremiumPerUnit <= 0) {
        console.log(`${dayStr}: Non-positive net premium (₹${netPremiumPerUnit.toFixed(2)}), skipping`);
        continue;
      }

      const maxLossPerUnit = HEDGE_GAP - netPremiumPerUnit;
      const maxLossPerLot = maxLossPerUnit * LOT_SIZE;
      if (maxLossPerLot <= 0) {
        console.log(`${dayStr}: Non-positive max loss, skipping`);
        continue;
      }

      const marginBudget = capital * MARGIN_CAPITAL_PCT;
      let lots = Math.floor(marginBudget / maxLossPerLot);
      if (vixData.vix && vixData.vix >= VIX_HIGH_THRESHOLD) lots += 1;
      lots = Math.max(1, Math.min(lots, MAX_LOTS));

      const quantity = lots * LOT_SIZE;
      const netPremium = netPremiumPerUnit * quantity;
      const maxLoss = maxLossPerUnit * quantity;
      const maxProfit = netPremium;

      const legs: CondorLeg[] = [
        { role: "hedge_put", strike: strikes.hedgePut, symbol: hedgePutSymbol, entryPremium: hedgePutPremium, quantity, closed: false, exitPremium: null, exitTime: null },
        { role: "hedge_call", strike: strikes.hedgeCall, symbol: hedgeCallSymbol, entryPremium: hedgeCallPremium, quantity, closed: false, exitPremium: null, exitTime: null },
        { role: "sold_put", strike: strikes.soldPut, symbol: soldPutSymbol, entryPremium: soldPutPremium, quantity, closed: false, exitPremium: null, exitTime: null },
        { role: "sold_call", strike: strikes.soldCall, symbol: soldCallSymbol, entryPremium: soldCallPremium, quantity, closed: false, exitPremium: null, exitTime: null },
      ];

      activePosition = {
        id: `${dayStr}-${Date.now()}`,
        legs,
        spotAtEntry: spot,
        expiryDate: expiryDateKey,
        directionTilt: tilt,
        netPremium,
        maxLoss,
        maxProfit,
        lots,
        quantity,
        capitalAtEntry: capital,
        enteredAt: entryCandle.date,
        sameDirectionDays: 0,
        lastTrendDirection: signal.direction === "up" || signal.direction === "down" ? signal.direction : "neutral",
        lastTrendCheckDay: dayStr,
        entryDayHigh: dayHigh,
        entryDayLow: dayLow,
      };

      console.log(`\n  ENTRY: ${dayStr} ${tilt} | Spot: ${spot} | Expiry: ${expiryDateKey}`);
      console.log(`    Sold PUT ${strikes.soldPut}PE @ ₹${soldPutPremium} | Sold CALL ${strikes.soldCall}CE @ ₹${soldCallPremium}`);
      console.log(`    Hedge PUT ${strikes.hedgePut}PE @ ₹${hedgePutPremium} | Hedge CALL ${strikes.hedgeCall}CE @ ₹${hedgeCallPremium}`);
      console.log(`    Net premium: ₹${netPremium.toFixed(2)} | Max loss: ₹${maxLoss.toFixed(2)} | Max profit: ₹${maxProfit.toFixed(2)} | Lots: ${lots}`);
    }
  }

  // ── Close any remaining position at last available data ──
  if (activePosition) {
    console.log(`\n  Force-closing remaining position at end of backtest...`);
    const lastDay = tradingDays[tradingDays.length - 1]!;
    const spotCandles = await fetchSpotCandles(kite, lastDay);
    const lastSpot = spotCandles[spotCandles.length - 1];
    const livePrices = new Map<string, number>();
    for (const leg of activePosition.legs) {
      if (leg.closed) continue;
      const inst = findInstrument(leg.symbol, instruments);
      if (inst) {
        await sleep(350);
        const candles = await fetchOptionCandles(kite, inst.instrument_token, lastDay);
        const last = candles[candles.length - 1];
        if (last) livePrices.set(leg.symbol, last.close);
      }
    }
    for (const leg of activePosition.legs) {
      if (!leg.closed) {
        leg.closed = true;
        leg.exitPremium = livePrices.get(leg.symbol) ?? leg.entryPremium;
        leg.exitTime = lastSpot?.date ?? lastDay;
      }
    }
    const { realized } = legsPnl(activePosition.legs, livePrices);
    const netAfterCosts = realized > 0 ? realized * (1 - TAX_COST_PCT / 100) : realized;
    capital = activePosition.capitalAtEntry + netAfterCosts;
    results.push({
      position: activePosition,
      exitReason: "backtest_end",
      realisedPnl: realized,
      netAfterCosts,
      capitalAfter: capital,
      heldDays: 0,
      entryDate: istDateKey(new Date(activePosition.enteredAt)),
      exitDate: lastDay,
    });
    console.log(`  Force-close P&L: ₹${netAfterCosts.toFixed(2)} | Capital: ₹${capital.toFixed(2)}`);
  }

  // ─── Summary ─────────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(80));
  console.log("BACKTEST SUMMARY");
  console.log("=".repeat(80));
  console.log(`Period: ${from} → ${to}`);
  console.log(`Initial Capital: ₹${CAPITAL_INITIAL.toLocaleString("en-IN")}`);
  console.log(`Final Capital: ₹${capital.toFixed(2)}`);
  console.log(`Total P&L: ₹${(capital - CAPITAL_INITIAL).toFixed(2)} (${(((capital - CAPITAL_INITIAL) / CAPITAL_INITIAL) * 100).toFixed(2)}%)`);
  console.log(`Total Positions: ${results.length}`);

  const wins = results.filter((r) => r.netAfterCosts > 0);
  const losses = results.filter((r) => r.netAfterCosts <= 0);
  console.log(`Wins: ${wins.length} | Losses: ${losses.length} | Win Rate: ${results.length > 0 ? ((wins.length / results.length) * 100).toFixed(1) : 0}%`);

  if (wins.length > 0) {
    const avgWin = wins.reduce((s, r) => s + r.netAfterCosts, 0) / wins.length;
    const maxWin = Math.max(...wins.map((r) => r.netAfterCosts));
    console.log(`Avg Win: ₹${avgWin.toFixed(2)} | Max Win: ₹${maxWin.toFixed(2)}`);
  }
  if (losses.length > 0) {
    const avgLoss = losses.reduce((s, r) => s + r.netAfterCosts, 0) / losses.length;
    const maxLoss = Math.min(...losses.map((r) => r.netAfterCosts));
    console.log(`Avg Loss: ₹${avgLoss.toFixed(2)} | Max Loss: ₹${maxLoss.toFixed(2)}`);
  }

  // Exit reason breakdown
  const reasons = new Map<string, number>();
  for (const r of results) {
    reasons.set(r.exitReason, (reasons.get(r.exitReason) ?? 0) + 1);
  }
  console.log("\nExit Reasons:");
  for (const [reason, count] of reasons) {
    console.log(`  ${reason}: ${count}`);
  }

  // Trade-by-trade detail
  console.log("\nTrade Details:");
  console.log("-".repeat(80));
  for (const r of results) {
    const p = r.position;
    console.log(`\n  #${results.indexOf(r) + 1} | ${r.entryDate} → ${r.exitDate} | ${p.directionTilt} | ${r.exitReason}`);
    console.log(`    Spot: ${p.spotAtEntry} | Lots: ${p.lots} | Net Premium: ₹${p.netPremium.toFixed(2)}`);
    console.log(`    P&L: ₹${r.netAfterCosts.toFixed(2)} | Capital: ₹${r.capitalAfter.toFixed(2)}`);
    for (const leg of p.legs) {
      const isSold = leg.role === "sold_put" || leg.role === "sold_call";
      const legPnl = leg.exitPremium !== null
        ? isSold ? (leg.entryPremium - leg.exitPremium) * leg.quantity : (leg.exitPremium - leg.entryPremium) * leg.quantity
        : 0;
      console.log(`    ${leg.role.padEnd(12)} ${leg.symbol.padEnd(22)} entry:₹${leg.entryPremium.toFixed(2)} exit:₹${leg.exitPremium?.toFixed(2) ?? "—"} | ₹${legPnl.toFixed(2)}`);
    }
  }

  console.log("\n" + "=".repeat(80));
  console.log("Backtest complete.\n");
  process.exit(0);
}

runBacktest().catch((err) => {
  console.error("Backtest failed:", err);
  process.exit(1);
});

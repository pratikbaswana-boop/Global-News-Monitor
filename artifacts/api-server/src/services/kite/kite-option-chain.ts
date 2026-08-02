// Kite-based real-time option chain fetcher for the intraday signal engine.
//
// Uses Kite getQuote() API to fetch OI, volume, and LTP for all NIFTY option
// strikes in the current weekly expiry. Computes ATM IV via Newton-Raphson
// Black-Scholes inversion, then derives gamma from that IV.
//
// This replaces the Firecrawl-based NSE scraper for signal generation, giving
// us millisecond-latency official API data instead of 30s web scraping.

import { KiteConnect } from "kiteconnect";
import { db, brokerAccountsTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { logger } from "../../lib/logger.js";
import { bsGamma } from "../market/tier3-signal.js";

const KITE_API_KEY = process.env["KITE_API_KEY"] ?? "";
const KITE_API_SECRET = process.env["KITE_API_SECRET"] ?? "";

// pratikjat2811@gmail.com — global data source user
const GLOBAL_DATA_USER_ID = "afa66116-88bf-4ef3-81fc-4673565937b6";

// NIFTY strike interval
const STRIKE_INTERVAL = 50;
// How many strikes on each side of ATM to fetch (±15 = 30 strikes × 2 CE/PE = 60 instruments)
const STRIKE_RANGE = 15;

interface NfoInstrument {
  instrument_token: number;
  tradingsymbol: string;
  strike: number;
  instrument_type: "CE" | "PE";
  expiry: string;
  name: string;
}

let instrumentsCache: NfoInstrument[] | null = null;
let instrumentsCacheTime = 0;
const INSTRUMENTS_CACHE_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Get a Kite client for fetching market data. Priority:
 *   1. User whose api_key matches KITE_API_KEY (the premium/global account)
 *   2. The configured global data user (pratikjat2811@gmail.com)
 *   3. Any active user with a non-expired token
 *
 * The api_key used to create the client MUST match the api_key that was used
 * to generate the access_token — otherwise Kite returns "Incorrect api_key".
 */
/**
 * Resolve the credentials (api_key + access_token) for the global market-data
 * account, using the priority order documented on {@link getGlobalKiteClient}.
 * Extracted so both the REST client and the KiteTicker WebSocket feed share the
 * exact same account selection.
 */
async function resolveGlobalDataAccount(): Promise<{ apiKey: string; accessToken: string } | null> {
  const now = new Date();

  // 1. Prefer the user whose api_key matches the global KITE_API_KEY
  if (KITE_API_KEY) {
    const rows = await db
      .select()
      .from(brokerAccountsTable)
      .where(
        and(
          eq(brokerAccountsTable.apiKey, KITE_API_KEY),
          eq(brokerAccountsTable.isActive, true)
        )
      )
      .orderBy(desc(brokerAccountsTable.expiresAt))
      .limit(1);

    if (rows.length && rows[0]?.accessToken &&
        (!rows[0]?.expiresAt || rows[0].expiresAt > now)) {
      const account = rows[0]!;
      logger.info({ userId: account.userId }, "kite-option-chain: using global API key user");
      return { apiKey: KITE_API_KEY, accessToken: account.accessToken! };
    }
  }

  // 2. Try the configured global data user
  const globalRows = await db
    .select()
    .from(brokerAccountsTable)
    .where(
      and(
        eq(brokerAccountsTable.userId, GLOBAL_DATA_USER_ID),
        eq(brokerAccountsTable.isActive, true)
      )
    )
    .limit(1);

  if (globalRows.length && globalRows[0]?.accessToken &&
      (!globalRows[0]?.expiresAt || globalRows[0].expiresAt > now)) {
    const account = globalRows[0]!;
    const apiKey = account.apiKey ?? KITE_API_KEY;
    if (apiKey) {
      logger.info({ userId: account.userId }, "kite-option-chain: using global data user");
      return { apiKey, accessToken: account.accessToken! };
    }
  }

  // 3. Fallback: any active user with a non-expired token, most recent first
  logger.warn("kite-option-chain: global user unavailable, trying any active user");
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
    logger.info({ userId: account.userId }, "kite-option-chain: using fallback user");
    return { apiKey, accessToken: account.accessToken };
  }

  logger.warn("kite-option-chain: no valid Kite access token found in any broker account");
  return null;
}

export async function getGlobalKiteClient(): Promise<KiteConnect | null> {
  try {
    const creds = await resolveGlobalDataAccount();
    if (!creds) return null;
    const kite = new KiteConnect({ api_key: creds.apiKey, timeout: 7000 });
    kite.setAccessToken(creds.accessToken);
    return kite;
  } catch (err) {
    logger.error({ err }, "kite-option-chain: failed to get global Kite client");
    return null;
  }
}

/**
 * Credentials for the global market-data account — used to build the KiteTicker
 * WebSocket feed (see market-ticker.ts). Same account selection as getGlobalKiteClient.
 */
export async function getGlobalDataCreds(): Promise<{ apiKey: string; accessToken: string } | null> {
  try {
    return await resolveGlobalDataAccount();
  } catch (err) {
    logger.error({ err }, "kite-option-chain: failed to resolve global data creds");
    return null;
  }
}

/**
 * Fetch and cache NFO instruments for NIFTY options.
 * Kite's getInstruments("NFO") returns all NFO instruments — we filter for
 * NIFTY and cache the result for 6 hours.
 */
async function getNiftyOptionInstruments(kite: KiteConnect): Promise<NfoInstrument[]> {
  const now = Date.now();
  if (instrumentsCache && now - instrumentsCacheTime < INSTRUMENTS_CACHE_MS) {
    return instrumentsCache;
  }

  const raw = await kite.getInstruments("NFO");
  let allInstruments: Array<Record<string, unknown>>;

  // KiteConnect v5 may return CSV string or parsed array — handle both
  if (typeof raw === "string") {
    logger.info("kite-option-chain: instruments returned as CSV string, parsing...");
    const lines = raw.trim().split("\n");
    const header = lines[0]!.split(",");
    allInstruments = lines.slice(1).map((line) => {
      const vals = line.split(",");
      const row: Record<string, unknown> = {};
      for (let i = 0; i < header.length; i++) {
        row[header[i]!] = vals[i];
      }
      return row;
    });
  } else if (Array.isArray(raw)) {
    allInstruments = raw as Array<Record<string, unknown>>;
  } else {
    logger.error({ type: typeof raw }, "kite-option-chain: unexpected instruments response type");
    allInstruments = [];
  }

  logger.info({ total: allInstruments.length, sampleKeys: allInstruments[0] ? Object.keys(allInstruments[0]!) : [] }, "kite-option-chain: instruments fetched");

  const niftyOptions = allInstruments
    .filter((inst) => inst["name"] === "NIFTY" && (inst["instrument_type"] === "CE" || inst["instrument_type"] === "PE"))
    .map((inst) => {
      // KiteConnect v5 returns expiry as Date object or string — normalize to YYYY-MM-DD
      const rawExpiry = inst["expiry"];
      let expiryStr: string;
      if (rawExpiry instanceof Date) {
        expiryStr = `${rawExpiry.getFullYear()}-${String(rawExpiry.getMonth() + 1).padStart(2, "0")}-${String(rawExpiry.getDate()).padStart(2, "0")}`;
      } else if (typeof rawExpiry === "string" && rawExpiry.includes("-")) {
        // Already YYYY-MM-DD format
        expiryStr = rawExpiry.slice(0, 10);
      } else if (typeof rawExpiry === "string") {
        // Parse date string like "Tue Jul 07 2026"
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

  instrumentsCache = niftyOptions;
  instrumentsCacheTime = now;
  logger.info({ count: niftyOptions.length, sampleExpiry: niftyOptions[0]?.expiry }, "kite-option-chain: cached NIFTY option instruments");
  return niftyOptions;
}

/**
 * Get the nearest available NIFTY weekly expiry from Kite's instruments list.
 * Falls back to computed nearest Thursday if instruments haven't been cached yet.
 * Exported so the signal executor can build correct option symbols.
 */
export async function getNearestExpiry(excludeToday = false): Promise<Date> {
  if (instrumentsCache && instrumentsCache.length > 0) {
    const availableExpiries = [...new Set(instrumentsCache.map((i) => i.expiry))].sort();
    const todayStr = formatExpiryDate(new Date());
    const filterFn = excludeToday ? (e: string) => e > todayStr : (e: string) => e >= todayStr;
    const nearest = availableExpiries.find(filterFn) ?? availableExpiries[availableExpiries.length - 1]!;
    // Parse YYYY-MM-DD into a Date at midnight UTC
    const [y, m, d] = nearest.split("-").map(Number);
    return new Date(Date.UTC(y!, m! - 1, d!));
  }
  // Fallback: compute nearest Thursday
  return getNearestWeeklyExpiry();
}

/**
 * Get the nearest weekly Thursday expiry. If today is Thursday (expiry day),
 * always roll to next Thursday — the condor never enters on expiry day.
 */
export function getNearestWeeklyExpiry(): Date {
  const today = new Date();
  const day = today.getDay();
  let daysUntilThursday = (4 - day + 7) % 7;
  if (daysUntilThursday === 0) daysUntilThursday = 7; // today is Thursday → roll to next week
  const expiry = new Date(today);
  expiry.setDate(today.getDate() + daysUntilThursday);
  return expiry;
}

/**
 * Get the next weekly expiry after the nearest one (for re-entries when
 * nearest expiry is too close to gamma cutoff).
 */
export function getNextWeeklyExpiry(): Date {
  const nearest = getNearestWeeklyExpiry();
  const next = new Date(nearest);
  next.setDate(nearest.getDate() + 7);
  return next;
}

/**
 * Format expiry date as YYYY-MM-DD (Kite instrument format).
 */
function formatExpiryDate(expiry: Date): string {
  const y = expiry.getFullYear();
  const m = String(expiry.getMonth() + 1).padStart(2, "0");
  const d = String(expiry.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// ── Black-Scholes IV solver (Newton-Raphson) ─────────────────────────────────

function normCdf(x: number): number {
  // Abramowitz & Stegun approximation
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

function bsCallPrice(S: number, K: number, sigma: number, T: number, r: number): number {
  if (T <= 0 || sigma <= 0) return Math.max(S - K, 0);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
}

/**
 * Solve for implied volatility using Newton-Raphson.
 * @param marketPrice Observed option premium
 * @param S Spot price
 * @param K Strike price
 * @param T Time to expiry in years
 * @param r Risk-free rate
 * @param isCall true for call, false for put
 */
function solveIV(marketPrice: number, S: number, K: number, T: number, r = 0.065, isCall = true): number {
  if (marketPrice <= 0 || T <= 0) return 0;
  let sigma = 0.2; // initial guess 20%
  const maxIter = 50;
  const tolerance = 1e-4;

  for (let i = 0; i < maxIter; i++) {
    const price = isCall ? bsCallPrice(S, K, sigma, T, r) : bsCallPrice(S, K, sigma, T, r) - S + K * Math.exp(-r * T);
    const diff = price - marketPrice;
    if (Math.abs(diff) < tolerance) return sigma;

    // Vega (derivative of call price w.r.t. sigma)
    const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
    const vega = S * Math.sqrt(T) * Math.exp(-0.5 * d1 * d1) / Math.sqrt(2 * Math.PI);
    if (vega < 1e-8) break;

    sigma = sigma - diff / vega;
    sigma = Math.max(sigma, 0.01); // floor at 1%
    sigma = Math.min(sigma, 5.0);  // cap at 500%
  }

  return sigma;
}

// ── Years to weekly expiry ────────────────────────────────────────────────────

function yearsToWeeklyExpiry(): number {
  const now = new Date();
  const day = now.getUTCDay();
  let daysUntilThu = (4 - day + 7) % 7;
  if (daysUntilThu === 0) daysUntilThu = 0;
  const ms = daysUntilThu * 24 * 60 * 60 * 1000;
  return Math.max(ms, 2 * 60 * 60 * 1000) / (365 * 24 * 60 * 60 * 1000);
}

// ── Public: Fetch option chain observation via Kite ──────────────────────────

export interface KiteOptionChainObservation {
  spotPrice: number;
  callOI: number;
  putOI: number;
  optionVolume: number;
  atmIV: number;       // percentage (e.g. 12.5 means 12.5%)
  atmGamma: number;
  pcr: number;
  maxPainStrike: number | null;
  source: "kite";
}

// ── Live tick-fed chain metrics (WebSocket path) ─────────────────────────────
// The KiteTicker feed pushes per-instrument ticks; we keep a token->tick map and
// recompute the chain observation from it. These helpers are shared with the
// legacy getQuote fetch so both paths produce identical results.

/**
 * The NIFTY 50 index instrument token on NSE, used to subscribe to spot.
 * Well-known Kite token (256265); override via env if it ever changes.
 */
export const NIFTY_SPOT_TOKEN = Number(process.env["KITE_NIFTY_SPOT_TOKEN"] ?? 256265);

export interface TickData {
  ltp: number;
  oi: number;
  volume: number; // cumulative-for-day traded volume
}

export interface ResolvedChain {
  expiryStr: string;
  atmStrike: number;
  relevantInstruments: NfoInstrument[];
}

/**
 * Resolve the ATM-centred NIFTY option chain (nearest expiry + ±STRIKE_RANGE
 * strikes) for a given spot price. Returns the instruments to subscribe/aggregate.
 * Uses the cached instrument list, so it is cheap on repeat calls.
 */
export async function resolveNiftyChain(kite: KiteConnect, spotPrice: number): Promise<ResolvedChain | null> {
  if (spotPrice <= 0) return null;

  const instruments = await getNiftyOptionInstruments(kite);
  const availableExpiries = [...new Set(instruments.map((i) => i.expiry))].sort();
  if (availableExpiries.length === 0) return null;

  const todayStr = formatExpiryDate(new Date());
  const expiryStr = availableExpiries.find((e) => e >= todayStr) ?? availableExpiries[availableExpiries.length - 1]!;
  const expiryInstruments = instruments.filter((i) => i.expiry === expiryStr);
  if (expiryInstruments.length === 0) return null;

  const atmStrike = Math.round(spotPrice / STRIKE_INTERVAL) * STRIKE_INTERVAL;
  const minStrike = atmStrike - STRIKE_RANGE * STRIKE_INTERVAL;
  const maxStrike = atmStrike + STRIKE_RANGE * STRIKE_INTERVAL;
  const relevantInstruments = expiryInstruments.filter((i) => i.strike >= minStrike && i.strike <= maxStrike);
  if (relevantInstruments.length === 0) return null;

  return { expiryStr, atmStrike, relevantInstruments };
}

/**
 * Look up the actual Kite tradingsymbol for a NIFTY option given strike, type, and expiry.
 * Kite's symbol format changes between weekly (YYMDD) and monthly (YYMMM) expiries,
 * so building it manually is unreliable. This searches the cached instruments list
 * (which has the real symbols from Kite's API) and returns the exact tradingsymbol.
 * Falls back to a computed YYMDD format if the cache is cold or no match is found.
 */
export function lookupOptionSymbol(strike: number, type: "CE" | "PE", expiry: Date): string {
  if (instrumentsCache && instrumentsCache.length > 0) {
    const expiryStr = formatExpiryDate(expiry);
    const hit = instrumentsCache.find(
      (i) => i.strike === strike && i.instrument_type === type && i.expiry === expiryStr
    );
    if (hit) return hit.tradingsymbol;
  }
  // Fallback: old numeric format (works for weekly expiries)
  const yy = String(expiry.getFullYear()).slice(-2);
  const mm = String(expiry.getMonth() + 1);
  const dd = String(expiry.getDate()).padStart(2, "0");
  return `NIFTY${yy}${mm}${dd}${strike}${type}`;
}

/**
 * Resolve the KiteTicker instrument_token for a NIFTY option trading symbol, using the
 * cached instrument list (fetching it once if cold). Used to subscribe held positions to
 * the market-data feed for tick-driven exits (R5). Returns null if not found.
 */
export async function findInstrumentToken(tradingsymbol: string): Promise<number | null> {
  if (instrumentsCache) {
    const hit = instrumentsCache.find((i) => i.tradingsymbol === tradingsymbol);
    if (hit) return hit.instrument_token;
  }
  const kite = await getGlobalKiteClient();
  if (!kite) return null;
  const insts = await getNiftyOptionInstruments(kite);
  return insts.find((i) => i.tradingsymbol === tradingsymbol)?.instrument_token ?? null;
}

/**
 * Compute the option-chain observation (OI/volume/IV/gamma/PCR/maxPain) from a
 * live token->tick map. Pure — no I/O. Returns null if OI is incomplete.
 * Identical math to the legacy getQuote aggregation (max pain preserved as the
 * strike minimising strike×(ceOI+peOI)).
 */
export function computeChainMetrics(
  tickMap: Map<number, TickData>,
  chain: ResolvedChain,
  spotPrice: number
): KiteOptionChainObservation | null {
  const { atmStrike, relevantInstruments } = chain;

  let callOI = 0;
  let putOI = 0;
  let optionVolume = 0;
  let atmCallLtp = 0;
  const strikeOIMap = new Map<number, { ceOI: number; peOI: number }>();

  for (const inst of relevantInstruments) {
    const tick = tickMap.get(inst.instrument_token);
    const oi = tick?.oi ?? 0;
    const volume = tick?.volume ?? 0;
    const ltp = tick?.ltp ?? 0;

    if (inst.instrument_type === "CE") {
      callOI += oi;
      optionVolume += volume;
      if (inst.strike === atmStrike) atmCallLtp = ltp;
    } else {
      putOI += oi;
      optionVolume += volume;
    }

    const existing = strikeOIMap.get(inst.strike) ?? { ceOI: 0, peOI: 0 };
    if (inst.instrument_type === "CE") existing.ceOI += oi;
    else existing.peOI += oi;
    strikeOIMap.set(inst.strike, existing);
  }

  if (callOI === 0 || putOI === 0) return null;

  const T = yearsToWeeklyExpiry();
  let atmIV = 0;
  if (atmCallLtp > 0) {
    atmIV = solveIV(atmCallLtp, spotPrice, atmStrike, T, 0.065, true) * 100; // percentage
  }
  const atmGamma = atmIV > 0 ? bsGamma(spotPrice, atmStrike, atmIV / 100, T) : 0;

  const pcr = callOI > 0 ? putOI / callOI : 0;

  let maxPainStrike: number | null = null;
  let minPain = Infinity;
  for (const [strike, { ceOI, peOI }] of strikeOIMap) {
    const pain = strike * (ceOI + peOI);
    if (pain < minPain) {
      minPain = pain;
      maxPainStrike = strike;
    }
  }

  return { spotPrice, callOI, putOI, optionVolume, atmIV, atmGamma, pcr, maxPainStrike, source: "kite" };
}

/**
 * Fetch real-time NIFTY option chain data via Kite getQuote() API.
 * Returns null if Kite is unavailable or data is incomplete.
 *
 * Now a thin wrapper: resolves the chain, snapshots quotes into a tick map, and
 * defers to computeChainMetrics() so it stays byte-identical to the WebSocket path.
 * Still used by routes/trading.ts for on-demand fetches.
 */
export async function fetchKiteOptionChain(): Promise<KiteOptionChainObservation | null> {
  const kite = await getGlobalKiteClient();
  if (!kite) {
    logger.warn("kite-option-chain: no Kite client available");
    return null;
  }

  try {
    // 1. Get NIFTY spot price
    const indexQuote = await kite.getQuote(["NSE:NIFTY 50"]) as Record<string, unknown>;
    const niftyData = (indexQuote["NSE:NIFTY 50"] ?? indexQuote) as Record<string, unknown>;
    const spotPrice = Number(niftyData["last_price"] ?? 0);
    if (spotPrice <= 0) {
      logger.warn("kite-option-chain: could not get NIFTY spot price");
      return null;
    }

    // 2. Resolve the ATM-centred chain (nearest expiry + ±STRIKE_RANGE strikes)
    const chain = await resolveNiftyChain(kite, spotPrice);
    if (!chain) {
      logger.warn({ spotPrice }, "kite-option-chain: could not resolve option chain");
      return null;
    }

    // 3. Snapshot quotes into a token->tick map so aggregation shares code with
    //    the WebSocket feed (guarantees identical PCR/maxPain/IV/gamma output).
    const instrumentKeys = chain.relevantInstruments.map((i) => `NFO:${i.tradingsymbol}`);
    const quotes = await kite.getQuote(instrumentKeys) as Record<string, unknown>;

    const tickMap = new Map<number, TickData>();
    for (const inst of chain.relevantInstruments) {
      const quote = (quotes[`NFO:${inst.tradingsymbol}`] ?? {}) as Record<string, unknown>;
      tickMap.set(inst.instrument_token, {
        ltp: Number(quote["last_price"] ?? 0),
        oi: Number(quote["oi"] ?? 0),
        volume: Number(quote["volume"] ?? 0),
      });
    }

    // 4. Aggregate via the shared pure function
    const result = computeChainMetrics(tickMap, chain, spotPrice);
    if (!result) {
      logger.warn("kite-option-chain: zero OI from quotes");
      return null;
    }

    logger.info({
      spotPrice,
      callOI: result.callOI,
      putOI: result.putOI,
      optionVolume: result.optionVolume,
      atmIV: result.atmIV.toFixed(2),
      atmGamma: result.atmGamma.toFixed(6),
      pcr: result.pcr.toFixed(3),
      maxPainStrike: result.maxPainStrike,
      instruments: chain.relevantInstruments.length,
    }, "kite-option-chain: fetched real-time option chain");

    return result;
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err }, "kite-option-chain: fetch failed");
    return null;
  }
}

// NSE India direct scraper — unofficial JSON endpoints (primary data source).
// Fetches: India VIX, FII/DII net flow, F&O Put-Call Ratio, sectoral indices, INR/USD.
// Falls back to Yahoo Finance for price data when NSE endpoints are unavailable.
//
// NSE requires browser-like headers + session cookie handshake on first request.

import { logger } from "../../lib/logger.js";
import type { RegimeFeatures } from "./hmm-regime.js";

// ── NSE HTTP client with session management ───────────────────────────────────

let nseSessionCookie = "";
let sessionExpiresAt = 0;
const USE_NSE_DIRECT = process.env["USE_NSE_DIRECT"] !== "false"; // default true locally, set false on EC2

const NSE_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Referer": "https://www.nseindia.com/",
  "X-Requested-With": "XMLHttpRequest",
  "Connection": "keep-alive",
  "Cache-Control": "no-cache",
};

async function ensureNseSession(): Promise<void> {
  if (!USE_NSE_DIRECT) throw new Error("NSE direct API disabled (USE_NSE_DIRECT=false)");
  if (Date.now() < sessionExpiresAt && nseSessionCookie) return;

  // GET / returns 403 from cloud IPs but /api/marketStatus returns 200 and
  // sets the same anti-bot cookies. See tier3-fetcher.ts:ensureNseSession for
  // the full rationale.
  try {
    const res = await fetch("https://www.nseindia.com/api/marketStatus", {
      headers: {
        "User-Agent": NSE_HEADERS["User-Agent"]!,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.nseindia.com/",
      },
    });
    const cookies = res.headers.get("set-cookie");
    if (cookies && res.ok) {
      nseSessionCookie = cookies
        .split(/,(?=[^,]+=)/)
        .map((c) => c.split(";")[0]!.trim())
        .filter(Boolean)
        .join("; ");
      sessionExpiresAt = Date.now() + 25 * 60 * 1000;
      logger.debug({ status: res.status }, "NSE session refreshed via /api/marketStatus");
    } else {
      logger.warn({ status: res.status }, "NSE marketStatus did not set cookies");
    }
  } catch (err) {
    logger.warn({ err }, "NSE session handshake failed — proceeding without cookie");
  }
}

async function nseGet<T>(path: string): Promise<T> {
  await ensureNseSession();
  const res = await fetch(`https://www.nseindia.com${path}`, {
    headers: {
      ...NSE_HEADERS,
      ...(nseSessionCookie ? { Cookie: nseSessionCookie } : {}),
    },
  });
  if (!res.ok) throw new Error(`NSE ${path} returned HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

// ── India VIX ─────────────────────────────────────────────────────────────────

interface NseVixData {
  data: Array<{ indexSymbol: string; last: number; previousClose: number }>;
}

export interface VixSnapshot {
  current: number;
  previousClose: number;
  change: number;
}

export async function fetchIndiaVix(): Promise<VixSnapshot> {
  const raw = await nseGet<NseVixData>("/api/allIndices");
  const vix = raw.data.find(d => d.indexSymbol === "INDIA VIX");
  if (!vix) throw new Error("India VIX not found in NSE index list");
  return {
    current: vix.last,
    previousClose: vix.previousClose,
    change: vix.last - vix.previousClose,
  };
}

// ── FII / DII flow ────────────────────────────────────────────────────────────

interface NseFiiEntry {
  date: string;
  buyValue: number;
  sellValue: number;
  netValue: number;
  category: "FII" | "DII";
}

interface NseFiiResponse {
  data: NseFiiEntry[];
}

export interface FiiSnapshot {
  latestDate: string;
  fiiNetToday: number;     // ₹ crore
  fiiNetFlow5d: number;    // 5-day rolling sum ₹ crore
  diiNetToday: number;
}

export async function fetchFiiDiiFlow(): Promise<FiiSnapshot> {
  const raw = await nseGet<NseFiiResponse>("/api/fiidiiTradeReact");
  const entries = raw.data ?? [];

  const fiiEntries = entries
    .filter(e => e.category === "FII")
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const diiEntries = entries
    .filter(e => e.category === "DII")
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const fiiNetToday = fiiEntries[0]?.netValue ?? 0;
  const diiNetToday = diiEntries[0]?.netValue ?? 0;
  const fiiNetFlow5d = fiiEntries.slice(0, 5).reduce((s, e) => s + e.netValue, 0);
  const latestDate = fiiEntries[0]?.date ?? "";

  return { latestDate, fiiNetToday, fiiNetFlow5d, diiNetToday };
}

// ── F&O Put-Call Ratio ────────────────────────────────────────────────────────

interface NsePcrResponse {
  totCE: { totOI: number };
  totPE: { totOI: number };
}

export interface PcrSnapshot {
  pcr: number; // put-call ratio by OI; > 1.2 = bearish hedge, < 0.8 = complacency
}

export async function fetchPutCallRatio(): Promise<PcrSnapshot> {
  const raw = await nseGet<NsePcrResponse>("/api/option-chain-indices?symbol=NIFTY");
  const ceOI = raw.totCE?.totOI ?? 1;
  const peOI = raw.totPE?.totOI ?? 1;
  return { pcr: peOI / ceOI };
}

// ── Sectoral index closes ─────────────────────────────────────────────────────

const SECTOR_SYMBOLS = [
  "NIFTY BANK", "NIFTY IT", "NIFTY PHARMA", "NIFTY FMCG",
  "NIFTY AUTO", "NIFTY METAL", "NIFTY REALTY", "NIFTY ENERGY",
];

export interface SectoralClose {
  symbol: string;
  last: number;
  change1dPct: number;
}

export async function fetchSectoralIndices(): Promise<SectoralClose[]> {
  const raw = await nseGet<NseVixData>("/api/allIndices");
  return raw.data
    .filter(d => SECTOR_SYMBOLS.includes(d.indexSymbol))
    .map(d => ({
      symbol: d.indexSymbol,
      last: d.last,
      change1dPct: d.previousClose > 0 ? ((d.last - d.previousClose) / d.previousClose) * 100 : 0,
    }));
}

// ── Sectoral deltas vs NIFTY 50 (live, every 5min) ────────────────────────────

export interface SectorDeltas {
  nifty50PctChange: number;
  bankPctChange: number;
  itPctChange: number;
  pharmaPctChange: number;
  autoPctChange: number;
  // deltas vs NIFTY 50
  bank: number;
  it: number;
  pharma: number;
  auto: number;
}

export async function fetchSectoralDeltas(): Promise<SectorDeltas> {
  const raw = await nseGet<NseVixData>("/api/allIndices");
  const find = (sym: string): number => {
    const row = raw.data.find(d => d.indexSymbol === sym);
    if (!row || row.previousClose <= 0) return 0;
    return ((row.last - row.previousClose) / row.previousClose) * 100;
  };
  const nifty50 = find("NIFTY 50");
  const bank = find("NIFTY BANK");
  const it = find("NIFTY IT");
  const pharma = find("NIFTY PHARMA");
  const auto = find("NIFTY AUTO");
  return {
    nifty50PctChange: nifty50,
    bankPctChange: bank,
    itPctChange: it,
    pharmaPctChange: pharma,
    autoPctChange: auto,
    bank: bank - nifty50,
    it: it - nifty50,
    pharma: pharma - nifty50,
    auto: auto - nifty50,
  };
}

// ── Advance/Decline ratio (live, every 5min) ──────────────────────────────────

export interface AdvanceDeclineSnapshot {
  advance: number;
  decline: number;
  ratio: number; // adv / dec
}

interface NseAdvDecResponse {
  data?: Array<{ advance?: number; decline?: number }>;
}

export async function fetchADRatio(): Promise<AdvanceDeclineSnapshot> {
  const raw = await nseGet<NseAdvDecResponse>("/api/live-analysis-variations?index=nse500");
  const entry = raw.data?.[0] ?? {};
  const advance = entry.advance ?? 0;
  const decline = entry.decline ?? 0;
  const ratio = decline > 0 ? advance / decline : 0;
  return { advance, decline, ratio };
}

// ── INR/USD from Yahoo Finance (NSE doesn't expose FX directly) ───────────────

interface YahooQuote {
  chart: { result: Array<{ meta: { regularMarketPrice: number; chartPreviousClose: number } }> };
}

async function fetchInrUsd(): Promise<{ current: number; change5dPct: number }> {
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/USDINR=X?interval=1d&range=10d";
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Yahoo FX fetch failed: ${res.status}`);
  const raw = await res.json() as YahooQuote;
  const meta = raw.chart.result[0]?.meta;
  if (!meta) throw new Error("Yahoo FX: no data");
  const current = meta.regularMarketPrice;
  const prev5d = meta.chartPreviousClose;
  return { current, change5dPct: prev5d > 0 ? ((current - prev5d) / prev5d) * 100 : 0 };
}

// ── NIFTY realized volatility (10-day) ───────────────────────────────────────

async function fetchNiftyRealVol(): Promise<{ vol10d: number; closes: number[] }> {
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=1d&range=30d";
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Yahoo NIFTY fetch failed: ${res.status}`);
  interface YahooOHLC {
    chart: { result: Array<{ indicators: { quote: Array<{ close: number[] }> } }> };
  }
  const raw = await res.json() as YahooOHLC;
  const closes = (raw.chart.result[0]?.indicators.quote[0]?.close ?? []).filter(Boolean);
  if (closes.length < 11) throw new Error("Not enough NIFTY closes for vol");

  const last11 = closes.slice(-11);
  const returns = last11.slice(1).map((c, i) => Math.log(c / last11[i]!));
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  const dailyVol = Math.sqrt(variance);
  const annualisedVol = dailyVol * Math.sqrt(252) * 100;

  return { vol10d: annualisedVol, closes: closes.slice(-5) };
}

// ── Composite: build RegimeFeatures[] rolling window ─────────────────────────

const FEATURES_CACHE: { data: RegimeFeatures[]; expiresAt: number } = { data: [], expiresAt: 0 };

export async function fetchRegimeFeatures(lookbackDays = 20): Promise<RegimeFeatures[]> {
  if (Date.now() < FEATURES_CACHE.expiresAt && FEATURES_CACHE.data.length > 0) {
    return FEATURES_CACHE.data;
  }

  const [vix, pcr, inrUsd, niftyVol] = await Promise.allSettled([
    fetchIndiaVix(),
    fetchPutCallRatio(),
    fetchInrUsd(),
    fetchNiftyRealVol(),
  ]);

  const vixData   = vix.status   === "fulfilled" ? vix.value   : { current: 16, change: 0, previousClose: 16 };
  const pcrData   = pcr.status   === "fulfilled" ? pcr.value   : { pcr: 1.0 };
  const fxData    = inrUsd.status === "fulfilled" ? inrUsd.value : { current: 83.5, change5dPct: 0 };
  const volData   = niftyVol.status === "fulfilled" ? niftyVol.value : { vol10d: 14.0, closes: [] };

  // Build a single "today" feature snapshot; rolling window is filled from cache + today
  const todayFeature: RegimeFeatures = {
    vixLevel: vixData.current,
    vixChange5d: vixData.change,
    pcrIntraday: pcrData.pcr,
    niftyRealVol10d: volData.vol10d,
    inrUsdChange5d: fxData.change5dPct,
  };

  // Retain up to lookbackDays-1 prior snapshots plus today
  const prior = FEATURES_CACHE.data.slice(-(lookbackDays - 1));
  let features = [...prior, todayFeature];

  // HMM needs ≥5 rows. On cold start the cache is empty — pad by repeating
  // today's snapshot so the model can decode a regime immediately. Real
  // history accumulates as cycles run.
  const MIN_HMM_ROWS = 5;
  while (features.length < MIN_HMM_ROWS) {
    features = [todayFeature, ...features];
  }

  FEATURES_CACHE.data = features;
  FEATURES_CACHE.expiresAt = Date.now() + 60 * 60 * 1000; // 1h cache

  logger.debug({ regime_features: todayFeature, rowCount: features.length }, "NSE features fetched");
  return features;
}

// ── Legacy: daily close prices (for backward compat with nse-scraper) ─────────

export interface DailyClose {
  date: string;
  close: number;
  returnPct: number;
}

export async function fetchNSEPriceData(symbol: string, days = 35): Promise<DailyClose[]> {
  const yahooSymbol = symbol.endsWith(".NS") ? symbol : `${symbol}.NS`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=${Math.ceil(days * 1.5)}d`;

  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Yahoo price fetch failed for ${symbol}: ${res.status}`);

  interface YahooTS {
    chart: {
      result: Array<{
        timestamp: number[];
        indicators: { quote: Array<{ close: number[] }> };
      }>;
    };
  }
  const raw = await res.json() as YahooTS;
  const result = raw.chart.result[0];
  if (!result) throw new Error(`No data for ${symbol}`);

  const timestamps = result.timestamp;
  const closes = result.indicators.quote[0]?.close ?? [];

  const pairs: DailyClose[] = [];
  for (let i = 1; i < timestamps.length && i < closes.length; i++) {
    if (!closes[i] || !closes[i - 1]) continue;
    pairs.push({
      date: new Date(timestamps[i]! * 1000).toISOString().slice(0, 10),
      close: closes[i]!,
      returnPct: ((closes[i]! - closes[i - 1]!) / closes[i - 1]!) * 100,
    });
  }

  return pairs.slice(-days);
}

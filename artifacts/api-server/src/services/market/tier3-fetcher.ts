// Tier 3 Data Fetcher — splits market data into two cadences:
//
//   1. Session priors (FII/DII cash flow, delivery %, FII participant OI):
//      Published by NSE EOD. Loaded once at session open (09:15 IST) and held
//      constant all day. These are CONTEXT priors, not intraday signals.
//
//   2. Live snapshot (VIX, PCR, A/D ratio, sectoral deltas):
//      Genuinely update every NSE tick. Fetched on the 5-minute cycle.
//
// fetchTier3Snapshot() composes both into the Tier3Snapshot shape consumed by
// market-agent.ts and the ensemble layer.

import { logger } from "../../lib/logger.js";
import {
  fetchIndiaVix,
  fetchFiiDiiFlow,
  fetchADRatio,
  fetchSectoralDeltas,
  firecrawlFetchJson,
  fetchSGXNiftyFirecrawl,
  fetchOptionChainPcrFirecrawl,
  fetchNseAllIndicesFirecrawl,
  fetchPcrFromUpstox,
  fetchMaxPainFromNiftyInvest,
  type SectorDeltas,
} from "./nse-direct-scraper.js";

const USE_NSE_DIRECT = process.env["USE_NSE_DIRECT"] !== "false"; // default true locally, set false on EC2

// ── Public types ──────────────────────────────────────────────────────────────

export interface SessionPriors {
  fiiNetFlowCrore: number;
  diiNetFlowCrore: number;
  fiiDataDate: string;
  fiiIsStale: boolean;
  deliveryPct: number | null;
  deliveryDate: string | null;
  fiiParticipantOINet: number | null; // FII long index futures − FII short index futures
  sgxNiftyChangePct: number | null;
  fetchedAt: string;
  tradingDate: string;
}

export interface LiveSnapshot {
  indiaVix: number | null;
  indiaVixPreviousClose: number | null;
  indiaVix5dChange: number | null;
  putCallRatio: number | null;
  advanceDeclineRatio: number | null;
  advanceCount: number | null;
  declineCount: number | null;
  sectorDeltas: SectorDeltas | null;
  // Macro anchors live too (Yahoo, available 24/7)
  inrUsdRate: number;
  inrUsd5dChangePct: number;
  yield10Y: number;
  yield10Y5dChangeBps: number;
  crudeBrent: number;
  crude5dChangePct: number;
  // Options structure
  impliedVolPct: number | null;
  openInterestChange: number;
  maxPainStrike: number | null;
  maxPainDistancePct: number | null;
  fetchedAt: string;
}

export interface Tier3Snapshot {
  // --- Institutional flows (EOD prior) ---
  fiiNetCrore: number;
  diiNetCrore: number;
  fiiDataDate: string;
  fiiIsStale: boolean;
  fiiParticipantOINet: number | null;

  // --- Delivery quality (EOD prior) ---
  deliveryPct: number | null;
  deliveryDate: string | null;

  // --- Options market (live) ---
  putCallRatio: number | null;
  impliedVolPct: number | null;
  openInterestChange: number;

  // --- Breadth (live) ---
  advanceCount: number | null;
  declineCount: number | null;
  advanceDeclineRatio: number | null;

  // --- Macro anchors (live) ---
  inrUsdRate: number;
  inrUsd5dChangePct: number;
  yield10Y: number;
  yield10Y5dChangeBps: number;
  crudeBrent: number;
  crude5dChangePct: number;

  // --- VIX (live) ---
  indiaVix: number | null;
  indiaVix5dChange: number | null;

  // --- Sectoral deltas (live) ---
  sectorDeltas: SectorDeltas | null;
  sectorDeltaScore: number;

  // --- Max Pain (live from option chain) ---
  maxPainStrike: number | null;
  maxPainDistancePct: number | null;

  // --- SGX Nifty (session prior, pre-market) ---
  sgxNiftyChangePct: number | null;

  // --- Short covering signal (derived) ---
  shortCoveringSignal: "none" | "covering" | "unwinding";

  fetchedAt: string;
}

// ── In-memory session prior cache (set once per session by scheduler) ─────────

let _sessionPriors: SessionPriors | null = null;

export function setSessionPriors(p: SessionPriors): void {
  _sessionPriors = p;
}

export function getSessionPriors(): SessionPriors | null {
  return _sessionPriors;
}

export function clearSessionPriors(): void {
  _sessionPriors = null;
}

// ── OI cache for computing change vs prior session ────────────────────────────

let _priorOiCache: { totalOi: number; fetchedAt: number } | null = null;
const OI_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day

// ── NSE session helpers (reuse headers from nse-direct-scraper) ───────────────

let nseSessionCookie = "";
let sessionExpiresAt = 0;

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
  if (Date.now() < sessionExpiresAt && nseSessionCookie) return;
  // NSE blocks GET / on cloud IPs (403). The anti-bot cookies (bm_sz, akamai)
  // are also set by /api/marketStatus — which returns 200 from EC2/other clouds.
  // Use that path instead of the homepage so the cookie handshake actually
  // succeeds, unlocking option-chain (PCR), allIndices (VIX, sectoral) and
  // live-analysis-variations (ADR) on cloud deployments.
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
      // Keep ALL set-cookie pairs, not just the first one — NSE sends multiple
      // (bm_sz, ak_bmsc, _abck, nsit) and the API needs them together.
      nseSessionCookie = cookies
        .split(/,(?=[^,]+=)/)
        .map((c) => c.split(";")[0]!.trim())
        .filter(Boolean)
        .join("; ");
      sessionExpiresAt = Date.now() + 25 * 60 * 1000;
      logger.debug({ status: res.status }, "tier3-fetcher: NSE session refreshed via /api/marketStatus");
    } else {
      logger.warn({ status: res.status }, "tier3-fetcher: NSE marketStatus did not set cookies");
    }
  } catch (err) {
    logger.warn({ err }, "tier3-fetcher: NSE session handshake failed");
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

// ── Yahoo Finance helper ──────────────────────────────────────────────────────

interface YahooChartResult {
  chart: {
    result?: Array<{
      meta?: { regularMarketPrice?: number; chartPreviousClose?: number };
      timestamp?: number[];
      indicators?: { quote?: Array<{ close?: (number | null)[] }> };
    }>;
    error?: { description?: string };
  };
}

async function fetchYahooChart(symbol: string, range: string): Promise<YahooChartResult> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`Yahoo ${symbol} fetch failed: ${res.status}`);
    return res.json() as Promise<YahooChartResult>;
  } catch (err) {
    logger.warn({ symbol, err: err instanceof Error ? err.message : err }, "Yahoo direct fetch failed — trying Firecrawl");
    return firecrawlFetchJson<YahooChartResult>(url);
  }
}

function getLatestClose(chart: YahooChartResult): number | null {
  const result = chart.chart.result?.[0];
  if (!result) return null;
  const meta = result.meta;
  if (meta?.regularMarketPrice != null) return meta.regularMarketPrice;
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  for (let i = closes.length - 1; i >= 0; i--) {
    if (closes[i] != null) return closes[i]!;
  }
  return null;
}

function get5dChangePct(chart: YahooChartResult): number {
  const result = chart.chart.result?.[0];
  if (!result) return 0;
  const meta = result.meta;
  const current = meta?.regularMarketPrice ?? meta?.chartPreviousClose ?? 0;
  const prev = meta?.chartPreviousClose ?? 0;
  if (!current || !prev) return 0;
  return ((current - prev) / prev) * 100;
}

function getCloses(chart: YahooChartResult): number[] {
  const result = chart.chart.result?.[0];
  if (!result) return [];
  return (result.indicators?.quote?.[0]?.close ?? []).filter((c): c is number => c != null);
}

// ── EOD-only fetchers (called once at 09:15 IST) ──────────────────────────────

async function fetchPreviousDayFIIDII(): Promise<{ fii: number; dii: number; date: string }> {
  if (!USE_NSE_DIRECT) return { fii: 0, dii: 0, date: "" };
  try {
    const data = await fetchFiiDiiFlow();
    return { fii: data.fiiNetToday, dii: data.diiNetToday, date: data.latestDate };
  } catch (err) {
    logger.warn({ err }, "tier3-fetcher: previous day FII/DII fetch failed");
    return { fii: 0, dii: 0, date: "" };
  }
}

async function fetchPreviousDayDelivery(): Promise<{ pct: number | null; date: string | null }> {
  if (!USE_NSE_DIRECT) return { pct: null, date: null };
  try {
    // Bhav copy CSV is only available after ~18:00 IST. At 09:15 IST we read
    // the PREVIOUS trading day's bhav copy as the session prior.
    const dateStr = getPreviousTradingDate().replace(/-/g, "");
    const url = `https://archives.nseindia.com/products/content/sec_bhavdata_full_${dateStr}.csv`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return { pct: null, date: null };
    const text = await res.text();
    const lines = text.split("\n").slice(1);
    let totalQty = 0;
    let totalDelQty = 0;
    for (const line of lines) {
      const cols = line.split(",");
      if (cols.length < 14) continue;
      const qty = parseFloat(cols[8] ?? "0");
      const delQty = parseFloat(cols[12] ?? "0");
      if (!isNaN(qty) && !isNaN(delQty) && qty > 0) {
        totalQty += qty;
        totalDelQty += delQty;
      }
    }
    if (totalQty === 0) return { pct: null, date: null };
    return { pct: (totalDelQty / totalQty) * 100, date: getPreviousTradingDate() };
  } catch (err) {
    logger.warn({ err }, "tier3-fetcher: previous day delivery fetch failed");
    return { pct: null, date: null };
  }
}

interface FoParticipantRow {
  clientType?: string;
  futIdxLong?: number;
  futIdxShort?: number;
}

async function fetchPreviousDayParticipantOI(): Promise<number | null> {
  if (!USE_NSE_DIRECT) return null;
  try {
    // NSE F&O participant-wise OI report
    const raw = await nseGet<{ data?: FoParticipantRow[] }>("/api/fii-participant-oi");
    const fii = raw.data?.find(r => (r.clientType ?? "").toUpperCase().startsWith("FII"));
    if (!fii) return null;
    const long = fii.futIdxLong ?? 0;
    const short = fii.futIdxShort ?? 0;
    return long - short;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "tier3-fetcher: FII participant OI fetch failed");
    return null;
  }
}

async function fetchSGXNifty(): Promise<{ changePct: number | null }> {
  try {
    const chart = await fetchYahooChart("IN1!", "2d");
    const closes = getCloses(chart);
    if (closes.length < 2) {
      // Fallback: try ^NSEI pre-market
      const fallbackChart = await fetchYahooChart("%5ENSEI", "2d");
      const fallbackCloses = getCloses(fallbackChart);
      if (fallbackCloses.length < 2) throw new Error("Yahoo SGX Nifty: no data");
      return { changePct: ((fallbackCloses[1]! - fallbackCloses[0]!) / fallbackCloses[0]!) * 100 };
    }
    return { changePct: ((closes[1]! - closes[0]!) / closes[0]!) * 100 };
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "tier3-fetcher: Yahoo SGX Nifty failed — trying Firecrawl");
    return fetchSGXNiftyFirecrawl();
  }
}

export function getPreviousTradingDate(): string {
  // Walk back from today, skip weekends. (NSE holiday list ignored — best-effort.)
  const d = new Date();
  d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

export async function fetchSessionPriors(): Promise<SessionPriors> {
  logger.info("tier3-fetcher: loading EOD session priors (once-per-session)");
  const [fii, delivery, participantOI, sgxNifty] = await Promise.allSettled([
    fetchPreviousDayFIIDII(),
    fetchPreviousDayDelivery(),
    fetchPreviousDayParticipantOI(),
    fetchSGXNifty(),
  ]);
  const fiiData = fii.status === "fulfilled" ? fii.value : { fii: 0, dii: 0, date: "" };
  const delData = delivery.status === "fulfilled" ? delivery.value : { pct: null, date: null };
  const poi = participantOI.status === "fulfilled" ? participantOI.value : null;
  const sgxData = sgxNifty.status === "fulfilled" ? sgxNifty.value : { changePct: null };

  const priors: SessionPriors = {
    fiiNetFlowCrore: fiiData.fii,
    diiNetFlowCrore: fiiData.dii,
    fiiDataDate: fiiData.date,
    fiiIsStale: fiiData.date ? isBeforeYesterday(fiiData.date) : true,
    deliveryPct: delData.pct,
    deliveryDate: delData.date,
    fiiParticipantOINet: poi,
    sgxNiftyChangePct: sgxData.changePct,
    fetchedAt: new Date().toISOString(),
    tradingDate: getPreviousTradingDate(),
  };
  logger.info({
    fiiNet: priors.fiiNetFlowCrore,
    diiNet: priors.diiNetFlowCrore,
    deliveryPct: priors.deliveryPct,
    fiiParticipantOINet: priors.fiiParticipantOINet,
    sgxNiftyChangePct: priors.sgxNiftyChangePct,
    tradingDate: priors.tradingDate,
  }, "tier3-fetcher: session priors loaded — frozen for today");
  return priors;
}

// ── Live fetchers (called every 5min) ─────────────────────────────────────────

async function fetchOptionChainFull(): Promise<{
  pcr: number | null;
  atmIv: number | null;
  totalOi: number;
  maxPainStrike: number | null;
  maxPainDistancePct: number | null;
}> {
  // Firecrawl is PRIMARY via nseGet (works on EC2); NSE direct is fallback.
  // Dedicated Firecrawl fallbacks (Upstox PCR + NiftyInvest Max Pain) if both fail.
  if (USE_NSE_DIRECT) {
    try {
      interface OptionChainRecord {
        strikePrice: number;
        CE?: { openInterest?: number; impliedVolatility?: number };
        PE?: { openInterest?: number };
      }
      interface OptionChainResponse {
        records?: { underlyingValue?: number; data?: OptionChainRecord[] };
        filtered?: { CE?: { totOI?: number }; PE?: { totOI?: number }; data?: OptionChainRecord[] };
      }

      const raw = await nseGet<OptionChainResponse>("/api/option-chain-v3?symbol=NIFTY");
      let ceTotOi = raw.filtered?.CE?.totOI ?? 0;
      let peTotOi = raw.filtered?.PE?.totOI ?? 0;
      if (ceTotOi === 0 || peTotOi === 0) {
        for (const rec of raw.records?.data ?? []) {
          ceTotOi += rec.CE?.openInterest ?? 0;
          peTotOi += rec.PE?.openInterest ?? 0;
        }
      }
      if (ceTotOi === 0) throw new Error("option-chain-v3: no CE openInterest");
      const pcr = peTotOi / ceTotOi;

      const underlying = raw.records?.underlyingValue ?? 0;
      const data = raw.filtered?.data ?? raw.records?.data ?? [];

      let atmIv = 0;
      if (underlying > 0 && data.length > 0) {
        let minDiff = Infinity;
        for (const rec of data) {
          const diff = Math.abs(rec.strikePrice - underlying);
          if (diff < minDiff) {
            minDiff = diff;
            atmIv = rec.CE?.impliedVolatility ?? 0;
          }
        }
      }

      let maxPainStrike: number | null = null;
      let maxPainDistancePct: number | null = null;
      if (underlying > 0 && data.length > 0) {
        let minPain = Infinity;
        for (const rec of data) {
          const ceOi = rec.CE?.openInterest ?? 0;
          const peOi = rec.PE?.openInterest ?? 0;
          const strike = rec.strikePrice;
          const pain = strike * (ceOi + peOi);
          if (pain < minPain) {
            minPain = pain;
            maxPainStrike = strike;
          }
        }
        if (maxPainStrike !== null && maxPainStrike > 0) {
          maxPainDistancePct = ((underlying - maxPainStrike) / maxPainStrike) * 100;
        }
      }

      const totalOi = ceTotOi + peTotOi;
      return { pcr, atmIv, totalOi, maxPainStrike, maxPainDistancePct };
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, "tier3-fetcher: NSE direct option chain failed — trying Firecrawl");
    }
  }
  // Firecrawl fallback: Upstox for PCR, NiftyInvest for Max Pain (EC2/cloud IPs)
  try {
    const [{ pcr }, { maxPainStrike, maxPainDistancePct }] = await Promise.all([
      fetchPcrFromUpstox(),
      fetchMaxPainFromNiftyInvest(),
    ]);
    return { pcr, atmIv: null, totalOi: 0, maxPainStrike, maxPainDistancePct };
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "tier3-fetcher: Upstox/NiftyInvest fallback failed");
    return { pcr: null, atmIv: null, totalOi: 0, maxPainStrike: null, maxPainDistancePct: null };
  }
}

async function fetchInrUsdFull(): Promise<{ rate: number; change5dPct: number }> {
  try {
    const chart = await fetchYahooChart("USDINR=X", "10d");
    const rate = getLatestClose(chart) ?? 83.5;
    const change5dPct = get5dChangePct(chart);
    return { rate, change5dPct };
  } catch (err) {
    logger.warn({ err }, "tier3-fetcher: INR/USD fetch failed");
    return { rate: 83.5, change5dPct: 0 };
  }
}

async function fetchCrudeBrent(): Promise<{ price: number; change5dPct: number }> {
  try {
    const chart = await fetchYahooChart("BZ=F", "10d");
    const price = getLatestClose(chart) ?? 82.0;
    const change5dPct = get5dChangePct(chart);
    return { price, change5dPct };
  } catch (err) {
    logger.warn({ err }, "tier3-fetcher: Brent crude fetch failed");
    return { price: 82.0, change5dPct: 0 };
  }
}

async function fetchYield10Y(): Promise<{ yield: number; change5dBps: number }> {
  try {
    const chart = await fetchYahooChart("^IRX", "10d");
    const current = getLatestClose(chart) ?? 7.0;
    const closes = getCloses(chart);
    if (closes.length >= 6) {
      const prev5 = closes[closes.length - 6]!;
      const changeBps = (current - prev5) * 100;
      return { yield: current, change5dBps: changeBps };
    }
    return { yield: current, change5dBps: 0 };
  } catch (err) {
    logger.warn({ err }, "tier3-fetcher: 10Y yield fetch failed");
    return { yield: 7.0, change5dBps: 0 };
  }
}

async function fetchIndiaVixYahoo(): Promise<{ current: number; previousClose: number; change: number } | null> {
  try {
    const chart = await fetchYahooChart("^INDIAVIX", "10d");
    const closes = getCloses(chart);
    if (closes.length < 2) return null;
    const current = closes[closes.length - 1]!;
    const prevClose = closes[closes.length - 2]!;
    const firstClose = closes[0]!;
    return { current, previousClose: prevClose, change: current - firstClose };
  } catch (err) {
    logger.warn({ err }, "tier3-fetcher: Yahoo VIX fetch failed");
    return null;
  }
}

export async function fetchLiveSnapshot(): Promise<LiveSnapshot> {
  // Firecrawl is PRIMARY for VIX + AD + sectoral (works on EC2 where NSE blocks IPs).
  // NSE direct is fallback for local dev. Correct index: NIFTY 50 (not NSE500).
  let vixData: { current: number | null; previousClose: number | null; change: number | null };
  let adrData: { advance: number; decline: number; ratio: number } = { advance: 0, decline: 0, ratio: 0 };
  let sectorData: SectorDeltas | null = null;

  // 1. Try Firecrawl allIndices first (single call gets VIX + Nifty50 AD + sectoral)
  const allIdx = await fetchNseAllIndicesFirecrawl();
  if (allIdx.vix !== null && allIdx.advances !== null && allIdx.declines !== null) {
    vixData = {
      current: allIdx.vix,
      previousClose: null,
      change: null,
    };
    adrData = {
      advance: allIdx.advances,
      decline: allIdx.declines,
      ratio: allIdx.declines > 0 ? allIdx.advances / allIdx.declines : 0,
    };
    // Derive sectoral deltas from bankNifty and niftyIt vs nifty50
    if (allIdx.nifty50 && allIdx.bankNifty && allIdx.niftyIt) {
      const nifty50Pct = 0;
      const bankPct = ((allIdx.bankNifty - allIdx.nifty50) / allIdx.nifty50) * 100;
      const itPct = ((allIdx.niftyIt - allIdx.nifty50) / allIdx.nifty50) * 100;
      sectorData = {
        nifty50PctChange: nifty50Pct,
        bankPctChange: bankPct,
        itPctChange: itPct,
        pharmaPctChange: 0,
        autoPctChange: 0,
        bank: bankPct,
        it: itPct,
        pharma: 0,
        auto: 0,
      };
    }
    logger.info({ vix: allIdx.vix, advances: allIdx.advances, declines: allIdx.declines }, "tier3-fetcher: Firecrawl allIndices primary succeeded");
  } else {
    // 2. Fallback to NSE direct (local dev only)
    logger.warn("Firecrawl allIndices incomplete — falling back to NSE direct");
    const [vixDirect, adrDirect, sectorDirect] = await Promise.allSettled([
      fetchIndiaVix(),
      fetchADRatio(),
      fetchSectoralDeltas(),
    ]);
    vixData = vixDirect.status === "fulfilled" ? vixDirect.value : { current: null, previousClose: null, change: null };
    adrData = adrDirect.status === "fulfilled" ? adrDirect.value : { advance: 0, decline: 0, ratio: 0 };
    sectorData = sectorDirect.status === "fulfilled" ? sectorDirect.value : null;
  }

  // Option chain, FX, crude, yields are independent of NSE/Firecrawl choice
  const optDirect = await fetchOptionChainFull();
  const [inrUsd, crude, yield10y] = await Promise.allSettled([
    fetchInrUsdFull(),
    fetchCrudeBrent(),
    fetchYield10Y(),
  ]);

  const optData = optDirect ?? { pcr: null, atmIv: null, totalOi: 0, maxPainStrike: null as number | null, maxPainDistancePct: null as number | null };
  const fxData = inrUsd.status === "fulfilled" ? inrUsd.value : { rate: 83.5, change5dPct: 0 };
  const crudeData = crude.status === "fulfilled" ? crude.value : { price: 82.0, change5dPct: 0 };
  const yieldData = yield10y.status === "fulfilled" ? yield10y.value : { yield: 7.0, change5dBps: 0 };

  let oiChange = 0;
  if (_priorOiCache && Date.now() - _priorOiCache.fetchedAt < OI_CACHE_TTL_MS && _priorOiCache.totalOi > 0) {
    oiChange = ((optData.totalOi - _priorOiCache.totalOi) / _priorOiCache.totalOi) * 100;
  }
  _priorOiCache = { totalOi: optData.totalOi, fetchedAt: Date.now() };

  return {
    indiaVix: vixData.current,
    indiaVixPreviousClose: vixData.previousClose,
    indiaVix5dChange: vixData.change ?? null,
    putCallRatio: optData.pcr,
    advanceDeclineRatio: adrData.ratio > 0 ? adrData.ratio : null,
    advanceCount: adrData.advance > 0 ? adrData.advance : null,
    declineCount: adrData.decline > 0 ? adrData.decline : null,
    sectorDeltas: sectorData,
    inrUsdRate: fxData.rate,
    inrUsd5dChangePct: fxData.change5dPct,
    yield10Y: yieldData.yield,
    yield10Y5dChangeBps: yieldData.change5dBps,
    crudeBrent: crudeData.price,
    crude5dChangePct: crudeData.change5dPct,
    impliedVolPct: optData.atmIv,
    openInterestChange: oiChange,
    maxPainStrike: optData.maxPainStrike ?? null,
    maxPainDistancePct: optData.maxPainDistancePct ?? null,
    fetchedAt: new Date().toISOString(),
  };
}

// ── Short covering signal helper ──────────────────────────────────────────────

function computeShortCoveringSignal(
  pcr: number | null,
  oiChange: number,
  vix5dChange: number
): "none" | "covering" | "unwinding" {
  if (pcr === null) return "none";
  // covering: high PCR + falling OI + falling VIX = shorts buying back
  if (pcr > 1.0 && oiChange < 0 && vix5dChange < 0) return "covering";
  // unwinding: low PCR + rising OI + rising VIX = fresh shorts entering
  if (pcr < 0.9 && oiChange > 0 && vix5dChange > 0) return "unwinding";
  return "none";
}

// ── Sector delta score helper ────────────────────────────────────────────────

export function computeSectorDeltaScore(sectorDeltas: SectorDeltas | null): number {
  if (!sectorDeltas) return 0;
  const bankLead = sectorDeltas.bank;   // already vs NIFTY 50
  const itSignal = sectorDeltas.it;
  const raw = (bankLead * 0.6) + (itSignal * 0.4);
  return Math.max(-1, Math.min(1, raw / 2.0));
}

// ── Staleness helpers ─────────────────────────────────────────────────────────

function daysSince(dateStr: string): number {
  const d = new Date(dateStr);
  const now = new Date();
  return Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
}

function isBeforeYesterday(dateStr: string): boolean {
  const d = new Date(dateStr);
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);
  return d.getTime() < yesterday.getTime();
}

// ── Composite snapshot (live + cached priors) ─────────────────────────────────

export async function fetchTier3Snapshot(): Promise<Tier3Snapshot> {
  logger.info("tier3-fetcher: fetching live snapshot");

  // If priors haven't been loaded yet (e.g. process started mid-session), lazy-load once.
  if (!_sessionPriors) {
    try {
      _sessionPriors = await fetchSessionPriors();
    } catch (err) {
      logger.warn({ err }, "tier3-fetcher: lazy session prior load failed; using empty priors");
    }
  }

  const live = await fetchLiveSnapshot();
  const priors = _sessionPriors;

  const sectorDeltaScore = computeSectorDeltaScore(live.sectorDeltas);

  const shortCoveringSignal = computeShortCoveringSignal(
    live.putCallRatio,
    live.openInterestChange,
    live.indiaVix5dChange ?? 0
  );

  const snapshot: Tier3Snapshot = {
    fiiNetCrore: priors?.fiiNetFlowCrore ?? 0,
    diiNetCrore: priors?.diiNetFlowCrore ?? 0,
    fiiDataDate: priors?.fiiDataDate ?? "",
    fiiIsStale: priors?.fiiIsStale ?? true,
    fiiParticipantOINet: priors?.fiiParticipantOINet ?? null,

    deliveryPct: priors?.deliveryPct ?? null,
    deliveryDate: priors?.deliveryDate ?? null,

    putCallRatio: live.putCallRatio,
    impliedVolPct: live.impliedVolPct,
    openInterestChange: live.openInterestChange,

    advanceCount: live.advanceCount,
    declineCount: live.declineCount,
    advanceDeclineRatio: live.advanceDeclineRatio,

    inrUsdRate: live.inrUsdRate,
    inrUsd5dChangePct: live.inrUsd5dChangePct,
    yield10Y: live.yield10Y,
    yield10Y5dChangeBps: live.yield10Y5dChangeBps,
    crudeBrent: live.crudeBrent,
    crude5dChangePct: live.crude5dChangePct,

    indiaVix: live.indiaVix,
    indiaVix5dChange: live.indiaVix5dChange,

    sectorDeltas: live.sectorDeltas,
    sectorDeltaScore,

    maxPainStrike: live.maxPainStrike,
    maxPainDistancePct: live.maxPainDistancePct,
    sgxNiftyChangePct: priors?.sgxNiftyChangePct ?? null,
    shortCoveringSignal,

    fetchedAt: new Date().toISOString(),
  };

  if (snapshot.fiiDataDate && daysSince(snapshot.fiiDataDate) > 1) {
    snapshot.fiiIsStale = true;
  }
  if (snapshot.deliveryDate && daysSince(snapshot.deliveryDate) > 1) {
    snapshot.deliveryPct = null;
  }

  logger.info({
    fiiNet: snapshot.fiiNetCrore,
    diiNet: snapshot.diiNetCrore,
    pcr: snapshot.putCallRatio !== null ? snapshot.putCallRatio.toFixed(2) : "N/A",
    adr: snapshot.advanceDeclineRatio !== null ? snapshot.advanceDeclineRatio.toFixed(2) : "N/A",
    vix: snapshot.indiaVix !== null ? snapshot.indiaVix : "N/A",
    bankDelta: snapshot.sectorDeltas?.bank?.toFixed(2) ?? "N/A",
    itDelta: snapshot.sectorDeltas?.it?.toFixed(2) ?? "N/A",
    sectorScore: sectorDeltaScore.toFixed(2),
  }, "tier3-fetcher: snapshot complete");

  return snapshot;
}

// ── Tier3Score: live signals dominate (0.85), priors are context (0.15) ──────

export function computeTier3Score(s: Tier3Snapshot): number {
  let liveScore = 0;
  let liveWeight = 0;

  // Live signals — total weight 0.85
  if (s.putCallRatio !== null) {
    // Short covering: high PCR + falling OI = bullish (shorts buying back).
    // Otherwise: PCR < 0.8 = bullish complacency; > 1.1 = bearish hedging.
    let pcrScore = clamp((1.0 - s.putCallRatio) / 0.5, -1, 1);
    if (s.shortCoveringSignal === "covering") {
      // Invert: high PCR is bullish during short covering
      pcrScore = clamp((s.putCallRatio - 1.0) / 0.5, -1, 1);
    }
    liveScore += pcrScore * 0.30;
    liveWeight += 0.30;
  }

  if (s.advanceDeclineRatio !== null) {
    const adrScore = clamp((s.advanceDeclineRatio - 1.0) / 0.5, -1, 1);
    liveScore += adrScore * 0.25;
    liveWeight += 0.25;
  }

  if (s.indiaVix5dChange !== null) {
    // Falling VIX = bullish; rising = bearish.
    const vixScore = clamp(-s.indiaVix5dChange / 2.0, -1, 1);
    liveScore += vixScore * 0.18;
    liveWeight += 0.18;
  }

  // Sectoral divergence — formerly dead code, now an active live signal.
  liveScore += clamp(s.sectorDeltaScore, -1, 1) * 0.12;
  liveWeight += 0.12;

  // Session priors — total weight 0.15 (context, not intraday).
  let priorScore = 0;
  let priorWeight = 0;
  if (!s.fiiIsStale && s.fiiDataDate) {
    const fiiScore = clamp(s.fiiNetCrore / 3000, -1, 1);
    priorScore += fiiScore * 0.09;
    priorWeight += 0.09;
  }
  if (s.deliveryPct !== null) {
    const delScore = clamp((s.deliveryPct - 35) / 15, -1, 1);
    priorScore += delScore * 0.03;
    priorWeight += 0.03;
  }
  if (s.fiiParticipantOINet !== null) {
    // Net positive = FII long bias in index futures; scale heuristically.
    const oiScore = clamp(s.fiiParticipantOINet / 50000, -1, 1);
    priorScore += oiScore * 0.03;
    priorWeight += 0.03;
  }

  // Max Pain penalty: if price is >1.5% away from max pain, apply directional pull toward pin
  if (s.maxPainDistancePct !== null && Math.abs(s.maxPainDistancePct) > 1.5) {
    // Negative distance = underlying below max pain = bullish pull; positive = bearish pull
    const painScore = clamp(-s.maxPainDistancePct / 3.0, -1, 1);
    priorScore += painScore * 0.10;
    priorWeight += 0.10;
  }

  // SGX Nifty divergence: if pre-market move >0.5% vs regime, adjust uncertainty
  if (s.sgxNiftyChangePct !== null && Math.abs(s.sgxNiftyChangePct) > 0.5) {
    // SGX up = bullish; SGX down = bearish. Weight lightly — it's a prior.
    const sgxScore = clamp(s.sgxNiftyChangePct / 1.5, -1, 1);
    priorScore += sgxScore * 0.08;
    priorWeight += 0.08;
  }

  const totalWeight = liveWeight + priorWeight;
  if (totalWeight === 0) return 0;
  // Normalize so partial availability still produces a score in [-1, +1].
  return clamp((liveScore + priorScore) / totalWeight, -1, 1);
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

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
const FIRECRAWL_API_KEY = process.env["FIRECRAWL_API_KEY"];

// ── Firecrawl fallback for blocked APIs ─────────────────────────────────────

export async function firecrawlFetchJson<T>(url: string): Promise<T> {
  if (!FIRECRAWL_API_KEY) throw new Error("FIRECRAWL_API_KEY not set");

  const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${FIRECRAWL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url,
      formats: ["markdown"],
      onlyMainContent: false,
      maxAge: 0,
      storeInCache: false,
    }),
  });

  if (!res.ok) throw new Error(`Firecrawl returned HTTP ${res.status}`);
  const body = await res.json() as { success: boolean; data?: { markdown?: string } };
  if (!body.success || !body.data?.markdown) throw new Error("Firecrawl scrape failed");

  const text = body.data.markdown;
  // Try to extract JSON object from markdown text
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
    throw new Error("No JSON object found in Firecrawl response");
  }

  return JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as T;
}


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
  // Firecrawl is PRIMARY (works on EC2/cloud where NSE blocks IPs).
  // NSE direct is fallback for local dev only.
  try {
    return await firecrawlFetchJson<T>(`https://www.nseindia.com${path}`);
  } catch (fcErr) {
    logger.warn({ path, err: fcErr instanceof Error ? fcErr.message : fcErr }, "Firecrawl failed — falling back to NSE direct");
  }

  try {
    await ensureNseSession();
    const res = await fetch(`https://www.nseindia.com${path}`, {
      headers: {
        ...NSE_HEADERS,
        ...(nseSessionCookie ? { Cookie: nseSessionCookie } : {}),
      },
    });
    if (!res.ok) throw new Error(`NSE ${path} returned HTTP ${res.status}`);
    return res.json() as Promise<T>;
  } catch (err) {
    logger.error({ path, err: err instanceof Error ? err.message : err }, "NSE direct fallback also failed");
    throw err;
  }
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

// NSE returns three things that didn't match the original parser:
//   (1) The response is a BARE ARRAY, not `{data: [...]}`.
//   (2) FII category string is "FII/FPI", not "FII".
//   (3) netValue / buyValue / sellValue are strings ("3821"), not numbers.
// All three silently produced 0 + fiiIsStale=true in the DB.
interface NseFiiEntry {
  date: string;
  buyValue: string;
  sellValue: string;
  netValue: string;
  category: string;
}

export interface FiiSnapshot {
  latestDate: string;
  fiiNetToday: number;     // ₹ crore
  fiiNetFlow5d: number;    // 5-day rolling sum ₹ crore
  diiNetToday: number;
}

export async function fetchFiiDiiFlow(): Promise<FiiSnapshot> {
  const raw = await nseGet<NseFiiEntry[] | { data: NseFiiEntry[] }>(
    "/api/fiidiiTradeReact",
  );
  const entries: NseFiiEntry[] = Array.isArray(raw) ? raw : (raw.data ?? []);

  const isFii = (cat: string) => /^FII/i.test(cat); // matches "FII" or "FII/FPI"
  const isDii = (cat: string) => /^DII/i.test(cat);

  const fiiEntries = entries
    .filter((e) => isFii(e.category))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const diiEntries = entries
    .filter((e) => isDii(e.category))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const num = (s: string | undefined) => (s ? parseFloat(s) || 0 : 0);

  const fiiNetToday = num(fiiEntries[0]?.netValue);
  const diiNetToday = num(diiEntries[0]?.netValue);
  const fiiNetFlow5d = fiiEntries.slice(0, 5).reduce((s, e) => s + num(e.netValue), 0);
  const latestDate = fiiEntries[0]?.date ?? "";

  return { latestDate, fiiNetToday, fiiNetFlow5d, diiNetToday };
}

// ── F&O Put-Call Ratio ────────────────────────────────────────────────────────

export interface PcrSnapshot {
  pcr: number; // put-call ratio by OI; > 1.2 = bearish hedge, < 0.8 = complacency
}

export async function fetchPutCallRatio(): Promise<PcrSnapshot> {
  // NSE retired /api/option-chain-indices (returns 404). The replacement is
  // /api/option-chain-v3, same data shape. We aggregate totalOI ourselves
  // since v3 doesn't expose totCE/totPE top-level either — fall back to
  // summing per-strike CE/PE openInterest from records.data.
  const raw = await nseGet<{
    records?: { data?: Array<{ CE?: { openInterest?: number }; PE?: { openInterest?: number } }> };
    totCE?: { totOI?: number };
    totPE?: { totOI?: number };
  }>("/api/option-chain-v3?symbol=NIFTY");

  if (raw.totCE?.totOI && raw.totPE?.totOI) {
    return { pcr: raw.totPE.totOI / raw.totCE.totOI };
  }
  let ceOI = 0;
  let peOI = 0;
  for (const row of raw.records?.data ?? []) {
    ceOI += row.CE?.openInterest ?? 0;
    peOI += row.PE?.openInterest ?? 0;
  }
  if (ceOI === 0) throw new Error("option-chain-v3: no CE openInterest in response");
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

export async function fetchADRatio(): Promise<AdvanceDeclineSnapshot> {
  // /api/live-analysis-variations now returns "Missing index or key." regardless
  // of the index parameter. /api/market-data-pre-open?key=NIFTY exposes raw
  // declines + unchanged counts per index constituent, from which advances are
  // derivable. Data is intraday-fresh during market hours and freezes at close.
  const raw = await nseGet<{
    declines?: number;
    advances?: number;
    unchanged?: number;
    data?: Array<{ metadata?: { pChange?: number } }>;
  }>("/api/market-data-pre-open?key=NIFTY");

  let advance = raw.advances ?? 0;
  let decline = raw.declines ?? 0;
  // Some response shapes only return declines + unchanged + total stock rows
  // and we have to compute advances from per-row pChange.
  if (advance === 0 && Array.isArray(raw.data)) {
    advance = raw.data.filter((r) => (r.metadata?.pChange ?? 0) > 0).length;
    if (decline === 0) {
      decline = raw.data.filter((r) => (r.metadata?.pChange ?? 0) < 0).length;
    }
  }
  const ratio = decline > 0 ? advance / decline : 0;
  return { advance, decline, ratio };
}

// ── SGX Nifty via sgxnifty.org (Firecrawl fallback) ───────────────────────────

export async function fetchSGXNiftyFirecrawl(): Promise<{ changePct: number | null }> {
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${FIRECRAWL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: "https://www.sgxnifty.org/",
        formats: ["markdown"],
        maxAge: 0,
        storeInCache: false,
      }),
    });
    if (!res.ok) throw new Error(`Firecrawl SGX failed: ${res.status}`);
    const fc = await res.json() as { data?: { markdown?: string } };
    const md = fc.data?.markdown ?? "";
    // Parse markdown table: | Last Trade | Change | Change in % |
    //                        | 23,205.0   | -98.0  | -0.42%      |
    const m = md.match(/\|\s*Last Trade\s*\|\s*Change\s*\|\s*Change in %\s*\|[\s\S]*?\|\s*([\d,]+\.?\d*)\s*\|\s*([-\d,]+\.?\d*)\s*\|\s*([-\d.]+)%?\s*\|/);
    if (m) {
      const changePct = parseFloat(m[3].replace(",", ""));
      return { changePct: isNaN(changePct) ? null : changePct };
    }
    // Fallback: search for any percentage
    const fallback = md.match(/Change in %\s*\n.*?\|\s*([-\d.]+)%?\s*\|/);
    if (fallback) {
      const pct = parseFloat(fallback[1]);
      return { changePct: isNaN(pct) ? null : pct };
    }
    throw new Error("SGX Nifty data not found in Firecrawl response");
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "SGX Nifty Firecrawl fetch failed");
    return { changePct: null };
  }
}

// ── NSE Option Chain PCR via Firecrawl (scrapes HTML page) ────────────────────

export async function fetchOptionChainPcrFirecrawl(): Promise<{
  pcr: number | null;
  maxPainStrike: number | null;
  maxPainDistancePct: number | null;
  atmIv: number | null;
  totalOi: number;
}> {
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${FIRECRAWL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: "https://www.nseindia.com/option-chain?symbol=NIFTY",
        formats: ["markdown"],
        onlyMainContent: true,
        waitFor: 3000,
        maxAge: 0,
        storeInCache: false,
      }),
    });
    if (!res.ok) throw new Error(`Firecrawl option chain failed: ${res.status}`);
    const fc = await res.json() as { data?: { markdown?: string } };
    const md = fc.data?.markdown ?? "";

    // Parse Total row for Call OI and Put OI
    // | Total | Call OI | Call Volume | Put OI | Put Volume |
    const totalMatch = md.match(/\|\s*Total\s*\|\s*([\d,]+)\s*\|\s*[\d,]+\s*\|\s*([\d,]+)\s*\|/);
    let pcr: number | null = null;
    let totalOi = 0;
    if (totalMatch) {
      const callOi = parseInt(totalMatch[1].replace(/,/g, ""), 10);
      const putOi = parseInt(totalMatch[2].replace(/,/g, ""), 10);
      if (callOi > 0) {
        pcr = putOi / callOi;
        totalOi = callOi + putOi;
        logger.info({ pcr: pcr.toFixed(2), callOi, putOi }, "Firecrawl: option chain PCR parsed");
      }
    } else {
      logger.warn("Firecrawl: option chain Total row not found in markdown");
    }

    // Try to get underlying price from page
    const underlyingMatch = md.match(/underlyingValue["\s:=]+(\d+(?:\.\d+)?)/i) ||
                           md.match(/NIFTY\s+50\s+Index[\s\S]*?(\d{2},\d{3}\.\d{2})/);
    const underlying = underlyingMatch ? parseFloat(underlyingMatch[1].replace(/,/g, "")) : 0;

    // Try to get ATM IV from page content (look for IV near current price)
    let atmIv: number | null = null;
    const ivMatches = md.match(/IV[\s\S]*?(\d+\.\d{2})/g);
    if (ivMatches && ivMatches.length > 0) {
      // Take median IV
      const ivs = ivMatches.map(m => parseFloat(m.match(/(\d+\.\d{2})/)?.[1] ?? "0")).filter(v => v > 0);
      if (ivs.length > 0) {
        ivs.sort((a, b) => a - b);
        atmIv = ivs[Math.floor(ivs.length / 2)];
      }
    }

    // Compute Max Pain from individual strike rows
    let maxPainStrike: number | null = null;
    let maxPainDistancePct: number | null = null;

    if (underlying > 0) {
      // Parse strike rows from markdown table
      const strikes: { strike: number; ceOi: number; peOi: number }[] = [];
      const lines = md.split("\n");
      for (const line of lines) {
        if (!line.startsWith("|")) continue;
        const parts = line.split("|").map(p => p.trim());
        // Find strike price: looks like "23,450.00" at specific position
        for (let i = 0; i < parts.length; i++) {
          if (/^\d{2},\d{3}\.\d{2}$/.test(parts[i])) {
            const strike = parseFloat(parts[i].replace(/,/g, ""));
            // Approximate OI positions: CE OI ~6 cols left, PE OI ~6 cols right
            const ceOiStr = parts[Math.max(0, i - 6)]?.replace(/,/g, "").replace(/-/g, "0") ?? "0";
            const peOiStr = parts[Math.min(parts.length - 1, i + 6)]?.replace(/,/g, "").replace(/-/g, "0") ?? "0";
            try {
              const ceOi = parseInt(ceOiStr, 10) || 0;
              const peOi = parseInt(peOiStr, 10) || 0;
              if (ceOi > 0 || peOi > 0) {
                strikes.push({ strike, ceOi, peOi });
              }
            } catch { /* skip */ }
            break;
          }
        }
      }

      if (strikes.length > 0) {
        let minPain = Infinity;
        for (const candidate of strikes) {
          let pain = 0;
          for (const s of strikes) {
            pain += s.ceOi * Math.max(0, candidate.strike - s.strike);
            pain += s.peOi * Math.max(0, s.strike - candidate.strike);
          }
          if (pain < minPain) {
            minPain = pain;
            maxPainStrike = candidate.strike;
          }
        }
        if (maxPainStrike !== null) {
          maxPainDistancePct = ((underlying - maxPainStrike) / maxPainStrike) * 100;
        }
      }
    }

    return { pcr, maxPainStrike, maxPainDistancePct, atmIv, totalOi };
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "Option chain Firecrawl fetch failed");
    return { pcr: null, maxPainStrike: null, maxPainDistancePct: null, atmIv: null, totalOi: 0 };
  }
}

// ── NSE Option Chain FULL via Firecrawl v2 (with JS render wait) ─────────────
// Scrapes the NSE option-chain HTML page with waitFor=8000 so the JS-rendered
// option chain table is fully loaded. Extracts total CE/PE OI, volume, ATM IV,
// spot price, and per-strike OI for max pain calculation.
//
// This is the PRIMARY option chain source on EC2 where NSE's Akamai bot protection
// blocks the /api/option-chain-v3 JSON endpoint (returns {} for non-browser clients).

export async function fetchOptionChainFullFirecrawl(): Promise<{
  pcr: number | null;
  atmIv: number | null;
  totalOi: number;
  maxPainStrike: number | null;
  maxPainDistancePct: number | null;
  callOI: number;
  putOI: number;
  optionVolume: number;
  atmGamma: number;
  spotPrice: number | null;
}> {
  if (!FIRECRAWL_API_KEY) throw new Error("FIRECRAWL_API_KEY not set");

  const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${FIRECRAWL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url: "https://www.nseindia.com/option-chain",
      formats: ["markdown"],
      onlyMainContent: true,
      waitFor: 8000,
      maxAge: 0,
      storeInCache: false,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) throw new Error(`Firecrawl v2 option chain failed: ${res.status}`);
  const fc = await res.json() as { success?: boolean; data?: { markdown?: string } };
  const md = fc.data?.markdown ?? "";
  if (!md) throw new Error("Firecrawl v2 returned empty markdown");

  // Parse the Total row: | Total | CE_OI | ... | CE_Volume | ... | PE_Volume | ... | PE_OI | |
  // The table header is: OI | Chng in OI | Volume | IV | LTP | ... | Strike | ... | IV | Volume | Chng in OI | OI
  const totalMatch = md.match(/\|\s*Total\s*\|([^|]+)\|([^|]*)\|([^|]+)\|/);
  let callOI = 0;
  let putOI = 0;
  let ceVolume = 0;
  let peVolume = 0;
  let pcr: number | null = null;

  if (totalMatch) {
    callOI = parseInt(totalMatch[1].replace(/,/g, "").trim(), 10) || 0;
    ceVolume = parseInt(totalMatch[3].replace(/,/g, "").trim(), 10) || 0;
  }

  // Also parse PE OI and PE volume from the Total row (further right in the table)
  // Total row format: | Total | CE_OI | - | CE_Vol | - | ... | - | PE_Vol | - | PE_OI | |
  const totalParts = md.split("\n").find(l => l.includes("| Total |"))?.split("|").map(p => p.trim()) ?? [];
  if (totalParts.length >= 22) {
    // PE OI is the last numeric value before the trailing empty/chart column
    for (let i = totalParts.length - 2; i >= 0; i--) {
      const val = totalParts[i].replace(/,/g, "").trim();
      if (/^\d+$/.test(val) && parseInt(val, 10) > 0) {
        putOI = parseInt(val, 10);
        break;
      }
    }
    // PE Volume is the second-to-last numeric value
    let foundPeOi = false;
    for (let i = totalParts.length - 2; i >= 0; i--) {
      const val = totalParts[i].replace(/,/g, "").trim();
      if (/^\d+$/.test(val) && parseInt(val, 10) > 0) {
        if (foundPeOi) {
          peVolume = parseInt(val, 10);
          break;
        }
        foundPeOi = true;
      }
    }
  }

  if (callOI > 0) {
    pcr = putOI / callOI;
  }

  const totalOi = callOI + putOI;
  const optionVolume = ceVolume + peVolume;

  // Parse individual strike rows using header-driven column detection.
  // The NSE option chain table header looks like:
  //   | | OI | Chng in OI | Volume | IV | LTP | Chng | Bid Qty | Bid | Ask | Ask Qty | Strike | Bid Qty | Bid | Ask | Ask Qty | Chng | LTP | IV | Volume | Chng in OI | OI | |
  // We find the column indices from the header, then use them for all data rows.
  const strikes: { strike: number; ceOi: number; peOi: number; ceIv: number; peIv: number }[] = [];
  let spotPrice: number | null = null;

  // Find header row to determine column indices
  const lines = md.split("\n");
  let ceOiCol = -1, ceIvCol = -1, strikeCol = -1, peIvCol = -1, peOiCol = -1;
  for (const line of lines) {
    if (line.includes("| OI |") && line.includes("Strike")) {
      const headers = line.split("|").map(p => p.trim().toLowerCase());
      for (let i = 0; i < headers.length; i++) {
        if (headers[i] === "oi" && ceOiCol === -1) ceOiCol = i;
        if (headers[i] === "iv" && ceIvCol === -1) ceIvCol = i;
        if (headers[i] === "strike") strikeCol = i;
        if (headers[i] === "iv" && ceIvCol !== -1 && i > strikeCol) peIvCol = i;
        if (headers[i] === "oi" && ceOiCol !== -1 && i > strikeCol) peOiCol = i;
      }
      break;
    }
  }
  // Fallback to known column positions if header not found
  if (strikeCol === -1) { ceOiCol = 2; ceIvCol = 5; strikeCol = 12; peIvCol = 19; peOiCol = 22; }

  for (const line of lines) {
    if (!line.startsWith("|") || line.includes("Total") || line.includes("CALLS") || line.includes("Strike")) continue;
    if (!line.includes("chart")) continue; // data rows have chart images

    const parts = line.split("|").map(p => p.trim().replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/,/g, ""));
    const strikeStr = parts[strikeCol] ?? "";
    if (!/^\d{4,6}\.\d{2}$/.test(strikeStr)) continue;

    const strike = parseFloat(strikeStr);
    if (isNaN(strike) || strike <= 0) continue;

    const ceOi = parseInt(parts[ceOiCol] ?? "0", 10) || 0;
    const ceIv = parseFloat(parts[ceIvCol] ?? "0") || 0;
    const peIv = parseFloat(parts[peIvCol] ?? "0") || 0;
    const peOi = parseInt(parts[peOiCol] ?? "0", 10) || 0;

    if (ceOi > 0 || peOi > 0) {
      strikes.push({ strike, ceOi, peOi, ceIv, peIv });
    }
  }

  // Spot price: extract from page content
  // The NSE page has "underlyingValue" or shows the NIFTY spot value near the top
  const spotMatch = md.match(/underlying[^\d]*(\d{2},\d{3}\.\d{2})/i);
  if (spotMatch) {
    spotPrice = parseFloat(spotMatch[1].replace(/,/g, ""));
  }
  // Fallback: use the strike with the highest combined OI as approximate spot (ATM)
  if (!spotPrice && strikes.length > 0) {
    let maxOi = 0;
    let atmStrikeVal = strikes[0]!.strike;
    for (const s of strikes) {
      const totalOi = s.ceOi + s.peOi;
      if (totalOi > maxOi) {
        maxOi = totalOi;
        atmStrikeVal = s.strike;
      }
    }
    spotPrice = atmStrikeVal;
  }

  // ATM IV: find strike closest to spot price
  let atmIv: number | null = null;
  let atmStrike = 0;
  if (spotPrice && strikes.length > 0) {
    let minDiff = Infinity;
    for (const s of strikes) {
      const diff = Math.abs(s.strike - spotPrice);
      if (diff < minDiff) {
        minDiff = diff;
        atmIv = s.ceIv > 0 ? s.ceIv : s.peIv > 0 ? s.peIv : null;
        atmStrike = s.strike;
      }
    }
  }

  // Max pain calculation
  let maxPainStrike: number | null = null;
  let maxPainDistancePct: number | null = null;
  if (strikes.length > 0) {
    let minPain = Infinity;
    for (const candidate of strikes) {
      let pain = 0;
      for (const s of strikes) {
        pain += s.ceOi * Math.max(0, candidate.strike - s.strike);
        pain += s.peOi * Math.max(0, s.strike - candidate.strike);
      }
      if (pain < minPain) {
        minPain = pain;
        maxPainStrike = candidate.strike;
      }
    }
    if (maxPainStrike !== null && maxPainStrike > 0 && spotPrice) {
      maxPainDistancePct = ((spotPrice - maxPainStrike) / maxPainStrike) * 100;
    }
  }

  // ATM gamma via Black-Scholes (import lazily to avoid circular deps)
  let atmGamma = 0;
  if (atmStrike > 0 && spotPrice && atmIv && atmIv > 0) {
    try {
      const { bsGamma } = await import("./tier3-signal.js");
      const yearsToExpiry = (() => {
        const now = new Date();
        const day = now.getUTCDay();
        let daysUntilThu = (4 - day + 7) % 7;
        const ms = Math.max(daysUntilThu * 86400000, 2 * 3600000);
        return ms / (365 * 86400000);
      })();
      atmGamma = bsGamma(spotPrice, atmStrike, atmIv / 100, yearsToExpiry);
    } catch { /* tier3-signal not available */ }
  }

  logger.info({
    pcr: pcr !== null ? pcr.toFixed(2) : "N/A",
    callOI, putOI, optionVolume,
    atmIv: atmIv ?? "N/A",
    spotPrice: spotPrice ?? "N/A",
    maxPainStrike: maxPainStrike ?? "N/A",
    strikes: strikes.length,
  }, "Firecrawl v2: full option chain parsed");

  return {
    pcr, atmIv, totalOi, maxPainStrike, maxPainDistancePct,
    callOI, putOI, optionVolume, atmGamma, spotPrice,
  };
}

// ── NSE allIndices via Firecrawl (for VIX, AD ratio, sectoral) ───────────────

export async function fetchNseAllIndicesFirecrawl(): Promise<{
  vix: number | null;
  advances: number | null;
  declines: number | null;
  bankNiftyPctChange: number | null;
  niftyItPctChange: number | null;
  nifty50PctChange: number | null;
  nifty50: number | null;
}> {
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${FIRECRAWL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: "https://www.nseindia.com/api/allIndices",
        formats: ["markdown"],
        maxAge: 0,
        storeInCache: false,
      }),
    });
    if (!res.ok) throw new Error(`Firecrawl allIndices failed: ${res.status}`);
    const fc = await res.json() as { data?: { markdown?: string } };
    const md = fc.data?.markdown ?? "";

    // Try to extract JSON from markdown code block
    let jsonData: unknown;
    const jsonBlock = md.match(/```json\n([\s\S]*?)\n```/);
    if (jsonBlock) {
      jsonData = JSON.parse(jsonBlock[1]);
    } else {
      // Try parsing the markdown as raw JSON
      jsonData = JSON.parse(md);
    }

    interface IndexData {
      indexSymbol?: string;
      last?: number | string;
      variation?: number | string;
      percentChange?: number | string;
      advances?: number | string;
      declines?: number | string;
    }

    const data = (jsonData as { data?: IndexData[] }).data ?? [];

    let vix: number | null = null;
    let advances: number | null = null;
    let declines: number | null = null;
    let bankNiftyPctChange: number | null = null;
    let niftyItPctChange: number | null = null;
    let nifty50PctChange: number | null = null;
    let nifty50: number | null = null;

    for (const item of data) {
      const sym = (item.indexSymbol ?? "").toUpperCase();
      if (sym === "INDIA VIX") vix = parseFloat(String(item.last ?? "0"));
      if (sym === "NIFTY BANK") bankNiftyPctChange = parseFloat(String(item.percentChange ?? "0"));
      if (sym === "NIFTY IT") niftyItPctChange = parseFloat(String(item.percentChange ?? "0"));
      if (sym === "NIFTY 50") {
        nifty50 = parseFloat(String(item.last ?? "0"));
        nifty50PctChange = parseFloat(String(item.percentChange ?? "0"));
        advances = parseInt(String(item.advances ?? "0"), 10) || null;
        declines = parseInt(String(item.declines ?? "0"), 10) || null;
      }
    }

    return { vix, advances, declines, bankNiftyPctChange, niftyItPctChange, nifty50PctChange, nifty50 };
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "allIndices Firecrawl fetch failed");
    return { vix: null, advances: null, declines: null, bankNiftyPctChange: null, niftyItPctChange: null, nifty50PctChange: null, nifty50: null };
  }
}

// ── Upstox PCR via Firecrawl ────────────────────────────────────────────────

export async function fetchPcrFromUpstox(): Promise<{ pcr: number | null }> {
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${FIRECRAWL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: "https://upstox.com/fno-discovery/open-interest-analysis/nifty-pcr/",
        formats: ["markdown"],
        onlyMainContent: true,
        waitFor: 5000,
        maxAge: 0,
        storeInCache: false,
      }),
    });
    if (!res.ok) throw new Error(`Firecrawl Upstox PCR failed: ${res.status}`);
    const fc = await res.json() as { data?: { markdown?: string } };
    const md = fc.data?.markdown ?? "";

    // Try multiple PCR patterns (standalone, inline, FAQ sentence)
    const patterns = [
      /PCR\s*[:=]?\s*(\d+\.\d+)/i,              // "PCR 0.79" or "PCR: 0.79"
      /has a PCR of (\d+\.\d+)/i,                // "has a PCR of 0.79"
      /put.call ratio.*?is\s+(\d+\.\d+)/i,       // "put-call ratio is 0.79"
    ];
    for (const pattern of patterns) {
      const match = md.match(pattern);
      if (match) {
        const pcr = parseFloat(match[1]);
        logger.info({ pcr, pattern: pattern.source }, "Firecrawl: Upstox PCR parsed");
        return { pcr };
      }
    }
    logger.warn({ markdownPreview: md.slice(0, 200).replace(/\s+/g, " ") }, "Firecrawl: Upstox PCR not found in markdown");
    return { pcr: null };
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "Upstox PCR Firecrawl fetch failed");
    return { pcr: null };
  }
}

// ── NiftyInvest Max Pain via Firecrawl ──────────────────────────────────────

export async function fetchMaxPainFromNiftyInvest(): Promise<{
  maxPainStrike: number | null;
  maxPainDistancePct: number | null;
}> {
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${FIRECRAWL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: "https://niftyinvest.com/max-pain/NIFTY",
        formats: ["markdown"],
        onlyMainContent: true,
        maxAge: 0,
        storeInCache: false,
      }),
    });
    if (!res.ok) throw new Error(`Firecrawl NiftyInvest Max Pain failed: ${res.status}`);
    const fc = await res.json() as { data?: { markdown?: string } };
    const md = fc.data?.markdown ?? "";
    const match = md.match(/Max Pain for NIFTY is (\d+(?:,\d+)*)/i);
    if (match) {
      const maxPainStrike = parseFloat(match[1].replace(/,/g, ""));
      // Fetch NIFTY 50 spot for distance calculation from allIndices
      const { nifty50 } = await fetchNseAllIndicesFirecrawl();
      let maxPainDistancePct: number | null = null;
      if (nifty50 !== null && maxPainStrike > 0) {
        maxPainDistancePct = ((nifty50 - maxPainStrike) / maxPainStrike) * 100;
      }
      logger.info({ maxPainStrike, maxPainDistancePct }, "Firecrawl: NiftyInvest Max Pain parsed");
      return { maxPainStrike, maxPainDistancePct };
    }
    logger.warn("Firecrawl: NiftyInvest Max Pain not found in markdown");
    return { maxPainStrike: null, maxPainDistancePct: null };
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "NiftyInvest Max Pain Firecrawl fetch failed");
    return { maxPainStrike: null, maxPainDistancePct: null };
  }
}

// ── INR/USD from Yahoo Finance (NSE doesn't expose FX directly) ───────────────

interface YahooQuote {
  chart: { result: Array<{ meta: { regularMarketPrice: number; chartPreviousClose: number } }> };
}

async function fetchInrUsd(): Promise<{ current: number; change5dPct: number }> {
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/USDINR=X?interval=1d&range=10d";
  let raw: YahooQuote;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`Yahoo FX fetch failed: ${res.status}`);
    raw = await res.json() as YahooQuote;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "Yahoo FX direct failed — trying Firecrawl");
    raw = await firecrawlFetchJson<YahooQuote>(url);
  }
  const meta = raw.chart.result[0]?.meta;
  if (!meta) throw new Error("Yahoo FX: no data");
  const current = meta.regularMarketPrice;
  const prev5d = meta.chartPreviousClose;
  return { current, change5dPct: prev5d > 0 ? ((current - prev5d) / prev5d) * 100 : 0 };
}

// ── NIFTY realized volatility (10-day) ───────────────────────────────────────

async function fetchNiftyRealVol(): Promise<{ vol10d: number; closes: number[] }> {
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=1d&range=30d";
  interface YahooOHLC {
    chart: { result: Array<{ indicators: { quote: Array<{ close: number[] }> } }> };
  }
  let raw: YahooOHLC;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`Yahoo NIFTY fetch failed: ${res.status}`);
    raw = await res.json() as YahooOHLC;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "Yahoo NIFTY vol direct failed — trying Firecrawl");
    raw = await firecrawlFetchJson<YahooOHLC>(url);
  }
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
  // Index symbols (^NSEI, ^BSESN) and futures (GC=F, SI=F) must not get .NS suffix
  const yahooSymbol = symbol.startsWith("^") || symbol.includes("=") || symbol.endsWith(".NS")
    ? symbol
    : `${symbol}.NS`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=${Math.ceil(days * 1.5)}d`;

  interface YahooTS {
    chart: {
      result: Array<{
        timestamp: number[];
        indicators: { quote: Array<{ close: number[] }> };
      }>;
    };
  }
  let raw: YahooTS;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`Yahoo price fetch failed for ${symbol}: ${res.status}`);
    raw = await res.json() as YahooTS;
  } catch (err) {
    logger.warn({ symbol, err: err instanceof Error ? err.message : err }, "Yahoo price direct failed — trying Firecrawl");
    raw = await firecrawlFetchJson<YahooTS>(url);
  }
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

// Phase 5: Prediction System Hardened Market Agent.
// Uses Tier 3 data + Candle Trust + 3 separate window contexts + priceScore + FlipGuard.

import { db, predictionV2Table, marketRegimesTable, flipGuardsTable } from "@workspace/db";
import { eq, desc, and, gt } from "drizzle-orm";
import { logger } from "../../lib/logger.js";
import { runEnsembleInference, type EnsembleResult, type GeopoliticalSignal } from "./ensemble.js";
import type { RegimeState } from "./hmm-regime.js";
import type { ForecasterTree } from "../reasoning/agent-forecaster.js";
import { runCypher } from "../graph/neo4j-client.js";
import { fetchTier3Snapshot, computeTier3Score, type Tier3Snapshot } from "./tier3-fetcher.js";
import { firecrawlFetchJson, type SectorDeltas } from "./nse-direct-scraper.js";
import { checkCandleTrust, type CandleTrustResult, type OHLCV } from "./candle-trust.js";
import { randomUUID } from "crypto";

export interface MarketSignal {
  direction: "up" | "down" | "neutral" | "uncertain";
  magnitude: "strong" | "moderate" | "mild";
  confidence: "high" | "medium" | "low";
  timeframe: "intraday" | "next-session";
  priceImpactEstimate: string;
  verdict: string;
  dominantNarrative: string;
  assumptions: string;
  triggerNewsSummary: string;
  bullScore: number;
  bearScore: number;
  regime: string;
  regimeProbabilities: Record<string, number>;
  activeGeopoliticalScenarios: string[];
  activeChannels: string[];
  ensembleVotes: EnsembleResult["votes"];
  uncertaintyFlag: boolean;

  // ── New Phase-5 fields ──
  priceScore: number;
  flipConfirmed: boolean;
  tier3Evidence: {
    fiiNetCrore: number;
    fiiIsStale: boolean;
    putCallRatio: number | null;
    advanceDeclineRatio: number | null;
    deliveryPct: number | null;
    indiaVix5dChange: number | null;
    tier3Score: number;
    maxPainStrike: number | null;
    maxPainDistancePct: number | null;
    sgxNiftyChangePct: number | null;
    shortCoveringSignal: "none" | "covering" | "unwinding";
  };
  candleTrustScore: number;
  candleFlags: string[];
  regimeAge: number;
  channelDecaySummary: {
    channelId: string;
    decayedWeight: number;
    daysSinceTrigger: number;
  }[];
}

// ── FlipGuard interface (in-memory + DB backed) ───────────────────────────────

interface FlipGuard {
  pendingDirection: "up" | "down" | "uncertain" | null;
  pendingCount: number;
  confirmedDirection: "up" | "down" | "uncertain";
}

const _inMemoryFlipGuards = new Map<string, FlipGuard>();

// ── Cache ─────────────────────────────────────────────────────────────────────

const _cache = new Map<string, { signal: MarketSignal; fetchedAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h

// ── Active channels with decay (Change 6) ───────────────────────────────────

interface ActiveChannel {
  channelId: string;
  name: string;
  rawWeight: number;
  storyId: string;
  triggerDate: string;
  daysSinceTrigger: number;
  decayedWeight: number;
  isActive: boolean;
}

interface RawChannel {
  channelId: string;
  name: string;
  rawWeight: number;
  storyId: string;
  triggerDate: string;
}

// ── Sectoral narrative (Change 5) ─────────────────────────────────────────────

function deriveSectoralNarrative(deltas: SectorDeltas | null): string {
  if (!deltas) return "Sectoral data unavailable.";
  const lines: string[] = [];
  if (deltas.bank > 0.5) lines.push(
    `Bank Nifty outperforming NIFTY by ${deltas.bank.toFixed(2)}% — institutional buying, bullish for index`
  );
  if (deltas.bank < -0.5) lines.push(
    `Bank Nifty underperforming NIFTY by ${Math.abs(deltas.bank).toFixed(2)}% — institutional selling, bearish`
  );
  if (deltas.it < -0.5) lines.push(
    `Nifty IT lagging by ${Math.abs(deltas.it).toFixed(2)}% — possible FII rotation out of IT`
  );
  if (deltas.bank > 0.3 && deltas.it > 0.3) lines.push(
    `Both Bank and IT outperforming — broad institutional participation, strong bullish`
  );
  return lines.length ? lines.join(". ") : "No significant sector divergence.";
}

// ── Geopolitical signal derivation for ensemble tiebreak ──────────────────────

function deriveGeopoliticalSignal(channels: ActiveChannel[]): GeopoliticalSignal | undefined {
  if (!channels.length) return undefined;
  const top = channels[0]!;
  const channelId = top.channelId.toLowerCase();
  // Map channel ID → directional sentiment. fii_risk_off is the canonical bearish channel.
  let sentiment: "bullish" | "bearish" | "neutral" = "neutral";
  if (channelId.includes("fii_risk_off") || channelId.includes("crude_spike") || channelId.includes("inr_weak")) {
    sentiment = "bearish";
  } else if (channelId.includes("fii_risk_on") || channelId.includes("inr_strong")) {
    sentiment = "bullish";
  }
  return {
    dominantChannel: channelId,
    sentiment,
    decayedWeight: top.decayedWeight,
  };
}

function applyChannelDecay(channels: RawChannel[]): ActiveChannel[] {
  const today = new Date();
  return channels.map(ch => {
    const triggerDate = new Date(ch.triggerDate);
    const daysSinceTrigger = Math.floor(
      (today.getTime() - triggerDate.getTime()) / (1000 * 60 * 60 * 24)
    );
    const decayFactor = Math.pow(0.5, Math.max(0, daysSinceTrigger - 1));
    const decayedWeight = ch.rawWeight * decayFactor;
    return {
      ...ch,
      daysSinceTrigger,
      decayedWeight,
      isActive: decayedWeight > 0.1,
    };
  }).filter(ch => ch.isActive);
}

async function getActiveTransmissionChannels(): Promise<ActiveChannel[]> {
  try {
    const result = await runCypher(
      `MATCH (s:Story)-[r:TRANSMITS_TO]->(c:Channel)
       WHERE s.status = 'active'
       RETURN DISTINCT c.id AS channelId, c.label AS label,
         c.weight AS weight, s.id AS storyId,
         coalesce(r.triggerDate, datetime().epochMillis) AS triggerDate
       ORDER BY c.weight DESC
       LIMIT 10`,
      {}
    );
    const rawChannels: RawChannel[] = result.records.map(r => ({
      channelId: r.get("channelId") as string,
      name: r.get("label") as string,
      rawWeight: Number(r.get("weight") ?? 0),
      storyId: r.get("storyId") as string,
      triggerDate: typeof r.get("triggerDate") === "string"
        ? r.get("triggerDate")
        : new Date().toISOString(),
    }));
    return applyChannelDecay(rawChannels);
  } catch {
    return [];
  }
}

// ── Active scenarios with priced-in context (Change 7) ────────────────────────

interface DecayedScenario {
  label: string;
  alreadyTransmitted: boolean;
  transmissionDate: string | null;
  decayFactor: number;
  probability: number;
  channel: string;
}

async function getActiveScenariosWithDecay(): Promise<DecayedScenario[]> {
  try {
    const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000);
    const rows = await db
      .select({
        finalScenarios: predictionV2Table.finalScenarios,
        dominantChannel: predictionV2Table.dominantChannel,
        generatedAt: predictionV2Table.generatedAt,
        storyId: predictionV2Table.storyId,
      })
      .from(predictionV2Table)
      .where(and(
        eq(predictionV2Table.resolutionStatus, "pending"),
        gt(predictionV2Table.generatedAt, cutoff),
      ))
      .orderBy(desc(predictionV2Table.generatedAt))
      .limit(10);

    const scenarios: DecayedScenario[] = [];
    for (const row of rows) {
      try {
        const tree = JSON.parse(row.finalScenarios) as ForecasterTree["scenarios"];
        const dominant = tree[0];
        if (!dominant) continue;

        const daysSince = Math.floor(
          (Date.now() - new Date(row.generatedAt).getTime()) / (1000 * 60 * 60 * 24)
        );
        // Simple priced-in heuristic: if prediction is >1 day old, assume partially transmitted
        const alreadyTransmitted = daysSince >= 1;
        const decayFactor = alreadyTransmitted
          ? Math.max(0.1, 1.0 - (daysSince * 0.3))
          : 1.0;

        scenarios.push({
          label: dominant.label,
          alreadyTransmitted,
          transmissionDate: alreadyTransmitted ? row.generatedAt.toISOString() : null,
          decayFactor,
          probability: dominant.probability,
          channel: row.dominantChannel ?? "unknown",
        });
      } catch { /* skip malformed */ }
    }
    return scenarios;
  } catch {
    return [];
  }
}

// ── Stored regime from DB ─────────────────────────────────────────────────────

type StoredRegime = typeof marketRegimesTable.$inferSelect;

async function getStoredRegime(assetId: string): Promise<StoredRegime | null> {
  try {
    const rows = await db
      .select()
      .from(marketRegimesTable)
      .where(eq(marketRegimesTable.assetId, assetId))
      .orderBy(desc(marketRegimesTable.detectedAt))
      .limit(1);
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

// ── Regime age (Change 3) ─────────────────────────────────────────────────────

async function getRegimeAge(): Promise<number> {
  try {
    const rows = await db
      .select({ regime: marketRegimesTable.regime })
      .from(marketRegimesTable)
      .orderBy(desc(marketRegimesTable.detectedAt))
      .limit(200);
    if (!rows.length) return 0;
    const current = rows[0]!.regime;
    let age = 0;
    for (const row of rows) {
      if (row.regime === current) age++;
      else break;
    }
    return age;
  } catch {
    return 0;
  }
}

// ── Yahoo Finance OHLCV helper ──────────────────────────────────────────────────

interface YahooOHLCV {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  changePct: number;
}

async function fetchYahooOHLCV(symbol: string, days = 25): Promise<YahooOHLCV[] | null> {
  try {
    // Index symbols (^NSEI, ^BSESN) and futures (GC=F, SI=F) must not get .NS suffix
    const yahooSymbol = symbol.startsWith("^") || symbol.includes("=") || symbol.endsWith(".NS")
      ? symbol
      : `${symbol}.NS`;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=${Math.ceil(days * 1.5)}d`;
    let json: {
      chart?: {
        result?: Array<{
          timestamp?: number[];
          indicators?: {
            quote?: Array<{
              open?: (number | null)[];
              high?: (number | null)[];
              low?: (number | null)[];
              close?: (number | null)[];
              volume?: (number | null)[];
            }>;
          };
        }>;
      };
    };
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(12000) });
      if (!res.ok) throw new Error(`Yahoo returned HTTP ${res.status}`);
      json = await res.json() as typeof json;
    } catch (err) {
      logger.warn({ symbol, err: err instanceof Error ? err.message : err }, "market-agent: Yahoo OHLCV direct failed — trying Firecrawl");
      json = await firecrawlFetchJson<typeof json>(url);
    }

    const result = json.chart?.result?.[0];
    if (!result) return null;
    const timestamps = result.timestamp ?? [];
    const q = result.indicators?.quote?.[0];
    if (!q) return null;

    const candles: YahooOHLCV[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const o = q.open?.[i];
      const h = q.high?.[i];
      const l = q.low?.[i];
      const c = q.close?.[i];
      const v = q.volume?.[i];
      if (o == null || h == null || l == null || c == null) continue;
      const prevClose = candles.length > 0 ? candles[candles.length - 1]!.close : c;
      candles.push({
        date: new Date(timestamps[i]! * 1000).toISOString().slice(0, 10),
        open: o,
        high: h,
        low: l,
        close: c,
        volume: v ?? 0,
        changePct: prevClose > 0 ? ((c - prevClose) / prevClose) * 100 : 0,
      });
    }
    return candles.length >= 2 ? candles.slice(-days) : null;
  } catch {
    return null;
  }
}

// ── PriceScore computation (Change 5) ─────────────────────────────────────────

function computePriceScore(
  tier3Score: number,
  candleTrust: CandleTrustResult,
  votes: { call: string; confidence: number }[]
): { priceScore: number; direction: "up" | "down" | "uncertain"; flipReady: boolean } {
  const avgConfidence = votes.reduce((s, v) => s + v.confidence, 0) / votes.length;
  const tier1Contribution = candleTrust.tier1Score * candleTrust.trustScore * avgConfidence;
  const priceScore = (tier3Score * 0.7) + (tier1Contribution * 0.3);

  let direction: "up" | "down" | "uncertain";
  if (priceScore > 0.20) direction = "up";
  else if (priceScore < -0.20) direction = "down";
  else {
    // When priceScore is neutral (e.g., NSE data unavailable), fall back to ensemble majority
    const callCounts: Record<string, number> = {};
    for (const v of votes) {
      callCounts[v.call] = (callCounts[v.call] ?? 0) + 1;
    }
    let bestCall = "UNCERTAIN";
    let bestCount = 0;
    for (const [call, count] of Object.entries(callCounts)) {
      if (count > bestCount) {
        bestCount = count;
        bestCall = call;
      }
    }
    direction = bestCall === "BULLISH" ? "up" : bestCall === "BEARISH" ? "down" : "uncertain";
  }

  return { priceScore, direction, flipReady: true };
}

// ── FlipGuard (Change 5b) ───────────────────────────────────────────────────────

function applyFlipGuard(
  guard: FlipGuard,
  newDirection: "up" | "down" | "uncertain"
): { emitFlip: boolean; confirmedDirection: "up" | "down" | "uncertain"; updatedGuard: FlipGuard } {
  if (newDirection === guard.confirmedDirection) {
    return {
      emitFlip: false,
      confirmedDirection: guard.confirmedDirection,
      updatedGuard: { pendingDirection: null, pendingCount: 0, confirmedDirection: guard.confirmedDirection },
    };
  }

  // From uncertain, accept any clear direction immediately (no 2-signal wait)
  if (guard.confirmedDirection === "uncertain" && newDirection !== "uncertain") {
    return {
      emitFlip: true,
      confirmedDirection: newDirection,
      updatedGuard: { pendingDirection: null, pendingCount: 0, confirmedDirection: newDirection },
    };
  }

  if (newDirection === guard.pendingDirection) {
    if (guard.pendingCount >= 1) {
      return {
        emitFlip: true,
        confirmedDirection: newDirection,
        updatedGuard: { pendingDirection: null, pendingCount: 0, confirmedDirection: newDirection },
      };
    } else {
      return {
        emitFlip: false,
        confirmedDirection: guard.confirmedDirection,
        updatedGuard: { pendingDirection: newDirection, pendingCount: guard.pendingCount + 1, confirmedDirection: guard.confirmedDirection },
      };
    }
  }

  return {
    emitFlip: false,
    confirmedDirection: guard.confirmedDirection,
    updatedGuard: { pendingDirection: newDirection, pendingCount: 1, confirmedDirection: guard.confirmedDirection },
  };
}

// DB is the primary FlipGuard store; in-memory map is a read-through cache only.

async function loadFlipGuard(assetId: string): Promise<FlipGuard> {
  // 1. Always try DB first (spec requirement: survive restarts)
  try {
    const rows = await db.select().from(flipGuardsTable).where(eq(flipGuardsTable.assetId, assetId)).limit(1);
    if (rows.length) {
      const r = rows[0]!;
      const guard: FlipGuard = {
        pendingDirection: r.pendingDirection as "up" | "down" | "uncertain" | null ?? null,
        pendingCount: r.pendingCount ?? 0,
        confirmedDirection: (r.confirmedDirection as "up" | "down" | "uncertain") ?? "uncertain",
      };
      _inMemoryFlipGuards.set(assetId, guard); // cache for fast reads
      return guard;
    }
  } catch {
    // DB unavailable — fall back to in-memory cache
    const mem = _inMemoryFlipGuards.get(assetId);
    if (mem) return mem;
  }

  // No DB row and no cache → fresh guard
  const fresh: FlipGuard = { pendingDirection: null, pendingCount: 0, confirmedDirection: "uncertain" };
  _inMemoryFlipGuards.set(assetId, fresh);
  return fresh;
}

async function saveFlipGuard(assetId: string, guard: FlipGuard): Promise<void> {
  // 1. Write to DB first (primary store)
  try {
    const existing = await db.select({ id: flipGuardsTable.id }).from(flipGuardsTable).where(eq(flipGuardsTable.assetId, assetId)).limit(1);
    if (existing.length) {
      await db.update(flipGuardsTable).set({
        pendingDirection: guard.pendingDirection,
        pendingCount: guard.pendingCount,
        confirmedDirection: guard.confirmedDirection,
        updatedAt: new Date(),
      }).where(eq(flipGuardsTable.id, existing[0]!.id));
    } else {
      await db.insert(flipGuardsTable).values({
        id: randomUUID(),
        assetId,
        pendingDirection: guard.pendingDirection,
        pendingCount: guard.pendingCount,
        confirmedDirection: guard.confirmedDirection,
        updatedAt: new Date(),
      });
    }
  } catch (err) {
    logger.warn({ assetId, err }, "market-agent: flip guard DB write failed — state lost on next restart");
  }

  // 2. Update in-memory cache as read-through layer
  _inMemoryFlipGuards.set(assetId, guard);
}

// ── Direction mapping from ensemble call ─────────────────────────────────────

function ensembleCallToDirection(call: string): "up" | "down" | "neutral" | "uncertain" {
  if (call === "BULLISH") return "up";
  if (call === "BEARISH") return "down";
  if (call === "UNCERTAIN") return "uncertain";
  return "neutral";
}

function confidenceFromEnsemble(result: EnsembleResult): "high" | "medium" | "low" {
  if (result.uncertaintyFlag) return "low";
  const avgConf = result.votes.reduce((s, v) => s + v.confidence, 0) / result.votes.length;
  if (result.unanimous && avgConf > 0.7) return "high";
  if (avgConf > 0.5) return "medium";
  return "low";
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function runMarketAgent(
  assetId: string,
  assetName: string,
  assetSymbol: string,
  regimeState: RegimeState,
  candleSummary: string,
  marketStats: string,
  lessons: string | null,
  options: { force?: boolean; ohlcvCandles?: YahooOHLCV[]; relevantNews?: string } = {},
): Promise<MarketSignal> {
  if (!options.force) {
    const cached = _cache.get(assetId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.signal;
  }

  logger.info({ assetId, regime: regimeState.regime }, "market-agent: running ensemble inference");

  // ── Fetch Tier 3 + OHLCV + regime age in parallel ──────────────────────────
  const [tier3, rawCandles, regimeAge] = await Promise.all([
    fetchTier3Snapshot(),
    options.ohlcvCandles ?? fetchYahooOHLCV(assetSymbol, 25),
    getRegimeAge(),
  ]);

  const tier3Score = computeTier3Score(tier3);

  // ── Candle trust (Change 2) ──────────────────────────────────────────────
  let candleTrust: CandleTrustResult = {
    trustScore: 1.0,
    flags: [],
    tier1Score: 0,
  };
  let latestCandle: YahooOHLCV | null = null;
  let rollingAvgVolume20d = 0;
  if (rawCandles && rawCandles.length >= 2) {
    latestCandle = rawCandles[rawCandles.length - 1]!;
    const volWindow = rawCandles.slice(-20);
    rollingAvgVolume20d = volWindow.reduce((s, c) => s + c.volume, 0) / volWindow.length;
    candleTrust = checkCandleTrust(
      {
        open: latestCandle.open,
        high: latestCandle.high,
        low: latestCandle.low,
        close: latestCandle.close,
        volume: latestCandle.volume,
      },
      rollingAvgVolume20d,
      tier3.deliveryPct
    );
  }

  const storedRegime = await getStoredRegime(assetId);
  const regimeProbs = storedRegime
    ? { RISK_ON: storedRegime.riskOnProbability, RISK_OFF: storedRegime.riskOffProbability, CRISIS: storedRegime.crisisProbability }
    : regimeState.probabilities;

  // ── Active channels + scenarios with decay ───────────────────────────────
  const [activeChannelsRaw, activeScenariosWithDecay] = await Promise.all([
    getActiveTransmissionChannels(),
    getActiveScenariosWithDecay(),
  ]);
  const activeChannels = activeChannelsRaw.map(ch => `${ch.channelId} (${ch.name})`);

  // ── Build three separate contexts (Change 3) ───────────────────────────────
  const currentRegime = regimeState.regime;
  const sessionOpenPrice = latestCandle?.open ?? 0;
  const prevCandle = rawCandles && rawCandles.length >= 2 ? rawCandles[rawCandles.length - 2] : null;
  const yesterdayClose = {
    nifty: latestCandle?.close ?? 0,
    sensex: latestCandle?.close ?? 0,
    returnPct: prevCandle?.changePct ?? 0,
  };

  const sectoralNarrative = deriveSectoralNarrative(tier3.sectorDeltas);
  const sectoralLine = tier3.sectorDeltas
    ? `Bank Nifty vs NIFTY delta: ${tier3.sectorDeltas.bank.toFixed(2)}% | Nifty IT vs NIFTY delta: ${tier3.sectorDeltas.it.toFixed(2)}%`
    : "Sectoral deltas unavailable";

  // Per-asset raw news, already filtered to this instrument's market drivers and to
  // the last-trading-day window (see stock-news.ts). Only relevant headlines reach here.
  const newsBlock = options.relevantNews?.trim()
    ? `\nDRIVER NEWS (last-trading-day window, filtered for this instrument):\n${options.relevantNews.trim()}\n`
    : "";
  if (newsBlock) {
    logger.info({ assetId, newsPreview: newsBlock.slice(0, 200) }, "market-agent: news injected into prompt");
  } else {
    logger.warn({ assetId }, "market-agent: no news block for prompt");
  }

  const context6h = `
HORIZON: 6 hours (intraday)
CURRENT SESSION DATA (use this, not historical closes):
- Session open price: ${sessionOpenPrice.toFixed(2)}
- Current price vs open: ${sessionOpenPrice > 0 ? (((latestCandle?.close ?? 0) - sessionOpenPrice) / sessionOpenPrice * 100).toFixed(2) : "0"}%
- Candle trust score: ${candleTrust.trustScore.toFixed(2)} (1.0=clean, <0.5=flagged)
- Candle flags: ${candleTrust.flags.length > 0 ? candleTrust.flags.join(", ") : "none"}
- Live put/call ratio: ${tier3.putCallRatio !== null ? tier3.putCallRatio.toFixed(2) + " (below 0.8=bullish, above 1.1=bearish)" : "unavailable"}
- Advance/decline ratio: ${tier3.advanceDeclineRatio !== null ? tier3.advanceDeclineRatio.toFixed(2) + " (above 1.5=bullish breadth)" : "unavailable"}
- India VIX: ${tier3.indiaVix !== null ? tier3.indiaVix.toFixed(1) + " (5d change: " + (tier3.indiaVix5dChange !== null && tier3.indiaVix5dChange > 0 ? "+" : "") + (tier3.indiaVix5dChange !== null ? tier3.indiaVix5dChange.toFixed(1) : "N/A") + ")" : "unavailable"}
- Live implied volatility: ${tier3.impliedVolPct !== null ? tier3.impliedVolPct.toFixed(1) + "%" : "unavailable"}
- Max pain strike: ${tier3.maxPainStrike !== null ? tier3.maxPainStrike.toFixed(0) + " (distance: " + (tier3.maxPainDistancePct !== null ? (tier3.maxPainDistancePct > 0 ? "+" : "") + tier3.maxPainDistancePct.toFixed(2) + "%" : "N/A") + ")" : "unavailable"}
- SGX Nifty pre-market: ${tier3.sgxNiftyChangePct !== null ? (tier3.sgxNiftyChangePct > 0 ? "+" : "") + tier3.sgxNiftyChangePct.toFixed(2) + "%" : "unavailable"}
- Short covering signal: ${tier3.shortCoveringSignal} (${tier3.shortCoveringSignal === "covering" ? "high PCR + falling OI + falling VIX = shorts buying back, bullish" : tier3.shortCoveringSignal === "unwinding" ? "low PCR + rising OI + rising VIX = fresh shorts, bearish" : "no clear short covering pattern"})
SECTORAL CONTEXT (intraday, updates every 5 minutes):
${sectoralNarrative}
${sectoralLine}
Weight rule: Bank Nifty leading NIFTY up by >0.5% is the single strongest intraday signal for institutional conviction. Weight this above candle patterns. If short covering is active, the upside can be 1.5-2% because there are no sellers left.
HMM REGIME: ${currentRegime} (active for ${regimeAge} consecutive cycles)
REGIME INSTRUCTION: If regime says RISK_OFF but live microstructure data is unavailable, rely on candle quality, price momentum, and geopolitical channels instead. Do not default to NEUTRAL just because NSE data is missing.
ACTIVE GEOPOLITICAL CHANNELS (only channels with daysSinceTrigger <= 3 and decayedWeight > 0.3):
${activeChannelsRaw.filter(c => c.decayedWeight > 0.3).map(c => `- ${c.name}: weight ${c.decayedWeight.toFixed(2)}`).join("\n") || "- none active"}
${newsBlock}NEWS INSTRUCTION: You MUST reference specific headlines from the DRIVER NEWS section in your rationale. If news contradicts the quantitative signals, state the conflict explicitly and reduce confidence. If no news block is present, say so.
Return JSON: { "call": "BULLISH" | "BEARISH" | "NEUTRAL", "confidence": 0.0-1.0, "rationale": "string max 80 words, MUST mention at least one news headline if present" }
`.trim();

  const context24h = `
HORIZON: 24 hours (next session)
YESTERDAY'S CLOSE DATA:
- NIFTY close: ${yesterdayClose.nifty.toFixed(2)}
- SENSEX close: ${yesterdayClose.sensex.toFixed(2)}
- Session return: ${yesterdayClose.returnPct.toFixed(2)}%
INSTITUTIONAL CONVICTION (this is the primary signal for this window):
- FII net flow: ${tier3.fiiDataDate ? "₹" + tier3.fiiNetCrore.toFixed(0) + " crore" + (tier3.fiiIsStale ? " [WARNING: stale data]" : "") : "unavailable"}
- DII net flow: ${tier3.fiiDataDate ? "₹" + tier3.diiNetCrore.toFixed(0) + " crore" : "unavailable"}
- Delivery %: ${tier3.deliveryPct !== null ? tier3.deliveryPct.toFixed(1) + "%" : "not yet available (intraday)"}
- Open interest change: ${tier3.openInterestChange > 0 ? "+" : ""}${tier3.openInterestChange.toFixed(1)}% (positive=new positions=conviction)
- Put/call ratio: ${tier3.putCallRatio !== null ? tier3.putCallRatio.toFixed(2) : "unavailable"}
- Short covering assessment: ${tier3.shortCoveringSignal} (${tier3.shortCoveringSignal === "covering" ? "bullish — shorts are trapped, no sellers left" : tier3.shortCoveringSignal === "unwinding" ? "bearish — fresh shorts entering" : "neutral — no clear pattern"})
- Max pain pin level: ${tier3.maxPainStrike !== null ? tier3.maxPainStrike.toFixed(0) : "unavailable"} (market makers may pull price toward this at expiry)
MACRO (secondary signal):
- INR/USD: ${tier3.inrUsdRate.toFixed(2)} (5d change: ${tier3.inrUsd5dChangePct > 0 ? "+" : ""}${tier3.inrUsd5dChangePct.toFixed(2)}%)
- 10Y yield: ${tier3.yield10Y.toFixed(2)}% (5d change: ${tier3.yield10Y5dChangeBps > 0 ? "+" : ""}${tier3.yield10Y5dChangeBps.toFixed(0)} bps)
SECTORAL CONTEXT (intraday, updates every 5 minutes):
${sectoralNarrative}
${sectoralLine}
HMM REGIME: ${currentRegime} (active for ${regimeAge} cycles)
REGIME INSTRUCTION: If FII net is positive AND delivery % exceeds 38%, treat this as a potential regime transition away from RISK_OFF regardless of the HMM label. State this explicitly in your rationale.
PRICED-IN CONTEXT:
${activeScenariosWithDecay.map(s => `- ${s.label}: ${s.alreadyTransmitted ? "[ALREADY TRANSMITTED to market on " + s.transmissionDate + ", decay factor " + s.decayFactor.toFixed(2) + "]" : "active"}`).join("\n") || "- no active scenarios"}
${newsBlock}NEWS INSTRUCTION: You MUST reference specific headlines from the DRIVER NEWS section in your rationale. If news contradicts the quantitative signals, state the conflict explicitly and reduce confidence.
Return JSON: { "call": "BULLISH" | "BEARISH" | "NEUTRAL", "confidence": 0.0-1.0, "rationale": "string max 80 words, MUST mention at least one news headline if present" }
`.trim();

  const context72h = `
HORIZON: 72 hours (3 sessions)
IMPORTANT: Do not use recent price action. Your signal comes from structural macro and options market only.
MACRO STRUCTURAL SIGNALS:
- Brent crude: $${tier3.crudeBrent.toFixed(1)} (5d change: ${tier3.crude5dChangePct > 0 ? "+" : ""}${tier3.crude5dChangePct.toFixed(1)}%)
- INR/USD 5d trend: ${tier3.inrUsd5dChangePct > 0 ? "INR weakening +" : "INR strengthening "}${Math.abs(tier3.inrUsd5dChangePct).toFixed(2)}%
- 10Y yield 5d trend: ${tier3.yield10Y5dChangeBps > 0 ? "rising +" : "falling "}${Math.abs(tier3.yield10Y5dChangeBps).toFixed(0)} bps
- India VIX 5d change: ${tier3.indiaVix5dChange !== null ? (tier3.indiaVix5dChange > 0 ? "+" : "") + tier3.indiaVix5dChange.toFixed(1) + " points" : "unavailable"}
OPTIONS STRUCTURE (3-day view):
- Put/call ratio: ${tier3.putCallRatio !== null ? tier3.putCallRatio.toFixed(2) : "unavailable"}
- Implied volatility: ${tier3.impliedVolPct !== null ? tier3.impliedVolPct.toFixed(1) + "%" : "unavailable"}
- OI change trend: ${tier3.openInterestChange > 0 ? "building" : "unwinding"} (${tier3.openInterestChange > 0 ? "+" : ""}${tier3.openInterestChange.toFixed(1)}%)
- Max pain strike: ${tier3.maxPainStrike !== null ? tier3.maxPainStrike.toFixed(0) : "unavailable"} (if price >1.5% away, expect pin toward expiry)
- Short covering signal: ${tier3.shortCoveringSignal} (structural view: covering rallies can extend 1.5-2%)
ACTIVE GEOPOLITICAL SCENARIOS (structural, 72h view):
${activeScenariosWithDecay.map(s => `- ${s.label} (prob: ${(s.probability * 100).toFixed(0)}%, channel: ${s.channel}, decay: ${s.decayFactor.toFixed(2)})`).join("\n") || "- none"}
HMM REGIME: ${currentRegime} (${regimeAge} cycles). Weight this at 30% of your reasoning. Macro signals above are 70%.
${newsBlock}NEWS INSTRUCTION: You MUST reference specific headlines from the DRIVER NEWS section in your rationale. If news contradicts the quantitative signals, state the conflict explicitly and reduce confidence.
Return JSON: { "call": "BULLISH" | "BEARISH" | "NEUTRAL", "confidence": 0.0-1.0, "rationale": "string max 80 words, MUST mention at least one news headline if present" }
`.trim();

  // ── Run ensemble with separate contexts (Change 4) ─────────────────────────
  const geopoliticalSignal = deriveGeopoliticalSignal(activeChannelsRaw);
  const ensemble = await runEnsembleInference({
    assetId,
    regime: regimeState.regime,
    regimeProbabilities: regimeProbs,
    activeChannels,
    context6h,
    context24h,
    context72h,
    geopoliticalSignal,
  });

  // ── Compute priceScore and apply FlipGuard (Change 5) ─────────────────────
  const { priceScore, direction: rawDirection } = computePriceScore(tier3Score, candleTrust, ensemble.votes);

  const flipGuard = await loadFlipGuard(assetId);
  const flipResult = applyFlipGuard(flipGuard, rawDirection);
  await saveFlipGuard(assetId, flipResult.updatedGuard);

  const finalDirection = flipResult.confirmedDirection;
  const flipConfirmed = flipResult.emitFlip;

  // Map finalDirection back to MarketCall for consistency
  const finalCall: "BULLISH" | "BEARISH" | "NEUTRAL" | "UNCERTAIN" =
    finalDirection === "up" ? "BULLISH" : finalDirection === "down" ? "BEARISH" : finalDirection === "uncertain" ? "UNCERTAIN" : "NEUTRAL";

  // bull/bear scores must align with the final verdict, otherwise the UI
  // shows e.g. "100% bullish weight" while the direction badge says NEUTRAL
  // (because the ensemble landed UNCERTAIN with 2 BULLISH + 1 NEUTRAL votes).
  // Score reflects the verdict + magnitude rather than raw window-vote counts.
  const bullVotes = ensemble.votes.filter(v => v.call === "BULLISH").length;
  const bearVotes = ensemble.votes.filter(v => v.call === "BEARISH").length;
  let bullScore = 0;
  let bearScore = 0;
  if (finalCall === "BULLISH") {
    bullScore = bullVotes * 3 + 1;
    bearScore = bearVotes * 3;
  } else if (finalCall === "BEARISH") {
    bearScore = bearVotes * 3 + 1;
    bullScore = bullVotes * 3;
  } else {
    // NEUTRAL or UNCERTAIN by FlipGuard — but the ensemble may still have
    // voted directionally (e.g. 1 BULLISH + 2 NEUTRAL). Reflect the raw
    // ensemble vote balance so the UI's "bull signals / bear signals" row
    // shows real evidence instead of triggering an "insufficient data"
    // empty state. Direction badge will still read NEUTRAL — correctly —
    // because the agent hasn't confirmed a flip yet.
    bullScore = bullVotes * 3;
    bearScore = bearVotes * 3;
  }

  const primaryRationale = ensemble.votes.find(v => v.call === finalCall)?.rationale
    ?? ensemble.votes.find(v => v.call === ensemble.final)?.rationale
    ?? ensemble.votes[0]?.rationale ?? "";

  const signal: MarketSignal = {
    direction: finalDirection,
    magnitude: ensemble.unanimous ? "strong" : "moderate",
    confidence: confidenceFromEnsemble(ensemble),
    timeframe: ensemble.uncertaintyFlag ? "next-session" : "intraday",
    priceImpactEstimate: finalCall === "BULLISH" ? "+0.5% to +1.2%" : finalCall === "BEARISH" ? "-0.5% to -1.2%" : "±0.3%",
    verdict: primaryRationale,
    dominantNarrative: finalCall === "UNCERTAIN"
      ? "Mixed signals — ensemble split"
      : `${finalCall} consensus (${ensemble.votes.map(v => `${v.window}:${v.call}`).join(", ")})`,
    assumptions: `Regime persists as ${regimeState.regime}; no sudden FII reversal`,
    triggerNewsSummary: `${activeChannels.length} active geopolitical channel(s): ${activeChannels.slice(0, 3).join(", ") || "none"}`,
    bullScore,
    bearScore,
    regime: regimeState.regime,
    regimeProbabilities: regimeProbs,
    activeGeopoliticalScenarios: activeChannels,
    activeChannels,
    ensembleVotes: ensemble.votes,
    uncertaintyFlag: ensemble.uncertaintyFlag,

    // New fields
    priceScore,
    flipConfirmed,
    tier3Evidence: {
      fiiNetCrore: tier3.fiiNetCrore,
      fiiIsStale: tier3.fiiIsStale,
      putCallRatio: tier3.putCallRatio,
      advanceDeclineRatio: tier3.advanceDeclineRatio,
      deliveryPct: tier3.deliveryPct,
      indiaVix5dChange: tier3.indiaVix5dChange,
      tier3Score,
      maxPainStrike: tier3.maxPainStrike,
      maxPainDistancePct: tier3.maxPainDistancePct,
      sgxNiftyChangePct: tier3.sgxNiftyChangePct,
      shortCoveringSignal: tier3.shortCoveringSignal,
    },
    candleTrustScore: candleTrust.trustScore,
    candleFlags: candleTrust.flags,
    regimeAge,
    channelDecaySummary: activeChannelsRaw.map(ch => ({
      channelId: ch.channelId,
      decayedWeight: ch.decayedWeight,
      daysSinceTrigger: ch.daysSinceTrigger,
    })),
  };

  _cache.set(assetId, { signal, fetchedAt: Date.now() });
  logger.info({ assetId, direction: signal.direction, priceScore: signal.priceScore.toFixed(3), flip: signal.flipConfirmed }, "market-agent: done");
  return signal;
}

export type { OHLCV as YahooOHLCV } from "./candle-trust.js";


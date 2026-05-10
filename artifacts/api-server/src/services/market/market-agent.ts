// Phase 4: GPT-4o ensemble market agent.
// Uses 3-window ensemble (6h/24h/72h) + HMM regime + active TRANSMITS_TO channels from Neo4j.

import { db, predictionV2Table, marketRegimesTable } from "@workspace/db";
import { eq, desc, and, gt } from "drizzle-orm";
import { logger } from "../../lib/logger.js";
import { runEnsembleInference, type EnsembleResult } from "./ensemble.js";
import type { RegimeState } from "./hmm-regime.js";
import type { ForecasterTree } from "../reasoning/agent-forecaster.js";
import { runCypher } from "../graph/neo4j-client.js";

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
  // Regime & ensemble metadata
  regime: string;
  regimeProbabilities: Record<string, number>;
  activeGeopoliticalScenarios: string[];
  activeChannels: string[];
  ensembleVotes: EnsembleResult["votes"];
  uncertaintyFlag: boolean;
}

const _cache = new Map<string, { signal: MarketSignal; fetchedAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h

// ── Active TRANSMITS_TO channels from Neo4j ────────────────────────────────────

async function getActiveTransmissionChannels(): Promise<string[]> {
  try {
    const result = await runCypher(
      `MATCH (s:Story)-[:TRANSMITS_TO]->(c:Channel)
       WHERE s.status = 'active'
       RETURN DISTINCT c.id AS channelId, c.label AS label, c.weight AS weight
       ORDER BY c.weight DESC
       LIMIT 10`,
      {}
    );
    return result.records.map(r => `${r.get("channelId") as string} (${r.get("label") as string})`);
  } catch {
    return [];
  }
}

// ── Active geopolitical scenarios from prediction_v2 ─────────────────────────

async function getActiveScenarios(windowHours: number): Promise<string> {
  try {
    const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000);
    const rows = await db
      .select({ finalScenarios: predictionV2Table.finalScenarios, dominantChannel: predictionV2Table.dominantChannel })
      .from(predictionV2Table)
      .where(and(
        eq(predictionV2Table.resolutionStatus, "pending"),
        gt(predictionV2Table.generatedAt, cutoff),
      ))
      .orderBy(desc(predictionV2Table.generatedAt))
      .limit(10);

    const lines = rows.flatMap(row => {
      try {
        const scenarios = JSON.parse(row.finalScenarios) as ForecasterTree["scenarios"];
        const dominant = scenarios[0];
        return dominant
          ? [`[${row.dominantChannel ?? "unknown"}] ${dominant.label} (${(dominant.probability * 100).toFixed(0)}%): ${(dominant.narrative ?? "").slice(0, 100)}`]
          : [];
      } catch { return []; }
    });

    return lines.length > 0 ? lines.join("\n") : "No active scenarios in this window.";
  } catch {
    return "Scenario data unavailable.";
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
  lessons: string | null
): Promise<MarketSignal> {
  const cached = _cache.get(assetId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.signal;

  logger.info({ assetId, regime: regimeState.regime }, "market-agent: running ensemble inference");

  const [storedRegime, activeChannels, scenarios6h, scenarios24h, scenarios72h] = await Promise.all([
    getStoredRegime(assetId),
    getActiveTransmissionChannels(),
    getActiveScenarios(6),
    getActiveScenarios(24),
    getActiveScenarios(72),
  ]);

  const regimeProbs = storedRegime
    ? { RISK_ON: storedRegime.riskOnProbability, RISK_OFF: storedRegime.riskOffProbability, CRISIS: storedRegime.crisisProbability }
    : regimeState.probabilities;

  const baseContext = `Asset: ${assetName} (${assetSymbol})\nRegime sequence: ${regimeState.sequenceSummary}\n${marketStats}\nLessons: ${lessons ?? "none"}\n`;

  const ensemble = await runEnsembleInference({
    assetId,
    regime: regimeState.regime,
    regimeProbabilities: regimeProbs,
    activeChannels,
    context6h: `${baseContext}OHLCV (7d):\n${candleSummary}\nScenarios (6h window):\n${scenarios6h}`,
    context24h: `${baseContext}OHLCV (7d):\n${candleSummary}\nScenarios (24h window):\n${scenarios24h}`,
    context72h: `${baseContext}Scenarios (72h window — macro focus):\n${scenarios72h}`,
  });

  // Derive scalar scores from ensemble
  const bullVotes = ensemble.votes.filter(v => v.call === "BULLISH").length;
  const bearVotes = ensemble.votes.filter(v => v.call === "BEARISH").length;
  const bullScore = bullVotes * 3 + (ensemble.final === "BULLISH" ? 1 : 0);
  const bearScore = bearVotes * 3 + (ensemble.final === "BEARISH" ? 1 : 0);

  const primaryRationale = ensemble.votes.find(v => v.call === ensemble.final)?.rationale
    ?? ensemble.votes[0]?.rationale ?? "";

  const signal: MarketSignal = {
    direction: ensembleCallToDirection(ensemble.final),
    magnitude: ensemble.unanimous ? "strong" : "moderate",
    confidence: confidenceFromEnsemble(ensemble),
    timeframe: ensemble.uncertaintyFlag ? "next-session" : "intraday",
    priceImpactEstimate: ensemble.final === "BULLISH" ? "+0.5% to +1.2%" : ensemble.final === "BEARISH" ? "-0.5% to -1.2%" : "±0.3%",
    verdict: primaryRationale,
    dominantNarrative: ensemble.uncertaintyFlag
      ? "Mixed signals — ensemble split"
      : `${ensemble.final} consensus (${ensemble.votes.map(v => `${v.window}:${v.call}`).join(", ")})`,
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
  };

  _cache.set(assetId, { signal, fetchedAt: Date.now() });
  logger.info({ assetId, direction: signal.direction, uncertain: signal.uncertaintyFlag }, "market-agent: done");
  return signal;
}

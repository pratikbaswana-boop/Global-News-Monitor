// Phase 4: GPT-4o ensemble market agent.
// Replaces keyword bull/bear scoring with: HMM regime + active geopolitical scenarios → directional signal.
// Returns the same AIPrediction shape used by the legacy aiPredictAsset function.

import { openai } from "@workspace/integrations-openai-ai-server";
import { db, predictionV2Table, marketRegimesTable } from "@workspace/db";
import { eq, desc, and, gt } from "drizzle-orm";
import { logger } from "../../lib/logger.js";
import type { RegimeState } from "./hmm-regime.js";
import type { ForecasterTree } from "../reasoning/agent-forecaster.js";

// Mirror of the AIPrediction interface from intelligence.ts (avoids circular import)
export interface MarketSignal {
  direction: "up" | "down" | "neutral";
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
  // Regime-specific additions
  regime: "bull" | "sideways" | "bear";
  regimeProbabilities: { bull: number; sideways: number; bear: number };
  activeGeopoliticalScenarios: string[];
}

const _cache = new Map<string, { signal: MarketSignal; fetchedAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h

// Fetch active geopolitical scenarios from prediction_v2 (last 12h)
async function getActiveScenarios(): Promise<string[]> {
  try {
    const cutoff = new Date(Date.now() - 12 * 60 * 60 * 1000);
    const rows = await db
      .select({ finalScenarios: predictionV2Table.finalScenarios, dominantChannel: predictionV2Table.dominantChannel })
      .from(predictionV2Table)
      .where(and(
        eq(predictionV2Table.resolutionStatus, "pending"),
        gt(predictionV2Table.generatedAt, cutoff),
      ))
      .orderBy(desc(predictionV2Table.generatedAt))
      .limit(10);

    return rows.flatMap(row => {
      try {
        const scenarios = JSON.parse(row.finalScenarios) as ForecasterTree["scenarios"];
        const dominant = scenarios[0];
        return dominant ? [`[${row.dominantChannel ?? "unknown"}] ${dominant.label} (${(dominant.probability * 100).toFixed(0)}%): ${dominant.narrative?.slice(0, 120) ?? ""}`.trim()] : [];
      } catch { return []; }
    });
  } catch {
    return [];
  }
}

// Fetch the latest stored regime for an asset (from market_regimes table)
async function getStoredRegime(assetId: string): Promise<MarketRegime | null> {
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

type MarketRegime = typeof marketRegimesTable.$inferSelect;

const MARKET_AGENT_SYSTEM = `You are a quantitative market analyst for Indian equity markets. You receive:
1. The current HMM-detected market regime with state probabilities
2. Active geopolitical scenarios from a multi-agent intelligence pipeline
3. 7-day OHLCV data for the asset

Synthesize these inputs into a short-term directional signal. Return only valid JSON conforming to this schema:
{
  "direction": "up" | "down" | "neutral",
  "magnitude": "strong" | "moderate" | "mild",
  "confidence": "high" | "medium" | "low",
  "timeframe": "intraday" | "next-session",
  "priceImpactEstimate": string (e.g. "+0.5% to +1.2%"),
  "verdict": string (1-2 sentences),
  "dominantNarrative": string (key driver in 10 words),
  "assumptions": string (key assumption that could invalidate the call),
  "triggerNewsSummary": string (1 sentence on what's driving this),
  "bullScore": number (0-10),
  "bearScore": number (0-10)
}

Rules:
- In a BULL regime with no adverse geopolitical channel: bias upward unless hard data contradicts
- In a BEAR regime with active crude_oil_spike/fii_risk_off/global_risk_off channels: strong bear bias
- In SIDEWAYS: lower magnitude, higher uncertainty, prefer "neutral" direction
- priceImpactEstimate must be a range (e.g. "-0.5% to -1.0%")
- bullScore + bearScore typically ≤ 15; if direction=neutral they should be close to each other`;

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

  logger.info({ assetId, regime: regimeState.regime }, "market-agent: running");

  const [geopoliticalScenarios, storedRegime] = await Promise.all([
    getActiveScenarios(),
    getStoredRegime(assetId),
  ]);

  // Use stored regime probabilities if current detection was ephemeral
  const probs = storedRegime
    ? { bull: storedRegime.bullProbability, sideways: storedRegime.sidewaysProbability, bear: storedRegime.bearProbability }
    : regimeState.probabilities;

  const regimeText = `HMM REGIME: ${regimeState.regime.toUpperCase()} (confidence: ${(regimeState.confidence * 100).toFixed(0)}%)
State probabilities: Bull=${(probs.bull * 100).toFixed(0)}% | Sideways=${(probs.sideways * 100).toFixed(0)}% | Bear=${(probs.bear * 100).toFixed(0)}%
Regime sequence (last 10 days): ${regimeState.sequenceSummary}`;

  const geoText = geopoliticalScenarios.length > 0
    ? `ACTIVE GEOPOLITICAL SCENARIOS (from intelligence pipeline):\n${geopoliticalScenarios.map((s, i) => `[${i + 1}] ${s}`).join("\n")}`
    : "GEOPOLITICAL SCENARIOS: None active (reasoning pipeline not yet seeded)";

  const lessonsSection = lessons ? `\nPAST FAILURES:\n${lessons}` : "";

  const userContent = `Analyze ${assetName} (${assetSymbol}) for a short-term directional signal.

${regimeText}

${geoText}

7-DAY OHLCV:
${candleSummary}
${marketStats}
${lessonsSection}`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.2,
      max_tokens: 600,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: MARKET_AGENT_SYSTEM },
        { role: "user", content: userContent },
      ],
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as {
      direction: "up" | "down" | "neutral";
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
    };

    const signal: MarketSignal = {
      ...parsed,
      regime: regimeState.regime,
      regimeProbabilities: probs,
      activeGeopoliticalScenarios: geopoliticalScenarios,
    };

    _cache.set(assetId, { signal, fetchedAt: Date.now() });
    logger.info({ assetId, direction: signal.direction, regime: signal.regime }, "market-agent: done");
    return signal;

  } catch (err) {
    logger.error({ assetId, err }, "market-agent: GPT-4o failed — returning neutral fallback");
    const fallback: MarketSignal = {
      direction: "neutral", magnitude: "mild", confidence: "low",
      timeframe: "next-session",
      priceImpactEstimate: "0% to ±0.5%",
      verdict: "Market agent unavailable. Defaulting to neutral.", dominantNarrative: "Agent error",
      assumptions: "n/a", triggerNewsSummary: "n/a",
      bullScore: 3, bearScore: 3,
      regime: regimeState.regime, regimeProbabilities: probs, activeGeopoliticalScenarios: [],
    };
    return fallback;
  }
}

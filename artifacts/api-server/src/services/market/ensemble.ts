// 3-window ensemble inference for market direction.
// Three independent GPT-4o calls with different context windows: 6h / 24h / 72h.
// Majority vote determines final call; 3-way split or CRISIS regime → UNCERTAIN.

import { chatComplete } from "@workspace/integrations-openai-ai-server";
import { logger } from "../../lib/logger.js";
import type { Regime } from "./hmm-regime.js";

export type MarketCall = "BULLISH" | "BEARISH" | "NEUTRAL" | "UNCERTAIN";

export interface EnsembleVote {
  window: "6h" | "24h" | "72h";
  call: MarketCall;
  confidence: number; // 0-1
  rationale: string;
}

export interface EnsembleResult {
  final: MarketCall;
  votes: EnsembleVote[];
  unanimous: boolean;
  uncertaintyFlag: boolean; // true if 3-way split or CRISIS regime override
}

// ── Per-window system prompt ───────────────────────────────────────────────────

function buildWindowPrompt(window: "6h" | "24h" | "72h"): string {
  const horizon = { "6h": "intraday (next 6 hours)", "24h": "next 24 hours", "72h": "next 72 hours" }[window];
  return `You are a quantitative analyst assessing Indian equity market direction for the ${horizon} horizon.
You receive: (1) current market regime state, (2) active geopolitical transmission channels, (3) recent news summary.

Return only valid JSON:
{
  "call": "BULLISH" | "BEARISH" | "NEUTRAL" | "UNCERTAIN",
  "confidence": number (0.0–1.0),
  "rationale": string (1–2 sentences, specific to the ${window} window)
}

Rules:
- UNCERTAIN only if signals are genuinely contradictory or regime is CRISIS with >0.6 crisis probability
- Confidence < 0.5 should map to NEUTRAL or UNCERTAIN, not a directional call
- Weight channel severity by recency — channels active < 12h count double
- ${window === "6h" ? "Focus on momentum and intraday flow data." : ""}
- ${window === "72h" ? "Focus on structural regime shift probability and macro channel accumulation." : ""}`;
}

// ── Single window inference ───────────────────────────────────────────────────

async function runWindowInference(
  window: "6h" | "24h" | "72h",
  regime: Regime,
  regimeProbabilities: Record<string, number>,
  activeChannels: string[],
  contextSummary: string,
): Promise<EnsembleVote> {
  const userContent = `REGIME: ${regime} (probabilities: ${JSON.stringify(regimeProbabilities)})
ACTIVE TRANSMISSION CHANNELS: ${activeChannels.length > 0 ? activeChannels.join(", ") : "none detected"}
CONTEXT (${window} window):
${contextSummary}`;

  try {
    const response = await chatComplete({
      model: "gpt-4o",
      temperature: 0.2,
      max_tokens: 300,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildWindowPrompt(window) },
        { role: "user", content: userContent },
      ],
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as { call: MarketCall; confidence: number; rationale: string };

    return {
      window,
      call: parsed.call ?? "UNCERTAIN",
      confidence: Math.min(1, Math.max(0, parsed.confidence ?? 0.5)),
      rationale: parsed.rationale ?? "",
    };
  } catch (err) {
    logger.error({ window, err }, "ensemble: window inference failed");
    return { window, call: "UNCERTAIN", confidence: 0, rationale: "inference error" };
  }
}

// ── Majority vote logic ───────────────────────────────────────────────────────

function majorityVote(votes: EnsembleVote[], regime: Regime, crisisProbability: number): EnsembleResult {
  // CRISIS override: if crisis probability > 0.6, force UNCERTAIN
  if (regime === "CRISIS" && crisisProbability > 0.6) {
    return {
      final: "UNCERTAIN",
      votes,
      unanimous: false,
      uncertaintyFlag: true,
    };
  }

  const callCounts: Record<string, number> = {};
  for (const vote of votes) {
    callCounts[vote.call] = (callCounts[vote.call] ?? 0) + 1;
  }

  // 3-way split (all different) → UNCERTAIN
  const uniqueCalls = Object.keys(callCounts);
  if (uniqueCalls.length === 3) {
    return { final: "UNCERTAIN", votes, unanimous: false, uncertaintyFlag: true };
  }

  // Find call with max votes; ties → UNCERTAIN
  let bestCall: MarketCall = "UNCERTAIN";
  let bestCount = 0;
  let tied = false;
  for (const [call, count] of Object.entries(callCounts)) {
    if (count > bestCount) {
      bestCount = count;
      bestCall = call as MarketCall;
      tied = false;
    } else if (count === bestCount) {
      tied = true;
    }
  }

  if (tied) bestCall = "UNCERTAIN";

  const unanimous = uniqueCalls.length === 1;
  return {
    final: bestCall,
    votes,
    unanimous,
    uncertaintyFlag: bestCall === "UNCERTAIN",
  };
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function runEnsembleInference(params: {
  assetId: string;
  regime: Regime;
  regimeProbabilities: Record<string, number>;
  activeChannels: string[];
  context6h: string;
  context24h: string;
  context72h: string;
}): Promise<EnsembleResult> {
  logger.info({ assetId: params.assetId, regime: params.regime }, "ensemble: running 3-window inference");

  const crisisProbability = params.regimeProbabilities["CRISIS"] ?? 0;

  // Run all 3 windows in parallel — independent calls
  const [vote6h, vote24h, vote72h] = await Promise.all([
    runWindowInference("6h",  params.regime, params.regimeProbabilities, params.activeChannels, params.context6h),
    runWindowInference("24h", params.regime, params.regimeProbabilities, params.activeChannels, params.context24h),
    runWindowInference("72h", params.regime, params.regimeProbabilities, params.activeChannels, params.context72h),
  ]);

  const result = majorityVote([vote6h, vote24h, vote72h], params.regime, crisisProbability);

  logger.info(
    { assetId: params.assetId, final: result.final, uncertain: result.uncertaintyFlag, votes: result.votes.map(v => v.call) },
    "ensemble: complete"
  );

  return result;
}

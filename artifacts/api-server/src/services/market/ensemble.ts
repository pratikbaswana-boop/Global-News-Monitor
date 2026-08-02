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
  uncertaintyFlag: boolean; // true if genuinely ambiguous or CRISIS regime override
  score: number;            // confidence-weighted directional score in [-1, +1]
  reason: string;           // why the final call was chosen (audit trail)
}

export interface GeopoliticalSignal {
  dominantChannel: string | null;        // e.g. "fii_risk_off", "crude_spike", etc.
  sentiment: "bullish" | "bearish" | "neutral";
  decayedWeight: number;                 // 0-1 — how live the signal still is after decay
}

// ── Per-window system prompts (Change 4) ─────────────────────────────────────

const systemPrompt6h = `You are a quantitative analyst assessing Indian equity market direction for the INTRADAY (6 hour) horizon. You specialise in reading live market microstructure: candle quality, options flow, and breadth. You do not extrapolate multi-day trends. You assess only what the next 6 hours look like based on the data given. If candle trust score is below 0.5, heavily discount the price signal and rely on put/call ratio and advance/decline instead. PCR INTERPRETATION: Normal range 0.8-1.1 is neutral. Below 0.8 = bullish (more calls being written). Above 1.1 = bearish (more puts being written). HOWEVER, at extremes (>1.5 or <0.5), PCR becomes a CONTRARIAN signal: PCR >1.5 means everyone has already hedged with puts, no more sellers left → contrarian BULLISH. PCR <0.5 means everyone has already bought calls, no more buyers left → contrarian BEARISH. When PCR is at an extreme, check current price momentum: if price is rising with PCR >1.5, the contrarian bullish signal is confirmed. CRITICAL: If put/call ratio and advance/decline are marked unavailable, base your call ENTIRELY on candle quality, price momentum, and geopolitical channels. Do NOT default to NEUTRAL just because some data is missing. Return only valid JSON with fields: call, confidence, rationale.`;

const systemPrompt24h = `You are a quantitative analyst assessing Indian equity market direction for the NEXT SESSION (24 hour) horizon. Your primary inputs are institutional conviction signals: FII/DII flows, delivery percentage, and open interest change. Price action from yesterday is context only — not your primary signal. If FII net is positive and delivery % exceeds 38%, this is strong bullish conviction even if yesterday's price was flat or down. If regime says RISK_OFF but institutional signals are bullish, explicitly flag the contradiction and lean toward the institutional data. CRITICAL: If FII/DII flow or delivery data is marked unavailable, weight macro signals (INR trend, crude oil, bond yields) at 70% of your reasoning. Do NOT default to NEUTRAL just because institutional data is missing. Return only valid JSON with fields: call, confidence, rationale.`;

const systemPrompt72h = `You are a macro analyst assessing Indian equity market direction for the 72 HOUR (3 session) horizon. You must not use recent price action in your reasoning. Your inputs are structural: crude oil trend, INR direction, bond yield direction, VIX trend, options structure, and geopolitical scenario probabilities. A falling VIX + stable INR + flat crude = structurally supportive regardless of recent price. Weight macro signals at 70% and the HMM regime label at 30%. CRITICAL: If options structure data is marked unavailable, base your call entirely on macro structural signals and geopolitical scenarios. Do NOT default to NEUTRAL just because options data is missing. Return only valid JSON with fields: call, confidence, rationale.`;

// ── Single window inference ───────────────────────────────────────────────────

async function runWindowInference(
  window: "6h" | "24h" | "72h",
  systemPrompt: string,
  contextSummary: string,
): Promise<EnsembleVote> {
  try {
    const response = await chatComplete({
      model: "gpt-4o",
      temperature: 0.2,
      max_tokens: 300,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: contextSummary },
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

// ── Confidence-weighted vote with geopolitical tiebreak ──────────────────────
// Replaces majorityVote(). In a sideways market the three windows commonly
// disagree, so majority vote over-triggered UNCERTAIN. Confidence-weighted
// scoring lets a strong-conviction window outweigh weak disagreement, and
// only flags UNCERTAIN when at least two HIGH-confidence votes disagree.

const WINDOW_WEIGHTS: Record<EnsembleVote["window"], number> = {
  "6h": 0.35,
  "24h": 0.40,
  "72h": 0.25,
};

function confidenceWeightedVote(
  votes: EnsembleVote[],
  regime: Regime,
  crisisProbability: number,
  geopoliticalSignal?: GeopoliticalSignal,
): EnsembleResult {
  // CRISIS override stays — legitimate.
  if (regime === "CRISIS" && crisisProbability > 0.6) {
    return {
      final: "UNCERTAIN",
      votes,
      unanimous: false,
      uncertaintyFlag: true,
      score: 0,
      reason: "crisis_regime",
    };
  }

  let weightedScore = 0;
  let totalWeight = 0;
  for (const vote of votes) {
    const dirScore = vote.call === "BULLISH" ? 1 : vote.call === "BEARISH" ? -1 : 0;
    const weight = WINDOW_WEIGHTS[vote.window] * vote.confidence;
    weightedScore += dirScore * weight;
    totalWeight += weight;
  }
  let normalizedScore = totalWeight > 0 ? weightedScore / totalWeight : 0;

  // Geopolitical channel as a tiebreaker bias (not a dominator).
  if (
    geopoliticalSignal &&
    geopoliticalSignal.dominantChannel === "fii_risk_off" &&
    geopoliticalSignal.decayedWeight > 0.3
  ) {
    normalizedScore += geopoliticalSignal.sentiment === "bearish" ? -0.15 : 0.15;
  }

  const unanimous = new Set(votes.map(v => v.call)).size === 1;

  if (normalizedScore > 0.20) {
    return { final: "BULLISH", votes, unanimous, uncertaintyFlag: false, score: normalizedScore, reason: "weighted_score" };
  }
  if (normalizedScore < -0.20) {
    return { final: "BEARISH", votes, unanimous, uncertaintyFlag: false, score: normalizedScore, reason: "weighted_score" };
  }

  // Only genuinely ambiguous when ≥2 HIGH-confidence votes point in different directions.
  const highConfidenceVotes = votes.filter(v => v.confidence > 0.5);
  const highConfDirections = new Set(highConfidenceVotes.map(v => v.call));
  if (highConfidenceVotes.length >= 2 && highConfDirections.size >= 2) {
    return { final: "UNCERTAIN", votes, unanimous: false, uncertaintyFlag: true, score: normalizedScore, reason: "genuine_ambiguity" };
  }

  // Low confidence across the board — defer to geopolitical signal if it's still live.
  if (geopoliticalSignal && geopoliticalSignal.decayedWeight > 0.2 && geopoliticalSignal.sentiment !== "neutral") {
    const finalCall: MarketCall = geopoliticalSignal.sentiment === "bearish" ? "BEARISH" : "BULLISH";
    return { final: finalCall, votes, unanimous: false, uncertaintyFlag: false, score: normalizedScore, reason: "geo_signal_tiebreak" };
  }

  return { final: "NEUTRAL", votes, unanimous, uncertaintyFlag: false, score: normalizedScore, reason: "neutral_default" };
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
  geopoliticalSignal?: GeopoliticalSignal;
}): Promise<EnsembleResult> {
  logger.info({ assetId: params.assetId, regime: params.regime }, "ensemble: running 3-window inference");

  const crisisProbability = params.regimeProbabilities["CRISIS"] ?? 0;

  const [vote6h, vote24h, vote72h] = await Promise.all([
    runWindowInference("6h",  systemPrompt6h, params.context6h),
    runWindowInference("24h", systemPrompt24h, params.context24h),
    runWindowInference("72h", systemPrompt72h, params.context72h),
  ]);

  const result = confidenceWeightedVote(
    [vote6h, vote24h, vote72h],
    params.regime,
    crisisProbability,
    params.geopoliticalSignal,
  );

  logger.info(
    {
      assetId: params.assetId,
      final: result.final,
      score: result.score.toFixed(3),
      reason: result.reason,
      uncertain: result.uncertaintyFlag,
      votes: result.votes.map((v: EnsembleVote) => `${v.window}:${v.call}@${v.confidence.toFixed(2)}`),
    },
    "ensemble: complete"
  );

  return result;
}

// Agent B: Historian — historical analogue retrieval and base rate extraction
// Input: SituationReport + historical analogues from ChromaDB
// Output: HistorianReport with base rates per outcome type

import { chatComplete } from "@workspace/integrations-openai-ai-server";
import { logger } from "../../lib/logger.js";
import type { SituationReport } from "./agent-analyst.js";
import { queryHistoricalAnalogues, type HistoricalAnalogue } from "./historical-corpus.js";

export interface BaseRate {
  outcome: "escalation" | "negotiated_settlement" | "frozen_conflict" | "collapse" | "status_quo";
  probability: number; // 0-1, from historical analogues
  analogueCount: number;
  mostRelevantAnalogue: string;
}

export interface HistorianReport {
  storyId: string;
  analogues: HistoricalAnalogue[];
  baseRates: BaseRate[];
  historicalPattern: string; // 1-2 sentence pattern description
  keyDifferentiators: string[]; // ways this situation differs from analogues
  noHistoricalAnalogue: boolean; // true if similarity < threshold across all results
  analogueConfidence: number; // 0-1, avg similarity score of top analogues
}

const HISTORIAN_SYSTEM_PROMPT = `You are a historical analyst specializing in international crises and conflict patterns. You analyze historical precedents to extract base rates and patterns relevant to current situations. Return only valid JSON conforming to the HistorianReport schema.

HistorianReport schema:
{
  "storyId": string,
  "baseRates": [{
    "outcome": "escalation" | "negotiated_settlement" | "frozen_conflict" | "collapse" | "status_quo",
    "probability": number,
    "analogueCount": number,
    "mostRelevantAnalogue": string
  }],
  "historicalPattern": string,
  "keyDifferentiators": string[],
  "noHistoricalAnalogue": boolean,
  "analogueConfidence": number
}

Base rates must sum to 1.0. If analogues are weak (low similarity), set noHistoricalAnalogue=true and base rates should reflect maximum uncertainty (roughly equal probabilities). Focus on structural similarities, not surface-level label matching.`;

export async function runHistorianAgent(
  storyId: string,
  situationReport: SituationReport,
  feedbackLessons?: string
): Promise<HistorianReport> {
  logger.info({ storyId }, "historian agent: querying historical analogues");

  // Build situation text for vector search
  const situationText = [
    `Power configuration: ${situationReport.powerConfiguration}`,
    `Primary actors: ${situationReport.primaryActors.map(a => a.actorLabel).join(", ")}`,
    `Tension indicators: ${situationReport.tensionIndicators.map(t => `${t.type} (${t.intensity})`).join(", ")}`,
    `Key uncertainties: ${situationReport.keyUncertainties.join("; ")}`,
    `Indian market exposure: ${situationReport.indianMarketExposure.severity} via ${situationReport.indianMarketExposure.channels.join(", ")}`,
  ].join("\n");

  const analogues = await queryHistoricalAnalogues(situationText, 8);
  const noHistoricalAnalogue = analogues.length === 0 || analogues[0].similarityScore < 0.55;
  const analogueConfidence = analogues.length > 0
    ? analogues.slice(0, 5).reduce((sum, a) => sum + a.similarityScore, 0) / Math.min(5, analogues.length)
    : 0;

  logger.info({ storyId, analogueCount: analogues.length, noHistoricalAnalogue }, "historian agent: analogues retrieved");

  const analogueSummaries = analogues.slice(0, 6).map((a, i) =>
    `[${i + 1}] Source: ${a.source.toUpperCase()} | ID: ${a.id} | Similarity: ${a.similarityScore.toFixed(3)}\n${a.document}\nMetadata: ${JSON.stringify(a.metadata)}`
  ).join("\n\n");

  const feedbackSection = feedbackLessons
    ? `\n\nPAST CALIBRATION FAILURES (from previous prediction cycles on this story — adjust base rates accordingly):\n${feedbackLessons}`
    : "";

  const userContent = noHistoricalAnalogue
    ? `No strong historical analogues found (best similarity: ${analogues[0]?.similarityScore?.toFixed(3) ?? "none"}). Generate base rates reflecting maximum uncertainty.\n\nSituation:\n${situationText}${feedbackSection}`
    : `Historical analogues found:\n\n${analogueSummaries}\n\nCurrent situation:\n${situationText}${feedbackSection}\n\nExtract base rates from these analogues.`;

  const response = await chatComplete({
    model: "gpt-4o",
    temperature: 0.1,
    max_tokens: 1500,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: HISTORIAN_SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? "{}";

  try {
    const report = JSON.parse(raw) as Omit<HistorianReport, "analogues" | "noHistoricalAnalogue" | "analogueConfidence">;
    const finalReport: HistorianReport = {
      ...report,
      storyId,
      analogues,
      noHistoricalAnalogue,
      analogueConfidence,
    };
    logger.info({ storyId, baseRateCount: finalReport.baseRates.length }, "historian agent: complete");
    return finalReport;
  } catch {
    logger.error({ storyId, raw }, "historian agent: JSON parse failed");
    throw new Error(`Historian agent returned invalid JSON for story ${storyId}`);
  }
}

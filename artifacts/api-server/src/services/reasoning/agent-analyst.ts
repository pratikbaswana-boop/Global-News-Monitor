// Agent A: Analyst — structural situation assessment
// Input: story subgraph JSON (actors, events, contradictions, edges)
// Output: SituationReport JSON

import { openai } from "@workspace/integrations-openai-ai-server";
import { logger } from "../../lib/logger.js";

export interface ActorPosition {
  actorId: string;
  actorLabel: string;
  statedGoal: string;
  perceivedGoal: string;
  recentActions: string[];
  leverage: string[];
  constraints: string[];
}

export interface TensionIndicator {
  type: "military_posturing" | "economic_coercion" | "diplomatic_breakdown" | "proxy_activation" | "information_warfare" | "financial_contagion";
  intensity: "low" | "medium" | "high" | "critical";
  evidence: string[];
}

export interface ContradictionResolution {
  eventIdA: string;
  eventIdB: string;
  resolution: "one_actor_bluffing" | "misattribution" | "negotiated_simultaneously" | "different_factions" | "unresolvable";
  reasoning: string;
}

export interface SituationReport {
  storyId: string;
  powerConfiguration: "unipolar_dominant" | "bipolar_contested" | "multipolar_fragmented" | "proxy_war" | "economic_coercion_only";
  primaryActors: ActorPosition[];
  tensionIndicators: TensionIndicator[];
  contradictionResolutions: ContradictionResolution[];
  keyUncertainties: string[];
  indianMarketExposure: {
    channels: string[];
    severity: "none" | "indirect" | "moderate" | "direct";
    reasoning: string;
  };
  assessmentConfidence: number; // 0-1
}

const ANALYST_SYSTEM_PROMPT = `You are a geopolitical analyst. You assess structural changes in international situations. You do not summarize news. You assess power configurations. Return only valid JSON conforming to the SituationReport schema.

SituationReport schema:
{
  "storyId": string,
  "powerConfiguration": "unipolar_dominant" | "bipolar_contested" | "multipolar_fragmented" | "proxy_war" | "economic_coercion_only",
  "primaryActors": [{
    "actorId": string,
    "actorLabel": string,
    "statedGoal": string,
    "perceivedGoal": string,
    "recentActions": string[],
    "leverage": string[],
    "constraints": string[]
  }],
  "tensionIndicators": [{
    "type": "military_posturing" | "economic_coercion" | "diplomatic_breakdown" | "proxy_activation" | "information_warfare" | "financial_contagion",
    "intensity": "low" | "medium" | "high" | "critical",
    "evidence": string[]
  }],
  "contradictionResolutions": [{
    "eventIdA": string,
    "eventIdB": string,
    "resolution": "one_actor_bluffing" | "misattribution" | "negotiated_simultaneously" | "different_factions" | "unresolvable",
    "reasoning": string
  }],
  "keyUncertainties": string[],
  "indianMarketExposure": {
    "channels": string[],
    "severity": "none" | "indirect" | "moderate" | "direct",
    "reasoning": string
  },
  "assessmentConfidence": number
}

Focus on structural factors, not event recitation. Assess what actors want vs. what they say. Identify leverage asymmetries. For Indian market exposure, consider: crude oil import dependency, USD/INR sensitivity, FII risk appetite, trade route disruption, sanctions spillover.`;

export async function runAnalystAgent(
  storyId: string,
  subgraphJson: string
): Promise<SituationReport> {
  logger.info({ storyId }, "analyst agent: starting situation assessment");

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.2,
    max_tokens: 2000,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: ANALYST_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Assess this geopolitical situation:\n\n${subgraphJson}`,
      },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? "{}";

  try {
    const report = JSON.parse(raw) as SituationReport;
    report.storyId = storyId;
    logger.info({ storyId, confidence: report.assessmentConfidence }, "analyst agent: complete");
    return report;
  } catch {
    logger.error({ storyId, raw }, "analyst agent: JSON parse failed");
    throw new Error(`Analyst agent returned invalid JSON for story ${storyId}`);
  }
}

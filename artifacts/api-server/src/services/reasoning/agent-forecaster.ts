// Agent C: Forecaster — probabilistic scenario tree generation
// Input: SituationReport + HistorianReport
// Output: 3 scenarios with probabilities, timeframes, falsification conditions

import { openai } from "@workspace/integrations-openai-ai-server";
import { logger } from "../../lib/logger.js";
import type { SituationReport } from "./agent-analyst.js";
import type { HistorianReport } from "./agent-historian.js";

export interface Scenario {
  label: string; // ≤ 8 words
  probability: number; // 0-1
  timeframeDays: number; // expected resolution window
  keyIndicators: string[]; // observable signals that confirm this scenario
  falsificationConditions: string[]; // observable signals that rule it out
  transmissionChannelIds: string[]; // which Indian market channels activate
  historicalBaseRate: number; // from historian, 0-1
  narrative: string; // 3-4 sentence description
}

export interface ForecasterTree {
  storyId: string;
  scenarios: [Scenario, Scenario, Scenario]; // always exactly 3
  dominantScenario: 0 | 1 | 2; // index of highest probability scenario
  modelConfidence: number; // 0-1, self-assessed
  noHistoricalAnalogue: boolean; // propagated from historian
  dominantChannel: string; // primary Indian market transmission channel
  resolveAfterDays: number; // when to check for resolution
}

const FORECASTER_SYSTEM_PROMPT = `You are a probabilistic forecaster specializing in geopolitical risk. You generate exactly 3 scenarios covering the full probability space. Probabilities must sum to 1.0. Return only valid JSON conforming to the ForecasterTree schema.

ForecasterTree schema:
{
  "storyId": string,
  "scenarios": [
    {
      "label": string (max 8 words),
      "probability": number,
      "timeframeDays": number,
      "keyIndicators": string[],
      "falsificationConditions": string[],
      "transmissionChannelIds": string[],
      "historicalBaseRate": number,
      "narrative": string
    },
    ... (exactly 3 scenarios)
  ],
  "dominantScenario": 0 | 1 | 2,
  "modelConfidence": number,
  "noHistoricalAnalogue": boolean,
  "dominantChannel": string,
  "resolveAfterDays": number
}

Available transmission channels: crude_oil_spike, crude_oil_drop, usd_inr_depreciation, fii_risk_off, china_trade_escalation, middle_east_conflict, russia_sanctions_tighten, fed_hawkish_signal, global_risk_off, rbi_surprise_action

Rules:
- 3 scenarios exactly: typically base/optimistic/pessimistic or status_quo/escalation/de-escalation
- Probabilities must sum to exactly 1.0
- timeframeDays: minimum 7, maximum 365
- falsificationConditions must be concrete and observable within the timeframe
- If noHistoricalAnalogue=true, widen probability intervals (reduce highest probability)
- resolveAfterDays: when we should check if any falsification condition was met`;

export async function runForecasterAgent(
  storyId: string,
  situationReport: SituationReport,
  historianReport: HistorianReport
): Promise<ForecasterTree> {
  logger.info({ storyId }, "forecaster agent: generating scenario tree");

  const baseRateText = historianReport.baseRates
    .map(r => `${r.outcome}: ${(r.probability * 100).toFixed(0)}% (n=${r.analogueCount} analogues)`)
    .join(", ");

  const userContent = `Generate a probabilistic scenario tree for this geopolitical situation.

SITUATION ASSESSMENT:
Power configuration: ${situationReport.powerConfiguration}
Primary actors: ${situationReport.primaryActors.map(a => `${a.actorLabel} (goal: ${a.perceivedGoal})`).join("; ")}
Tension indicators: ${situationReport.tensionIndicators.map(t => `${t.type}/${t.intensity}`).join(", ")}
Key uncertainties: ${situationReport.keyUncertainties.join("; ")}
Indian market exposure: ${situationReport.indianMarketExposure.severity} via ${situationReport.indianMarketExposure.channels.join(", ")}
Assessment confidence: ${situationReport.assessmentConfidence}

HISTORICAL BASE RATES:
Pattern: ${historianReport.historicalPattern}
Base rates: ${baseRateText}
No historical analogue: ${historianReport.noHistoricalAnalogue}
Key differentiators from analogues: ${historianReport.keyDifferentiators.join("; ")}
Analogue confidence: ${historianReport.analogueConfidence.toFixed(2)}

Generate exactly 3 scenarios. Anchor probabilities to historical base rates but adjust for current structural differences.`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.3,
    max_tokens: 2500,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: FORECASTER_SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? "{}";

  try {
    const tree = JSON.parse(raw) as ForecasterTree;
    tree.storyId = storyId;
    tree.noHistoricalAnalogue = historianReport.noHistoricalAnalogue;

    // Normalise probabilities to ensure they sum to 1.0
    const total = tree.scenarios.reduce((sum, s) => sum + s.probability, 0);
    if (Math.abs(total - 1.0) > 0.01) {
      tree.scenarios.forEach(s => { s.probability = s.probability / total; });
    }

    logger.info({
      storyId,
      scenarios: tree.scenarios.map(s => ({ label: s.label, p: s.probability.toFixed(2) })),
      dominantChannel: tree.dominantChannel,
    }, "forecaster agent: complete");

    return tree;
  } catch {
    logger.error({ storyId, raw }, "forecaster agent: JSON parse failed");
    throw new Error(`Forecaster agent returned invalid JSON for story ${storyId}`);
  }
}

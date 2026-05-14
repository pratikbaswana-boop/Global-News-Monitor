// Agent D: Devil's Advocate — critiques forecaster assumptions
// Input: ForecasterTree only (isolated from analyst/historian to avoid anchoring)
// Output: DevilCritique with revised probability intervals

import { chatComplete } from "@workspace/integrations-openai-ai-server";
import { logger } from "../../lib/logger.js";
import type { ForecasterTree, Scenario } from "./agent-forecaster.js";

export interface ScenarioRevision {
  scenarioIndex: 0 | 1 | 2;
  originalProbability: number;
  revisedProbabilityMin: number;
  revisedProbabilityMax: number;
  reasoning: string;
}

export interface DevilCritique {
  storyId: string;
  weakestAssumption: string; // the single most fragile assumption in the forecaster tree
  ignoredSignals: string[]; // signals the forecaster likely underweighted
  minorityScenario: string; // a 4th scenario the forecaster missed entirely
  minorityScenarioProbability: number; // probability mass stolen from existing scenarios
  revisions: ScenarioRevision[]; // revised intervals for each scenario
  devilConfidence: number; // 0-1, how confident the Devil is in its critique
  finalScenarios: Scenario[]; // the 3 original scenarios with devil-adjusted probabilities
}

const DEVIL_SYSTEM_PROMPT = `You are a Devil's Advocate analyst. You receive a probabilistic forecast and systematically identify its weakest points. You do not see the underlying intelligence — only the forecast. Your job is to stress-test it. Return only valid JSON conforming to the DevilCritique schema.

DevilCritique schema:
{
  "storyId": string,
  "weakestAssumption": string,
  "ignoredSignals": string[],
  "minorityScenario": string,
  "minorityScenarioProbability": number,
  "revisions": [
    {
      "scenarioIndex": 0 | 1 | 2,
      "originalProbability": number,
      "revisedProbabilityMin": number,
      "revisedProbabilityMax": number,
      "reasoning": string
    }
  ],
  "devilConfidence": number,
  "finalScenarios": [...same structure as input scenarios with adjusted probabilities...]
}

Rules:
- weakestAssumption: one concrete, falsifiable claim the forecaster implicitly relied on
- ignoredSignals: 2-4 specific observable signals that would shift probabilities if true
- minorityScenario: must be distinct from all 3 forecasted scenarios
- minorityScenarioProbability: probability mass (0.05–0.25) to steal proportionally from existing scenarios
- revisions: all 3 scenarios must be revised — even small adjustments signal scrutiny
- finalScenarios: apply the midpoint of each revised interval; probabilities must still sum to 1.0
- devilConfidence: 0.5 = major critique, 0.9 = minor refinements only`;

export async function runDevilAgent(
  storyId: string,
  forecasterTree: ForecasterTree
): Promise<DevilCritique> {
  logger.info({ storyId }, "devil's advocate agent: critiquing forecast");

  const scenarioText = forecasterTree.scenarios.map((s, i) =>
    `Scenario ${i} (${(s.probability * 100).toFixed(0)}%): "${s.label}"
  Timeframe: ${s.timeframeDays} days
  Key indicators: ${s.keyIndicators.join("; ")}
  Falsification: ${s.falsificationConditions.join("; ")}
  Transmission channels: ${s.transmissionChannelIds.join(", ")}
  Historical base rate: ${(s.historicalBaseRate * 100).toFixed(0)}%`
  ).join("\n\n");

  const userContent = `Critique this probabilistic forecast:

Dominant scenario: ${forecasterTree.dominantScenario} (${(forecasterTree.scenarios[forecasterTree.dominantScenario].probability * 100).toFixed(0)}%)
Model confidence: ${forecasterTree.modelConfidence}
No historical analogue: ${forecasterTree.noHistoricalAnalogue}
Dominant Indian market channel: ${forecasterTree.dominantChannel}

SCENARIOS:
${scenarioText}

Identify the weakest assumption, ignored signals, a missing minority scenario, and revise the probability intervals.`;

  const response = await chatComplete({
    model: "gpt-4o",
    temperature: 0.9,
    max_tokens: 2000,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: DEVIL_SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? "{}";

  try {
    const critique = JSON.parse(raw) as DevilCritique;
    critique.storyId = storyId;

    // Ensure finalScenarios probabilities sum to 1.0
    if (critique.finalScenarios?.length === 3) {
      const total = critique.finalScenarios.reduce((sum, s) => sum + s.probability, 0);
      if (Math.abs(total - 1.0) > 0.01) {
        critique.finalScenarios.forEach(s => { s.probability = s.probability / total; });
      }
    } else {
      // Fall back to original scenarios if devil didn't return them properly
      critique.finalScenarios = forecasterTree.scenarios.map((s, i) => {
        const revision = critique.revisions?.find(r => r.scenarioIndex === i);
        if (revision) {
          return { ...s, probability: (revision.revisedProbabilityMin + revision.revisedProbabilityMax) / 2 };
        }
        return s;
      });
      const total = critique.finalScenarios.reduce((sum, s) => sum + s.probability, 0);
      critique.finalScenarios.forEach(s => { s.probability = s.probability / total; });
    }

    logger.info({
      storyId,
      weakestAssumption: critique.weakestAssumption?.slice(0, 60),
      minorityScenario: critique.minorityScenario?.slice(0, 60),
    }, "devil's advocate agent: complete");

    return critique;
  } catch {
    logger.error({ storyId, raw }, "devil's advocate agent: JSON parse failed");
    throw new Error(`Devil's advocate agent returned invalid JSON for story ${storyId}`);
  }
}

// Agent C: Forecaster — probabilistic scenario tree generation
// Input: SituationReport + HistorianReport
// Output: 3 scenarios with probabilities, timeframes, falsification conditions

import { chatComplete } from "@workspace/integrations-openai-ai-server";
import { logger } from "../../lib/logger.js";
import type { SituationReport } from "./agent-analyst.js";
import type { HistorianReport } from "./agent-historian.js";

// ── Priced-In Detector (Change 7a) ────────────────────────────────────────────

interface PricedInResult {
  alreadyTransmitted: boolean;
  transmissionDate: string | null;
  marketMoveOnTriggerDay: number;
  decayFactor: number;
}

function daysBetween(a: string, b: string): number {
  const da = new Date(a);
  const db = new Date(b);
  return Math.floor(Math.abs(db.getTime() - da.getTime()) / (1000 * 60 * 60 * 24));
}

async function fetchNiftyClose(triggerDate: string): Promise<{ close: number; returnPct: number }> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=1d&range=5d`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return { close: 0, returnPct: 0 };
    const json = await res.json() as {
      chart?: {
        result?: Array<{
          timestamp?: number[];
          indicators?: { quote?: Array<{ close?: (number | null)[] }> };
        }>;
      };
    };
    const result = json.chart?.result?.[0];
    if (!result) return { close: 0, returnPct: 0 };
    const timestamps = result.timestamp ?? [];
    const closes = result.indicators?.quote?.[0]?.close ?? [];
    for (let i = 0; i < timestamps.length; i++) {
      const dateStr = new Date(timestamps[i]! * 1000).toISOString().slice(0, 10);
      if (dateStr === triggerDate.slice(0, 10)) {
        const c = closes[i];
        const prev = i > 0 ? closes[i - 1] : null;
        if (c != null) {
          return {
            close: c,
            returnPct: prev != null && prev > 0 ? ((c - prev) / prev) * 100 : 0,
          };
        }
      }
    }
    return { close: 0, returnPct: 0 };
  } catch {
    return { close: 0, returnPct: 0 };
  }
}

async function checkIfPricedIn(storyId: string, storyTriggerDate: string): Promise<PricedInResult> {
  const niftyOnTriggerDay = await fetchNiftyClose(storyTriggerDate);
  const marketMovePct = niftyOnTriggerDay.returnPct;
  const alreadyTransmitted = Math.abs(marketMovePct) > 0.5;
  const daysSince = daysBetween(storyTriggerDate, new Date().toISOString());

  const decayFactor = alreadyTransmitted
    ? Math.max(0.1, 1.0 - (daysSince * 0.3))
    : 1.0;

  return {
    alreadyTransmitted,
    transmissionDate: alreadyTransmitted ? storyTriggerDate : null,
    marketMoveOnTriggerDay: marketMovePct,
    decayFactor,
  };
}

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
      "label": string (max 12 words) — MUST be an explicit prediction statement, not a topic. Examples: "Iran likely to breach 60% enrichment within 30 days" NOT "Iran Nuclear Program"; "US-China tariffs to expand to semiconductor sector by Q3" NOT "Trade War". The label must clearly state WHO will do WHAT and WHEN.
      "probability": number,
      "timeframeDays": number,
      "keyIndicators": string[],
      "falsificationConditions": string[],
      "transmissionChannelIds": string[],
      "historicalBaseRate": number,
      "narrative": string (200-400 words) — a detailed, story-specific reasoning that explains: (1) the specific current events and evidence driving this scenario, (2) the causal chain from those events to the predicted outcome, (3) why this scenario is more/less likely than the alternatives given the power configuration and actor goals, (4) what key indicators would confirm this scenario is unfolding. Use concrete details from the situation report. Do NOT write generic geopolitical platitudes.
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
- label MUST be an explicit prediction: state the actor, action, and timeframe clearly
- narrative MUST be detailed and story-specific: cite specific actors, tension indicators, and evidence from the situation. Explain the causal chain. Minimum 200 words.
- Probabilities must sum to exactly 1.0
- timeframeDays: minimum 7, maximum 365
- falsificationConditions must be concrete and observable within the timeframe
- If noHistoricalAnalogue=true, widen probability intervals (reduce highest probability)
- resolveAfterDays: when we should check if any falsification condition was met
- dominantChannel MUST be the single most relevant transmission channel for this specific story (e.g. middle_east_conflict for Israel-Gaza, crude_oil_spike for Iran-oil, china_trade_escalation for US-China trade). Do NOT default to fii_risk_off or global_risk_off unless the story is genuinely about broad market sentiment.

PRICED-IN RULE (mandatory):
You will be given a field called pricedInContext. If alreadyTransmitted is true, it means the market already reacted to this story with a move of {marketMoveOnTriggerDay}% on {transmissionDate}. In this case:
1. Do not forecast continued directional impact in the same direction as the initial move.
2. Reduce the probability of your dominant bearish or bullish scenario by the decayFactor ({decayFactor}).
3. Increase the probability of your "status_quo" or "consolidation" scenario accordingly.
4. In the narrative field for the dominant scenario, explicitly write: "Note: market already absorbed {marketMoveOnTriggerDay}% move on {transmissionDate}. Residual impact estimated at {decayFactor * 100}% of original."
If alreadyTransmitted is false, proceed normally.`;

export async function runForecasterAgent(
  storyId: string,
  situationReport: SituationReport,
  historianReport: HistorianReport,
  calibrationWarning?: string
): Promise<ForecasterTree> {
  logger.info({ storyId }, "forecaster agent: generating scenario tree");

  const baseRateText = historianReport.baseRates
    .map(r => `${r.outcome}: ${(r.probability * 100).toFixed(0)}% (n=${r.analogueCount} analogues)`)
    .join(", ");

  const calibrationSection = calibrationWarning ? `\n${calibrationWarning}\n` : "";

  // Compute priced-in context before calling GPT-4o
  const storyTriggerDate = new Date().toISOString();
  const pricedIn = await checkIfPricedIn(storyId, storyTriggerDate);

  const userContent = `Generate a probabilistic scenario tree for this geopolitical situation.${calibrationSection}

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

pricedInContext: ${JSON.stringify(pricedIn)}

Generate exactly 3 scenarios. Anchor probabilities to historical base rates but adjust for current structural differences.`;

  const response = await chatComplete({
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

// Agent D: Devil's Advocate — critiques forecaster assumptions
// Input: ForecasterTree only (isolated from analyst/historian to avoid anchoring)
// Output: DevilCritique with revised probability intervals

import { chatComplete } from "@workspace/integrations-openai-ai-server";
import { logger } from "../../lib/logger.js";
import { runCypher } from "../graph/neo4j-client.js";
import type { ForecasterTree, Scenario } from "./agent-forecaster.js";

// ── Channel → market instrument mapping (Change 7b full) ─────────────────────

interface ChannelInstrument {
  ticker: string;          // Yahoo Finance symbol
  expectedDirection: "up" | "down"; // what the channel implies for this instrument
}

const CHANNEL_TO_INSTRUMENT: Record<string, ChannelInstrument> = {
  crude_oil_spike:        { ticker: "CL=F",   expectedDirection: "up" },
  crude_oil_drop:         { ticker: "CL=F",   expectedDirection: "down" },
  usd_inr_depreciation:   { ticker: "INR=X",  expectedDirection: "up" },
  fii_risk_off:           { ticker: "^NSEI",  expectedDirection: "down" },
  china_trade_escalation: { ticker: "^NSEI",  expectedDirection: "down" },
  middle_east_conflict:   { ticker: "CL=F",   expectedDirection: "up" },
  russia_sanctions_tighten: { ticker: "CL=F", expectedDirection: "up" },
  fed_hawkish_signal:     { ticker: "^NSEI",  expectedDirection: "down" },
  global_risk_off:        { ticker: "^NSEI",  expectedDirection: "down" },
  rbi_surprise_action:    { ticker: "^NSEI",  expectedDirection: "down" },
};

/**
 * Fetch the daily return for a channel's target instrument on the story trigger date.
 * Returns null if data is unavailable.  A move >0.5 % in the expected direction
 * is treated as "channel transmitted to market".
 */
async function fetchMarketMoveForChannel(
  channelId: string,
  triggerDate: string
): Promise<{ movePct: number | null; priceMovedOnChannel: boolean }> {
  const mapping = CHANNEL_TO_INSTRUMENT[channelId];
  if (!mapping) return { movePct: null, priceMovedOnChannel: false };

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(mapping.ticker)}?interval=1d&range=5d`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { movePct: null, priceMovedOnChannel: false };

    const json = await res.json() as {
      chart?: {
        result?: Array<{
          timestamp?: number[];
          indicators?: { quote?: Array<{ close?: (number | null)[] }> };
        }>;
      };
    };
    const result = json.chart?.result?.[0];
    if (!result) return { movePct: null, priceMovedOnChannel: false };

    const timestamps = result.timestamp ?? [];
    const closes = result.indicators?.quote?.[0]?.close ?? [];
    for (let i = 0; i < timestamps.length; i++) {
      const dateStr = new Date(timestamps[i]! * 1000).toISOString().slice(0, 10);
      if (dateStr === triggerDate.slice(0, 10)) {
        const c = closes[i];
        const prev = i > 0 ? closes[i - 1] : null;
        if (c == null || prev == null || prev === 0) continue;
        const movePct = ((c - prev) / prev) * 100;
        const priceMovedOnChannel = mapping.expectedDirection === "up"
          ? movePct > 0.5
          : movePct < -0.5;
        return { movePct, priceMovedOnChannel };
      }
    }
    return { movePct: null, priceMovedOnChannel: false };
  } catch {
    return { movePct: null, priceMovedOnChannel: false };
  }
}

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
- devilConfidence: 0.5 = major critique, 0.9 = minor refinements only

CHANNEL VALIDATION RULE (mandatory):
You will receive TWO validation blocks:

1. channelValidation — active channels from Neo4j with decayed weights. If a channel has decayedWeight < 0.3 and was triggered >3 days ago, it MUST be removed from transmissionChannelIds. If the forecaster used a channel not listed here, flag it as "channel hallucination" in weakestAssumption.

2. channelPriceMoves — for every transmission channel the Forecaster cites, we check whether its target market instrument actually moved >0.5% in the expected direction on the story trigger date. Fields: channelId, instrument, expectedDirection, movePct, priceMovedOnChannel (boolean). If priceMovedOnChannel is FALSE, the channel was fresh but the market did NOT react — this is a critical weakness. Flag it explicitly: "Channel {channelId} cited but {instrument} moved only {movePct}% (expected {expectedDirection}) — transmission to market failed."

This catches cases like the H-1B/TCS scenario where the channel was active but the target stock never moved.`;

export async function runDevilAgent(
  storyId: string,
  forecasterTree: ForecasterTree,
  storyTriggerDate?: string
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

  // Build channel validation context (Change 7b)
  let channelValidation = "Active channels from Neo4j:\n";
  try {
    const channelResult = await runCypher(
      `MATCH (s:Story)-[r:TRANSMITS_TO]->(c:Channel)
       WHERE s.status = 'active'
       RETURN c.id AS channelId, c.label AS label,
         c.weight AS weight, coalesce(r.triggerDate, datetime().epochMillis) AS triggerDate`,
      {}
    );
    const today = new Date();
    for (const r of channelResult.records) {
      const chId = r.get("channelId") as string;
      const label = r.get("label") as string;
      const rawWeight = Number(r.get("weight") ?? 0);
      const triggerDate = typeof r.get("triggerDate") === "string"
        ? r.get("triggerDate")
        : new Date().toISOString();
      const daysSince = Math.floor(
        (today.getTime() - new Date(triggerDate).getTime()) / (1000 * 60 * 60 * 24)
      );
      const decayFactor = Math.pow(0.5, Math.max(0, daysSince - 1));
      const decayedWeight = rawWeight * decayFactor;
      channelValidation += `- ${chId} (${label}): decayedWeight=${decayedWeight.toFixed(3)}, daysSinceTrigger=${daysSince}\n`;
    }
  } catch {
    channelValidation += "(channel lookup failed)\n";
  }

  // Build channel price-move validation for every channel cited by the Forecaster
  const uniqueChannels = [...new Set(forecasterTree.scenarios.flatMap(s => s.transmissionChannelIds))];
  const channelPriceMoves: string[] = [];
  // Use the caller-supplied trigger date (earliest event from subgraph) so the
  // Yahoo Finance lookup checks the right trading day rather than always today.
  const effectiveTriggerDate = storyTriggerDate ?? new Date().toISOString();
  for (const chId of uniqueChannels) {
    const { movePct, priceMovedOnChannel } = await fetchMarketMoveForChannel(chId, effectiveTriggerDate);
    const mapping = CHANNEL_TO_INSTRUMENT[chId];
    if (mapping) {
      channelPriceMoves.push(
        `- ${chId} (instrument: ${mapping.ticker}, expected: ${mapping.expectedDirection}): move=${movePct !== null ? movePct.toFixed(2) : "N/A"}%, priceMovedOnChannel=${priceMovedOnChannel}`
      );
    } else {
      channelPriceMoves.push(`- ${chId}: no instrument mapping`);
    }
  }

  const userContent = `Critique this probabilistic forecast:

Dominant scenario: ${forecasterTree.dominantScenario} (${(forecasterTree.scenarios[forecasterTree.dominantScenario].probability * 100).toFixed(0)}%)
Model confidence: ${forecasterTree.modelConfidence}
No historical analogue: ${forecasterTree.noHistoricalAnalogue}
Dominant Indian market channel: ${forecasterTree.dominantChannel}

SCENARIOS:
${scenarioText}

CHANNEL VALIDATION (Neo4j active channels with decay):
${channelValidation}

CHANNEL PRICE MOVES (did the market react on trigger date?):
${channelPriceMoves.join("\n") || "- no channels mapped to instruments"}

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

// Post-mortem forensics agent — runs after a prediction_v2 is resolved.
// Determines: was Devil's Advocate right? Which channel was missed? Lessons for future runs.

import { openai } from "@workspace/integrations-openai-ai-server";
import { logger } from "../../lib/logger.js";
import type { Scenario } from "../reasoning/agent-forecaster.js";
import type { DevilCritique } from "../reasoning/agent-devil.js";

export interface ForensicsReport {
  devilWasRight: boolean;
  devilVindicationReason: string; // empty string if devil was wrong
  missedChannel: string | null;   // which Indian market channel was overlooked
  dominantChannel: string | null; // channel that actually drove the outcome
  lessonsLearned: string;         // 3-5 bullet points for future runs
}

const FORENSICS_SYSTEM = `You are a post-mortem analyst for a geopolitical prediction system. You receive:
1. The 3 probabilistic scenarios that were forecast
2. The Devil's Advocate critique (weakest assumption, ignored signals, minority scenario)
3. The actual outcome description

Your job: determine what went right or wrong and extract lessons. Return only valid JSON.

Schema:
{
  "devilWasRight": boolean,
  "devilVindicationReason": string (empty if devil was wrong),
  "missedChannel": string | null (one of: crude_oil_spike, crude_oil_drop, usd_inr_depreciation, fii_risk_off, china_trade_escalation, middle_east_conflict, russia_sanctions_tighten, fed_hawkish_signal, global_risk_off, rbi_surprise_action, or null if no channel missed),
  "dominantChannel": string | null (same list),
  "lessonsLearned": string (3-5 bullet points, each starting with "• ")
}

Rules:
- devilWasRight: true if the devil's weakestAssumption proved incorrect OR the minorityScenario actually materialized
- missedChannel: which Indian market transmission channel the forecast underweighted
- lessonsLearned: concrete and falsifiable — not platitudes`;

export async function runForensicsAgent(
  storyId: string,
  scenarios: Scenario[],
  devilCritique: DevilCritique,
  materialisedScenarioIndex: number | null,
  outcomeDescription: string
): Promise<ForensicsReport> {
  logger.info({ storyId, materialisedScenarioIndex }, "forensics: running post-mortem");

  const scenarioText = scenarios.map((s, i) =>
    `[${i}] "${s.label}" — ${(s.probability * 100).toFixed(0)}%: ${s.narrative ?? ""}`
  ).join("\n");

  const outcome = materialisedScenarioIndex !== null
    ? `Materialised scenario: [${materialisedScenarioIndex}] "${scenarios[materialisedScenarioIndex]?.label ?? "unknown"}"\n${outcomeDescription}`
    : `No clear materialisation detected. Description: ${outcomeDescription}`;

  const userContent = `Post-mortem for story: ${storyId}

FORECAST SCENARIOS:
${scenarioText}

DEVIL'S CRITIQUE:
Weakest assumption: ${devilCritique.weakestAssumption}
Ignored signals: ${devilCritique.ignoredSignals.join("; ")}
Minority scenario proposed: "${devilCritique.minorityScenario}" (${(devilCritique.minorityScenarioProbability * 100).toFixed(0)}% probability)
Devil confidence: ${devilCritique.devilConfidence}

ACTUAL OUTCOME:
${outcome}`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.2,
      max_tokens: 800,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: FORENSICS_SYSTEM },
        { role: "user", content: userContent },
      ],
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const report = JSON.parse(raw) as ForensicsReport;
    logger.info({ storyId, devilWasRight: report.devilWasRight, missedChannel: report.missedChannel }, "forensics: complete");
    return report;

  } catch (err) {
    logger.error({ storyId, err }, "forensics: GPT-4o failed");
    return {
      devilWasRight: false,
      devilVindicationReason: "",
      missedChannel: null,
      dominantChannel: null,
      lessonsLearned: "• Forensics agent failed — no lessons extracted this cycle.",
    };
  }
}

// Fetch aggregated lessons from past prediction_v2 forensics for a given story.
// Used by the reasoning pipeline to inject calibration feedback before forecasting.
export async function getFeedbackLessons(storyId: string): Promise<string | null> {
  try {
    const { db, predictionV2Table } = await import("@workspace/db");
    const { eq, isNotNull, desc } = await import("drizzle-orm");
    void isNotNull; // imported for future use

    const rows = await db
      .select({ lessonsLearned: predictionV2Table.lessonsLearned, devilWasRight: predictionV2Table.devilWasRight })
      .from(predictionV2Table)
      .where(eq(predictionV2Table.storyId, storyId))
      .orderBy(desc(predictionV2Table.resolvedAt))
      .limit(5);

    const lessons = rows
      .filter(r => r.lessonsLearned)
      .map(r => r.lessonsLearned!)
      .join("\n");

    return lessons.length > 0 ? lessons : null;
  } catch {
    return null;
  }
}

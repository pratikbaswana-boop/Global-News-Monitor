// Automated resolution watcher for prediction_v2.
//
// Every 6h it checks for expired pending predictions (resolveAfter < now).
// For each one it:
//   1. Fetches recent events from Neo4j for the story
//   2. Asks GPT-4o which scenario (if any) materialised
//   3. Computes Brier score
//   4. Runs forensics post-mortem
//   5. Writes all results back to prediction_v2

import { openai } from "@workspace/integrations-openai-ai-server";
import { db, predictionV2Table } from "@workspace/db";
import { eq, lt, and, isNull } from "drizzle-orm";
import { logger } from "../../lib/logger.js";
import { runCypher, isGraphAvailable } from "../graph/neo4j-client.js";
import { computeBrierScore } from "./brier-score.js";
import { runForensicsAgent } from "./forensics.js";
import type { Scenario } from "../reasoning/agent-forecaster.js";
import type { DevilCritique } from "../reasoning/agent-devil.js";

// ── Outcome determination ─────────────────────────────────────────────────────

interface OutcomeDetermination {
  materialisedIndex: number | null; // null = ambiguous / no scenario matched
  outcomeDescription: string;
  confidence: "high" | "medium" | "low";
}

const OUTCOME_SYSTEM = `You are a geopolitical outcome assessor. Given a list of forecast scenarios and a summary of recent events, determine which scenario (if any) materialised. Return only valid JSON.

Schema:
{
  "materialisedIndex": number | null,
  "outcomeDescription": string (2-3 sentences describing what actually happened),
  "confidence": "high" | "medium" | "low"
}

Rules:
- materialisedIndex: 0, 1, or 2 for the matching scenario, null if ambiguous or no match
- If the situation is still developing and the forecast window was too short, set confidence="low" and materialisedIndex=null
- Match based on the falsification conditions: if a scenario's falsification conditions were met, that scenario did NOT materialise`;

async function fetchRecentStoryEvents(storyId: string): Promise<string> {
  try {
    const result = await runCypher(
      `MATCH (s:Story {id: $storyId})-[:CONTAINS]->(e:Event)
       WHERE e.eventDate > datetime() - duration({days: 30})
       RETURN e.cameoLabel AS label, e.actors AS actors, toString(e.eventDate) AS date
       ORDER BY e.eventDate DESC LIMIT 20`,
      { storyId }
    );
    if (!result.records.length) return "No recent events found in knowledge graph.";
    return result.records.map(r =>
      `${r.get("date")}: ${r.get("label")} — actors: ${JSON.stringify(r.get("actors"))}`
    ).join("\n");
  } catch {
    return "Knowledge graph unavailable.";
  }
}

async function determineOutcome(
  storyId: string,
  scenarios: Scenario[],
  recentEvents: string
): Promise<OutcomeDetermination> {
  const scenarioText = scenarios.map((s, i) =>
    `[${i}] "${s.label}" (${(s.probability * 100).toFixed(0)}%)
  Falsification: ${s.falsificationConditions.join("; ")}`
  ).join("\n\n");

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.1,
    max_tokens: 600,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: OUTCOME_SYSTEM },
      {
        role: "user",
        content: `Story: ${storyId}\n\nFORCAST SCENARIOS:\n${scenarioText}\n\nRECENT EVENTS:\n${recentEvents}`,
      },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? "{}";
  return JSON.parse(raw) as OutcomeDetermination;
}

// ── Resolution cycle ──────────────────────────────────────────────────────────

export async function runResolutionCycle(): Promise<void> {
  const graphOk = await isGraphAvailable().catch(() => false);

  const now = new Date();
  let expired: typeof predictionV2Table.$inferSelect[];

  try {
    expired = await db
      .select()
      .from(predictionV2Table)
      .where(
        and(
          eq(predictionV2Table.resolutionStatus, "pending"),
          lt(predictionV2Table.resolveAfter, now),
          isNull(predictionV2Table.resolvedAt)
        )
      );
  } catch (err) {
    logger.error({ err }, "resolution-watcher: DB query failed");
    return;
  }

  if (!expired.length) {
    logger.info("resolution-watcher: no expired predictions to resolve");
    return;
  }

  logger.info({ count: expired.length }, "resolution-watcher: resolving expired predictions");

  for (const row of expired) {
    try {
      let scenarios: Scenario[] = [];
      let devilCritique: DevilCritique | null = null;

      try {
        scenarios = JSON.parse(row.finalScenarios) as Scenario[];
        devilCritique = JSON.parse(row.devilCritique) as DevilCritique;
      } catch {
        // Corrupt data — skip with a note
        await db.update(predictionV2Table)
          .set({ resolutionStatus: "auto_resolved", resolvedAt: now, lessonsLearned: JSON.stringify({ error: "JSON parse failed" }) })
          .where(eq(predictionV2Table.id, row.id));
        continue;
      }

      // Fetch recent events and determine outcome
      const recentEvents = graphOk ? await fetchRecentStoryEvents(row.storyId) : "Knowledge graph not connected.";
      const outcome = await determineOutcome(row.storyId, scenarios, recentEvents);

      // Compute Brier score
      const scored = scenarios.map((s, i) => ({
        label: s.label,
        probability: s.probability,
        materialised: i === outcome.materialisedIndex,
      }));
      const brierScore = computeBrierScore(scored);

      // Run forensics (only if we have devil critique and outcome confidence is sufficient)
      let forensics = null;
      if (devilCritique && outcome.confidence !== "low") {
        forensics = await runForensicsAgent(
          row.storyId,
          scenarios,
          devilCritique,
          outcome.materialisedIndex,
          outcome.outcomeDescription
        );
      }

      // Write resolution back to DB
      await db.update(predictionV2Table)
        .set({
          resolutionStatus: "auto_resolved",
          resolvedAt: now,
          brierScore,
          lessonsLearned: forensics ? JSON.stringify(forensics.lessonsLearned) : null,
          devilWasRight: forensics ? String(forensics.devilWasRight) : null,
          missedChannel: forensics?.missedChannel ?? null,
          dominantChannel: forensics?.dominantChannel ?? row.dominantChannel,
        })
        .where(eq(predictionV2Table.id, row.id));

      logger.info({
        predictionId: row.id,
        storyId: row.storyId,
        materialisedIndex: outcome.materialisedIndex,
        brierScore,
        devilWasRight: forensics?.devilWasRight,
      }, "resolution-watcher: prediction resolved");

    } catch (err) {
      logger.warn({ predictionId: row.id, err }, "resolution-watcher: resolution failed for prediction");
    }
  }

  logger.info({ count: expired.length }, "resolution-watcher: resolution cycle complete");
}

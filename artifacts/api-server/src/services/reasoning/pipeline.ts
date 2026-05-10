// LangGraph-style 4-agent pipeline: Analyst → Historian → Forecaster → Devil's Advocate
// Runs for a single story and writes the result to prediction_v2.

import { randomUUID } from "crypto";
import { db } from "@workspace/db";
import { predictionV2Table } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { runCypher } from "../graph/neo4j-client.js";
import { logger } from "../../lib/logger.js";
import { runAnalystAgent } from "./agent-analyst.js";
import { runHistorianAgent } from "./agent-historian.js";
import { runForecasterAgent } from "./agent-forecaster.js";
import { runDevilAgent } from "./agent-devil.js";
import { getFeedbackLessons } from "../resolution/forensics.js";
import { getCalibrationWarning } from "./self-calibration.js";

// ── Pipeline state ─────────────────────────────────────────────────────────────

interface PipelineState {
  storyId: string;
  stage: "idle" | "analyst" | "historian" | "forecaster" | "devil" | "writing" | "done" | "error";
  flags: string[];
  error?: string;
}

// ── Neo4j subgraph fetch ───────────────────────────────────────────────────────

async function fetchStorySubgraph(storyId: string): Promise<string> {
  const result = await runCypher(
    `
    MATCH (s:Story {id: $storyId})
    OPTIONAL MATCH (s)-[:CONTAINS]->(e:Event)
      WHERE e.eventDate >= datetime() - duration({hours: 72})
    OPTIONAL MATCH (e)-[:ACTED_ON]->(c:Country)
    OPTIONAL MATCH (e1:Event)-[r:CONTRADICTS]->(e2:Event)
      WHERE (s)-[:CONTAINS]->(e1) AND (s)-[:CONTAINS]->(e2)
    WITH s,
         collect(DISTINCT {
           id: e.id,
           cameoCode: e.cameoCode,
           cameoLabel: e.cameoLabel,
           eventDate: toString(e.eventDate),
           actors: e.actors,
           statedIntent: e.statedIntent,
           effectiveWeight: e.effectiveWeight,
           confidence: e.confidence
         }) AS events,
         collect(DISTINCT {iso: c.iso_code, name: c.name}) AS countries,
         collect(DISTINCT {
           eventIdA: e1.id,
           eventIdB: e2.id,
           cameoCodeA: r.cameoCodeA,
           cameoCodeB: r.cameoCodeB
         }) AS contradictions
    RETURN s.id AS storyId, s.label AS storyLabel, s.status AS status,
           events, countries, contradictions
    `,
    { storyId }
  );

  if (!result.records.length) {
    throw new Error(`Story ${storyId} not found in graph`);
  }

  const record = result.records[0];
  return JSON.stringify({
    storyId: record.get("storyId"),
    storyLabel: record.get("storyLabel"),
    status: record.get("status"),
    events: record.get("events"),
    countries: record.get("countries"),
    contradictions: record.get("contradictions"),
  }, null, 2);
}

// ── Skip if recent prediction exists (within 5h) ──────────────────────────────

async function hasRecentPrediction(storyId: string): Promise<boolean> {
  const rows = await db
    .select({ generatedAt: predictionV2Table.generatedAt })
    .from(predictionV2Table)
    .where(eq(predictionV2Table.storyId, storyId))
    .orderBy(desc(predictionV2Table.generatedAt))
    .limit(1);

  if (!rows.length) return false;
  const ageMs = Date.now() - new Date(rows[0].generatedAt).getTime();
  return ageMs < 5 * 60 * 60 * 1000; // 5 hours
}

// ── Main pipeline ──────────────────────────────────────────────────────────────

export async function runPipeline(storyId: string): Promise<void> {
  const state: PipelineState = { storyId, stage: "idle", flags: [] };
  logger.info({ storyId }, "pipeline: starting");

  // Guard: skip if fresh prediction already exists
  if (await hasRecentPrediction(storyId)) {
    logger.info({ storyId }, "pipeline: recent prediction exists — skipping");
    return;
  }

  try {
    // ── Stage 0: Feedback injection — load lessons from past resolutions ──────
    const feedbackLessons = await getFeedbackLessons(storyId).catch(() => null);
    if (feedbackLessons) {
      logger.info({ storyId }, "pipeline: injecting feedback lessons from past resolutions");
    }

    // ── Stage 1: Fetch subgraph ────────────────────────────────────────────────
    const subgraphJson = await fetchStorySubgraph(storyId);

    // ── Stage 2: Analyst ──────────────────────────────────────────────────────
    state.stage = "analyst";
    const situationReport = await runAnalystAgent(storyId, subgraphJson);

    // ── Stage 3: Historian ────────────────────────────────────────────────────
    state.stage = "historian";
    // Pass feedback lessons so the historian can anchor on past calibration errors
    const historianReport = await runHistorianAgent(storyId, situationReport, feedbackLessons ?? undefined);

    if (historianReport.noHistoricalAnalogue) {
      state.flags.push("no_historical_analogue");
    }

    // ── Stage 4: Forecaster (with self-calibration warning if Brier > 0.22) ────
    state.stage = "forecaster";
    const dominantChannel = situationReport.indianMarketExposure?.channels?.[0] ?? "unknown";
    const calibrationWarning = getCalibrationWarning(dominantChannel);
    if (calibrationWarning) {
      logger.warn({ storyId, dominantChannel }, "pipeline: calibration penalty active for this story type");
      state.flags.push("calibration_penalty_active");
    }
    const forecasterTree = await runForecasterAgent(storyId, situationReport, historianReport, calibrationWarning ?? undefined);

    // ── Stage 5: Devil's Advocate ─────────────────────────────────────────────
    state.stage = "devil";
    const devilCritique = await runDevilAgent(storyId, forecasterTree);

    // Detect active contradiction flag (from subgraph)
    const subgraph = JSON.parse(subgraphJson) as { contradictions: unknown[] };
    if (subgraph.contradictions?.length > 0) {
      state.flags.push("active_contradiction");
    }

    // Detect narrative drifting flag (from historian — high uncertainty)
    if (historianReport.analogueConfidence < 0.45 && !historianReport.noHistoricalAnalogue) {
      state.flags.push("narrative_drifting");
    }

    // ── Stage 6: Write to DB ──────────────────────────────────────────────────
    state.stage = "writing";

    const minTimeframeDays = Math.min(...forecasterTree.scenarios.map(s => s.timeframeDays));
    const resolveAfter = new Date(Date.now() + minTimeframeDays * 24 * 60 * 60 * 1000);

    await db.insert(predictionV2Table).values({
      id: randomUUID(),
      storyId,
      analystReport: JSON.stringify(situationReport),
      historianPrecedents: JSON.stringify(historianReport),
      forecasterTree: JSON.stringify(forecasterTree),
      devilCritique: JSON.stringify(devilCritique),
      finalScenarios: JSON.stringify(devilCritique.finalScenarios),
      flags: JSON.stringify(state.flags),
      resolveAfter,
      resolutionStatus: "pending",
      dominantChannel: forecasterTree.dominantChannel,
    });

    state.stage = "done";
    logger.info({ storyId, flags: state.flags }, "pipeline: complete");

  } catch (err) {
    state.stage = "error";
    state.error = String(err);
    logger.error({ storyId, stage: state.stage, err }, "pipeline: failed");
    throw err;
  }
}

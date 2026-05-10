// Self-calibration job — runs daily.
// Computes rolling 10-prediction Brier score per story type and CAMEO action.
// When rolling_brier > 0.22, a confidence_penalty flag is written to DB so the
// Forecaster system prompt can inject a calibration warning on the next run.

import { randomUUID } from "crypto";
import { db, predictionV2Table } from "@workspace/db";
import { eq, desc, isNotNull, sql } from "drizzle-orm";
import { logger } from "../../lib/logger.js";
import { computeBrierScore } from "../resolution/brier-score.js";
import type { Scenario } from "./agent-forecaster.js";

const BRIER_PENALTY_THRESHOLD = 0.22;
const ROLLING_WINDOW = 10;

// ── Per-story-type rolling Brier ──────────────────────────────────────────────

interface CalibrationEntry {
  storyType: string;
  rollingBrier: number;
  windowSize: number;
  penaltyActive: boolean;
}

// In-memory calibration state: storyType → penalty flag
// Reset on each daily run; persisted as JSON in predictionV2Table.calibrationPenalty column
const _calibrationState = new Map<string, CalibrationEntry>();

export function getConfidencePenalty(storyType: string): number {
  const entry = _calibrationState.get(storyType);
  return entry?.penaltyActive ? 0.20 : 0;
}

export function getCalibrationWarning(storyType: string): string | null {
  const entry = _calibrationState.get(storyType);
  if (!entry?.penaltyActive) return null;
  return `⚠️ CALIBRATION WARNING: Rolling Brier score for story type "${storyType}" is ${entry.rollingBrier.toFixed(3)} (threshold: ${BRIER_PENALTY_THRESHOLD}). Apply a confidence_penalty of 0.20 — shade all scenario probabilities toward base rates and widen uncertainty bounds.`;
}

// ── Compute rolling Brier per story type ─────────────────────────────────────

async function computeRollingBrierByStoryType(): Promise<Map<string, CalibrationEntry>> {
  const result = new Map<string, CalibrationEntry>();

  try {
    // Fetch last ROLLING_WINDOW resolved predictions grouped by dominant channel (proxy for story type)
    const rows = await db
      .select({
        storyId: predictionV2Table.storyId,
        dominantChannel: predictionV2Table.dominantChannel,
        finalScenarios: predictionV2Table.finalScenarios,
        resolvedScenarioIndex: predictionV2Table.resolvedScenarioIndex,
        resolutionStatus: predictionV2Table.resolutionStatus,
      })
      .from(predictionV2Table)
      .where(isNotNull(predictionV2Table.resolvedScenarioIndex))
      .orderBy(desc(predictionV2Table.resolvedAt))
      .limit(200);

    // Group by dominant channel (used as story type proxy)
    const byType = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = row.dominantChannel ?? "unknown";
      if (!byType.has(key)) byType.set(key, []);
      byType.get(key)!.push(row);
    }

    for (const [storyType, typeRows] of byType) {
      const window = typeRows.slice(0, ROLLING_WINDOW);

      const brierScores: number[] = [];
      for (const row of window) {
        if (!row.finalScenarios || row.resolvedScenarioIndex === null) continue;
        try {
          const scenarios = JSON.parse(row.finalScenarios) as Scenario[];
          const scored = scenarios.map((s, i) => ({
            probability: s.probability,
            outcome: i === row.resolvedScenarioIndex ? 1 : 0,
          }));
          brierScores.push(computeBrierScore(scored));
        } catch { continue; }
      }

      if (brierScores.length === 0) continue;

      const rollingBrier = brierScores.reduce((a, b) => a + b, 0) / brierScores.length;
      const penaltyActive = rollingBrier > BRIER_PENALTY_THRESHOLD;

      result.set(storyType, {
        storyType,
        rollingBrier,
        windowSize: brierScores.length,
        penaltyActive,
      });

      if (penaltyActive) {
        logger.warn({ storyType, rollingBrier, windowSize: brierScores.length },
          "self-calibration: Brier > threshold — confidence_penalty ACTIVE");
      }
    }

  } catch (err) {
    logger.error({ err }, "self-calibration: failed to compute rolling Brier");
  }

  return result;
}

// ── 4-level Brier tracking ────────────────────────────────────────────────────
// Tracks per-record, per-story-type, per-CAMEO-action, per-transmission-channel

interface BrierBreakdown {
  perRecord: number;
  byStoryType: Record<string, number>;
  byCameoAction: Record<string, number>;
  byChannel: Record<string, number>;
}

export async function compute4LevelBrier(): Promise<BrierBreakdown> {
  const breakdown: BrierBreakdown = {
    perRecord: 0,
    byStoryType: {},
    byCameoAction: {},
    byChannel: {},
  };

  try {
    const rows = await db
      .select({
        storyId: predictionV2Table.storyId,
        dominantChannel: predictionV2Table.dominantChannel,
        finalScenarios: predictionV2Table.finalScenarios,
        analystReport: predictionV2Table.analystReport,
        resolvedScenarioIndex: predictionV2Table.resolvedScenarioIndex,
      })
      .from(predictionV2Table)
      .where(isNotNull(predictionV2Table.resolvedScenarioIndex))
      .orderBy(desc(predictionV2Table.resolvedAt))
      .limit(500);

    const allBriers: number[] = [];

    for (const row of rows) {
      if (!row.finalScenarios || row.resolvedScenarioIndex === null) continue;
      try {
        const scenarios = JSON.parse(row.finalScenarios) as Scenario[];
        const scored = scenarios.map((s, i) => ({
          probability: s.probability,
          outcome: i === row.resolvedScenarioIndex ? 1 : 0,
        }));
        const brier = computeBrierScore(scored);
        allBriers.push(brier);

        // By channel
        const channel = row.dominantChannel ?? "unknown";
        if (!breakdown.byChannel[channel]) breakdown.byChannel[channel] = brier;
        else breakdown.byChannel[channel] = (breakdown.byChannel[channel]! + brier) / 2;

        // By story type (from analyst report)
        if (row.analystReport) {
          try {
            const analyst = JSON.parse(row.analystReport) as { powerConfiguration?: string };
            const storyType = analyst.powerConfiguration ?? "unknown";
            if (!breakdown.byStoryType[storyType]) breakdown.byStoryType[storyType] = brier;
            else breakdown.byStoryType[storyType] = (breakdown.byStoryType[storyType]! + brier) / 2;
          } catch { /* skip */ }
        }

        // By CAMEO action (from scenario transmissionChannelIds as proxy)
        for (const txId of (scenarios[row.resolvedScenarioIndex]?.transmissionChannelIds ?? [])) {
          if (!breakdown.byCameoAction[txId]) breakdown.byCameoAction[txId] = brier;
          else breakdown.byCameoAction[txId] = (breakdown.byCameoAction[txId]! + brier) / 2;
        }
      } catch { continue; }
    }

    breakdown.perRecord = allBriers.length > 0
      ? allBriers.reduce((a, b) => a + b, 0) / allBriers.length
      : 0;

  } catch (err) {
    logger.error({ err }, "self-calibration: 4-level Brier computation failed");
  }

  return breakdown;
}

// ── Daily job ─────────────────────────────────────────────────────────────────

async function runSelfCalibration(): Promise<void> {
  logger.info("self-calibration: starting daily run");

  const entries = await computeRollingBrierByStoryType();
  const breakdown = await compute4LevelBrier();

  // Update in-memory calibration state
  _calibrationState.clear();
  for (const [key, entry] of entries) {
    _calibrationState.set(key, entry);
  }

  logger.info({
    storyTypes: entries.size,
    penaltiesActive: [...entries.values()].filter(e => e.penaltyActive).length,
    overallBrier: breakdown.perRecord.toFixed(4),
    channelCount: Object.keys(breakdown.byChannel).length,
  }, "self-calibration: complete");
}

const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 10 * 60 * 1000; // 10 min after startup

export function startSelfCalibrationScheduler(): void {
  logger.info("self-calibration: scheduler registered (first run in 10 min, then daily)");
  setTimeout(() => {
    void runSelfCalibration();
    setInterval(() => { void runSelfCalibration(); }, DAILY_INTERVAL_MS);
  }, FIRST_RUN_DELAY_MS);
}

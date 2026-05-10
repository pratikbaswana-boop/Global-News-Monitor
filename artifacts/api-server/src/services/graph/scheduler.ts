import { logger } from "../../lib/logger.js";
import { isGraphAvailable } from "./neo4j-client.js";
import { seedGraphSchema } from "./graph-schema-seed.js";
import { syncEventsToGraph } from "./event-graph-builder.js";
import { runStoryEmergence } from "./story-emergence.js";
import { runNarrativeDrift } from "./narrative-drift.js";
import { runContradictionDetection } from "./contradiction-detector.js";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const FIFTEEN_MIN_MS = 15 * 60 * 1000;

let graphSchedulerRunning = false;

export async function startGraphScheduler(): Promise<void> {
  if (graphSchedulerRunning) return;

  const available = await isGraphAvailable().catch(() => false);
  if (!available) {
    logger.warn(
      "NEO4J not reachable — Phase 2 graph scheduler is disabled. " +
      "Set NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD env vars and restart."
    );
    return;
  }

  graphSchedulerRunning = true;
  logger.info("phase 2 graph scheduler starting");

  // One-time seed: indexes, countries, transmission channels, Indian assets
  await seedGraphSchema().catch((e) =>
    logger.error({ err: e }, "graph schema seed failed")
  );

  // ── Event → Graph sync (every 15 min) ─────────────────────────────────────
  const syncEvents = () =>
    syncEventsToGraph().catch((e) =>
      logger.warn({ err: e instanceof Error ? e.message : e }, "event-graph sync error")
    );
  syncEvents();
  setInterval(syncEvents, FIFTEEN_MIN_MS);

  // ── Story Emergence via Louvain (every 6h) ─────────────────────────────────
  const storyEmergence = () =>
    runStoryEmergence().catch((e) =>
      logger.warn({ err: e instanceof Error ? e.message : e }, "story emergence error")
    );
  // First run after 5 minutes (let events populate first)
  setTimeout(() => {
    storyEmergence();
    setInterval(storyEmergence, SIX_HOURS_MS);
  }, 5 * 60 * 1000);

  // ── Contradiction Detection (every 30 min) ─────────────────────────────────
  const contradictionDetection = () =>
    runContradictionDetection().catch((e) =>
      logger.warn({ err: e instanceof Error ? e.message : e }, "contradiction detection error")
    );
  setTimeout(() => {
    contradictionDetection();
    setInterval(contradictionDetection, 30 * 60 * 1000);
  }, 10 * 60 * 1000);

  // ── Narrative Drift Detection (weekly) ────────────────────────────────────
  const narrativeDrift = () =>
    runNarrativeDrift().catch((e) =>
      logger.warn({ err: e instanceof Error ? e.message : e }, "narrative drift error")
    );
  // First run after 1h, then weekly
  setTimeout(() => {
    narrativeDrift();
    setInterval(narrativeDrift, ONE_WEEK_MS);
  }, 60 * 60 * 1000);

  logger.info("phase 2 graph scheduler started");
}

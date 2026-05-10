// Phase 3 reasoning scheduler — runs the 4-agent pipeline every 6h for active stories.
// Respects MAX_ACTIVE_STORIES=25 and is a no-op if Neo4j or ChromaDB are unavailable.

import { logger } from "../../lib/logger.js";
import { isGraphAvailable, getActiveStories } from "../graph/index.js";
import { isChromaAvailable } from "./chromadb-client.js";
import { runPipeline } from "./pipeline.js";

const PIPELINE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const FIRST_RUN_DELAY_MS = 3 * 60 * 1000;         // 3 min (after graph scheduler settles)
const MAX_CONCURRENT = 3;                           // run at most 3 story pipelines in parallel

async function runReasoningCycle(): Promise<void> {
  const [graphOk, chromaOk] = await Promise.all([
    isGraphAvailable().catch(() => false),
    isChromaAvailable().catch(() => false),
  ]);

  if (!graphOk) {
    logger.info("reasoning scheduler: Neo4j unavailable — skipping cycle");
    return;
  }

  if (!chromaOk) {
    logger.info("reasoning scheduler: ChromaDB unavailable — skipping cycle (historical analogues required)");
    return;
  }

  const stories = await getActiveStories().catch(() => []);
  if (!stories.length) {
    logger.info("reasoning scheduler: no active stories — nothing to do");
    return;
  }

  logger.info({ storyCount: stories.length }, "reasoning scheduler: starting pipeline cycle");

  // Process in batches of MAX_CONCURRENT to limit OpenAI concurrency
  for (let i = 0; i < stories.length; i += MAX_CONCURRENT) {
    const batch = stories.slice(i, i + MAX_CONCURRENT);
    await Promise.allSettled(
      batch.map(async (story) => {
        try {
          await runPipeline(story.id);
        } catch (err) {
          logger.warn({ storyId: story.id, err }, "reasoning scheduler: pipeline failed for story");
        }
      })
    );
  }

  logger.info({ storyCount: stories.length }, "reasoning scheduler: cycle complete");
}

export function startReasoningScheduler(): void {
  logger.info("reasoning scheduler: registering (first run in 3 min, then every 6h)");

  setTimeout(() => {
    void runReasoningCycle();
    setInterval(() => { void runReasoningCycle(); }, PIPELINE_INTERVAL_MS);
  }, FIRST_RUN_DELAY_MS);
}

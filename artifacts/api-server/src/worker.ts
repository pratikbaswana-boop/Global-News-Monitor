// Background worker thread entrypoint.
//
// Per WORKER_THREADS_PLAN.md: Phases 1-3, 5, and notifications run here —
// CPU-bound jobs (Louvain clustering, embedding/cosine dedup, GDELT parsing,
// 4-agent reasoning) that were blocking the main event loop and freezing
// tick evaluation for hundreds of ms.
//
// The worker shares NOTHING in memory with the trading engine. Both sides
// meet at Postgres/Neo4j/Chroma. Messages are lifecycle-only:
//   main -> worker: {type:"start"}, {type:"shutdown"}
//   worker -> main: {type:"ready"}, {type:"health", ...}, {type:"log", ...}

import { parentPort } from "node:worker_threads";
import { workerLogger } from "./lib/worker-logger.js";
import { startIngestionScheduler } from "./services/ingestion/index.js";
import { startGraphScheduler, startChannelRecalibrationScheduler } from "./services/graph/index.js";
import { startReasoningScheduler, startSelfCalibrationScheduler } from "./services/reasoning/index.js";
import { startResolutionScheduler } from "./services/resolution/index.js";
import { startMarketCloseSummaryScheduler } from "./services/notifications/push-notifications.js";

if (!parentPort) {
  throw new Error("worker.ts must be spawned as a worker_thread (no parentPort)");
}

const port = parentPort;

let shuttingDown = false;

// ── Health reporting ──────────────────────────────────────────────────────────
// Post a health heartbeat every 60s. No queue depths yet (lifecycle-only
// protocol); lastCycleMs can be added per-phase later if needed.

const HEALTH_INTERVAL_MS = 60_000;
let healthTimer: NodeJS.Timeout | null = null;

function startHealthReporting(): void {
  healthTimer = setInterval(() => {
    if (!shuttingDown) {
      port.postMessage({ type: "health", queueDepths: {}, lastCycleMs: 0 });
    }
  }, HEALTH_INTERVAL_MS);
  healthTimer.unref();
}

function stopHealthReporting(): void {
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
}

// ── Phase startup ─────────────────────────────────────────────────────────────

function startBackgroundPhases(): void {
  // Phase 1: AI-native ingestion pipeline (RSS/GDELT, semantic dedup, event extraction).
  startIngestionScheduler().catch((e) => {
    workerLogger.error({ err: e }, "Ingestion scheduler failed to start");
  });

  // Phase 2: Knowledge graph pipeline (event-graph-builder, Louvain story-emergence,
  // contradiction, narrative-drift, channel-recalibration). Degrades gracefully if Neo4j
  // is not connected.
  startGraphScheduler().catch((e) => {
    workerLogger.error({ err: e }, "Graph scheduler failed to start");
  });

  // Phase 2+: Quarterly Pearson recalibration of transmission channel correlations.
  startChannelRecalibrationScheduler();

  // Phase 3: 4-agent reasoning pipeline (requires Neo4j + ChromaDB). Degrades gracefully.
  startReasoningScheduler();

  // Phase 5: Automated resolution watcher (runs every 6h).
  startResolutionScheduler();

  // Phase 5+: Self-calibration job (runs daily — injects Brier penalty when rolling
  // score > 0.22).
  startSelfCalibrationScheduler();

  // Notifications: Market close summary (fires at 15:30 IST = 10:00 UTC daily).
  startMarketCloseSummaryScheduler();
}

// ── Message handling ──────────────────────────────────────────────────────────

port.on("message", (msg: { type: string }) => {
  switch (msg.type) {
    case "start":
      workerLogger.info("bg-worker: starting background phases");
      startBackgroundPhases();
      startHealthReporting();
      port.postMessage({ type: "ready" });
      break;

    case "shutdown":
      workerLogger.info("bg-worker: shutdown received — draining");
      shuttingDown = true;
      stopHealthReporting();
      // Schedulers use unref'd timers / long-poll loops — they will stop
      // naturally when the thread exits. Post ack and close.
      port.postMessage({ type: "shutdown-ack" });
      port.close();
      break;

    default:
      workerLogger.warn({ msg }, "bg-worker: unknown message");
  }
});

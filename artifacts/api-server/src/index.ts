import http from "node:http";
import app from "./app";
import { logger } from "./lib/logger";
import { attachWebSocketServer } from "./lib/ws-hub.js";
import { WorkerManager } from "./lib/worker-manager.js";
// Phase 4 + broker schedulers stay on main thread (latency-critical + in-process coupling).
import { startMarketScheduler } from "./services/market/index.js";
import { startMarketSignalScheduler } from "./services/market/signal-scheduler.js";
import { startMarketResolutionScheduler } from "./services/market/resolution-scheduler.js";
import { startTickEvaluator } from "./services/kite/tick-evaluator.js";
import { startPositionMonitor } from "./services/kite/position-monitor.js";
import { startEntryTracker } from "./services/kite/entry-tracker.js";
import { startTokenRefreshScheduler } from "./services/kite/token-refresh-scheduler.js";
import { startMarketTicker } from "./services/kite/market-ticker.js";
import { startWsBroadcaster } from "./services/kite/ws-broadcaster.js";
import { startPaperTradeEngine } from "./services/kite/paper-trade-engine.js";
import { startCondorPaperEngine } from "./services/kite/condor-paper-engine.js";
import { startEventLoopMonitor } from "./lib/event-loop-monitor.js";
// Phase 1-3/5 scheduler imports are deliberately NOT static here — they're loaded
// via dynamic import() only in the BG_IN_WORKER=false rollback path, so the main
// bundle doesn't statically depend on Phase 1-3 scheduler code (B6 cleanup).

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = http.createServer(app);

server.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Attach WebSocket server for real-time UI updates (eliminates polling lag)
  attachWebSocketServer(server);

  // Probe main-loop latency continuously — tells us whether the Phase 1-3 worker-thread
  // split (WORKER_THREADS_PLAN.md) is actually urgent. Runs regardless of the kill-switch.
  startEventLoopMonitor();

  // Emergency kill-switch — when the OpenAI key is invalid or Bedrock quota
  // is exhausted, the embedding-heavy background jobs are the ones spinning.
  // Per WORKER_THREADS_PLAN.md: DISABLE_BG_SCHEDULERS=true now means "don't
  // spawn the worker" — Phase 4 + broker schedulers on main still start, so
  // the trading engine + HTTP API keep serving.
  const bgDisabled = process.env["DISABLE_BG_SCHEDULERS"] === "true";
  if (bgDisabled) {
    logger.warn("DISABLE_BG_SCHEDULERS=true — background worker will not start");
  }

  if (!bgDisabled) {
    // ── Background phases (1-3, 5, notifications) ────────────────────────────
    // Per WORKER_THREADS_PLAN.md: CPU-bound jobs (Louvain, embedding dedup, GDELT
    // parsing, 4-agent reasoning) run in a worker thread so they stop blocking
    // the event loop the tick evaluator + position monitor run on.
    //
    // Rollback: set BG_IN_WORKER=false to run the phases on main as before
    // (pre-split behavior). Each batch is reversible without a code revert.
    const bgInWorker = process.env["BG_IN_WORKER"] !== "false";

    if (bgInWorker) {
      const workerManager = new WorkerManager();
      workerManager.start();

      // Graceful shutdown — signal the worker to drain, then terminate.
      const shutdown = () => {
        workerManager.shutdown().finally(() => process.exit(0));
      };
      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
    } else {
      logger.warn("BG_IN_WORKER=false — background phases running on main thread (rollback mode)");

      // Dynamic imports — only loaded in rollback mode. Keeps the main bundle
      // from statically depending on Phase 1-3 scheduler code (B6 cleanup).
      (async () => {
        const { startIngestionScheduler } = await import("./services/ingestion/index.js");
        const { startGraphScheduler, startChannelRecalibrationScheduler } = await import("./services/graph/index.js");
        const { startReasoningScheduler, startSelfCalibrationScheduler } = await import("./services/reasoning/index.js");
        const { startResolutionScheduler } = await import("./services/resolution/index.js");
        const { startMarketCloseSummaryScheduler } = await import("./services/notifications/push-notifications.js");

        // Phase 1: Start the AI-native ingestion pipeline in the background.
        startIngestionScheduler().catch((e) => {
          logger.error({ err: e }, "Ingestion scheduler failed to start");
        });

        // Phase 2: Start the knowledge graph pipeline (requires NEO4J_URI env var).
        // Degrades gracefully if Neo4j is not connected.
        startGraphScheduler().catch((e) => {
          logger.error({ err: e }, "Graph scheduler failed to start");
        });

        // Phase 3: Start the 4-agent reasoning pipeline (requires Neo4j + ChromaDB).
        // Degrades gracefully if either is not connected.
        startReasoningScheduler();

        // Phase 5: Start automated resolution watcher (runs every 6h).
        startResolutionScheduler();

        // Phase 5+: Self-calibration job (runs daily — injects Brier penalty when rolling score > 0.22).
        startSelfCalibrationScheduler();

        // Notifications: Market close summary (fires at 15:30 IST = 10:00 UTC daily).
        startMarketCloseSummaryScheduler();

        // Quarterly: Pearson recalibration of transmission channel correlations.
        startChannelRecalibrationScheduler();
      })().catch((e) => {
        logger.error({ err: e }, "Failed to load rollback background schedulers");
      });
    }
  }

  // ── Main-thread schedulers (latency-critical + in-process coupling) ──────
  // These always start — even when DISABLE_BG_SCHEDULERS=true — because the
  // trading engine + market data feed must keep running.
  {
    // Phase 4: Start HMM market regime detection (runs hourly during IST market hours).
    startMarketScheduler();

    // Phase 4-feed: Start the KiteTicker WebSocket market-data feed. Pushes NIFTY
    // option-chain ticks into the tier-3 signal buffer, replacing the 5s REST poll.
    startMarketTicker().catch((e) => {
      logger.error({ err: e }, "Market ticker failed to start");
    });

    // Phase 4a: Daily market signal snapshot at 09:00 IST.
    startMarketSignalScheduler();

    // Phase 4b: Daily market resolution at 15:30 IST.
    startMarketResolutionScheduler();

    // Broker: fill-confirmed entry tracker — wires Kite order postbacks (re-emitted from
    // the ticker) + a timeout sweep so entries become OPEN only on an actual fill (R6).
    // Started before the evaluator so it's listening when the first entry is placed.
    startEntryTracker();

    // Broker: Edge-triggered auto-trade executor (fires on signal-side transitions,
    // driven by the KiteTicker feed — replaces the 5s snapshot-scan loop).
    startTickEvaluator();

    // Broker: Tick-driven position monitor — trailing ratchet + exchange-side SL-M
    // backstop, driven by the KiteTicker feed (replaces the 5s poll loop).
    startPositionMonitor();

    // Broker: Token refresh (runs every 6h, refreshes tokens expiring within 6h).
    startTokenRefreshScheduler();

    // WebSocket: Broadcast enriched executions + orders to connected UI clients.
    startWsBroadcaster();

    // Paper trading: Virtual trading engine with Rs 1L compounding capital.
    startPaperTradeEngine();

    // Iron Condor paper trading: separate Rs 1L capital pool, option-SELLING strategy
    // (see nifty_master_guide.md) — fully independent of the option-buying engines above.
    startCondorPaperEngine();
  }
});

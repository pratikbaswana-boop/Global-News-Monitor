import app from "./app";
import { logger } from "./lib/logger";
import { startIngestionScheduler } from "./services/ingestion/index.js";
import { startGraphScheduler } from "./services/graph/index.js";
import { startReasoningScheduler } from "./services/reasoning/index.js";
import { startSelfCalibrationScheduler } from "./services/reasoning/self-calibration.js";
import { startMarketScheduler } from "./services/market/index.js";
import { startMarketSignalScheduler } from "./services/market/signal-scheduler.js";
import { startMarketResolutionScheduler } from "./services/market/resolution-scheduler.js";
import { startResolutionScheduler } from "./services/resolution/index.js";
import { startMarketCloseSummaryScheduler } from "./services/notifications/push-notifications.js";
import { startChannelRecalibrationScheduler } from "./services/graph/channel-recalibration.js";
import { startTickEvaluator } from "./services/kite/tick-evaluator.js";
import { startPositionMonitor } from "./services/kite/position-monitor.js";
import { startTokenRefreshScheduler } from "./services/kite/token-refresh-scheduler.js";
import { startMarketTicker } from "./services/kite/market-ticker.js";
import { startEventLoopMonitor } from "./lib/event-loop-monitor.js";

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

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Probe main-loop latency continuously — tells us whether the Phase 1-3 worker-thread
  // split (WORKER_THREADS_PLAN.md) is actually urgent. Runs regardless of the kill-switch.
  startEventLoopMonitor();

  // Emergency kill-switch — when the OpenAI key is invalid or Bedrock quota
  // is exhausted, the embedding-heavy background jobs spin the event loop and
  // make the HTTP API unresponsive. Setting DISABLE_BG_SCHEDULERS=true lets
  // the server serve cached data from the DB while we sort the upstream auth
  // out, without rebuilding the image.
  if (process.env["DISABLE_BG_SCHEDULERS"] === "true") {
    logger.warn("DISABLE_BG_SCHEDULERS=true — background schedulers will not start");
  } else {
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

    // Phase 5: Start automated resolution watcher (runs every 6h).
    startResolutionScheduler();

    // Phase 5+: Self-calibration job (runs daily — injects Brier penalty when rolling score > 0.22).
    startSelfCalibrationScheduler();

    // Notifications: Market close summary (fires at 15:30 IST = 10:00 UTC daily).
    startMarketCloseSummaryScheduler();

    // Quarterly: Pearson recalibration of transmission channel correlations.
    startChannelRecalibrationScheduler();

    // Broker: Edge-triggered auto-trade executor (fires on signal-side transitions,
    // driven by the KiteTicker feed — replaces the 5s snapshot-scan loop).
    startTickEvaluator();

    // Broker: Tick-driven position monitor — trailing ratchet + exchange-side SL-M
    // backstop, driven by the KiteTicker feed (replaces the 5s poll loop).
    startPositionMonitor();

    // Broker: Token refresh (runs every 6h, refreshes tokens expiring within 6h).
    startTokenRefreshScheduler();
  }
});

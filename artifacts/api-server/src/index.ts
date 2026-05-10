import app from "./app";
import { logger } from "./lib/logger";
import { startIngestionScheduler } from "./services/ingestion/index.js";
import { startGraphScheduler } from "./services/graph/index.js";
import { startReasoningScheduler } from "./services/reasoning/index.js";
import { startSelfCalibrationScheduler } from "./services/reasoning/self-calibration.js";
import { startMarketScheduler } from "./services/market/index.js";
import { startResolutionScheduler } from "./services/resolution/index.js";
import { startMarketCloseSummaryScheduler } from "./services/notifications/push-notifications.js";
import { startChannelRecalibrationScheduler } from "./services/graph/channel-recalibration.js";

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

  // Phase 5: Start automated resolution watcher (runs every 6h).
  startResolutionScheduler();

  // Phase 5+: Self-calibration job (runs daily — injects Brier penalty when rolling score > 0.22).
  startSelfCalibrationScheduler();

  // Notifications: Market close summary (fires at 15:30 IST = 10:00 UTC daily).
  startMarketCloseSummaryScheduler();

  // Quarterly: Pearson recalibration of transmission channel correlations.
  startChannelRecalibrationScheduler();
});

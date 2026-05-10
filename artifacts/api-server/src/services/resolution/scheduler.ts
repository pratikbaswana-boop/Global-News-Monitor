// Phase 5 resolution scheduler — runs every 6h to resolve expired prediction_v2 rows.

import { logger } from "../../lib/logger.js";
import { runResolutionCycle } from "./resolution-watcher.js";

const RESOLUTION_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const FIRST_RUN_DELAY_MS = 5 * 60 * 1000;           // 5 min after startup

export function startResolutionScheduler(): void {
  logger.info("resolution-scheduler: registering (first run in 5 min, then every 6h)");

  setTimeout(() => {
    void runResolutionCycle();
    setInterval(() => { void runResolutionCycle(); }, RESOLUTION_INTERVAL_MS);
  }, FIRST_RUN_DELAY_MS);
}

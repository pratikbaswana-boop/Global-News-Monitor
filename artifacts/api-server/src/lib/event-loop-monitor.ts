// Event-loop lag probe.
//
// The whole point of the event-driven trading engine is low main-loop latency, so measure it
// directly. This logs p50/p99/max event-loop delay each minute. Spikes that line up with
// background cycles (story-emergence / dedup / GDELT parse) are the evidence for whether the
// Phase 1-3 worker-thread split (WORKER_THREADS_PLAN.md) is actually urgent — decide with data,
// not by guessing.

import { monitorEventLoopDelay } from "perf_hooks";
import { logger } from "./logger.js";

const REPORT_INTERVAL_MS = 60_000;

export function startEventLoopMonitor(): void {
  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();

  const timer = setInterval(() => {
    const toMs = (ns: number) => Number((ns / 1e6).toFixed(1));
    logger.info(
      { loopLagMs: { p50: toMs(h.percentile(50)), p99: toMs(h.percentile(99)), max: toMs(h.max) } },
      "event-loop-lag"
    );
    h.reset();
  }, REPORT_INTERVAL_MS);
  timer.unref();

  logger.info("event-loop-monitor: started (p50/p99/max logged each minute)");
}

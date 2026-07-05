// Write-behind audit queue (R4).
//
// Postgres is demoted to an audit log: snapshots, signal events, executions and broker
// orders are still persisted (the Resolution scheduler + analytics need them), but the
// write is enqueued fire-and-forget so it never blocks the tick -> order chain. The hot
// path calls enqueueAudit() (O(1), synchronous) and moves on; a background drainer runs
// the actual DB writes on the event loop and swallows/logs errors.
//
// The authoritative hot-path state is in memory (the position-state machine), so a brief
// persistence lag — or a dropped task under extreme overload — cannot cause a double
// trade. The exchange-side SL backstop (R5) covers the "process dies with tasks queued"
// case for open positions.

import { logger } from "./logger.js";

interface AuditTask {
  label: string;
  run: () => Promise<void>;
  enqueuedAt: number;
}

// Bounded buffer — audit writes are not worth unbounded memory. On overflow we drop the
// oldest task (with a warning) rather than block or grow without limit.
const MAX_QUEUE = 5000;

const queue: AuditTask[] = [];
let draining = false;
let shutdownHooked = false;

function ensureShutdownFlush(): void {
  if (shutdownHooked) return;
  shutdownHooked = true;
  const flush = () => {
    void flushAuditQueue();
  };
  process.once("SIGTERM", flush);
  process.once("SIGINT", flush);
  process.once("beforeExit", flush);
}

/**
 * Enqueue a persistence task. Never throws, never blocks the caller. The task runs
 * asynchronously on the drainer; failures are logged, not propagated.
 */
export function enqueueAudit(label: string, run: () => Promise<void>): void {
  ensureShutdownFlush();

  if (queue.length >= MAX_QUEUE) {
    queue.shift();
    logger.warn({ label, size: queue.length }, "audit-queue: overflow — dropped oldest task");
  }
  queue.push({ label, run, enqueuedAt: Date.now() });

  if (!draining) void drain();
}

async function drain(): Promise<void> {
  draining = true;
  try {
    while (queue.length) {
      const task = queue.shift()!;
      try {
        await task.run();
      } catch (err) {
        logger.error({ label: task.label, err: err instanceof Error ? err.message : err }, "audit-queue: task failed");
      }
    }
  } finally {
    draining = false;
  }
}

/** Current backlog depth (diagnostics / tests). */
export function getAuditQueueDepth(): number {
  return queue.length;
}

/** Drain everything now — call on graceful shutdown. Resolves when the queue is empty. */
export async function flushAuditQueue(): Promise<void> {
  await drain();
}

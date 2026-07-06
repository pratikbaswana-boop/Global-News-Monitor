// Manages the background worker thread lifecycle.
//
// Per WORKER_THREADS_PLAN.md:
// - Worker crash must NOT take down the API → respawn with exponential backoff.
// - SIGTERM → signal worker to drain, then terminate.
// - Worker shares nothing in memory with the trading engine — messages are
//   lifecycle-only (start/shutdown/ready/health).

import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

export class WorkerManager {
  private worker: Worker | null = null;
  private restartCount = 0;
  private shuttingDown = false;
  private restartTimer: NodeJS.Timeout | null = null;

  start(): void {
    if (this.worker || this.shuttingDown) return;

    const workerPath = path.resolve(__dirname, "worker.mjs");
    this.worker = new Worker(workerPath, { env: process.env });

    this.worker.on("online", () => {
      logger.info("bg-worker: thread online");
    });

    this.worker.on("message", (msg: { type: string; [key: string]: unknown }) => {
      switch (msg.type) {
        case "ready":
          logger.info("bg-worker: ready");
          this.restartCount = 0;
          break;
        case "health":
          logger.info({ health: msg }, "bg-worker: health");
          break;
        case "log":
          // Worker forwards its own logs — already on stdout via pino, but
          // this channel exists for future structured health metrics.
          break;
      }
    });

    this.worker.on("error", (err: Error) => {
      logger.error({ err }, "bg-worker: error");
    });

    this.worker.on("exit", (code: number) => {
      this.worker = null;
      if (this.shuttingDown) {
        logger.info({ code }, "bg-worker: exited during shutdown");
        return;
      }
      logger.warn({ code, restartCount: this.restartCount }, "bg-worker: exited — respawning");
      this.scheduleRestart();
    });

    this.worker.postMessage({ type: "start" });
  }

  private scheduleRestart(): void {
    this.restartCount++;
    const backoff = Math.min(
      BASE_BACKOFF_MS * 2 ** Math.min(this.restartCount - 1, 5),
      MAX_BACKOFF_MS,
    );
    logger.info({ backoffMs: backoff, attempt: this.restartCount }, "bg-worker: restart scheduled");
    this.restartTimer = setTimeout(() => this.start(), backoff);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (!this.worker) return;

    await new Promise<void>((resolve) => {
      const forceKill = setTimeout(() => {
        logger.warn("bg-worker: shutdown timeout — terminating");
        this.worker?.terminate().then(() => resolve());
      }, SHUTDOWN_TIMEOUT_MS);

      this.worker!.once("exit", () => {
        clearTimeout(forceKill);
        resolve();
      });

      this.worker!.postMessage({ type: "shutdown" });
    });

    this.worker = null;
  }
}

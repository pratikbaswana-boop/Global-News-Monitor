// Logger for the background worker thread.
//
// Per WORKER_THREADS_PLAN.md: independent pino per thread (stdout is shared at the
// OS level). No pino-pretty transport — avoids nested worker-thread spawning inside
// an already-worker context. The {thread: "bg"} base field lets log filters
// distinguish main-thread vs worker logs.

import pino from "pino";

export const workerLogger = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  base: { thread: "bg" },
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
});

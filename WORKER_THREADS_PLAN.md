# Plan — Isolate Phase 1–3 CPU work into a worker thread (Follow-up #1)

**Goal:** stop CPU-bound background jobs (Louvain clustering, embedding/cosine dedup, GDELT
batch parsing, large JSON parses in the 4-agent pipeline) from blocking the Node event loop
that the tick evaluator and position monitor run on. Today a story-emergence job can freeze
the stop-loss evaluation for hundreds of ms. Move that work off the main loop.

**Chosen approach:** `worker_threads` (not a separate process). Minimal deploy change, one
container, one image. The existing `DISABLE_BG_SCHEDULERS` kill-switch is already the seam —
turn it into a thread boundary.

---

## The boundary (this is the whole design)

Phases 1–3 (and 5) talk to the trading engine **only through Postgres/Neo4j** — the market
engine reads their outputs (news, geopolitical signal, regimes) from the DB, never from an
in-process object. The **one exception** is the **Phase 4 market scheduler**, which publishes
the in-memory `hot-context` the executor reads on the same thread. So:

| Stays on MAIN thread (latency-critical + in-process coupling) | Moves to WORKER thread (CPU-heavy, DB-only coupling) |
|---|---|
| HTTP server (Express) | Phase 1: news ingestion (RSS/GDELT, semantic dedup, event extraction) |
| KiteTicker feed (`market-ticker`) | Phase 2: knowledge graph (event-graph-builder, **Louvain story-emergence**, contradiction, narrative-drift, channel-recalibration) |
| Tier-3 signal engine + tick evaluator + executor | Phase 3: 4-agent reasoning pipeline |
| Position monitor + write-behind audit drainer | Phase 5: resolution watcher, self-calibration |
| **Phase 4 market scheduler** (publishes hot-context in-process) | Notifications (market-close summary, push) |
| Token refresh | |

**Why the market scheduler stays:** it calls `publishAssetContext()` into a module-level map
that the executor reads lock-free *on the same thread*. Move it to a worker and that read
crosses a thread boundary — you'd have to serialize the context every 5 min and ship it back.
It's a 5-min slow-path job with negligible CPU (Yahoo fetch + LLM calls are I/O), so it does
not threaten tick latency. Leave it on main; keep the in-process hot-context intact.

**Result:** the worker shares **nothing in memory** with the trading engine. No hot-path
message protocol is needed — the two sides already meet at the database.

---

## The hard parts (worker_threads gotchas, ranked)

1. **No shared JS objects.** Workers get structured-clone messages, not references. Each worker
   must construct its **own** clients: Postgres/Drizzle pool, Neo4j driver, ChromaDB client,
   Bedrock/LLM client (`@workspace/integrations-openai-ai-server`), web-push. Audit: any
   module-level singleton those phases import must be safe to instantiate twice (once per
   thread). Most are (they read env + open their own connections). Flag any that assume a
   single global.
2. **Shared module-level caches.** Confirm no Phase 1–3 cache is also read by Phase 4 in-process.
   Known Phase-4 caches (`instrumentsCache`, session priors, FlipGuard, hot-context) stay on
   main — good. Grep for other cross-phase module state before cutover.
3. **Logging transport.** `pino` in a worker: route worker logs through `parentPort` or give the
   worker its own pino instance writing to the same stdout. Simplest: independent pino per
   thread (stdout is shared at the OS level). Keep the `{thread: "bg"}` field for filtering.
4. **Env + config.** The worker needs the same env (DB URL, NEO4J_URI, Bedrock creds, VAPID).
   `workerData` or inherited `process.env` (inherited by default). `DISABLE_BG_SCHEDULERS=true`
   → simply don't spawn the worker.
5. **Lifecycle + resilience.** Worker crash must not take down the API. `worker.on("error")` /
   `on("exit", code=>respawn with backoff)`. Graceful shutdown: on SIGTERM, signal the worker to
   drain (finish in-flight jobs, flush its own write-behind if any) then `terminate()`.
6. **esbuild bundling.** `build.mjs` currently emits one entry. Add a second entry for the worker
   (`worker.mjs`) and reference it via an absolute path resolved at runtime. Verify
   `esbuild-plugin-pino` handles the second entry.

---

## Minimal message protocol

Heavy data flows through the DB, so messages are lifecycle-only:

- main → worker: `{type:"start"}`, `{type:"shutdown"}`
- worker → main: `{type:"ready"}`, `{type:"health", queueDepths, lastCycleMs}`, `{type:"log", ...}`
- No trade data, no snapshots, no graph payloads cross the boundary.

---

## Batch plan (incremental, each independently shippable)

- **B1 — Worker scaffold.** Add `worker.ts` entrypoint + esbuild target; spawn from `index.ts`
  behind the existing kill-switch; worker just logs "ready". No phases moved yet. Prove
  spawn/crash-respawn/shutdown work.
- **B2 — Move Phase 5 + notifications** (lowest risk, purely DB/HTTP-out). Validate they run in
  the worker: resolutions still written, pushes still sent.
- **B3 — Move Phase 1 (ingestion).** Worker owns its Bedrock (fast model) + Postgres client.
  Validate raw_articles/events still populate; dedup still runs.
- **B4 — Move Phase 2 (graph, incl. Louvain).** Worker owns Neo4j driver. This is the biggest CPU
  win. Validate stories still emerge.
- **B5 — Move Phase 3 (reasoning).** Worker owns Bedrock (chat) + Neo4j + Chroma. Validate
  prediction_v2 still written.
- **B6 — Cleanup.** Main thread no longer imports Phase 1–3 modules; confirm the bundle for the
  trading engine shrank and shares no Phase 1–3 code.

---

## Verification — prove the loop no longer stalls

The whole point is main-loop latency, so measure it directly:

- **Event-loop lag probe** on the main thread (`monitorEventLoopDelay` from `perf_hooks`),
  logged each minute (p50/p99). Before: expect p99 spikes aligned with story-emergence /
  dedup cycles. After: p99 should flatten (no CPU jobs left on main).
- **Tick→eval latency**: timestamp gap between a tick arriving and `evaluate()` completing;
  assert no multi-hundred-ms gaps during a background cycle.
- **Functional parity**: row counts in raw_articles / events / prediction_v2 / market_regimes
  over a session match the pre-split baseline (the worker does the same work, elsewhere).
- **Resilience**: kill the worker mid-cycle → API stays up, worker respawns, no lost trading.

---

## Risks & rollback

- **Double connections**: worker + main both open DB/Neo4j pools → size pools down per thread so
  total stays within limits.
- **Ordering assumptions**: if any Phase-4 code assumed a Phase 1–3 job ran earlier *in the same
  tick of wall-clock*, that's now async across threads — but since coupling is via DB reads with
  their own cadences, this is already the case today.
- **Rollback**: the kill-switch already exists — a flag (`BG_IN_WORKER=false`) can run the phases
  on main as before, so each batch is reversible without a code revert.

---

## Effort / sequencing note

This is a **separate project from the R1–R5 migration**, not another batch of it — it refactors
Phases 1–3 (which the trading migration never touched). Recommend doing follow-up **#3 (parallel
dispatch)** first if multi-user fills are the near-term concern; do **#1** when background CPU
spikes are observed in the event-loop-lag probe (add that probe now — it's ~10 lines and tells
you whether #1 is urgent yet).

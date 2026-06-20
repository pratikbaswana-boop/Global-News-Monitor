# Global News Intelligence Dashboard — Complete System Architecture & Design

## Table of Contents
1. [System Overview](#1-system-overview)
2. [What The System Does](#2-what-the-system-does)
3. [High-Level Architecture](#3-high-level-architecture)
4. [Technology Stack](#4-technology-stack)
5. [Monorepo Structure](#5-monorepo-structure)
6. [Phase-by-Phase Data Flows & Loops](#6-phase-by-phase-data-flows--loops)
7. [Database Schema](#7-database-schema)
8. [AI Agent Pipeline & System Prompts](#8-ai-agent-pipeline--system-prompts)
9. [Scheduler Registry & Timing Matrix](#9-scheduler-registry--timing-matrix)
10. [External Integrations](#10-external-integrations)
11. [Error Handling & Graceful Degradation](#11-error-handling--graceful-degradation)
12. [Deployment Architecture](#12-deployment-architecture)

---

## 1. System Overview

The **Global News Intelligence Dashboard** is an AI-native geopolitical intelligence and market prediction platform. It continuously ingests global news, extracts structured geopolitical events using GPT-4o, builds a dynamic knowledge graph in Neo4j, runs a 4-agent probabilistic reasoning pipeline to forecast geopolitical outcomes, and uses Hidden Markov Models (HMM) combined with real-time market data to generate intraday directional predictions for Indian equity markets (NIFTY 50, SENSEX, individual stocks, Gold, Silver).

The system is a closed-loop prediction machine: it makes predictions, resolves them against real-world outcomes, computes Brier scores, and feeds accuracy lessons back into future prediction cycles.

---

## 2. What The System Does

### Core Capabilities

| Feature | Description |
|---------|-------------|
| **Intelligent News Ingestion** | Fetches from 50+ RSS feeds, NewsAPI, GNews, Guardian, GDELT global events database. Deduplicates semantically, extracts CAMEO-coded events via GPT-4o. |
| **Dynamic Knowledge Graph** | Events -> Neo4j graph (Event, Country, Leader, Story nodes). Detects contradictions, narrative drift, and story emergence via Louvain community detection. |
| **4-Agent Reasoning Pipeline** | LangGraph-style pipeline: Analyst -> Historian -> Forecaster -> Devil's Advocate. Produces probabilistic scenario trees with falsification conditions. |
| **Market Regime Detection** | HMM (Hidden Markov Model) on 5-dim feature vector (VIX, PCR, Realized Vol, INR/USD, FII flow) classifies market into RISK_ON / RISK_OFF / CRISIS. |
| **Intraday Market Predictions** | Per-asset ensemble inference (NIFTY, SENSEX, Reliance, TCS, HDFC Bank, Gold, Silver) with FlipGuard, Candle Trust, Tier 3 evidence, and channel decay. |
| **Track Record System** | Auto-snapshot predictions at market open, auto-resolve at 15:30 IST against real Yahoo Finance prices. Computes accuracy, Brier scores, lessons learned. |
| **Push Notifications** | Web Push (VAPID) for regime changes, market call flips, prediction updates, market close summaries, narrative drift alerts. |
| **Self-Calibration** | Daily Brier score computation per story type. When rolling Brier > 0.22, injects confidence penalty into forecaster prompts. |
| **PWA** | Installable Progressive Web App with service worker, offline capability, manifest. |

### Frontend Tabs

- **Market Impact** — Live directional signals with Bull/Bear validation, signal breakdown, price impact estimates
- **Event Forecast** — AI-generated geopolitical predictions with scenario trees and deadlines
- **Story Clusters** — Article grouping by geopolitical theme (Russia-Ukraine, Iran Sanctions, etc.)
- **Relationship Map** — Actor/entity network graph visualization
- **Track Record** — Accuracy donut, confidence breakdown, per-asset statistics
- **Chat** — Conversational intelligence interface

---

## 3. High-Level Architecture

```
+-------------------------------------------------------------------------------------+
|                                  CLIENT LAYER                                        |
|  +--------------+  React 19 + Vite + Tailwind CSS v4 + shadcn/ui + Radix          |
|  |  PWA (SPA)   |  TanStack Query, Recharts, Framer Motion, Wouter               |
|  |  /sw.js      |  Web Push subscriptions, installable manifest                |
|  +------+-------+                                                                    |
|         | HTTP /api/*                                                               |
+---------+---------------------------------------------------------------------------+
|         v                                                                           |
|  +--------------------------------------------------------------------------------+ |
|  |                         API SERVER (Express 5)                                    | |
|  |  +-------------+ +-------------+ +-------------+ +-------------+               | |
|  |  | /api/news   | |/api/intel...| | /api/chat   | | /api/push   |               | |
|  |  | /api/health | |             | |             | |             |               | |
|  |  +------+------+ +------+------+ +------+------+ +------+------+               | |
|  |         |               |               |               |                       | |
|  |         v               v               v               v                       | |
|  |  +-------------------------------------------------------------------------+   | |
|  |  |                    BACKGROUND SCHEDULERS (10 total)                      |   | |
|  |  |  Phase 1 | Phase 2 | Phase 3 | Phase 4 | Phase 5 | Notifications       |   | |
|  |  |  Ingest  | Graph   | Reason  | Market  | Resolve | Push / Calibrate    |   | |
|  |  +-------------------------------------------------------------------------+   | |
|  +--------------------------------------------------------------------------------+ |
|         |                           |                           |                  |
|         v                           v                           v                  |
|  +--------------+        +--------------+        +-----------------------------+  |
|  |  PostgreSQL  |        |    Neo4j     |        |         ChromaDB            |  |
|  |  (Drizzle)   |        |  (Knowledge  |        |   (Historical Analogues     |  |
|  |              |        |   Graph)     |        |    Vector Search)           |  |
|  +--------------+        +--------------+        +-----------------------------+  |
|         |                           |                           |                  |
|         +---------------------------+---------------------------+                  |
|                                     |                                              |
|                                     v                                              |
|  +--------------------------------------------------------------------------------+ |
|  |                         EXTERNAL DATA SOURCES                                   | |
|  |  Yahoo Finance | NSE Direct | GDELT | NewsAPI | GNews | Guardian | RSS Feeds    | |
|  |  OpenAI GPT-4o | OFAC SDN   | ACLED | UN News | Firecrawl (NSE scraping)       | |
|  +--------------------------------------------------------------------------------+ |
+-------------------------------------------------------------------------------------+
```

---

## 4. Technology Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Monorepo | pnpm workspaces | 8+ |
| Runtime | Node.js | 24 |
| Language | TypeScript | 5.9 |
| API Framework | Express | 5 |
| Frontend | React | 19 |
| Build | Vite (frontend), esbuild (API) | — |
| Styling | Tailwind CSS v4 + tw-animate-css | — |
| UI Components | shadcn/ui + Radix Primitives | — |
| Charts | Recharts | — |
| State | TanStack Query | — |
| Database | PostgreSQL + Drizzle ORM | — |
| Graph DB | Neo4j (via neo4j-driver) | 5.27+ |
| Vector DB | ChromaDB (via chromadb) | 1.9+ |
| Validation | Zod v4 + drizzle-zod | — |
| API Codegen | Orval (OpenAPI -> React hooks + Zod) | — |
| AI | OpenAI GPT-4o | — |
| Logging | Pino + pino-http | — |
| Push | web-push (VAPID) | 3.6+ |
| Deployment | Docker Compose + EC2 + Caddy | — |

---

## 6. Phase-by-Phase Data Flows & Loops

### Phase 1: AI-Native Ingestion Pipeline

**What it does:** Continuously harvests global news, deduplicates, extracts structured geopolitical events, and persists to PostgreSQL.

**Entry Point:** `startIngestionScheduler()` — `index.ts:45`

**Loop Architecture:**

```
+----------------------------------------------------------------------------+
|                          PHASE 1: INGESTION                                  |
|  +--------------+    +--------------+    +--------------+                  |
|  | RSS Feeds    |    | GDELT Batch  |    | Fallback APIs|                  |
|  | (50+ feeds)  |    | (every 15m)  |    | (NewsAPI,    |                  |
|  | Per-feed     |    |              |    |  GNews,      |                  |
|  | staggered    |    |              |    |  Guardian)   |                  |
|  | timers       |    |              |    |              |                  |
|  +------+-------+    +------+-------+    +------+-------+                  |
|         |                   |                   |                          |
|         v                   v                   v                          |
|  +--------------------------------------------------------------------+   |
|  |                    SINGLE ARTICLE PROCESSING                        |   |
|  |  1. URL dedup check (DB) -> skip if exists                         |   |
|  |  2. Semantic dedup (OpenAI embedding + cosine) -> skip if duplicate |   |
|  |  3. Persist raw_article (title, body, feedId, credibilityTier)     |   |
|  |  4. GPT-4o CAMEO extraction -> extracted_events row               |   |
|  |     (skip for state-media-only until corroborated)                  |   |
|  +--------------------------------------------------------------------+   |
|                              |                                             |
|                              v                                             |
|  +--------------------------------------------------------------------+   |
|  |                    POSTGRESQL TABLES                                |   |
|  |  feed_registry    -> Feed metadata, quarantine state, fetch interval|   |
|  |  raw_articles     -> Article content, embeddings, dedup status      |   |
|  |  extracted_events -> CAMEO-coded events with actors, targets        |   |
|  |  extraction_errors-> Failed extraction attempts                   |   |
|  +--------------------------------------------------------------------+   |
+----------------------------------------------------------------------------+
```

**Timing Loop:**
- Each RSS feed runs on its own `setInterval` based on `fetchIntervalSeconds` (default 900s = 15 min)
- Feeds are staggered by `random() * min(interval, 60s)` to avoid thundering herd
- GDELT batch runs every 15 minutes
- Feed quarantine: after 3 consecutive failures, feed is quarantined with exponential backoff

**Key Files:**
- `@/artifacts/api-server/src/services/ingestion/scheduler.ts`
- `@/artifacts/api-server/src/services/ingestion/event-extractor.ts`

---

### Phase 2: Dynamic Knowledge Graph

**What it does:** Synchronizes extracted events to Neo4j, detects emergent geopolitical stories via Louvain community detection, finds contradictions, detects narrative drift.

**Entry Point:** `startGraphScheduler()` — `index.ts:51`

**Neo4j Graph Schema:**

```
(:Story)-[:CONTAINS]->(:Event)-[:ACTED_ON]->(:Country/:Leader)
(:Event)-[:CONTRADICTS]->(:Event)
(:Story)-[:TRANSMITS_TO]->(:Channel)
(:Channel)-[:AFFECTS]->(:IndianAsset)
```

**Loop Architecture:**

```
+----------------------------------------------------------------------------+
|                          PHASE 2: KNOWLEDGE GRAPH                            |
|                                                                             |
|         ^                    ^                    ^                         |
|         |                    |                    |                         |
|  +--------------+   +--------------+   +------------------------------+    |
|  |Event->Graph   |   |Story         |   |Contradiction                 |    |
|  |Sync          |   |Emergence     |   |Detection                     |    |
|  |(every 15m)   |   |(every 6h)    |   |(every 30m)                   |    |
|  |              |   |              |   |                              |    |
|  |INSERT/UPDATE |   |Louvain       |   |Cross-event                   |    |
|  |Event nodes   |   |communities   |   |contradiction                 |    |
|  |with CAMEO    |   |-> Story nodes|   |detection                     |    |
|  |attributes    |   |GPT-4o labels |   |                              |    |
|  +--------------+   +--------------+   +------------------------------+    |
|         |                    |                    |                         |
|         +--------------------+--------------------+                         |
|                              |                                             |
|                              v                                             |
|  +--------------------------------------------------------------------+   |
|  |                    WEEKLY / QUARTERLY JOBS                          |   |
|  |  Narrative Drift Detection (weekly) — cosine distance > 0.25 flag   |   |
|  |  Channel Recalibration (quarterly) — Pearson correlation update     |   |
|  +--------------------------------------------------------------------+   |
+----------------------------------------------------------------------------+
```

**Story Emergence Algorithm:**
1. Fetch all non-hypothesis events from last 21 days
2. Build adjacency matrix weighted by country overlap
3. Run Louvain community detection
4. Filter communities: min 4 events, min 1 country
5. GPT-4o labels each community in <=8 words
6. Merge with existing stories via Jaccard similarity > 0.60
7. Cap at `MAX_ACTIVE_STORIES = 25`

**Key Files:**
- `@/artifacts/api-server/src/services/graph/scheduler.ts`
- `@/artifacts/api-server/src/services/graph/story-emergence.ts`

---

### Phase 3: 4-Agent Reasoning Pipeline

**What it does:** For each active story, runs a LangGraph-style pipeline of 4 GPT-4o agents to produce a probabilistic forecast with falsification conditions.

**Entry Point:** `startReasoningScheduler()` — `index.ts:57`, runs every 6h.

**Pipeline Architecture:**

```
+----------------------------------------------------------------------------+
|                     PHASE 3: 4-AGENT REASONING                               |
|                                                                             |
|  Input: Active Story IDs from Neo4j (max 25)                               |
|                                                                             |
|  +-------------+    +-------------+    +-------------+    +-------------+   |
|  |  Analyst    |--->|  Historian  |--->| Forecaster  |--->|   Devil     |   |
|  |  (Agent 1)  |    |  (Agent 2)  |    |  (Agent 3)  |    |  (Agent 4)  |   |
|  +-------------+    +-------------+    +-------------+    +-------------+   |
|         |                 |                 |                 |             |
|         v                 v                 v                 v             |
|  +--------------------------------------------------------------------+   |
|  |  Analyst: Situation report from Neo4j subgraph                      |   |
|  |    • Power configuration, escalation risk, Indian market exposure    |   |
|  |    • Transmission channels (crude_oil_spike, fii_risk_off, etc.)   |   |
|  |                                                                       |   |
|  |  Historian: Finds historical analogues via ChromaDB vector search     |   |
|  |    • Past similar events -> outcome patterns -> base rates          |   |
|  |    • Returns: historicalOutcomeRate, analogueConfidence             |   |
|  |                                                                       |   |
|  |  Forecaster: Builds probabilistic scenario tree (3 scenarios)       |   |
|  |    • Each scenario: probability, timeframeDays, transmissionChannel |   |
|  |    • Falsification conditions: what would prove this wrong?         |   |
|  |    • Injects self-calibration warning if rolling Brier > 0.22      |   |
|  |                                                                       |   |
|  |  Devil: Stress-tests the forecast, produces final scenarios           |   |
|  |    • Identifies blind spots, counter-narratives, edge cases          |   |
|  |    • Returns devilConfidence, keyBlindSpots, hedgedVerdict            |   |
|  +--------------------------------------------------------------------+   |
|                              |                                             |
|                              v                                             |
|  +--------------------------------------------------------------------+   |
|  |                    OUTPUT: prediction_v2 row                          |   |
|  |  • analystReport, historianPrecedents, forecasterTree, devilCritique|   |
|  |  • finalScenarios, flags, resolveAfter, dominantChannel              |   |
|  |  • Also writes TRANSMITS_TO relationship to Neo4j                   |   |
|  +--------------------------------------------------------------------+   |
+----------------------------------------------------------------------------+
```

**Concurrency Control:**
- Max 3 stories processed in parallel (`MAX_CONCURRENT = 3`)
- 5-hour throttle per story (skip if prediction exists within 5h)
- Gracefully degrades if Neo4j or ChromaDB unavailable

**Key Files:**
- `@/artifacts/api-server/src/services/reasoning/scheduler.ts`
- `@/artifacts/api-server/src/services/reasoning/pipeline.ts`

---

### Phase 4: Market Regime Detection & Prediction

**What it does:** Detects market regime via HMM, then runs per-asset ensemble inference to generate intraday directional predictions.

**Entry Point:** `startMarketScheduler()` — `index.ts:60`

**Smart Cadence by IST Window:**

| IST Time Window | Cadence | Action |
|----------------|---------|--------|
| Pre-market 08:45-09:15 | 15 min | HMM + ensemble + snapshot |
| Open 09:15-15:30 | 5 min | HMM + ensemble + snapshot refresh |
| Post-close 15:30-16:30 | 15 min | HMM only (no snapshots) |
| Off-hours 16:30-08:45 | 60 min | HMM only (no snapshots) |
| Weekend | 60 min | HMM only (no snapshots) |

**Additional:** 30-second Tier 3 refresh during market hours

**HMM Regime Detection Loop:**

```
+----------------------------------------------------------------------------+
|  HMM REGIME DETECTION (runs every cycle)                                     |
|                                                                             |
|  1. Fetch 30 days of regime features from NSE Direct / Yahoo Finance:       |
|     • VIX level & 5d change                                                |
|     • Put-Call Ratio (PCR) intraday                                       |
|     • NIFTY realized volatility 10d                                       |
|     • INR/USD 5d change                                                   |
|                                                                             |
|  2. Run Forward Algorithm on 3-state HMM:                                 |
|     States: RISK_ON, RISK_OFF, CRISIS                                     |
|     Transition matrix + emission modeled from historical data             |
|                                                                             |
|  3. Output: regime (max probability), confidence, sequenceSummary          |
|                                                                             |
|  4. Store to market_regimes table with full feature JSON                  |
|                                                                             |
|  5. Drift Alert: if avgLogLikelihood < threshold -> warn recalibrate       |
+----------------------------------------------------------------------------+
```

**Per-Asset Ensemble Inference Loop:**

```
+----------------------------------------------------------------------------+
|  ENSEMBLE INFERENCE PER ASSET                                               |
|  (NIFTY, SENSEX, Reliance, TCS, HDFC, Gold, Silver)                        |
|                                                                             |
|  Input: Latest HMM regime state + Yahoo Finance OHLCV (7-day)              |
|                                                                             |
|  +--------------------------------------------------------------------+    |
|  |  3-Window Ensemble (6h, 24h, 72h contexts)                          |    |
|  |                                                                     |    |
|  |  Each window gets:                                                  |    |
|  |    • Recent news headlines (last N hours)                          |    |
|  |    • HMM regime probabilities                                       |    |
|  |    • Tier 3 signals (PCR, FII, Max Pain, VIX, ADR)                 |    |
|  |    • Active geopolitical channels with decay                        |    |
|  |    • Candle trust score (pattern validation)                      |    |
|  |    • Session priors (FII/DII net flow, delivery %, OI) — frozen EOD|    |
|  |                                                                     |    |
|  |  GPT-4o per window -> direction vote + confidence                   |    |
|  +--------------------------------------------------------------------+    |
|                              |                                              |
|                              v                                              |
|  +--------------------------------------------------------------------+    |
|  |  Confidence-Weighted Vote Aggregator                                 |    |
|  |    • Weight votes by confidence, apply regime bias                   |    |
|  |    • Geopolitical signal tiebreak from active channels             |    |
|  |    • FlipGuard: direction requires 2 consecutive same votes        |    |
|  |    • Output: final direction, magnitude, confidence, priceScore      |    |
|  +--------------------------------------------------------------------+    |
|                              |                                              |
|                              v                                              |
|  +--------------------------------------------------------------------+    |
|  |  Snapshot Persistence (market_snapshots table)                       |    |
|  |    • On new day: INSERT new row                                      |    |
|  |    • On direction change: UPDATE with flipReason                     |    |
|  |    • 30s refresh: UPDATE tier3 + live price without ensemble rerun   |    |
|  +--------------------------------------------------------------------+    |
+----------------------------------------------------------------------------+
```

**FlipGuard Logic:**
- Direction change requires 2 consecutive ensemble cycles with same new direction
- Prevents whipsaw from single-cycle noise
- Flip guards reset at each new trading session (pre-market)
- Stored in `flip_guards` table + in-memory cache

**Session Priors:**
- Loaded once at first market open cycle of the day
- Frozen all day: FII net flow, DII net flow, delivery %, FII participant OI
- Prevents live 5-min cycle from re-fetching stale EOD data

**Key Files:**
- `@/artifacts/api-server/src/services/market/scheduler.ts`
- `@/artifacts/api-server/src/services/market/market-agent.ts`
- `@/artifacts/api-server/src/services/market/ensemble.ts`

---

### Phase 5: Prediction Resolution & Track Record

**What it does:** Automatically resolves expired predictions against real-world outcomes and computes Brier scores.

**Entry Point:** `startResolutionScheduler()` — `index.ts:69`, runs every 6h.

**Resolution Architecture:**

```
+----------------------------------------------------------------------------+
|                     PHASE 5: PREDICTION RESOLUTION                           |
|                                                                             |
|  +--------------------------------------------------------------------+    |
|  |  MULTI-SIGNAL RESOLUTION WATCHER (every 6h)                          |    |
|  |                                                                      |    |
|  |  For each expired prediction_v2 row:                                 |    |
|  |    1. OFAC XML watcher — sanctions additions/removals                |    |
|  |    2. ACLED API — per-country conflict events                        |    |
|  |    3. UN News RSS — UN statements matching story actors              |    |
|  |    4. NSE price threshold — NIFTY crossing +/-2% triggers resolution |    |
|  |    5. 60-day auto-mark — unresolved -> outcome_unverifiable          |    |
|  |    6. GPT-4o fallback — for stories without a specific watcher match |    |
|  |                                                                      |    |
|  |  UNCERTAIN retrospective scoring:                                     |    |
|  |    If uncertaintyFlag=true and |actual_pct_change| > 1% -> CORRECT  |    |
|  +--------------------------------------------------------------------+    |
|                              |                                              |
|                              v                                              |
|  +--------------------------------------------------------------------+    |
|  |  BRIER SCORE COMPUTATION                                              |    |
|  |    • Per-record Brier score                                          |    |
|  |    • Per-story-type Brier (rolling 10-prediction window)               |    |
|  |    • Per-CAMEO-action Brier                                          |    |
|  |    • Per-transmission-channel Brier                                  |    |
|  |                                                                      |    |
|  |  Forensics Agent runs post-resolution:                              |    |
|  |    • Why was the prediction wrong?                                    |    |
|  |    • What signals were missed?                                       |    |
|  |    • Lessons learned -> feedback for future Historian agent          |    |
|  +--------------------------------------------------------------------+    |
+----------------------------------------------------------------------------+
```

**Key Files:**
- `@/artifacts/api-server/src/services/resolution/scheduler.ts`
- `@/artifacts/api-server/src/services/resolution/resolution-watcher.ts`
- `@/artifacts/api-server/src/services/resolution/brier-score.ts`

---

## 7. Database Schema

### PostgreSQL Tables (13 total)

| Table | Phase | Purpose |
|-------|-------|---------|
| `feed_registry` | 1 | RSS feed metadata, fetch intervals, quarantine state |
| `raw_articles` | 1 | Ingested article content, embeddings, dedup status |
| `extracted_events` | 1 | CAMEO-coded events with actors, targets, locations |
| `extraction_errors` | 1 | Failed GPT-4o extraction attempts |
| `stories` | 2 | Emergent geopolitical story labels and metadata |
| `prediction_v2` | 3 | 4-agent pipeline outputs: scenarios, flags, Brier scores |
| `market_regimes` | 4 | HMM regime states with 5-dim feature snapshots |
| `market_snapshots` | 4 | Per-asset directional predictions with full evidence |
| `flip_guards` | 4/5 | Direction flip confirmation state per asset |
| `prediction_snapshots` | 4 | Geopolitical prediction snapshots for track record |
| `push_subscriptions` | — | Web push subscription endpoints (VAPID) |
| `conversations` | — | Chat session metadata |
| `messages` | — | Chat message history |

### Neo4j Graph Schema

**Nodes:**
- `Story {id, label, status, createdAt}`
- `Event {id, cameoCode, cameoLabel, eventDate, actors, statedIntent, effectiveWeight, confidence, isHypothesis}`
- `Country {iso_code, name, region}`
- `Leader {name, country_iso, role}`
- `Channel {id, name, description, correlationToNifty}`
- `IndianAsset {id, name, symbol, sector}`

**Relationships:**
- `(Story)-[:CONTAINS]->(Event)`
- `(Event)-[:ACTED_ON]->(Country|Leader)`
- `(Event)-[:CONTRADICTS {cameoCodeA, cameoCodeB}]->(Event)`
- `(Story)-[:TRANSMITS_TO {triggerDate, rawWeight}]->(Channel)`
- `(Channel)-[:AFFECTS]->(IndianAsset)`

---

## 8. Scheduler Registry & Timing Matrix

All 10 schedulers registered in `index.ts` at server startup:

| # | Scheduler | Entry Point | First Run | Interval | Phase |
|---|-----------|-------------|-----------|----------|-------|
| 1 | Ingestion | `startIngestionScheduler()` | Immediate | Per-feed (default 15m) | 1 |
| 2 | Graph | `startGraphScheduler()` | Immediate | 15m (events), 6h (stories), 30m (contradictions), 1w (drift) | 2 |
| 3 | Reasoning | `startReasoningScheduler()` | 3 min | 6h | 3 |
| 4 | Market | `startMarketScheduler()` | 2 min | Smart cadence (5-60m) | 4 |
| 5 | Market Signal | `startMarketSignalScheduler()` | At 09:00 IST | 24h | 4 |
| 6 | Market Resolution | `startMarketResolutionScheduler()` | At 15:30 IST | 24h | 5 |
| 7 | Resolution | `startResolutionScheduler()` | 5 min | 6h | 5 |
| 8 | Self-Calibration | `startSelfCalibrationScheduler()` | 10 min | 24h | 3+ |
| 9 | Market Close Summary | `startMarketCloseSummaryScheduler()` | At 15:30 IST | 24h | Notifications |
| 10 | Channel Recalibration | `startChannelRecalibrationScheduler()` | — | Quarterly | 2 |

**Kill Switch:** `DISABLE_BG_SCHEDULERS=true` env var prevents all background jobs from starting. Server serves cached data from DB only.

---

## 9. External Integrations

| Service | Purpose | Endpoint / Key |
|---------|---------|---------------|
| **OpenAI GPT-4o** | Event extraction, 4-agent pipeline, forensics, resolution fallback | `OPENAI_API_KEY` env var |
| **Yahoo Finance** | OHLCV data, real-time prices for 7 Indian assets | `query1.finance.yahoo.com` |
| **NSE Direct** | VIX, PCR, FII/DII flows, delivery %, OI data | `nseindia.com` (scraped via Firecrawl) |
| **GDELT** | Global event database with CAMEO codes | `data.gdeltproject.org` |
| **NewsAPI** | Fallback news aggregation | `NEWSAPI_KEY` env var |
| **GNews** | Fallback news aggregation | `GNEWS_KEY` env var |
| **The Guardian** | Fallback news aggregation | `GUARDIAN_KEY` env var |
| **RSS Feeds** | 50+ curated geopolitical feeds | Per-feed URLs in `feed-registry-seed.ts` |
| **OFAC SDN** | Sanctions list for resolution watcher | `treasury.gov/ofac/downloads/sdn.xml` |
| **ACLED** | Conflict event data for resolution | `ACLED_API_KEY` + `ACLED_EMAIL` env vars |
| **UN News RSS** | UN statements for resolution | `news.un.org/feed` |
| **Neo4j** | Knowledge graph | `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD` |
| **ChromaDB** | Historical analogue vector search | `CHROMADB_URL` |
| **PostgreSQL** | Primary relational database | `DATABASE_URL` |

---

## 10. Error Handling & Graceful Degradation

| Failure Mode | Behavior |
|-------------|----------|
| Neo4j unavailable | Graph scheduler skips. Reasoning pipeline skips (ChromaDB also required). API still serves cached data. |
| ChromaDB unavailable | Reasoning pipeline skips. API still serves cached predictions. |
| OpenAI rate limit | Per-agent retry with exponential backoff. Event extraction pauses and resumes. |
| OpenAI key invalid | `DISABLE_BG_SCHEDULERS=true` kill switch. Server runs with cached data. |
| Yahoo Finance down | Price fetch uses fallback. Market snapshots still generated with stale price data. |
| NSE Direct down | Tier 3 signals marked as stale (`fiiIsStale=true`). Ensemble continues with reduced confidence. |
| Feed failure x3 | Feed quarantined with exponential backoff. No further fetches until backoff expires. |
| RSS parse error | Per-article error isolation. Entire feed does not fail. |

---

## 11. Deployment Architecture

```
+----------------------------------------------------------------------------+
|                              PRODUCTION (EC2)                                |
|                                                                             |
|  +------------------+    +------------------+    +------------------+       |
|  |  Caddy Reverse   |    |  API Server      |    |  PostgreSQL      |       |
|  |  Proxy (HTTPS)   |--->|  (Node.js 24)    |    |  (Docker)        |       |
|  |  :443            |    |  :3000           |    |                  |       |
|  +------------------+    +------------------+    +------------------+       |
|         |                                                                             |
|         |                +------------------+    +------------------+       |
|         |                |  Neo4j           |    |  ChromaDB        |       |
|         |                |  (Graph DB)      |    |  (Vector DB)     |       |
|         |                +------------------+    +------------------+       |
|         |                                                                             |
|  +------------------+                                                              |
|  |  All-in-One      |    Single container: API + Frontend + Nginx               |
|  |  Docker Image    |    Used for simple deployments                              |
|  +------------------+                                                              |
|                                                                             |
|  Environment: AWS EC2 (t3.xlarge or larger)                                 |
|  OS: Ubuntu 22.04 LTS                                                       |
|  SSH Key: ~/.ssh/gnm-v2-key.pem                                             |
|                                                                             |
+----------------------------------------------------------------------------+
```

### Docker Compose Services (Production)

| Service | Image | Ports | Description |
|---------|-------|-------|-------------|
| `api` | Built from `Dockerfile.allinone` | 3000 | API server + built frontend |
| `postgres` | `postgres:16-alpine` | 5432 | Primary database |
| `neo4j` | `neo4j:5-community` | 7474, 7687 | Knowledge graph |
| `chromadb` | `chromadb/chroma:latest` | 8000 | Vector search |

### Key Environment Variables

```bash
# Required
PORT=3000
DATABASE_URL=postgresql://user:pass@postgres:5432/gnm
OPENAI_API_KEY=sk-...

# Optional (degrades gracefully if missing)
NEO4J_URI=bolt://neo4j:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=...
CHROMADB_URL=http://chromadb:8000
NEWSAPI_KEY=...
GNEWS_KEY=...
GUARDIAN_KEY=...
ACLED_API_KEY=...
ACLED_EMAIL=...
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...

# Kill switches
DISABLE_BG_SCHEDULERS=true   # Emergency: stop all background jobs
```

---

*Document generated from full codebase analysis.*
*All file paths are relative to workspace root.*


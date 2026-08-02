# Aumorphic Future Maker (AMF) — Complete Product Blueprint

> **Product:** AI-native geopolitical intelligence + Indian market prediction + automated trading platform.
> **Tagline:** From news to trades — a closed-loop system that ingests global events, reasons about market impact, predicts direction, executes trades, and learns from outcomes.
> **Document version:** 2.0 — July 23, 2026
> **Deployment:** EC2 (ap-south-1), IP 13.53.173.142, Docker Compose stack

---

## Table of Contents

1. [Product Vision](#1-product-vision)
2. [System Architecture](#2-system-architecture)
3. [Process Flow — End to End](#3-process-flow--end-to-end)
4. [Phase 1: News Ingestion Pipeline](#4-phase-1--news-ingestion-pipeline)
5. [Phase 2: Knowledge Graph](#5-phase-2--knowledge-graph)
6. [Phase 3: Multi-Agent Reasoning](#6-phase-3--multi-agent-reasoning)
7. [Phase 4: Market Direction Engine](#7-phase-4--market-direction-engine)
8. [Phase 4b: Tick Evaluator (Edge-Triggered)](#8-phase-4b--tick-evaluator-edge-triggered)
9. [Phase 4c: Signal Executor](#9-phase-4c--signal-executor)
10. [Phase 4d: Position Monitor](#10-phase-4d--position-monitor)
11. [Paper Trading Engine](#11-paper-trading-engine)
12. [Iron Condor Paper Engine](#12-iron-condor-paper-engine)
13. [AMF Stock Universe & Swing Engine](#13-amf-stock-universe--swing-engine)
14. [Phase 5: Resolution & Feedback Loop](#14-phase-5--resolution--feedback-loop)
15. [Database Schema](#15-database-schema)
16. [API Routes](#16-api-routes)
17. [Frontend](#17-frontend)
18. [System Prompts (Complete)](#18-system-prompts-complete)
19. [Decision-Making Logic (Complete)](#19-decision-making-logic-complete)
20. [Deployment Architecture](#20-deployment-architecture)
21. [External Integrations](#21-external-integrations)
22. [Timing Reference](#22-timing-reference)
23. [Error Handling & Graceful Degradation](#23-error-handling--graceful-degradation)
24. [Recent Fixes & Trading Logic Updates](#24-recent-fixes--trading-logic-updates)
25. [Key Decision Points Summary](#25-key-decision-points-summary)

---

## 1. Product Vision

### What it does
AMF is a **closed-loop autonomous trading intelligence system** that:

1. **Ingests** 50+ geopolitical news feeds (RSS + GDELT) every 15 minutes.
2. **Extracts** CAMEO-coded events from articles using GPT-4o-mini.
3. **Builds** a Neo4j knowledge graph of events, countries, leaders, and contradictions.
4. **Clusters** events into emergent "stories" via Louvain community detection.
5. **Reasons** about each story using a 4-agent GPT-4o pipeline (Analyst → Historian → Forecaster → Devil's Advocate).
6. **Predicts** Indian market direction using a 3-window ensemble (6h/24h/72h) of GPT-4o calls, fused with HMM regime detection and intraday microstructure signals.
7. **Executes** trades via Zerodha Kite API — edge-triggered on signal transitions, with fill-confirmed entries and tick-driven trailing stops.
8. **Resolves** predictions using OFAC/ACLED/UN/NSE watchers, computes Brier scores, and feeds lessons back into the next forecast.

### Tracked assets

| Asset ID | Symbol | Exchange | Yahoo | Type |
|----------|--------|----------|-------|------|
| nifty50 | NIFTY 50 | NSE | ^NSEI | Index (F&O) |
| sensex | SENSEX | BSE | ^BSESN | Index (spot) |
| reliance | RELIANCE | NSE | RELIANCE.NS | Equity (spot) |
| tcs | TCS | NSE | TCS.NS | Equity (spot) |
| hdfc-bank | HDFCBANK | NSE | HDFCBANK.NS | Equity (spot) |
| gold | GOLD | — | GC=F | Commodity |
| silver | SILVER | — | SI=F | Commodity |

### AMF stock universe (25 stocks for swing engine)

| Sector | Stocks |
|--------|--------|
| Energy | RELIANCE, ONGC, NTPC, POWERGRID |
| IT | TCS, INFY, WIPRO, HCLTECH, TECHM |
| Banking | HDFCBANK, ICICIBANK, SBIN, AXISBANK, KOTAKBANK |
| Auto | MARUTI, TATAMOTORS, M&M |
| FMCG | HINDUNILVR, ITC, NESTLEIND |
| Pharma | SUNPHARMA, DRREDDY, CIPLA |
| Metals | TATASTEEL, HINDALCO, JSWSTEEL |
| Infra | LT, ULTRACEMCO |
| Telecom | BHARTIARTL |

Each stock has `newsDrivers` keywords for filtering relevant news (e.g., RELIANCE matches "reliance", "ril", "ambani", "jio", "crude oil", "brent", etc.).

---

## 2. System Architecture

### 2.1 Two-Thread Model

```
┌──────────────────────────── MAIN THREAD ────────────────────────────┐
│  Express API server (PORT env, default 3000)                        │
│  WebSocket server (real-time UI updates)                            │
│                                                                     │
│  Latency-critical schedulers (always run here):                     │
│   • startMarketScheduler()           — HMM + ensemble every 5/15/60m│
│   • startMarketTicker()              — KiteTicker WebSocket feed    │
│   • startMarketSignalScheduler()     — Daily 09:00 IST signal snap  │
│   • startMarketResolutionScheduler() — Daily 15:30 IST resolution   │
│   • startTickEvaluator()             — Edge-triggered signal dispatch│
│   • startPositionMonitor()           — Trailing stop / exit control │
│   • startEntryTracker()              — Fill-confirmed entry gating  │
│   • startTokenRefreshScheduler()     — Kite OAuth token refresh     │
│   • startWsBroadcaster()             — Broadcast executions to UI   │
│   • startPaperTradeEngine()          — Virtual option-buying engine │
│   • startCondorPaperEngine()         — Iron Condor option-selling   │
│   • startEventLoopMonitor()          — Probe main-loop latency      │
└_____________________________________________________________________┘
        │ if BG_IN_WORKER=true (default)
        ▼
┌──────────────────────── WORKER THREAD (worker.ts) ──────────────────┐
│  CPU-bound phases (off-loaded from event loop):                     │
│   • startIngestionScheduler()        — Phase 1: RSS/GDELT ingestion │
│   • startGraphScheduler()            — Phase 2: Neo4j graph build   │
│   • startReasoningScheduler()        — Phase 3: 4-agent reasoning   │
│   • startResolutionScheduler()       — Phase 5: Prediction resolution│
│   • startSelfCalibrationScheduler()  — Daily Brier recalibration    │
│   • startMarketCloseSummaryScheduler()— Daily 15:30 IST push notif  │
│   • startChannelRecalibrationScheduler()— Quarterly Pearson recalib │
│  Health report posted to main thread every 60s.                     │
│  Crash → respawn with exponential backoff (1s → 30s max).           │
└_____________________________________________________________________┘
```

### 2.2 Kill Switches

| Env Var | Effect |
|---------|--------|
| `DISABLE_BG_SCHEDULERS=true` | No background phases start. HTTP API + trading engine only. |
| `BG_IN_WORKER=false` | Phases 1–3, 5 run on main thread (rollback mode). |

### 2.3 Worker Manager (`lib/worker-manager.ts`)

- Worker crash does NOT take down the API → respawn with exponential backoff.
- `SIGTERM` → signal worker to drain, then terminate (10s timeout).
- Worker shares nothing in memory with the trading engine — messages are lifecycle-only:
  - `main → worker`: `{type:"start"}`, `{type:"shutdown"}`
  - `worker → main`: `{type:"ready"}`, `{type:"health"}`, `{type:"log"}`

---

## 3. Process Flow — End to End

```
RSS/GDELT feeds (50+ sources, every 15 min)
     │
     ▼
[Phase 1] Ingestion ─────► raw_articles (Postgres) + embedding (ChromaDB)
     │   • semantic dedup (cosine ≥ 0.88 = duplicate, ≥ 0.70 = corroboration)
     │   • GPT-4o-mini CAMEO event extraction
     ▼
[Phase 2] Graph Build ───► Neo4j: Event─[:ACTED_ON]→Country/Leader
     │   • Louvain community detection → Story nodes
     │   • Contradiction detection, narrative drift (cosine centroid, 4-week)
     ▼
[Phase 3] Reasoning Pipeline (per story, GPT-4o, every 6h)
     │   Analyst → Historian → Forecaster → Devil's Advocate
     │   • feedback lessons injected from past resolutions
     │   • calibration penalty if rolling Brier > 0.22
     ▼
prediction_v2 (Postgres) + TRANSMITS_TO edge in Neo4j
     │
     ▼
[Phase 4] Market Agent (every 5 min during market hours)
     │   • HMM regime (RISK_ON / RISK_OFF / CRISIS)
     │   • 3-window ensemble (6h / 24h / 72h) → confidence-weighted vote
     │   • Tier-3 intraday microstructure (D/P/regime)
     │   • Candle trust, channel decay, FlipGuard
     ▼
market_snapshots (Postgres) + hot-context in-memory cache
     │
     ▼
[Phase 4b] Tick Evaluator (KiteTicker, every 1s)
     │   • edge-triggered: fires only on signal transition
     │   • dispatches trades to eligible users
     ▼
[Phase 4c] Signal Executor (Kite API)
     │   • builds option strikes, fetches quotes, places orders
     │   • hysteresis bands on maxPain / PCR / conflict
     │   • spot momentum tiebreaker when PCR conflicts with AI
     │   • entry persisted PENDING_ENTRY → OPEN only on confirmed fill
     ▼
[Phase 4d] Position Monitor (every tick + 30s heartbeat)
     │   • ratchet trailing stop, exchange-side SL (stop-loss limit)
     │   • time stop (far OTM), escalateExit (no cancel-then-exit race)
     ▼
signal_executions (Postgres) + Kite orders
     │
     ▼
[Phase 5] Resolution Watcher (every 6h)
     │   • OFAC / ACLED / UN News / NSE ±2% / GPT-4o fallback
     │   • Brier score, forensics post-mortem
     ▼
[Feedback] Self-Calibration (daily)
     • rolling 10-prediction Brier per story type
     • penalty flag → Forecaster system prompt on next run
     • better calibrated probabilities → re-resolved → Brier → …
```

---

## 4. Phase 1 — News Ingestion Pipeline

**Files:** `services/ingestion/scheduler.ts`, `rss-fetcher.ts`, `gdelt-fetcher.ts`, `event-extractor.ts`, `semantic-dedup.ts`, `feed-registry-seed.ts`

### 4.1 Sources

- **RSS feeds** seeded in `feed-registry-seed.ts` — 50+ feeds tiered by credibility 1–5.
  - Tier 1: Reuters, AFP, BBC, Guardian, NYT, WSJ
  - Tier 2: Economic Times, Mint, Hindu, Times of India
  - Tier 3: Global Times, Xinhua, RT (state media — `requires_corroboration` forced true)
  - Tier 4: GDELT, NewsAPI, GNews (aggregators)
- **GDELT** events (pre-coded CAMEO, bypasses GPT-4o extraction).

### 4.2 Article Processing Pipeline

```
1. Fetch RSS feed (with exponential backoff on failure)
2. For each article:
   a. URL dedup check (skip if already in raw_articles)
   b. Semantic dedup (cosine similarity against last 6h of articles)
      • cosine ≥ 0.88 → mark duplicate, keep higher-quality source
      • cosine ≥ 0.70 → link as corroboration, increment corroboration_count
   c. GPT-4o-mini CAMEO event extraction
      • Output: actors, action_type, target, location, event_date,
        stated_intent, requires_corroboration, confidence (0-1)
      • State media + tier ≥ 3 → requires_corroboration forced true
   d. Persist to raw_articles + extracted_events
```

### 4.3 CAMEO Codes Used

`SANCTION, MOBILIZE_MILITARY, NEGOTIATE, CONDEMN, THREATEN, PROVIDE_AID, SIGN_TREATY, IMPOSE_EMBARGO, EXPEL_DIPLOMAT, CEASEFIRE, PROTEST, ELECTION, POLICY_CHANGE, ECONOMIC_ACTION`

### 4.4 Feed Quarantine

3 consecutive failures → feed quarantined with exponential backoff. No further fetches until backoff expires.

### 4.5 Semantic Dedup Math

```
cos(a,b) = (a·b) / (‖a‖·‖b‖)

DUPLICATE_THRESHOLD = 0.88    → mark duplicate
CORROBORATION_THRESHOLD = 0.70 → link as corroboration
DEDUP_WINDOW_HOURS = 6
```

Embedding model: OpenAI `text-embedding` (1536 or 1024 dims). Dimension mismatch returns -1 sentinel and pair is skipped.

---

## 5. Phase 2 — Knowledge Graph

**Files:** `services/graph/event-graph-builder.ts`, `louvain.ts`, `story-emergence.ts`, `contradiction-detector.ts`, `narrative-drift.ts`, `channel-recalibration.ts`, `neo4j-client.ts`

### 5.1 Neo4j Graph Schema

```
Nodes:
  (:Story {id, label, status, createdAt})
  (:Event {id, cameoCode, cameoLabel, eventDate, actors, statedIntent, effectiveWeight, confidence, isHypothesis})
  (:Country {iso_code, name, region})
  (:Leader {name, country_iso, role})
  (:TransmissionChannel {id, name, description, correlationToNifty})
  (:IndianAsset {id, name, symbol, sector})

Relationships:
  (:Story)-[:CONTAINS]->(:Event)
  (:Event)-[:ACTED_ON]->(:Country|:Leader)
  (:Event)-[:CONTRADICTS {cameoCodeA, cameoCodeB}]->(:Event)
  (:Story)-[:TRANSMITS_TO {triggerDate, rawWeight}]->(:TransmissionChannel)
  (:TransmissionChannel)-[:AFFECTS]->(:IndianAsset)
```

### 5.2 Story Emergence (`story-emergence.ts`)

1. Fetch `Event` nodes from last `LOOKBACK_DAYS = 21` (excluding hypotheses).
2. Build weighted graph: events connected by shared country; edge weight = `(effectiveWeight_a + effectiveWeight_b)/2 * sharedCountryCount`.
3. Run **Louvain** community detection.
4. Filter: `MIN_COMMUNITY_EVENTS = 4`, `MIN_COMMUNITY_COUNTRIES = 1`, capped at `MAX_ACTIVE_STORIES = 25`.
5. Match to existing Story via **Jaccard similarity** of country sets:
   - `STORY_CONTINUITY_OVERLAP_THRESHOLD = 0.60` → update existing
   - Below threshold → create new story
6. New stories labelled by GPT-4o (`temperature=0.2`, `max_tokens=30`, "8 words or fewer").
7. Stories not seen this cycle → `status='dormant'`.

### 5.3 Contradiction Detection (`contradiction-detector.ts`)

Runs every 30 minutes. Detects events within the same story that have opposing CAMEO codes (e.g., `THREATEN` vs `NEGOTIATE`). Creates `CONTRADICTS` edges.

### 5.4 Narrative Drift (`narrative-drift.ts`) — Weekly

- Embeds up to 30 articles per story, computes weekly **centroid** (mean vector).
- Compares to centroid from `LOOKBACK_WEEKS = 4` weeks ago.
- `cosineDistance = 1 - cosineSimilarity(currentCentroid, oldCentroid)`.
- `DRIFT_THRESHOLD = 0.25` → GPT-4o writes a one-sentence `drift_description`.

### 5.5 Channel Recalibration (`channel-recalibration.ts`) — Quarterly

- Recomputes **Pearson correlation** between channel activation and a Brier-derived price-change proxy over last 90 days.
- Proxy: `priceChangePct = (1 - brierScore) * 2 - 1`
- Correlation clamped to `[0.10, 0.95]`.
- Uses chained `setTimeout` chunks of `MAX_TIMEOUT_MS = 24 days` (Node's setTimeout overflows INT32_MAX for 90-day intervals).

---

## 6. Phase 3 — Multi-Agent Reasoning

**Files:** `services/reasoning/pipeline.ts`, `agent-analyst.ts`, `agent-historian.ts`, `agent-forecaster.ts`, `agent-devil.ts`, `self-calibration.ts`

LangGraph-style 4-agent chain per story. Runs every 6 hours. Skips if a prediction exists younger than **5 hours**.

### 6.1 Pipeline Stages

| Stage | Agent | Model | Role |
|-------|-------|-------|------|
| 0 | Feedback loader | — | Pulls lessons from `forensics.ts` for this story |
| 1 | Subgraph fetch | — | Cypher: events + countries + contradictions (last 72h) |
| 2 | **Analyst** | GPT-4o | Situation report + Indian market exposure channels |
| 3 | **Historian** | GPT-4o | Historical analogues (anchored on feedback lessons) |
| 4 | **Forecaster** | GPT-4o | Scenario tree with probabilities + falsification conditions |
| 5 | **Devil's Advocate** | GPT-4o | Critique + adjusted `finalScenarios` |
| 6 | Write | — | `prediction_v2` row + `TRANSMITS_TO` Neo4j edge |

### 6.2 Flags Written to `prediction_v2.flags`

- `no_historical_analogue` — historian found no analogue.
- `calibration_penalty_active` — rolling Brier > 0.22 for this story type.
- `active_contradiction` — subgraph has real `CONTRADICTS` edges.
- `narrative_drifting` — `analogueConfidence < 0.45` and not `noHistoricalAnalogue`.

### 6.3 Self-Calibration (`self-calibration.ts`) — Daily

- Computes **rolling 10-prediction Brier** per story type (dominant channel as proxy).
- `BRIER_PENALTY_THRESHOLD = 0.22`, `ROLLING_WINDOW = 10`.
- If exceeded → `confidence_penalty = 0.20` injected into the Forecaster's next system prompt.
- Also computes **4-level Brier breakdown**: per-record, per-story-type, per-CAMEO-action, per-transmission-channel (last 500 resolved records).

### 6.4 Brier Score Formula

```
BS = (1/N) · Σᵢ (fᵢ − oᵢ)²

fᵢ = forecast probability for scenario i
oᵢ = 1 if materialised, 0 otherwise

Calibration labels:
  ≤0.10  Excellent
  ≤0.20  Good
  ≤0.33  Acceptable
  ≤0.50  Poor
  >0.50  Very poor
```

**Example:** 3 scenarios with probabilities `[0.6, 0.3, 0.1]`, scenario 1 materialised:
```
BS = ((0.6−0)² + (0.3−1)² + (0.1−0)²) / 3
   = (0.36 + 0.49 + 0.01) / 3 = 0.2867
```

---

## 7. Phase 4 — Market Direction Engine

**Files:** `services/market/scheduler.ts`, `hmm-regime.ts`, `ensemble.ts`, `market-agent.ts`, `candle-trust.ts`, `tier3-signal.ts`, `tier3-fetcher.ts`, `hot-context.ts`

### 7.1 Scheduler Cadence (IST-aware)

| Window | IST Time | Cadence |
|--------|----------|---------|
| Pre-market | 08:45–09:15 | 15 min |
| Open | 09:15–15:30 | **5 min** |
| Post-close | 15:30–16:30 | 15 min |
| Off-hours | else | 60 min |

Weekends → always `closed`. `FIRST_RUN_DELAY_MS = 2 min` after startup.

IST computed as: `istMin = (utcH*60 + utcM + 330) % 1440`

### 7.2 HMM Regime Detection (`hmm-regime.ts`)

3-state Gaussian Hidden Markov Model: **RISK_ON / RISK_OFF / CRISIS**.

**5-dim feature vector:** `[vixLevel, vixChange5d, pcrIntraday, niftyRealVol10d, inrUsdChange5d]`

(PCR replaced the old `fiiNetFlow5d` because FII cash flow is EOD-only and froze the HMM intraday.)

**Calibrated parameters (NSE 2010–2024):**

```
MU (means):
  RISK_ON:  [13.5, -0.5, 0.85, 11.0, -0.05]   // low VIX, falling, complacent calls, low vol, stable INR
  RISK_OFF: [19.0,  1.5, 1.15, 18.0,  0.25]   // elevated VIX, rising, protective puts, higher vol, INR weak
  CRISIS:   [28.0,  5.0, 1.45, 30.0,  1.20]   // high VIX, spike, panic puts, very high vol, INR crash

SIGMA (std devs):
  RISK_ON:  [3.0, 1.0, 0.15, 3.5, 0.20]
  RISK_OFF: [4.0, 1.5, 0.20, 5.0, 0.35]
  CRISIS:   [6.0, 3.0, 0.30, 8.0, 0.80]

A (transition matrix):
  RISK_ON →  [0.88, 0.10, 0.02]
  RISK_OFF → [0.08, 0.84, 0.08]
  CRISIS →   [0.03, 0.15, 0.82]

PI (initial): [0.55, 0.30, 0.15]
```

- **Viterbi** decodes most-likely state sequence.
- **Forward algorithm** gives `P(state | all observations)`.
- Needs ≥ 5 observations; otherwise defaults to `RISK_OFF` with uniform probs.
- **Drift detection:** trailing 5-observation avg log-likelihood; if `< DRIFT_THRESHOLD = -12.0` → `driftAlert: true`.

**Emission log-prob (diagonal Gaussian):**
```
logP(obs|state k) = Σ_d [ -0.5·log(2π) - log(σ) - 0.5·((obs-μ)/σ)² ]
```

### 7.3 3-Window Ensemble (`ensemble.ts`)

Three parallel GPT-4o calls (`temperature=0.2`, `max_tokens=300`, JSON mode) with distinct system prompts and context windows:

| Window | Weight | Focus |
|--------|--------|-------|
| 6h  | 0.35 | Intraday microstructure, candle quality, options flow, breadth |
| 24h | 0.40 | Institutional conviction: FII/DII, delivery %, OI change |
| 72h | 0.25 | Macro structural: crude, INR, bond yields, VIX trend, geopol scenarios |

**Confidence-weighted vote:**
```
weightedScore = Σ (directionSign(call) · windowWeight · confidence)
normalizedScore = weightedScore / Σ(windowWeight · confidence)

directionSign: BULLISH=+1, BEARISH=-1, NEUTRAL=0
```

**Decision thresholds:**
- `normalizedScore > 0.20` → `BULLISH`
- `normalizedScore < -0.20` → `BEARISH`
- Else: if ≥ 2 high-confidence (>0.5) votes disagree → `UNCERTAIN`
- Else: if a live geopolitical signal (`decayedWeight > 0.2`, non-neutral) exists → use it
- Else → `NEUTRAL`

**CRISIS override:** if `regime === CRISIS` and `crisisProbability > 0.6` → `UNCERTAIN` regardless of votes.

**Geopolitical tiebreak:** if `dominantChannel === "fii_risk_off"` and `decayedWeight > 0.3`, add `±0.15` to `normalizedScore`.

### 7.4 Candle Trust (`candle-trust.ts`)

Hardcoded rules applied to the latest OHLCV candle:

| Flag | Condition | Trust Penalty |
|------|-----------|---------------|
| `volume_anomaly` | `volume > 3 × rollingAvgVolume20d` | `-= 0.5` |
| `low_delivery_high_move` | `\|close-open\|/open > 0.5%` and `deliveryPct < 20` | `-= 0.3` |
| `wash_trade_suspected` | (heuristic) | `-= 0.4` |

Trust floored at `0.1`. `tier1Score = +1 (close>open), -1 (close<open), 0 (|move|<0.05%)`.

### 7.5 Tier-3 Intraday Microstructure (`tier3-signal.ts`)

Self-contained rolling-buffer engine fed by `market-ticker.ts` at ~1s cadence. Produces a `CALL / PUT / NONE` verdict that **gates** the AI-derived option side.

**Tunables:**
```
WINDOW_MS         = 300_000    // 5-min direction window
IV_WINDOW_MS      = 150_000    // 2.5-min IV confirmation
LONG_WINDOW_MS    = 600_000    // 10-min power/scale window
BUFFER_MAX_MS     = 750_000    // ~12.5 min retention
EMA_TAU_MS        = 150_000    // time-constant for direction EMA (~150s smoothing)
READY_FRACTION    = 0.5        // buffer must span ≥50% of WINDOW_MS
DO_SCALE_FALLBACK = 0.02       // before percentile history warms up
DO_SCALE_MIN_SAMPLES = 10
THETA_D           = 0.30       // direction-strength threshold
THETA_P_LOW       = 0.30       // power-low threshold (fade regime)
THETA_P_HIGH      = 0.55       // power-high threshold (tilt_on_power)
K_FADE            = 0.5        // fade scaling
TAU               = 0.08       // output deadzone
```

**Step 1 — Direction score D:**
```
ret         = log(latestPrice / pastPrice)     // past = nearest(latest.t - WINDOW_MS)
realizedVol  = sqrt(Σ logRets²)                // over window samples
Dp          = clip(ret / realizedVol, -1, 1)

priceWeight = tanh(3 · Dp)
dCall = latest.callOI - past.callOI
dPut  = latest.putOI  - past.putOI
doRaw = ((dCall - dPut) · priceWeight) / (latest.callOI + latest.putOI)

doScale = max(percentile(|doRaw| history, 0.90), 1e-9)
Do      = clip(doRaw / doScale, -1, 1)

dInst = 0.4·Dp + 0.6·Do
α     = 1 - exp(-dtMs / EMA_TAU_MS)     // time-based EMA
D     = EMA(dInst)                       // smoothed direction
```

**Step 2 — Power score P:**
```
volNow = max(latest.volume - prev.volume, 0)
oiNow  = |(latest.callOI + latest.putOI) - (prev.callOI + prev.putOI)|
Pv   = min(volNow / meanVol, 2) / 2
Poi  = min(oiNow  / meanOi,  2) / 2
Pg   = min(latest.atmGamma / meanGamma, 2) / 2
pRaw = 0.4·Pv + 0.4·Poi + 0.2·Pg

deltaIvPct = latest.atmIV / ivThen - 1
gate = 0.45 + 0.55 · clip(deltaIvPct / 0.08, 0, 1)   // IV confirmation multiplier

tilt     = sign(dCall - dPut)
disagree = tilt ≠ 0 and sign(D) ≠ 0 and tilt ≠ sign(D)
P = pRaw · gate · (disagree ? 0.8 : 1)
```

**Step 3 — Regime switch:**
```
if |D| > THETA_D and P < THETA_P_LOW:
    signalRaw = -D · K_FADE               // fade unsupported move
    regime = "fade"
elif |D| ≤ THETA_D and P > THETA_P_HIGH:
    signalRaw = tilt · P                  // ride positioning
    regime = "tilt_on_power"
else:
    signalRaw = D · P                     // aligned
    regime = "aligned"
```

**Step 4 — Deadzone output:**
```
signal = "CALL" if signalRaw >  TAU
       = "PUT"  if signalRaw < -TAU
       = "NONE" otherwise
```

**Black-Scholes ATM gamma** (NSE feed lacks gamma):
```
d1 = (ln(S/K) + (r + 0.5·σ²)·T) / (σ·√T)     with r = 0.065
γ  = φ(d1) / (S · σ · √T)                      where φ = standard normal pdf
```

### 7.6 Tier-3 Fetcher (`tier3-fetcher.ts`)

**Session priors** (loaded once at market open, frozen all day):
- Previous-day FII/DII net flows, delivery %, FII participant OI net, SGX Nifty change %.

**Short-covering signal:**
```
covering  : pcr > 1.0 and oiChange < 0 and vix5dChange < 0   // shorts buying back → bullish
unwinding : pcr < 0.9 and oiChange > 0 and vix5dChange > 0   // fresh shorts → bearish
none      : otherwise
```

**Sector delta score:** `raw = bank·0.6 + it·0.4`, then `clamp(raw/2, -1, +1)`.

**PCR score inversion during short covering:**
- Normal: `pcrScore = clamp((1-pcr)/0.5, -1, 1)` (high PCR = bearish)
- If covering: `pcrScore = clamp((pcr-1)/0.5, -1, 1)` (high PCR = bullish)

### 7.7 Channel Decay (`market-agent.ts`)

```
daysSinceTrigger = floor((today - triggerDate) / 1 day)
decayFactor      = 0.5 ^ max(0, daysSinceTrigger - 1)    // half-life = 1 day
decayedWeight    = rawWeight · decayFactor
isActive         = decayedWeight > 0.1
```

Only channels with `decayedWeight > 0.3` are shown to the GPT-4o prompts.

**Scenario priced-in decay:**
```
alreadyTransmitted = daysSince >= 1
decayFactor = alreadyTransmitted ? max(0.1, 1.0 - daysSince·0.3) : 1.0
```

### 7.8 PriceScore + FlipGuard

**PriceScore:**
```
avgConfidence     = mean(vote.confidence)
tier1Contribution = candleTrust.tier1Score · candleTrust.trustScore · avgConfidence
priceScore        = tier3Score·0.7 + tier1Contribution·0.3
direction         = "up" if priceScore > 0.20
                   "down" if priceScore < -0.20
                   else ensemble majority fallback
```

**FlipGuard** (DB-primary, survives restarts):
- If `newDirection === confirmedDirection` → no flip, reset pending.
- From `uncertain` → any clear direction flips **immediately**.
- Otherwise requires **2 consecutive** readings in the new direction:
  - 1st new direction → `pendingDirection = new, pendingCount = 1`, no emit.
  - 2nd matching → `emitFlip = true`, confirm new direction.
  - Different direction → reset pending to that new direction, count = 1.

### 7.9 Snapshot Persistence

Each cycle, for each asset:
- If material change (direction flip, flip confirmed, `|ΔpriceScore| > 0.15`, or confidence boost) → **insert new** `market_snapshots` row.
- Else → **update** existing today's row.
- `resolveAfter` = next 15:30 IST (10:00 UTC), skipping weekends.

**Hot-context** (`hot-context.ts`) publishes slow-path inputs lock-free for the tick executor to read without a DB hop.

---

## 8. Phase 4b — Tick Evaluator (Edge-Triggered)

**File:** `services/kite/tick-evaluator.ts`

Subscribes to the `marketTicker` EventEmitter; evaluates at most once per `EVAL_THROTTLE_MS = 1000` ms.

**Trading hours guard:**
```
istMin = (utcH·60 + utcM + 330) % 1440
istDay = (now + 330min).getUTCDay()
closed on Saturday (6) / Sunday (0)
open  when 555 ≤ istMin < 930    // 09:15–15:30 IST
```

**Edge-trigger logic:**
```
optionSide = computeLiveOptionSide("nifty50").signal
if optionSide !== lastOptionSide:
    lastOptionSide = optionSide
    if optionSide in {BUY_CALL, BUY_PUT}:
        dispatchEntryForSide("nifty50", optionSide)
```

Same pattern for spot equities (`reliance`, `tcs`, `hdfc-bank`) on AI direction change.

**Reconciliation:** every `RECONCILE_INTERVAL_MS = 10_000` ms, syncs in-memory state with DB.

---

## 9. Phase 4c — Signal Executor

**File:** `services/kite/signal-executor.ts` (~1602 lines)

### 9.1 Option Trading Constants

```
NIFTY_LOT_SIZE             = 65
MIN_OPTION_PREMIUM         = 5        // ₹
MAX_OPTION_PREMIUM         = 400      // ₹
MAX_OPTION_LOTS            = 20
NIFTY_STRIKE_INTERVAL      = 50

// Standard options
OPTION_HARD_STOP_PCT       = 30
OPTION_TRAIL_GAP_PCT       = 15
OPTION_MILESTONE_STEP      = 10

// Far-OTM options (delta < 0.15)
FAR_OTM_HARD_STOP_PCT      = 15
FAR_OTM_TRAIL_GAP_PCT      = 8
FAR_OTM_MILESTONE_STEP     = 5
FAR_OTM_TIME_STOP_MS       = 15·60·1000   // 15-min time stop
FAR_OTM_DELTA_THRESHOLD    = 0.15
FAR_OTM_MIN_GAIN_PCT       = 5            // must reach +5% within time window
```

### 9.2 Hysteresis Bands

Prevents oscillation around trigger thresholds. Trigger fires the signal; release clears it at a safer opposite-side value.

```
MAX_PAIN_TRIGGER   = 1.5    MAX_PAIN_RELEASE   = 1.2     // |dist| % from max pain
PCR_LOW_TRIGGER    = 0.65   PCR_LOW_RELEASE    = 0.75    // bullish low PCR
PCR_HIGH_TRIGGER   = 1.35   PCR_HIGH_RELEASE   = 1.25    // bearish high PCR
MILD_CONFLICT_TRIGGER = 1.0 MILD_CONFLICT_RELEASE = 0.8
```

**Note on PCR hysteresis direction:** The PCR hysteresis uses a **contrarian** interpretation:
- PCR < 0.65 (very low) → `BUY_PUT` (everyone already bought calls, no more buyers)
- PCR > 1.35 (very high) → `BUY_CALL` (everyone already hedged with puts, no more sellers)

This is the **opposite** of the standard PCR interpretation and aligns with the AI prompt's contrarian extreme PCR logic.

### 9.3 Spot Momentum Tiebreaker (NEW — July 2026)

When PCR/max pain hysteresis conflicts with AI direction, spot momentum acts as tiebreaker:

```
SPOT_MOMENTUM_THRESHOLD = 0.1   // ±0.1% move from prev close

spotRising  = spotMovePct > +0.1%
spotFalling = spotMovePct < -0.1%

// Max pain says BUY_PUT but spot rising + AI says UP → override to BUY_CALL
if hysteresis.maxPainSignal == "BUY_PUT" and spotRising and aiSaysUp:
    → BUY_CALL

// Max pain says BUY_CALL but spot falling + AI says DOWN → override to BUY_PUT
if hysteresis.maxPainSignal == "BUY_CALL" and spotFalling and aiSaysDown:
    → BUY_PUT

// Same logic for PCR hysteresis signals
if hysteresis.pcrSignal == "BUY_PUT" and spotRising and aiSaysUp:
    → BUY_CALL
if hysteresis.pcrSignal == "BUY_CALL" and spotFalling and aiSaysDown:
    → BUY_PUT

// Spot flat or AI neutral → let PCR/max pain win (structural signal)
```

### 9.4 Spot Momentum Override (Stale AI Direction)

When the hot context hasn't been refreshed in >10 min and spot has reversed significantly:

```
STALE_CTX_MS = 10 * 60 * 1000     // 10 min
REVERSAL_THRESHOLD_PCT = 0.25     // spot reversed 0.25% from day's extreme

if ctxAgeMs > STALE_CTX_MS:
    if aiDirection == "down" and moveFromLowPct > 0.25%:
        aiDirection = "up"        // market turning up
    if aiDirection == "up" and moveFromHighPct < -0.25%:
        aiDirection = "down"      // market turning down
```

### 9.5 Signal Derivation Order (`deriveBaseFromInputs`)

1. **Max pain hysteresis** (with spot momentum tiebreaker)
2. **PCR hysteresis** (with spot momentum tiebreaker)
3. **Short covering** → `BUY_CALL` if covering, `BUY_PUT` if unwinding
4. **SGX divergence** → `NO_TRADE` if SGX contradicts AI direction by >0.8%
5. **Mild conflict gate** → `NO_TRADE` if `|maxPainDistance| > 1.0%`
6. **AI direction fallback** → `BUY_CALL` if up, `BUY_PUT` if down, `NO_TRADE` if neutral

### 9.6 Tier-3 Gate

The intraday microstructure verdict (`CALL/PUT/NONE`) must agree with the AI-derived side, else `NO_TRADE`. During warmup (`ready === false`), base signal passes through unchanged.

### 9.7 Additional Gates

- **Range gate:** Suppresses trades when `priceImpactEstimate` is too high (illiquid strikes).
- **Chop gate:** Suppresses trades when `getNiftySpotPersistence() < MIN_PERSISTENCE` (oscillating market, no net move).

### 9.8 Strike Candidate Building

```
atmStrike  = round(spot / NIFTY_STRIKE_INTERVAL) · NIFTY_STRIKE_INTERVAL
candidates = [atmStrike ± k·NIFTY_STRIKE_INTERVAL  for k in 0..STRIKE_RANGE]
```

Filtered by `MIN_OPTION_PREMIUM ≤ premium ≤ MAX_OPTION_PREMIUM` and capital affordability.

### 9.9 Fill-Confirmed Entry (`entry-tracker.ts`)

```
PENDING_ENTRY ──(order COMPLETE / partial fill)──▶ OPEN
      │
      └──(REJECTED / CANCELLED / no fill in 20s)──▶ FLAT
```

- Fills confirmed by: (1) Kite order postback on KiteTicker WebSocket (sub-second); (2) poll of `getOrderHistory` as backstop.
- `ENTRY_FILL_TIMEOUT_MS = 20s` (env-overridable). Partial fill at timeout → promoted to OPEN with filled quantity.
- Restart-safe: `reconcilePendingEntries()` re-adopts orphaned `pending_entry` rows.

---

## 10. Phase 4d — Position Monitor (Tick-Driven Exits)

**File:** `services/kite/position-monitor.ts`

Runs on every tick + safety heartbeat every `SAFETY_INTERVAL_MS = 30_000` ms.

### 10.1 Ratchet Trailing Stop

```
profitPct = direction=="up"
          ? (peak - entry)/entry · 100
          : (entry - peak)/entry · 100

milestoneLevel = max(0, floor(profitPct / milestoneStep) · milestoneStep)

if milestoneLevel == 0:                              // no profit yet → hard stop
    stopPrice = up   ? entry·(1 - hardStopPct/100)
                     : entry·(1 + hardStopPct/100)
else:                                                // lock in milestone
    milestonePrice = up   ? entry·(1 + milestoneLevel/100)
                          : entry·(1 - milestoneLevel/100)
    stopPrice      = up   ? milestonePrice·(1 - trailGapPct/100)
                          : milestonePrice·(1 + trailGapPct/100)
    stopPrice      = up   ? max(stopPrice, entry)    // never below entry once profitable
                          : min(stopPrice, entry)
```

**Example (BUY_CALL, entry=₹100, peak=₹125, milestoneStep=10, trailGap=15, hardStop=30):**
```
profitPct       = 25%
milestoneLevel  = 20
milestonePrice  = ₹120
stopPrice       = ₹120·(1-0.15) = ₹102   (≥ entry ✓)
```

### 10.2 Exchange-Side SL Backstop

A stop-loss **limit (SL)** order rests at the exchange and fires natively. Why SL not SL-M: NSE discontinued SL-M for options in Sept 2021.

- Limit price set `SL_LIMIT_OFFSET_PCT = 4%` below trigger (stays marketable).
- **No cancel-then-exit race:** `escalateExit` converts the resting SL into the exit in place — modifies trigger to just below LTP, so the same exchange order becomes an aggressive exit (one order, no gap, no double-sell).

### 10.3 Far-OTM Time Stop

For options with `delta < 0.15`:
- Hard stop 15%, trail gap 8%, milestone 5%.
- If not gained `≥ 5%` within `15 min` → exit.

### 10.4 Mutable Exit State

`peakPrice`, `milestoneLevel`, `stopPrice`, `slOrderId`, `slTrigger`, `slLimit`, `exitOrderId`, `timeStopDeadline` persisted to `signal_executions` (in `notes`) on each tick batch so restart resumes exactly where it left off.

---

## 11. Paper Trading Engine

**File:** `services/kite/paper-trade-engine.ts`

Virtual option-buying engine with ₹1L compounding capital. Completely independent from live trading — has its own DB table (`paper_trades`) and its own state machine.

### 11.1 Constants

```
PAPER_CAPITAL_INITIAL    = 100_000   // ₹1 lakh
NIFTY_LOT_SIZE           = 65
OPTION_HARD_STOP_PCT     = 15
OPTION_TRAIL_GAP_PCT     = 8
OPTION_MILESTONE_STEP    = 10
FAR_OTM_TIME_STOP_MS     = 15·60·1000
FAR_OTM_MIN_GAIN_PCT     = 5

// Exit strategy constants
EOD_SQUAREOFF_IST_MIN    = 915       // 3:15 PM IST
MOMENTUM_WINDOW_MS       = 5·60·1000 // 5-min rolling window
MOMENTUM_DROPPCT         = 8         // 8% drop from peak → exit
MOMENTUM_MIN_HOLD_MS     = 120_000   // 120s minimum hold (NEW)
SIGNAL_FLIP_CONFIRM_TICKS = 2        // 2 consecutive flipped ticks
SPOT_PROXIMITY_THRESHOLD  = 50       // 50pts from strike → gamma risk
SPOT_PROXIMITY_MIN_HOLD_MS = 60_000  // 60s min hold
SPOT_PROXIMITY_DEEP_ITM_THRESHOLD = 80  // must have been >80pts ITM
VIX_SPIKE_PCT            = 20        // 20% above 15-min baseline → exit
VIX_BASELINE_WINDOW_MS   = 15·60·1000
REENTRY_COOLDOWN_MS      = 15·60·1000  // 15 min cooldown (NEW)
```

### 11.2 Exit Strategy (6 Exits)

| # | Exit | Trigger | Guard |
|---|------|---------|-------|
| 1 | `eod_squareoff` | IST ≥ 15:15 | None |
| 2 | `signal_flip` | AI direction reversed | 2 consecutive flipped ticks |
| 3 | `momentum_reversal` | Premium dropped ≥8% from 5-min peak | **≥120s hold time** (NEW) |
| 4 | `spot_proximity` | Spot within 50pts of strike (from ITM) | ≥60s hold + was deep ITM (>80pts) |
| 5 | `vix_spike` | VIX ≥20% above 15-min baseline | Throttled to 30s checks |
| 6 | `trailing_stop` / `stop_loss` | LTP ≤ ratchet stop price | Adaptive trail gap |

### 11.3 Re-Entry Logic (NEW — July 2026)

After exit, `lastExitAt = Date.now()` and `lastOptionSide = "NO_TRADE"` (so next signal evaluation sees a transition). Re-entry blocked for `REENTRY_COOLDOWN_MS = 15 min`. After cooldown, if signal direction is unchanged, a new trade can be entered.

### 11.4 Adaptive Trail Gap

```
adaptiveGap(profitPct, isFarOTM):
    if isFarOTM: return 8  // fixed for far OTM
    if profitPct > 30: return 12  // wider gap for big winners
    if profitPct > 15: return 10
    return 8  // default
```

---

## 12. Iron Condor Paper Engine

**File:** `services/kite/condor-paper-engine.ts`

Option-SELLING strategy with separate ₹1L capital pool. Completely independent from the option-buying engines.

### 12.1 Strategy

```
SELL far-OTM Put + far-OTM Call    (income from theta decay)
BUY  farther-OTM Put + Call        (hedge — caps max loss, defined risk)
Tilt strikes (not width) toward AI direction when trustworthy
```

### 12.2 Constants

```
CAPITAL_INITIAL        = 100_000
LOT_SIZE               = 65
STRIKE_INTERVAL        = 50
SOLD_LEG_OFFSET        = 250     // sold strikes ~250pts OTM
HEDGE_GAP              = 150     // hedge strikes 150pts beyond sold
TILT_SHIFT             = 100     // tilt shifts one side closer by 100pts
MARGIN_CAPITAL_PCT     = 0.55    // max 55% of capital as margin
MAX_LOTS               = 3
SOLD_LEG_EXIT_MULT     = 1.5     // 1.5x premium → exit that leg
BOOK_PROFIT_FRACTION   = 0.65    // book at 65% of max profit
SLOW_BLEED_DAYS        = 5
TAX_COST_PCT           = 20
VIX_LOW_THRESHOLD      = 12      // too thin, sit out
VIX_HIGH_THRESHOLD     = 18      // fat premiums, bonus
CRISIS_PROB_ENTRY_MAX  = 0.30    // only enter when regime is calm
CRISIS_PROB_EXIT_TRIGGER = 0.55  // news-shock exit
MONTHLY_MAX_LOSS_PCT   = 5
ENTRY_WINDOW           = 10:15–11:00 IST
```

### 12.3 Exit Rules

| Rule | Trigger | Action |
|------|---------|--------|
| #9 | Sold leg hits 1.5x entry premium | Exit that leg only |
| #10 | Total PnL ≥ 65% of max profit | Close full condor (`profit_booked`) |
| #11 | Past gamma cutoff (DTE ≤ 1.5 days) | Close full condor (`gamma_cutoff`) |
| #12 | 5 consecutive days same adverse direction | Close full condor (`slow_bleed`) |
| #13 | Crisis probability ≥ 0.55 | Close full condor (`news_shock`) |
| #16 | Monthly max loss ≥ 5% | Circuit breaker + revenge-trade cooldown |

### 12.4 Entry Guards

- Only enter during 10:15–11:00 IST.
- Skip on event-risk days.
- Skip when VIX < 12 (too thin).
- Skip when `crisisProbability > 0.30`.
- Monthly max-loss circuit breaker.
- Revenge-trade cooldown after a big loss.

---

## 13. AMF Stock Universe & Swing Engine

**File:** `services/kite/amf-stock-universe.ts`, `routes/amf.ts`

### 13.1 Stock Universe

25 NIFTY 50 stocks across 9 sectors, each with:
- `symbol` (NSE trading symbol)
- `assetId` (internal ID)
- `name` (display name)
- `sector`
- `kiteToken` (Kite instrument token, resolved dynamically if absent)
- `newsDrivers` (keywords for news matching)

### 13.2 AMF API Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/amf/portfolio` | GET | Unified portfolio state (condor + stocks + NIFTY) |
| `/api/amf/stocks` | GET | All AMF stocks with live prices |
| `/api/amf/stocks/:assetId` | GET | Single stock detail with AI signal |
| `/api/amf/sectors` | GET | Sector grouping |
| `/api/amf/signals` | GET | Recent AI signals for AMF stocks |

---

## 14. Phase 5 — Resolution & Feedback Loop

**Files:** `services/resolution/resolution-watcher.ts`, `brier-score.ts`, `forensics.ts`, `services/reasoning/self-calibration.ts`

Runs every **6 hours**.

### 14.1 Resolution Watchers

| Watcher | Source | Trigger |
|---------|--------|---------|
| OFAC | `treasury.gov/ofac/downloads/sdn.xml` (6h cache) | Actor name in SDN list |
| ACLED | `api.acleddata.com/acled/read` | Conflict events since `resolveAfter` |
| UN News | `news.un.org/feed/.../rss.xml` | Actor name in recent UN titles |
| NSE price | Yahoo `^NSEI` 2d close | `\|pctChange\| ≥ 2.0%` |
| GPT-4o fallback | — | Determines `materialisedIndex` from all signals |

### 14.2 UNCERTAIN Retrospective Scoring

```
isCorrect = |priceChangePct| > 1.0   // significant move = uncertainty was warranted
```

### 14.3 Auto-Mark

Predictions older than `AUTO_MARK_DAYS = 60` with no resolution → `resolutionStatus = "outcome_unverifiable"`.

### 14.4 Forensics Post-Mortem

If outcome confidence ≠ "low": runs a forensics agent comparing the Devil's Advocate critique to the actual outcome:
- `devilWasRight` (boolean)
- `missedChannel` (which transmission channel was overlooked)
- `lessonsLearned` (JSON bullet list)

These lessons are injected into the **next** reasoning pipeline run via `getFeedbackLessons()`.

### 14.5 Feedback Closed Loop

```
resolution → brierScore → self-calibration (daily)
          → confidence_penalty if rolling brier > 0.22
          → forecaster system prompt on next run
          → better calibrated probabilities
          → re-resolved → brier → …
```

---

## 15. Database Schema

### PostgreSQL Tables (25 total)

| Table | Phase | Purpose |
|-------|-------|---------|
| `feed_registry` | 1 | RSS feed metadata, fetch intervals, quarantine state |
| `raw_articles` | 1 | Ingested article content, embeddings, dedup status |
| `extracted_events` | 1 | CAMEO-coded events with actors, targets, locations |
| `extraction_errors` | 1 | Failed GPT-4o extraction attempts |
| `stories` | 2 | Emergent geopolitical story labels and metadata |
| `prediction_v2` | 3 | 4-agent pipeline outputs: scenarios, flags, Brier scores |
| `prediction_snapshots` | 4 | Geopolitical prediction snapshots for track record |
| `market_regimes` | 4 | HMM regime states with 5-dim feature snapshots |
| `market_snapshots` | 4 | Per-asset directional predictions with full evidence |
| `signal_snapshots` | 4 | Detailed signal execution records |
| `flip_guards` | 4/5 | Direction flip confirmation state per asset |
| `signal_executions` | 4 | Trade execution records with entry/exit state |
| `paper_trades` | Paper | Virtual option-buying trade records |
| `condor_positions` | Paper | Iron Condor position records with legs JSON |
| `tick_archive` | Data | Archived tick data for backtesting |
| `broker_accounts` | Broker | Zerodha account details, tokens, expiry |
| `broker_orders` | Broker | Order records from Kite API |
| `broker_positions` | Broker | Live position records from Kite |
| `broker_holdings` | Broker | Holdings from Kite |
| `user_trade_preferences` | Broker | Per-user auto-trade settings, risk limits |
| `users` | Auth | User accounts |
| `user_sessions` | Auth | Session tokens |
| `push_subscriptions` | Notif | Web push subscription endpoints (VAPID) |
| `conversations` | Chat | Chat session metadata |
| `messages` | Chat | Chat message history |
| `app_opens` | Analytics | App open events |
| `page_views` | Analytics | Page view tracking |

### Neo4j Graph Schema

**Nodes:** `Story`, `Event`, `Country`, `Leader`, `TransmissionChannel`, `IndianAsset`

**Relationships:**
- `(Story)-[:CONTAINS]->(Event)`
- `(Event)-[:ACTED_ON]->(Country|Leader)`
- `(Event)-[:CONTRADICTS {cameoCodeA, cameoCodeB}]->(Event)`
- `(Story)-[:TRANSMITS_TO {triggerDate, rawWeight}]->(Channel)`
- `(Channel)-[:AFFECTS]->(IndianAsset)`

### ChromaDB

Article embeddings for semantic search and dedup. Collections keyed by ingestion window.

---

## 16. API Routes

**File:** `artifacts/api-server/src/routes/index.ts`

| Route Prefix | File | Purpose |
|-------------|------|---------|
| `/api/health` | `health.ts` | Health check |
| `/api/news` | `news.ts` | News articles, feeds, search |
| `/api/intelligence` | `intelligence.ts` | Stories, predictions, scenarios, market snapshots |
| `/api/push` | `push.ts` | Web push notifications (VAPID) |
| `/api/chat` | `chat.ts` | Chat with AI about market/geopolitics |
| `/api/auth` | `auth.ts` | User authentication |
| `/api/engagement` | `engagement.ts` | App opens, page views |
| `/api/broker` | `broker.ts` | Zerodha OAuth, account status, holdings |
| `/api/trading` | `trading.ts` | Live trading: positions, orders, signals |
| `/api/paper-trading` | `paper-trading.ts` | Paper trade history and state |
| `/api/condor` | `condor.ts` | Iron Condor state and history |
| `/api/amf` | `amf.ts` | AMF portfolio, stock universe, signals |

### WebSocket Events (`lib/ws-hub.ts`)

| Event | Direction | Payload |
|-------|-----------|---------|
| `market_data` | Server → Client | Live NIFTY spot, option chain metrics |
| `paper_trading` | Server → Client | Paper trade state, PnL |
| `condor` | Server → Client | Condor state, legs, PnL |
| `execution` | Server → Client | Order fills, status changes |
| `order_update` | KiteTicker → Server | Order postback (fill/rejection) |

---

## 17. Frontend

**Directory:** `artifacts/global-news/`

### Pages

| Page | File | Purpose |
|------|------|---------|
| Landing | `landing.tsx` | Marketing/home page |
| Dashboard | `dashboard.tsx` | Market overview, AI signals |
| Intelligence | `intelligence.tsx` | Stories, predictions, scenarios, graph |
| Trading | `trading.tsx` | Live trading dashboard, positions, orders |
| Paper Trading | `paper-trading.tsx` | Paper trade performance, history |
| AMF | `amf.tsx` | AMF portfolio, stock universe, sector view |
| Trending | `trending.tsx` | Trending stories |
| Sources | `sources.tsx` | Feed registry, source credibility |

### Tech Stack

- React + TypeScript
- Vite (build)
- TailwindCSS (styling)
- Shadcn/ui (components)
- WebSocket for real-time updates

---

## 18. System Prompts (Complete)

### 18.1 6h Window — Intraday Microstructure Analyst

```
You are a quantitative analyst assessing Indian equity market direction for the INTRADAY
(6 hour) horizon. You specialise in reading live market microstructure: candle quality,
options flow, and breadth. You do not extrapolate multi-day trends. You assess only what
the next 6 hours look like based on the data given.

If candle trust score is below 0.5, heavily discount the price signal and rely on put/call
ratio and advance/decline instead.

PCR INTERPRETATION: Normal range 0.8-1.1 is neutral. Below 0.8 = bullish (more calls being
written). Above 1.1 = bearish (more puts being written). HOWEVER, at extremes (>1.5 or
<0.5), PCR becomes a CONTRARIAN signal: PCR >1.5 means everyone has already hedged with
puts, no more sellers left → contrarian BULLISH. PCR <0.5 means everyone has already bought
calls, no more buyers left → contrarian BEARISH. When PCR is at an extreme, check current
price momentum: if price is rising with PCR >1.5, the contrarian bullish signal is confirmed.

CRITICAL: If put/call ratio and advance/decline are marked unavailable, base your call
ENTIRELY on candle quality, price momentum, and geopolitical channels. Do NOT default to
NEUTRAL just because some data is missing.

Return only valid JSON with fields: call, confidence, rationale.
```

### 18.2 24h Window — Institutional Conviction Analyst

```
You are a quantitative analyst assessing Indian equity market direction for the NEXT SESSION
(24 hour) horizon. Your primary inputs are institutional conviction signals: FII/DII flows,
delivery percentage, and open interest change. Price action from yesterday is context only
— not your primary signal.

If FII net is positive and delivery % exceeds 38%, this is strong bullish conviction even
if yesterday's price was flat or down. If regime says RISK_OFF but institutional signals are
bullish, explicitly flag the contradiction and lean toward the institutional data.

CRITICAL: If FII/DII flow or delivery data is marked unavailable, weight macro signals
(INR trend, crude oil, bond yields) at 70% of your reasoning. Do NOT default to NEUTRAL
just because institutional data is missing.

Return only valid JSON with fields: call, confidence, rationale.
```

### 18.3 72h Window — Macro Structural Analyst

```
You are a macro analyst assessing Indian equity market direction for the 72 HOUR (3 session)
horizon. You must not use recent price action in your reasoning. Your inputs are structural:
crude oil trend, INR direction, bond yield direction, VIX trend, options structure, and
geopolitical scenario probabilities.

A falling VIX + stable INR + flat crude = structurally supportive regardless of recent price.
Weight macro signals at 70% and the HMM regime label at 30%.

CRITICAL: If options structure data is marked unavailable, base your call entirely on macro
structural signals and geopolitical scenarios. Do NOT default to NEUTRAL just because options
data is missing.

Return only valid JSON with fields: call, confidence, rationale.
```

### 18.4 Context Data Sent to 6h Window

```
HORIZON: 6 hours (intraday)
CURRENT SESSION DATA:
- Session open price: {open}
- Current price vs open: {pct}%
- Candle trust score: {score} (1.0=clean, <0.5=flagged)
- Candle flags: {flags}
- Live put/call ratio: {pcr} (below 0.8=bullish, above 1.1=bearish, BUT >1.5=contrarian
  bullish=everyone hedged, <0.5=contrarian bearish=everyone bought calls)
- Advance/decline ratio: {adr} (above 1.5=bullish breadth)
- India VIX: {vix} (5d change: {change})
- Live implied volatility: {iv}%
- Max pain strike: {strike} (distance: {dist}%)
- SGX Nifty pre-market: {sgx}%
- Short covering signal: {signal}
SECTORAL CONTEXT:
- Bank Nifty vs NIFTY delta: {bank}%
- Nifty IT vs NIFTY delta: {it}%
Weight rule: Bank Nifty leading NIFTY up by >0.5% is the single strongest intraday signal.
HMM REGIME: {regime} (active for {cycles} cycles)
ACTIVE GEOPOLITICAL CHANNELS: {channels}
DRIVER NEWS: {filtered news headlines}
Return JSON: { "call": "BULLISH"|"BEARISH"|"NEUTRAL", "confidence": 0.0-1.0, "rationale": "max 80 words" }
```

### 18.5 4-Agent Reasoning Prompts (Phase 3)

| Agent | Role | Key Instruction |
|-------|------|-----------------|
| **Analyst** | Situation report | Identify Indian market exposure channels from the story's events |
| **Historian** | Historical analogues | Find similar past events, anchored on feedback lessons from forensics |
| **Forecaster** | Scenario tree | Generate scenarios with probabilities + falsification conditions. Calibration penalty injected if rolling Brier > 0.22 |
| **Devil's Advocate** | Critique | Challenge the forecaster's assumptions, adjust `finalScenarios` |

---

## 19. Decision-Making Logic (Complete)

### 19.1 Signal Decision Tree (Full Order)

```
1. Insufficient options data (no maxPain, no PCR, no SGX)?
   → NO_TRADE

2. Max pain hysteresis active?
   → Check spot momentum tiebreaker:
     • Spot rising + AI up → BUY_CALL (override)
     • Spot falling + AI down → BUY_PUT (override)
     • Otherwise → follow max pain signal

3. PCR hysteresis active?
   → Check spot momentum tiebreaker:
     • Spot rising + AI up → BUY_CALL (override)
     • Spot falling + AI down → BUY_PUT (override)
     • Otherwise → follow PCR signal

4. Short covering active? → BUY_CALL
4b. Fresh shorts entering? → BUY_PUT

5. SGX divergence > 0.8% vs AI direction? → NO_TRADE

6. Mild max pain conflict (|dist| > 1.0%)? → NO_TRADE

7. AI direction fallback:
   • AI up → BUY_CALL
   • AI down → BUY_PUT
   • AI neutral → NO_TRADE

8. Tier-3 gate: intraday microstructure must agree with above, else NO_TRADE
9. Range gate: suppress if price impact too high
10. Chop gate: suppress if spot persistence < MIN_PERSISTENCE
```

### 19.2 Ensemble Vote Logic

```
CRISIS regime + crisisProb > 0.6 → UNCERTAIN (override)

weightedScore = Σ (dirSign · windowWeight · confidence) / Σ (windowWeight · confidence)

if score > 0.20  → BULLISH
if score < -0.20 → BEARISH
else:
  if ≥2 high-confidence votes disagree → UNCERTAIN
  elif live geopolitical signal (weight > 0.2, non-neutral) → use it
  else → NEUTRAL

Geopolitical tiebreak: fii_risk_off channel with weight > 0.3 → ±0.15 bias
```

### 19.3 FlipGuard Logic

```
if newDir === confirmedDir → no flip, reset pending
if confirmedDir === "uncertain" → flip immediately to any clear direction
else:
  1st new direction → pendingDirection = new, pendingCount = 1, no emit
  2nd matching → emitFlip = true, confirm new direction
  different direction → reset pending to new, count = 1
```

### 19.4 Paper Trade Exit Priority

```
1. EOD squareoff (IST ≥ 15:15)           → always fires
2. Signal flip (2 consecutive ticks)     → fires on confirmed flip
3. Momentum reversal (≥8% drop, ≥120s)   → fires on velocity exit
4. Spot proximity (≤50pts, was deep ITM) → fires on gamma risk
5. VIX spike (≥20% above baseline)       → fires on vol event
6. Trailing stop / stop loss             → fires on ratchet breach
7. Far-OTM time stop (15min, <5% gain)   → fires on time decay
```

---

## 20. Deployment Architecture

### 20.1 Docker Compose Stack

```
┌─────────────────── Docker Network: gnm ───────────────────┐
│                                                            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────┐ │
│  │ PostgreSQL│  │  Neo4j   │  │ ChromaDB │  │ API Server│ │
│  │   :5432  │  │  :7687   │  │  :8000   │  │   :3000   │ │
│  │ (healthy) │  │ (healthy) │  │          │  │ (main+   │ │
│  │           │  │          │  │          │  │  worker) │ │
│  └──────────┘  └──────────┘  └──────────┘  └───────────┘ │
│                                                    ↑       │
│  ┌──────────┐                              ┌───────────┐ │
│  │ Frontend │                              │   Caddy   │ │
│  │   :80    │←─────────────────────────────│  :80/:443 │ │
│  │  (SPA)   │                              │ (reverse  │ │
│  └──────────┘                              │  proxy)   │ │
│                                             └───────────┘ │
└────────────────────────────────────────────────────────────┘
```

### 20.2 Containers

| Container | Image | Purpose |
|-----------|-------|---------|
| `gnm_postgres_prod` | `postgres:16` | Primary database |
| `gnm_neo4j_prod` | `neo4j:5` | Knowledge graph (APOC enabled) |
| `gnm_chromadb_prod` | `chromadb/chroma:latest` | Vector embeddings |
| `gnm_api_prod` | `gnm/api-server:latest` | API server + trading engine |
| `gnm_frontend_prod` | `gnm/frontend:latest` | React SPA |
| `gnm_caddy_prod` | `caddy:2-alpine` | Reverse proxy + TLS |

### 20.3 Build Process

**API Server Dockerfile:**
1. Build stage: `node:24-bookworm-slim`, pnpm, esbuild → self-contained bundle in `dist/index.mjs`
2. Runtime stage: `node:24-bookworm-slim`, tini for signal handling, `node --enable-source-maps /app/dist/index.mjs`

### 20.4 EC2 Deployment

- **Instance:** EC2 (ap-south-1), IP 13.53.173.142
- **SSH:** `ssh -i ~/.ssh/gnm-v2-key.pem ubuntu@13.53.173.142`
- **App directory:** `/home/ubuntu/intel`
- **Env file:** `.env.production` (contains all API keys, DB credentials, etc.)
- **Deploy command:** `docker compose --env-file .env.production -f docker-compose.prod.yml build api-server && docker compose --env-file .env.production -f docker-compose.prod.yml up -d api-server`

### 20.5 Resource Limits

- API server: `NODE_OPTIONS: "--max-old-space-size=4096"` (4GB heap)
- Neo4j: heap 512MB–1GB, pagecache 512MB
- DB pool: `DB_POOL_MAX = 5` per thread (10 total across main + worker)

---

## 21. External Integrations

| Service | Purpose | Auth/Key |
|---------|---------|----------|
| **OpenAI GPT-4o** | Event extraction, 4-agent reasoning, ensemble inference, forensics, resolution fallback | `OPENAI_API_KEY` |
| **OpenAI GPT-4o-mini** | Fast event extraction (`chatCompleteFast`) | Same key |
| **OpenAI Embeddings** | Semantic dedup, narrative drift centroids | Same key |
| **AWS Bedrock** | Alternative LLM provider (Mistral Large) | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |
| **Zerodha Kite** | Order placement, quote fetch, OAuth token refresh | `KITE_API_KEY`, `KITE_API_SECRET` |
| **KiteTicker** | Real-time WebSocket market data (NIFTY option chain + spot equities) | Access token from broker_accounts |
| **Yahoo Finance** | OHLCV, SGX Nifty, VIX, fallback spot prices | No key (public API) |
| **NSE Direct** | Option chain, FII/DII, delivery %, participant OI | Scraped (blocks cloud IPs — use `USE_NSE_DIRECT=false` on EC2) |
| **Firecrawl** | NSE/SGX scraping fallback | `FIRECRAWL_API_KEY` |
| **GDELT** | Pre-coded CAMEO events | No key (public) |
| **NewsAPI** | Fallback news aggregation | `NEWSAPI_KEY` |
| **GNews** | Fallback news aggregation | `GNEWS_KEY` |
| **The Guardian** | Fallback news aggregation | `GUARDIAN_KEY` |
| **OFAC SDN** | Sanctions list for resolution watcher | No key (public XML) |
| **ACLED** | Conflict event data for resolution | `ACLED_API_KEY`, `ACLED_EMAIL` |
| **UN News RSS** | UN statements for resolution | No key (public RSS) |
| **Neo4j** | Knowledge graph | `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD` |
| **ChromaDB** | Historical analogue vector search | `CHROMADB_HOST`, `CHROMADB_PORT` |
| **PostgreSQL** | Primary relational database | `DATABASE_URL` |

### Zerodha Token Management

- `exchangeRequestToken()` → exchanges OAuth request token for access token.
- `saveBrokerAccount()` → persists `accessToken`, `refreshToken`, `expiresAt` (≈24h).
- `refreshExpiringTokens()` → runs every 6h, refreshes tokens expiring within 6h using `kite.renewAccessToken`.
- `startTokenRefreshScheduler()` → called on server startup.
- `getKiteClientForUser()` → checks token expiry before returning client.

**Note:** Zerodha's OAuth flow requires manual browser interaction for the initial authentication. Auto-refresh works for existing tokens via the refresh token, but the initial authorization cannot be fully automated.

---

## 22. Timing Reference

| Interval | Value | Where |
|----------|-------|-------|
| Ingestion cycle | Per-feed (default 15m) | `ingestion/scheduler.ts` |
| Graph build | 15m (events), 6h (stories), 30m (contradictions), 1w (drift) | `graph/scheduler.ts` |
| Reasoning pipeline | 6h (dedup 5h) | `reasoning/scheduler.ts` |
| Market scheduler — open | 5 min | `market/scheduler.ts` |
| Market scheduler — pre/post | 15 min | `market/scheduler.ts` |
| Market scheduler — off-hours | 60 min | `market/scheduler.ts` |
| Market signal snapshot | 09:00 IST daily | `market/signal-scheduler.ts` |
| Market resolution | 15:30 IST daily | `market/resolution-scheduler.ts` |
| Tick evaluation throttle | 1 s | `tick-evaluator.ts` |
| Position reconciliation | 10 s | `tick-evaluator.ts` |
| Entry fill timeout | 20 s (`ENTRY_FILL_TIMEOUT_MS`) | `entry-tracker.ts` |
| Position safety heartbeat | 30 s | `position-monitor.ts` |
| KiteTicker observation feed | 1 s | `market-ticker.ts` |
| Chain re-resolve drift | 250 pts | `market-ticker.ts` |
| Spot equity stale | 30 s | `market-ticker.ts` |
| Resolution cycle | 6 h | `resolution-watcher.ts` |
| Self-calibration | 24 h | `self-calibration.ts` |
| Channel recalibration | 90 d | `channel-recalibration.ts` |
| Narrative drift | weekly | `narrative-drift.ts` |
| Auto-mark unverifiable | 60 d | `resolution-watcher.ts` |
| Worker health report | 60 s | `worker.ts` |
| Token refresh | 6 h | `token-refresh-scheduler.ts` |
| Paper trade re-entry cooldown | 15 min | `paper-trade-engine.ts` |
| Paper trade momentum min hold | 120 s | `paper-trade-engine.ts` |
| Condor entry window | 10:15–11:00 IST | `condor-paper-engine.ts` |
| First-run delays | 2 / 10 / 15 min | various |

---

## 23. Error Handling & Graceful Degradation

| Failure Mode | Behavior |
|-------------|----------|
| Neo4j unavailable | Graph scheduler skips. Reasoning pipeline skips (ChromaDB also required). API serves cached data. |
| ChromaDB unavailable | Reasoning pipeline skips. API serves cached predictions. |
| OpenAI rate limit | Per-agent retry with exponential backoff. Event extraction pauses and resumes. |
| OpenAI key invalid | `DISABLE_BG_SCHEDULERS=true` kill switch. Server runs with cached data. |
| Yahoo Finance down | Price fetch uses fallback. Market snapshots still generated with stale price data. |
| NSE Direct down | Tier 3 signals marked as stale (`fiiIsStale=true`). Ensemble continues with reduced confidence. |
| Feed failure ×3 | Feed quarantined with exponential backoff. No further fetches until backoff expires. |
| RSS parse error | Per-article error isolation. Entire feed does not fail. |
| KiteTicker disconnect | Auto-reconnect (`max_retry: 10, max_delay: 60`). Tier-3 buffer preserved. |
| Worker thread crash | Respawn with exponential backoff (1s → 30s max). Main thread unaffected. |
| DB pool exhaustion | Pool size capped at 5 per thread (10 total). Queries queue. |
| Token expiry | `refreshExpiringTokens` runs every 6h. If refresh fails, client creation throws. |

---

## 24. Recent Fixes & Trading Logic Updates (July 2026)

### Fix 1: Momentum Reversal Minimum Hold Time

**Problem:** `momentum_reversal` exit fired in 5–38 seconds, killing 5 trades across 5 days (₹15,000–20,000 loss).
**Fix:** Added `MOMENTUM_MIN_HOLD_MS = 120_000` (120s) check before momentum reversal can fire.
**File:** `paper-trade-engine.ts:349`

### Fix 2: Re-Entry Cooldown

**Problem:** No re-entry after exit — on Jul 8 (517pt crash), only 1 trade was entered despite a full-day trend.
**Fix:** Added `REENTRY_COOLDOWN_MS = 15 min` cooldown. After exit, `lastOptionSide` resets to `NO_TRADE` so the next signal evaluation sees a transition. After 15 min, re-entry is allowed if direction is unchanged.
**File:** `paper-trade-engine.ts:43,477`

### Fix 3: PCR Hysteresis Spot Momentum Tiebreaker

**Problem:** PCR hysteresis overrode AI direction, causing wrong-direction PUT trades on 5/9 days when market was going UP.
**Fix:** When PCR/max pain hysteresis conflicts with AI direction, spot momentum acts as tiebreaker:
- Spot rising >0.1% + AI says UP → override PCR's BUY_PUT to BUY_CALL
- Spot falling <-0.1% + AI says DOWN → override PCR's BUY_CALL to BUY_PUT
- Spot flat or AI neutral → let PCR/max pain win (structural signal)
**File:** `signal-executor.ts:381-421`

### Fix 4: AI Bearish Bias — Contrarian PCR Prompt

**Problem:** AI called DOWN on 2 up days (Jul 13: +185pts, Jul 20: +61pts) but never called UP on a down day. The AI's prompt said "above 1.1 = bearish" for PCR, conflicting with the code's contrarian interpretation at extremes.
**Fix:** Updated 6h system prompt and context data to include contrarian PCR interpretation:
- PCR >1.5 = contrarian bullish (everyone hedged, no more sellers)
- PCR <0.5 = contrarian bearish (everyone bought calls, no more buyers)
- When PCR is at an extreme, check price momentum for confirmation
**Files:** `ensemble.ts:35`, `market-agent.ts:650`

---

## 25. Key Decision Points Summary

| Decision | Mechanism | Location |
|----------|-----------|----------|
| Is this article a duplicate? | Cosine sim ≥ 0.88 | `semantic-dedup.ts` |
| Is this event real? | `requires_corroboration` + state-media rule | `event-extractor.ts` |
| Do these events form a story? | Louvain + Jaccard ≥ 0.60 | `story-emergence.ts` |
| Has the story drifted? | Cosine centroid distance > 0.25 over 4 weeks | `narrative-drift.ts` |
| What regime are we in? | 3-state Gaussian HMM (Viterbi + Forward) | `hmm-regime.ts` |
| Bullish or bearish? | Confidence-weighted 3-window ensemble, ±0.20 | `ensemble.ts` |
| Is the candle trustworthy? | Volume/delivery flags, trust 0.1–1.0 | `candle-trust.ts` |
| Intraday microstructure? | D/P regime-switch, deadzone 0.08 | `tier3-signal.ts` |
| Should we flip direction? | FlipGuard: 2-consecutive confirmation | `market-agent.ts` |
| PCR conflicts with AI? | Spot momentum tiebreaker (±0.1%) | `signal-executor.ts` |
| AI direction stale? | Spot momentum override (0.25% reversal) | `signal-executor.ts` |
| Should we trade now? | Edge-triggered on signal transition + Tier-3 gate | `tick-evaluator.ts` |
| Which option strike? | ATM ± k·50, premium/capital filter | `signal-executor.ts` |
| Did the entry actually fill? | Order postback / poll → PENDING→OPEN, else timeout→FLAT | `entry-tracker.ts` |
| When to exit (live)? | Ratchet trailing stop + exchange SL + time stop | `position-monitor.ts` |
| When to exit (paper)? | 6 exits: EOD, signal flip, momentum, proximity, VIX, trailing | `paper-trade-engine.ts` |
| Can we re-enter after exit? | 15-min cooldown, then yes if direction unchanged | `paper-trade-engine.ts` |
| When to close condor? | 1.5x leg exit, 65% profit, gamma cutoff, slow bleed, news shock | `condor-paper-engine.ts` |
| Was the prediction right? | Brier score + 5 watchers + GPT-4o fallback | `resolution-watcher.ts` |
| Should we trust this story type? | Rolling 10-pred Brier > 0.22 → penalty 0.20 | `self-calibration.ts` |
| Are channel weights still valid? | Quarterly Pearson recalibration | `channel-recalibration.ts` |

---

_End of blueprint._

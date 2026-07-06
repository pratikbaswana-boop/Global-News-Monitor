# Global News Intelligence & Market Prediction — Complete System Blueprint

> AI-native geopolitical intelligence + Indian market prediction platform.
> Closed-loop: ingest news → build knowledge graph → multi-agent reasoning → market
> direction call → trade execution → resolution → Brier score → feed lessons back.

---

## 1. System Overview

The platform fuses three data domains:

1. **Geopolitical news** (RSS + GDELT) → CAMEO-coded events → Neo4j graph → stories.
2. **Market microstructure** (NSE option chain, FII/DII, VIX, PCR, SGX Nifty, sectoral deltas).
3. **AI reasoning** (GPT-4o multi-agent + 3-window ensemble + HMM regime + Tier-3 microstructure).

The output is a tradeable direction call (`BULLISH` / `BEARISH` / `NEUTRAL` / `UNCERTAIN`)
per asset, which an edge-triggered executor converts into option/spot trades via Zerodha Kite,
managed by a tick-driven trailing-stop position monitor. Predictions are later resolved and
scored with Brier scores; calibration penalties feed back into the next forecast.

### Tracked assets (hardcoded in `market/scheduler.ts`)

| id          | symbol    | yahoo    |
|-------------|-----------|----------|
| nifty50     | NIFTY     | ^NSEI    |
| sensex      | SENSEX    | ^BSESN   |
| reliance    | RELIANCE  | RELIANCE.NS |
| tcs         | TCS       | TCS.NS   |
| hdfc-bank   | HDFCBANK  | HDFCBANK.NS |
| gold        | GOLD      | GC=F     |
| silver      | SILVER    | SI=F     |

---

## 2. Process Architecture

### 2.1 Two-thread model (`artifacts/api-server/src/index.ts`)

```
┌──────────────────────────── MAIN THREAD ────────────────────────────┐
│  Express API server (PORT env, default 3000)                        │
│                                                                     │
│  Latency-critical schedulers (always run here):                     │
│   • startMarketScheduler()        — HMM + ensemble every 5/15/60 min│
│   • startMarketTicker()           — KiteTicker WebSocket feed       │
│   • startMarketSignalScheduler()  — Tier-3 signal refresh           │
│   • startMarketResolutionScheduler() — snapshot resolution          │
│   • startTickEvaluator()          — edge-triggered signal dispatch  │
│   • startPositionMonitor()        — trailing stop / exit control    │
│   • startTokenRefreshScheduler()  — Kite OAuth token refresh        │
└_____________________________________________________________________┘
        │ if BG_IN_WORKER=true (default)
        ▼
┌──────────────────────── WORKER THREAD (worker.ts) ──────────────────┐
│  CPU-bound phases (off-loaded from event loop):                     │
│   • startIngestionScheduler()        — Phase 1                      │
│   • startGraphScheduler()            — Phase 2                      │
│   • startReasoningScheduler()        — Phase 3                      │
│   • startResolutionScheduler()       — Phase 5 (every 6h)           │
│   • startSelfCalibrationScheduler()  — daily Brier recalibration    │
│   • startMarketCloseSummaryScheduler()                              │
│   • startChannelRecalibrationScheduler() — quarterly Pearson        │
│  Health report posted to main thread every 60s.                     │
└_____________________________________________________________________┘
```

### 2.2 Kill switches (env vars)

- `DISABLE_BG_SCHEDULERS=true` → no background phases start at all.
- `BG_IN_WORKER=false` → phases 1–3, 5 run on the main thread (rollback mode).

---

## 3. End-to-End Flow

```
RSS/GDELT feeds
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
[Phase 3] Reasoning Pipeline (per story, GPT-4o)
     │   Analyst → Historian → Forecaster → Devil's Advocate
     │   • feedback lessons injected from past resolutions
     │   • calibration penalty if rolling Brier > 0.22
     ▼
prediction_v2 (Postgres) + TRANSMITS_TO edge in Neo4j
     │
     ▼
[Phase 4] Market Agent (every 5 min during open)
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
     │   • entry persisted PENDING_ENTRY → OPEN only on a confirmed fill
     ▼
[Phase 4d] Position Monitor (every tick + 30s heartbeat)
     │   • ratchet trailing stop, exchange-side SL (stop-loss limit), time stop (far OTM)
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
```

---

## 4. Phase 1 — Ingestion

**Files:** `services/ingestion/scheduler.ts`, `rss-fetcher.ts`, `gdelt-fetcher.ts`,
`event-extractor.ts`, `semantic-dedup.ts`, `feed-registry-seed.ts`.

### 4.1 Sources
- **RSS feeds** seeded in `feed-registry-seed.ts` (tiered by credibility 1–5).
- **GDELT** events (pre-coded CAMEO, bypasses GPT-4o extraction).

### 4.2 Semantic dedup (`semantic-dedup.ts`)

Embeds `title + first 300 chars` via OpenAI `text-embedding` and compares against
articles ingested in the last `DEDUP_WINDOW_HOURS = 6` using cosine similarity.

**Hardcoded thresholds:**
- `DUPLICATE_THRESHOLD = 0.88` → mark `duplicate`, keep higher-quality (lower tier) source.
- `CORROBORATION_THRESHOLD = 0.70` → link as corroboration, increment `corroboration_count`.

**Cosine formula:**
```
cos(a,b) = (a·b) / (‖a‖·‖b‖)
```
Dimension mismatch (e.g. 1536 vs 1024) returns `-1` sentinel and the pair is skipped.

### 4.3 CAMEO event extraction (`event-extractor.ts`)

GPT-4o-mini (`chatCompleteFast`, `temperature=0.1`, `max_tokens=600`) with a strict
JSON schema system prompt. Output fields: `actors`, `action_type` (CAMEO code),
`target`, `location`, `event_date`, `stated_intent`, `requires_corroboration`,
`confidence` (0–1).

**Hardcoded rule:** `requires_corroboration` is forced `true` if the source is state
media AND credibility tier ≥ 3.

CAMEO codes used: `SANCTION, MOBILIZE_MILITARY, NEGOTIATE, CONDEMN, THREATEN,
PROVIDE_AID, SIGN_TREATY, IMPOSE_EMBARGO, EXPEL_DIPLOMAT, CEASEFIRE, PROTEST,
ELECTION, POLICY_CHANGE, ECONOMIC_ACTION`.

Malformed JSON / model refusals are persisted to `extraction_errors` for audit.

---

## 5. Phase 2 — Knowledge Graph

**Files:** `services/graph/event-graph-builder.ts`, `louvain.ts`, `story-emergence.ts`,
`contradiction-detector.ts`, `narrative-drift.ts`, `channel-recalibration.ts`,
`neo4j-client.ts`.

### 5.1 Graph schema (Neo4j)

```
(:Story)-[:CONTAINS]->(:Event)-[:ACTED_ON]->(:Country|:Leader)
(:Event)-[:CONTRADICTS]->(:Event)
(:Story)-[:TRANSMITS_TO]->(:TransmissionChannel {historical_correlation})
```

### 5.2 Story emergence (`story-emergence.ts`)

1. Fetch `Event` nodes from last `LOOKBACK_DAYS = 21` (excluding hypotheses).
2. Build weighted graph: events connected by shared country; edge weight =
   `(effectiveWeight_a + effectiveWeight_b)/2 * sharedCountryCount`.
3. Run **Louvain** community detection (`louvain.ts`).
4. Filter communities: `MIN_COMMUNITY_EVENTS = 4`, `MIN_COMMUNITY_COUNTRIES = 1`,
   capped at `MAX_ACTIVE_STORIES = 25`.
5. Match to existing Story via **Jaccard similarity** of country sets;
   `STORY_CONTINUITY_OVERLAP_THRESHOLD = 0.60` → update, else create.
6. New stories labelled by GPT-4o (`temperature=0.2`, `max_tokens=30`, "8 words or fewer").
7. Stories not seen this cycle → `status='dormant'`.

**Jaccard formula:**
```
J(A,B) = |A ∩ B| / |A ∪ B|
```

### 5.3 Narrative drift (`narrative-drift.ts`) — weekly

- Embeds up to 30 articles per story, computes weekly **centroid** (mean vector).
- Compares to centroid from `LOOKBACK_WEEKS = 4` weeks ago.
- `cosineDistance = 1 - cosineSimilarity(currentCentroid, oldCentroid)`.
- **Hardcoded:** `DRIFT_THRESHOLD = 0.25`. If exceeded, GPT-4o writes a one-sentence
  `drift_description` and stores `narrative_drift_score` on the Story node.

### 5.4 Channel recalibration (`channel-recalibration.ts`) — quarterly

- Recomputes **Pearson correlation** between channel activation and a Brier-derived
  price-change proxy over the last `LOOKBACK_DAYS = 90`.
- Proxy: `priceChangePct = (1 - brierScore) * 2 - 1` (maps Brier 0→+1, 1→-1).
- Correlation clamped to `[0.10, 0.95]` and written to
  `TransmissionChannel.historical_correlation`.
- **Implementation note:** uses chained `setTimeout` chunks of `MAX_TIMEOUT_MS = 24 days`
  because Node's `setTimeout` overflows `INT32_MAX` for the 90-day interval.

---

## 6. Phase 3 — Reasoning Pipeline

**Files:** `services/reasoning/pipeline.ts`, `agent-analyst.ts`, `agent-historian.ts`,
`agent-forecaster.ts`, `agent-devil.ts`, `self-calibration.ts`.

LangGraph-style 4-agent chain per story. Skips if a prediction exists younger than
**5 hours** (`hasRecentPrediction`).

### 6.1 Pipeline stages

| Stage | Agent | Model | Role |
|-------|-------|-------|------|
| 0 | Feedback loader | — | Pulls lessons from `forensics.ts` for this story |
| 1 | Subgraph fetch | — | Cypher: events + countries + contradictions (last 72h) |
| 2 | **Analyst** | GPT-4o | Situation report + Indian market exposure channels |
| 3 | **Historian** | GPT-4o | Historical analogues (anchored on feedback lessons) |
| 4 | **Forecaster** | GPT-4o | Scenario tree with probabilities + falsification conditions |
| 5 | **Devil's Advocate** | GPT-4o | Critique + adjusted `finalScenarios` |
| 6 | Write | — | `prediction_v2` row + `TRANSMITS_TO` Neo4j edge |

### 6.2 Flags written to `prediction_v2.flags`

- `no_historical_analogue` — historian found no analogue.
- `calibration_penalty_active` — rolling Brier > 0.22 for this story type.
- `active_contradiction` — subgraph has real `CONTRADICTS` edges.
- `narrative_drifting` — `analogueConfidence < 0.45` and not `noHistoricalAnalogue`.

### 6.3 Self-calibration (`self-calibration.ts`) — daily

- Computes **rolling 10-prediction Brier** per story type (dominant channel as proxy).
- **Hardcoded:** `BRIER_PENALTY_THRESHOLD = 0.22`, `ROLLING_WINDOW = 10`.
- If exceeded → `confidence_penalty = 0.20` injected into the Forecaster's next system
  prompt via `getCalibrationWarning()`.
- Also computes **4-level Brier breakdown**: per-record, per-story-type, per-CAMEO-action,
  per-transmission-channel (last 500 resolved records).

### 6.4 Brier score (`resolution/brier-score.ts`)

```
BS = (1/N) · Σᵢ (fᵢ − oᵢ)²
```
- `fᵢ` = forecast probability for scenario i, `oᵢ = 1` if it materialised else `0`.
- Lower is better: 0 = perfect, 1 = worst.
- **Calibration labels:** ≤0.10 Excellent, ≤0.20 Good, ≤0.33 Acceptable, ≤0.50 Poor,
  else Very poor.

**Example:** 3 scenarios with probabilities `[0.6, 0.3, 0.1]`, scenario 1 materialised:
```
BS = ((0.6−0)² + (0.3−1)² + (0.1−0)²) / 3
   = (0.36 + 0.49 + 0.01) / 3 = 0.2867
```

---

## 7. Phase 4 — Market Direction Engine

**Files:** `services/market/scheduler.ts`, `hmm-regime.ts`, `ensemble.ts`,
`market-agent.ts`, `candle-trust.ts`, `tier3-signal.ts`, `tier3-fetcher.ts`,
`hot-context.ts`.

### 7.1 Scheduler cadence (`scheduler.ts`) — IST-aware

| Window | IST | Cadence |
|--------|-----|---------|
| pre-market | 08:45–09:15 | 15 min |
| open | 09:15–15:30 | **5 min** |
| post-close | 15:30–16:30 | 15 min |
| off-hours | else | 60 min |

Weekends → always `closed`. `FIRST_RUN_DELAY_MS = 2 min` after startup.

IST computed as `istMin = (utcH*60 + utcM + 330) % 1440`.

### 7.2 HMM regime detection (`hmm-regime.ts`)

3-state Gaussian Hidden Markov Model: **RISK_ON / RISK_OFF / CRISIS**.

**5-dim feature vector:** `[vixLevel, vixChange5d, pcrIntraday, niftyRealVol10d, inrUsdChange5d]`
(PCR replaced the old `fiiNetFlow5d` because FII cash flow is EOD-only and froze the HMM
intraday).

**Hardcoded NSE-calibrated parameters (2010–2024):**

```
MU = [
  [13.5, -0.5, 0.85, 11.0, -0.05],  // RISK_ON
  [19.0,  1.5, 1.15, 18.0,  0.25],  // RISK_OFF
  [28.0,  5.0, 1.45, 30.0,  1.20],  // CRISIS
]
SIGMA = [
  [3.0, 1.0, 0.15, 3.5, 0.20],
  [4.0, 1.5, 0.20, 5.0, 0.35],
  [6.0, 3.0, 0.30, 8.0, 0.80],
]
A (transition) = [
  [0.88, 0.10, 0.02],
  [0.08, 0.84, 0.08],
  [0.03, 0.15, 0.82],
]
PI = [0.55, 0.30, 0.15]
```

- **Viterbi** decodes most-likely state sequence.
- **Forward algorithm** gives `P(state | all observations)`.
- Needs ≥ 5 observations; otherwise defaults to `RISK_OFF` with uniform probs.
- **Drift detection:** trailing 5-observation avg log-likelihood; if `< DRIFT_THRESHOLD = -12.0`
  → `driftAlert: true` (recommend recalibrating MU/SIGMA).

**Emission log-prob (diagonal Gaussian):**
```
logP(obs|state k) = Σ_d [ -0.5·log(2π) - log(σ) - 0.5·((obs-μ)/σ)² ]
```

### 7.3 3-window ensemble (`ensemble.ts`)

Three parallel GPT-4o calls (`temperature=0.2`, `max_tokens=300`, JSON mode) with
distinct system prompts and context windows:

| Window | Weight | Focus |
|--------|--------|-------|
| 6h  | 0.35 | Intraday microstructure, candle quality, options flow, breadth |
| 24h | 0.40 | Institutional conviction: FII/DII, delivery %, OI change |
| 72h | 0.25 | Macro structural: crude, INR, bond yields, VIX trend, geopol scenarios |

**Confidence-weighted vote (`confidenceWeightedVote`):**
```
weightedScore = Σ (directionSign(call) · windowWeight · confidence)
normalizedScore = weightedScore / Σ(windowWeight · confidence)
```
where `directionSign(BULLISH)=+1, BEARISH=-1, NEUTRAL=0`.

**Decision thresholds (hardcoded):**
- `normalizedScore > 0.20` → `BULLISH`
- `normalizedScore < -0.20` → `BEARISH`
- Else: if ≥ 2 high-confidence (>0.5) votes disagree → `UNCERTAIN`
- Else: if a live geopolitical signal (`decayedWeight > 0.2`, non-neutral) exists → use it
- Else → `NEUTRAL`

**CRISIS override:** if `regime === CRISIS` and `crisisProbability > 0.6` → `UNCERTAIN`
regardless of votes.

**Geopolitical tiebreak:** if `dominantChannel === "fii_risk_off"` and
`decayedWeight > 0.3`, add `±0.15` to `normalizedScore`.

### 7.4 Candle trust (`candle-trust.ts`)

Hardcoded rules applied to the latest OHLCV candle:
- `volume_anomaly` if `volume > 3 × rollingAvgVolume20d` → trust `-= 0.5`
- `low_delivery_high_move` if `|close-open|/open > 0.5%` and `deliveryPct < 20` → `-= 0.3`
- `wash_trade_suspected` → `-= 0.4`
- Trust floored at `0.1`.

`tier1Score = +1 (close>open), -1 (close<open), 0 (|move|<0.05%)`.

### 7.5 Tier-3 intraday microstructure (`tier3-signal.ts`)

Self-contained rolling-buffer engine fed by `market-ticker.ts` at ~1s cadence
(`OBSERVATION_INTERVAL_MS = 1000`). Produces a `CALL / PUT / NONE` verdict that **gates**
the AI-derived option side in `signal-executor.ts`.

**Tunables (hardcoded):**
```
WINDOW_MS        = 300_000   // 5-min direction window
IV_WINDOW_MS     = 150_000   // 2.5-min IV confirmation
LONG_WINDOW_MS   = 600_000   // 10-min power/scale window
BUFFER_MAX_MS    = 750_000   // ~12.5 min retention
EMA_TAU_MS       = 150_000   // time-constant for direction EMA
READY_FRACTION   = 0.5       // buffer must span ≥50% of WINDOW_MS
DO_SCALE_FALLBACK = 0.02     // before percentile history warms up
DO_SCALE_MIN_SAMPLES = 10
THETA_D  = 0.30              // direction-strength threshold
THETA_P_LOW  = 0.30          // power-low threshold (fade regime)
THETA_P_HIGH = 0.55          // power-high threshold (tilt_on_power)
K_FADE  = 0.5                // fade scaling
TAU     = 0.08               // output deadzone
```

**Step 1 — Direction score D:**
```
ret        = log(latestPrice / pastPrice)          // past = nearest(latest.t - WINDOW_MS)
realizedVol = sqrt(Σ logRets²)                     // over window samples
Dp         = clip(ret / realizedVol, -1, 1)

priceWeight = tanh(3 · Dp)
dCall = latest.callOI - past.callOI
dPut  = latest.putOI  - past.putOI
doRaw = ((dCall - dPut) · priceWeight) / (latest.callOI + latest.putOI)

doScale = max(percentile(|doRaw| history, 0.90), 1e-9)   // 90th percentile scale
Do      = clip(doRaw / doScale, -1, 1)

dInst = 0.4·Dp + 0.6·Do
α     = 1 - exp(-dtMs / EMA_TAU_MS)        // time-based EMA
D     = EMA(dInst)                          // smoothed direction
```

**Step 2 — Power score P:**
```
volNow = max(latest.volume - prev.volume, 0)
oiNow  = |(latest.callOI + latest.putOI) - (prev.callOI + prev.putOI)|
Pv   = min(volNow / meanVol, 2) / 2
Poi  = min(oiNow  / meanOi,  2) / 2
Pg   = min(latest.atmGamma / meanGamma, 2) / 2
pRaw = 0.4·Pv + 0.4·Poi + 0.2·Pg

deltaIvPct = latest.atmIV / ivThen - 1            // ivThen = nearest(latest.t - IV_WINDOW_MS)
gate = 0.45 + 0.55 · clip(deltaIvPct / 0.08, 0, 1)  // IV confirmation multiplier

tilt     = sign(dCall - dPut)
disagree = tilt ≠ 0 and sign(D) ≠ 0 and tilt ≠ sign(D)
P = pRaw · gate · (disagree ? 0.8 : 1)
```

**Step 3 — Regime switch:**
```
if |D| > THETA_D and P < THETA_P_LOW:
    signalRaw = -D · K_FADE              // fade unsupported move
    regime = "fade"
elif |D| ≤ THETA_D and P > THETA_P_HIGH:
    signalRaw = tilt · P                 // ride positioning
    regime = "tilt_on_power"
else:
    signalRaw = D · P                    // aligned
    regime = "aligned"
```

**Step 4 — Deadzone output:**
```
signal = "CALL" if signalRaw >  TAU
       = "PUT"  if signalRaw < -TAU
       = "NONE" otherwise
```

**Black-Scholes ATM gamma (`bsGamma`)** — used because NSE feed lacks gamma:
```
d1 = (ln(S/K) + (r + 0.5·σ²)·T) / (σ·√T)        with r = 0.065
γ  = φ(d1) / (S · σ · √T)        where φ = standard normal pdf
```

### 7.6 Tier-3 fetcher (`tier3-fetcher.ts`) — session priors + live snapshot

**Session priors** (loaded once at market open, frozen all day):
- Previous-day FII/DII net flows, delivery %, FII participant OI net, **SGX Nifty change %**.

**Short-covering signal (hardcoded rules):**
```
covering   : pcr > 1.0 and oiChange < 0 and vix5dChange < 0   // shorts buying back → bullish
unwinding  : pcr < 0.9 and oiChange > 0 and vix5dChange > 0   // fresh shorts → bearish
none       : otherwise
```

**Sector delta score:** `raw = bank·0.6 + it·0.4`, then `clamp(raw/2, -1, +1)`.

**SGX Nifty prior:** if `|sgxNiftyChangePct| > 0.5`, `sgxScore = clamp(sgxPct/1.5, -1, 1)`,
added to prior score with weight `0.08`.

**PCR score inversion during short covering:** normally `pcrScore = clamp((1-pcr)/0.5, -1, 1)`
(high PCR = bearish), but if `shortCoveringSignal === "covering"` → `pcrScore = clamp((pcr-1)/0.5, -1, 1)`
(high PCR = bullish).

### 7.7 Channel decay (`market-agent.ts`)

Active transmission channels fetched from Neo4j via `TRANSMITS_TO` edges, then decayed:
```
daysSinceTrigger = floor((today - triggerDate) / 1 day)
decayFactor      = 0.5 ^ max(0, daysSinceTrigger - 1)     // half-life = 1 day
decayedWeight    = rawWeight · decayFactor
isActive         = decayedWeight > 0.1
```
Only channels with `decayedWeight > 0.3` are shown to the GPT-4o prompts.

**Scenario priced-in decay** (for `getActiveScenariosWithDecay`):
```
alreadyTransmitted = daysSince >= 1
decayFactor = alreadyTransmitted ? max(0.1, 1.0 - daysSince·0.3) : 1.0
```

### 7.8 PriceScore + FlipGuard (`market-agent.ts`)

**PriceScore:**
```
avgConfidence     = mean(vote.confidence)
tier1Contribution = candleTrust.tier1Score · candleTrust.trustScore · avgConfidence
priceScore        = tier3Score·0.7 + tier1Contribution·0.3
direction         = "up" if priceScore > 0.20
                   "down" if priceScore < -0.20
                   else ensemble majority fallback
```

**FlipGuard** (DB-primary, in-memory read-through; survives restarts):
- If `newDirection === confirmedDirection` → no flip, reset pending.
- From `uncertain` → any clear direction flips **immediately**.
- Otherwise requires **2 consecutive** readings in the new direction:
  - 1st new direction → `pendingDirection = new, pendingCount = 1`, no emit.
  - 2nd matching → `emitFlip = true`, confirm new direction.
  - Different direction → reset pending to that new direction, count = 1.

`flipConfirmed` is only `true` when the guard actually emits a flip.

### 7.9 Snapshot persistence (`scheduler.ts`)

Each cycle, for each asset:
- If material change (direction flip, flip confirmed, `|ΔpriceScore| > 0.15`, or
  confidence boost low→medium/high) → **insert new** `market_snapshots` row.
- Else → **update** existing today's row and refresh `snapshotAt`.
- `resolveAfter` = next 15:30 IST (10:00 UTC), skipping weekends.

Hot-context (`hot-context.ts`) publishes slow-path inputs lock-free for the tick
executor to read without a DB hop.

---

## 8. Phase 4b — Tick Evaluator (edge-triggered)

**File:** `services/kite/tick-evaluator.ts`.

Subscribes to the `marketTicker` EventEmitter; evaluates at most once per
`EVAL_THROTTLE_MS = 1000` ms.

**Trading hours guard (`isTradingOpen`):**
```
istMin = (utcH·60 + utcM + 330) % 1440
istDay = (now + 330min).getUTCDay()
closed on Saturday (6) / Sunday (0)
open  when 555 ≤ istMin < 930      // 09:15–15:30 IST
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

**Reconciliation:** every `RECONCILE_INTERVAL_MS = 10_000` ms, syncs the in-memory
state machine with the DB (catches missed transitions, manual exits, etc.).

---

## 9. Phase 4c — Signal Executor

**File:** `services/kite/signal-executor.ts` (~1092 lines).

### 9.1 Asset → Kite symbol map (hardcoded)

```
nifty50   → NIFTY 50 (NSE)
sensex    → SENSEX (BSE)
reliance  → RELIANCE (NSE)
tcs       → TCS (NSE)
hdfc-bank → HDFCBANK (NSE)
```

### 9.2 Option trading constants (hardcoded)

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

### 9.3 Hysteresis bands (hardcoded)

Prevents oscillation around trigger thresholds. Trigger fires the signal; release
clears it (only at a safer opposite-side value).

```
MAX_PAIN_TRIGGER   = 1.5    MAX_PAIN_RELEASE   = 1.2     // |dist| % from max pain
PCR_LOW_TRIGGER    = 0.65   PCR_LOW_RELEASE    = 0.75    // bullish low PCR
PCR_HIGH_TRIGGER   = 1.35   PCR_HIGH_RELEASE   = 1.25    // bearish high PCR
MILD_CONFLICT_TRIGGER = 1.0 MILD_CONFLICT_RELEASE = 0.8
```

**Example:** PCR falling — at 0.65 the `BUY_CALL` (bullish) signal triggers; it stays
active until PCR rises back above `0.75` (release), preventing flicker between 0.64–0.66.

### 9.4 Option signal derivation (`deriveBaseFromInputs`)

1. **Max pain:** `dist = (spot - maxPainStrike) / spot · 100`.
   - `dist > MAX_PAIN_TRIGGER` → `BUY_PUT` (price too high, expect pull toward pain).
   - `dist < -MAX_PAIN_TRIGGER` → `BUY_CALL`.
   - `|dist| < MAX_PAIN_RELEASE` → clear max-pain signal.
2. **PCR low:** PCR < `PCR_LOW_TRIGGER` → `BUY_CALL`; release at `PCR_LOW_RELEASE`.
3. **PCR high:** PCR > `PCR_HIGH_TRIGGER` → `BUY_PUT`; release at `PCR_HIGH_RELEASE`.
4. **Mild conflict gate:** when AI direction and microstructure disagree at
   `MILD_CONFLICT_TRIGGER`, suppress; release at `MILD_CONFLICT_RELEASE`.
5. **Tier-3 gate:** the intraday microstructure verdict (`CALL/PUT/NONE` from
   `tier3-signal.ts`) must agree with the AI-derived side, else `NO_TRADE`.
6. **AI direction fallback:** if no microstructure override, use the ensemble's
   `up`/`down` direction → `BUY_CALL` / `BUY_PUT`; `neutral` → `NO_TRADE`.

### 9.5 Strike candidate building

```
atmStrike  = round(spot / NIFTY_STRIKE_INTERVAL) · NIFTY_STRIKE_INTERVAL
candidates = [atmStrike ± k·NIFTY_STRIKE_INTERVAL  for k in 0..STRIKE_RANGE]
```
Filtered by `MIN_OPTION_PREMIUM ≤ premium ≤ MAX_OPTION_PREMIUM` and capital affordability.

### 9.6 Spot equity quantity formula

```
maxRiskAmount  = capital · riskPct            // per-user risk budget
riskPerUnit    = realPrice · stopLossPct
quantity       = floor(maxRiskAmount / riskPerUnit)
```

### 9.7 Execution flow

1. Check user auto-trade preferences + capital + risk limits.
2. Build strike candidates, fetch quotes (from live tick map first, fallback to
   Kite REST `getQuote`).
3. `selectBestOption` by affordability + moneyness.
4. Place order via Kite API (`placeOrder`).
5. Persist to `signal_executions` via the audit queue with `status = 'pending_entry'`.
6. Register the entry with the **fill tracker** (`entry-tracker.ts`) — see §9.8.
7. Track the held symbol in `market-ticker` for tick-driven exits.

Trades are dispatched to **all eligible users** on a signal transition, with
concurrency-safe dispatching to prevent re-entry churn.

### 9.8 Fill-confirmed entry (`entry-tracker.ts`)

An accepted order is not a filled order. An unfilled/partial LIMIT entry that was treated
as `open` would leave the monitor trailing a phantom, and its exchange SL — if it fired —
would open a **naked short** option. So the state machine gates OPEN on an actual fill:

```
PENDING_ENTRY ──(order COMPLETE / partial fill)──▶ OPEN   (row → 'open', entryPrice = fill avg, qty = filled)
      │
      └──(REJECTED / CANCELLED / no fill in ENTRY_FILL_TIMEOUT_MS)──▶ FLAT   (order cancelled, row → 'cancelled')
```

- The position monitor only manages `status = 'open'` rows, so a `pending_entry` is never
  trailed and gets no SL backstop.
- Fills are confirmed by, whichever is first: **(1)** the Kite **order postback** —
  delivered on the KiteTicker WebSocket already held and re-emitted as `order_update` on
  the shared bus (sub-second); **(2)** a short **poll** of `getOrderHistory` as a backstop
  for accounts whose postbacks don't route to the global ticker connection.
- `ENTRY_FILL_TIMEOUT_MS` (default 20 s, env-overridable): an entry that never fills is
  cancelled and returns to FLAT (no cooldown → a later edge can retry). A partial fill at
  timeout is **promoted** to OPEN with the filled quantity, not cancelled.
- Restart-safe: `reconcilePendingEntries()` (run from the tick evaluator's 10 s reconcile)
  re-adopts orphaned `pending_entry` rows and resolves them the same way.

---

## 10. Phase 4d — Position Monitor (tick-driven exits)

**File:** `services/kite/position-monitor.ts`.

Runs on every tick + a safety heartbeat every `SAFETY_INTERVAL_MS = 30_000` ms
(in case ticks stall).

### 10.1 Ratchet trailing stop (`computeRatchetStop`)

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
profitPct       = (125-100)/100·100 = 25%
milestoneLevel  = floor(25/10)·10   = 20
milestonePrice  = 100·1.20          = 120
stopPrice       = 120·(1-0.15)      = 102   (≥ entry ✓)
```
So a 25% gain locks a stop at ₹102 (2% profit floor). If price drops to ₹102, exit.

### 10.2 Exchange-side SL (stop-loss limit) backstop

A stop-loss **limit (SL)** order — *not* SL-M — is placed directly on Kite once a fill is
confirmed, at the current ratchet stop price, and its trigger is trailed UP as milestones
step (trigger and limit modified together, never lowered). It rests at the exchange and
fires natively if ticks stall or the process dies.

- **Why SL, not SL-M:** NSE discontinued SL-M for options in Sept 2021 and Kite rejects
  SL-M for index options — an SL-M backstop would be rejected on every placement, so the
  "exchange-side backstop" would never actually exist. The SL's limit price is set
  `SL_LIMIT_OFFSET_PCT` (default 4 %) **below** the trigger so it stays marketable and
  fills the moment it triggers (a stop that only fills at the trigger can be skipped past
  in a fast move).
- **No cancel-then-exit race:** when the in-process monitor must exit (time stop, or a
  price breach with no resting SL) it does **not** cancel the SL first (which would leave
  the position unprotected between the cancel and the exit fill). Instead `escalateExit`:
  - **converts the resting SL into the exit in place** — modifies its trigger to just
    below LTP + a tighter limit, so the *same* exchange order becomes an aggressive exit
    (one order, no gap, no double-sell); or
  - if an exit is already working, **re-prices it lower** via modify; or
  - if no order rests (SL placement had failed), **places a fresh LIMIT exit**.
  A modify failure returns and lets the next tick re-evaluate against fresh position
  quantity rather than stacking a second sell (avoids oversell).

### 10.3 Far-OTM time stop

For options with `delta < FAR_OTM_DELTA_THRESHOLD (0.15)`:
- Hard stop `15%`, trail gap `8%`, milestone `5%`.
- **Time stop:** if not gained `≥ FAR_OTM_MIN_GAIN_PCT (5%)` within
  `FAR_OTM_TIME_STOP_MS (15 min)` → exit.

### 10.4 Mutable exit state

`peakPrice`, `milestoneLevel`, `stopPrice`, `slOrderId`, `slTrigger`, `slLimit`,
`exitOrderId`, `timeStopDeadline` are persisted to `signal_executions` (in `notes`) on
each tick batch so a restart resumes exactly where it left off.

---

## 11. Phase 5 — Resolution & Feedback Loop

**Files:** `services/resolution/resolution-watcher.ts`, `brier-score.ts`,
`forensics.ts`, `services/reasoning/self-calibration.ts`.

Runs every **6 hours**.

### 11.1 Resolution watchers (run in parallel per expired prediction)

| Watcher | Source | Trigger |
|---------|--------|---------|
| OFAC | `treasury.gov/ofac/downloads/sdn.xml` (6h cache) | Actor name appears in SDN list |
| ACLED | `api.acleddata.com/acled/read` (needs `ACLED_API_KEY` + `ACLED_EMAIL`) | Conflict events in country since `resolveAfter` |
| UN News | `news.un.org/feed/.../rss.xml` | Actor name in recent UN titles |
| NSE price | Yahoo `^NSEI` 2d close | `|pctChange| ≥ 2.0%` |
| GPT-4o fallback | — | Determines `materialisedIndex` from scenarios + events + watcher signals |

### 11.2 UNCERTAIN retrospective scoring

For `market_snapshots` with `uncertaintyFlag = true`:
```
isCorrect = |priceChangePct| > 1.0      // significant move = uncertainty was warranted
```

### 11.3 Auto-mark

Predictions older than `AUTO_MARK_DAYS = 60` with no resolution →
`resolutionStatus = "outcome_unverifiable"`.

### 11.4 Forensics post-mortem (`forensics.ts`)

If outcome confidence ≠ "low": runs a forensics agent that compares the Devil's
Advocate critique to the actual outcome, producing:
- `devilWasRight` (boolean)
- `missedChannel` (which transmission channel was overlooked)
- `lessonsLearned` (JSON bullet list)

These lessons are injected into the **next** reasoning pipeline run for the same
story via `getFeedbackLessons()`.

### 11.5 Feedback closed loop

```
resolution → brierScore → self-calibration (daily)
          → confidence_penalty if rolling brier > 0.22
          → forecaster system prompt on next run
          → better calibrated probabilities
          → re-resolved → brier → …
```

---

## 12. Market Data Feed — KiteTicker (`services/kite/market-ticker.ts`)

Single WebSocket connection replacing the 5-second REST poll.

**Subscriptions:**
- NIFTY 50 spot token (`NIFTY_SPOT_TOKEN`) — full mode.
- ATM-centred ±strike range option tokens (full mode for OI + volume).
- Spot equity tokens (RELIANCE/TCS/HDFCBANK/SENSEX) — env-overridable:
  ```
  KITE_RELIANCE_TOKEN  = 779521
  KITE_TCS_TOKEN       = 2953217
  KITE_HDFCBANK_TOKEN  = 857857
  KITE_SENSEX_TOKEN    = 265
  ```
- Held-position instruments (dynamically via `trackHeldSymbol`).

**Chain re-resolve:** when spot drifts `RESOLVE_DRIFT_PTS = 250` from current ATM
(5 strikes), re-resolves the chain, re-subscribes, and **resets the tier-3 buffer**
(cross-boundary OI deltas would be garbage for ~5 min).

**Stale equity fallback:** `SPOT_EQUITY_STALE_MS = 30_000` → fall back to Yahoo if
no tick in 30s.

**Reconnect:** `reconnect: true, max_retry: 10, max_delay: 60`.

---

## 13. Database & Storage

| Store | Tech | Purpose |
|-------|------|---------|
| PostgreSQL | Drizzle ORM | `raw_articles`, `extracted_events`, `prediction_v2`, `market_snapshots`, `market_regimes`, `flip_guards`, `signal_executions`, `story_centroids`, `article_corroborations`, `extraction_errors` |
| Neo4j | Cypher | `Story`, `Event`, `Country`, `Leader`, `TransmissionChannel` + relationships |
| ChromaDB | vector store | Article embeddings (semantic search / dedup) |

---

## 14. External Integrations

| Service | Use |
|---------|-----|
| OpenAI GPT-4o | Event extraction, story labelling, 4-agent reasoning, ensemble inference, outcome determination, drift description |
| OpenAI GPT-4o-mini (`chatCompleteFast`) | Fast event extraction |
| OpenAI embeddings | Semantic dedup + narrative drift centroids |
| Zerodha Kite | Order placement, quote fetch, OAuth token refresh |
| KiteTicker | Real-time WebSocket market data |
| Yahoo Finance | OHLCV, SGX Nifty, VIX, fallback spot prices |
| NSE direct scraper | Option chain, FII/DII, delivery %, participant OI |
| Firecrawl | NSE/SGX scraping fallback |
| GDELT | Pre-coded CAMEO events |
| OFAC SDN XML | Sanctions resolution watcher |
| ACLED API | Conflict events resolution watcher |
| UN News RSS | UN statement resolution watcher |

---

## 15. Key Decision Points Summary

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
| Should we trade now? | Edge-triggered on signal transition + Tier-3 gate | `tick-evaluator.ts` / `signal-executor.ts` |
| Which option strike? | ATM ± k·50, premium/capital filter | `signal-executor.ts` |
| Did the entry actually fill? | Order postback / poll → PENDING_ENTRY→OPEN, else timeout→FLAT | `entry-tracker.ts` |
| When to exit? | Ratchet trailing stop + exchange SL (limit) + time stop | `position-monitor.ts` |
| Was the prediction right? | Brier score + 5 watchers + GPT-4o fallback | `resolution-watcher.ts` |
| Should we trust this story type? | Rolling 10-pred Brier > 0.22 → penalty 0.20 | `self-calibration.ts` |
| Are channel weights still valid? | Quarterly Pearson recalibration | `channel-recalibration.ts` |

---

## 16. Timing Reference (all hardcoded)

| Interval | Value | Where |
|----------|-------|-------|
| Ingestion cycle | (per scheduler) | `ingestion/scheduler.ts` |
| Reasoning pipeline dedup | 5 h | `pipeline.ts` |
| Market scheduler — open | 5 min | `market/scheduler.ts` |
| Market scheduler — pre/post | 15 min | `market/scheduler.ts` |
| Market scheduler — off-hours | 60 min | `market/scheduler.ts` |
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
| First-run delays | 2 / 10 / 15 min | various |

---

_End of blueprint._

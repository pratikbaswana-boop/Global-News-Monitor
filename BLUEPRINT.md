# Global News Monitor — Complete System Blueprint

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              AWS EC2 (single instance)                           │
│                                                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │ Postgres │  │  Neo4j   │  │ ChromaDB │  │  Caddy   │  │   API Server     │  │
│  │   :5432  │  │  :7687   │  │  :8000   │  │ :80/:443 │  │   (Node :3000)   │  │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  └──────────────────┘  │
│                                                                                 │
│  ┌───────────────────────────────────────────────────────────────────────────┐   │
│  │                           API Server (Node.js)                             │   │
│  │                                                                             │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐   │   │
│  │  │  Ingestion   │  │  Knowledge  │  │  Reasoning  │  │     Market      │   │   │
│  │  │  Pipeline    │  │    Graph    │  │  Pipeline   │  │     Engine      │   │   │
│  │  │  (Phase 1)   │  │  (Phase 2)  │  │  (Phase 3)  │  │   (Phase 4)     │   │   │
│  │  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────────┘   │   │
│  │                                                                     │   │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐   │   │
│  │  │ Resolution   │  │   Self-     │  │  Kite       │  │   Frontend      │   │   │
│  │  │  Watcher     │  │ Calibration │  │  Broker     │  │   (React/Vite)  │   │   │
│  │  │  (Phase 5)   │  │             │  │  Integration│  │                 │   │   │
│  │  └─────────────┘  └─────────────┘  └─────────────────┘   └─────────────────┘   │   │
│  └───────────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
│  External APIs:                                                                 │
│  ├── AWS Bedrock (LLM: Mistral Large, Nova Lite, Titan Embed)                   │
│  ├── Yahoo Finance (OHLCV price data)                                           │
│  ├── Kite Connect (Zerodha: real-time option chain + order execution)           │
│  ├── Firecrawl (NSE web scraping: VIX, A/D ratio, FII/DII)                      │
│  ├── GDELT (global events batch feed)                                           │
│  ├── RSS feeds (Reuters, BBC, NYT, etc.)                                        │
│  └── Web Push (VAPID notifications)                                             │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Phase 1: News Ingestion Pipeline

### Flow
```
RSS Feeds ──→ fetchRssFeed() ──→ processArticle() ──→ raw_articles table
GDELT Batch ──→ fetchGdeltBatch() ──→ processArticle()
                                        │
                                        ├── Step 1: Semantic Dedup (embedding cosine similarity)
                                        ├── Step 2: Persist to raw_articles (Postgres)
                                        └── Step 3: Event Extraction (LLM → CAMEO codes)
                                                    └── events table
```

### Key Details
- **Feed Registry**: Seeded from `feed-registry-seed.ts` with credibility tiers (1=Reuters, 5=state media)
- **Dedup**: Uses embedding cosine similarity to catch near-duplicate rewrites. Articles with >0.92 similarity to existing are discarded
- **Event Extraction**: Uses `chatCompleteFast()` (Bedrock Nova Lite on AWS) to extract CAMEO event codes from articles
- **State Media**: Articles from state media (credibility tier ≥3) require corroboration before event extraction
- **Backoff**: 3 consecutive failures → feed quarantined with exponential backoff
- **Cadence**: Runs every `NEWS_FETCH_INTERVAL_HOURS` (default 1h)

### Hardcoded Values
| Value | Location | Description |
|-------|----------|-------------|
| `5000` chars | `scheduler.ts:62` | Max article body length |
| `500` chars | `scheduler.ts:62` | Max title length |
| `0.92` | `semantic-dedup.ts` | Cosine similarity dedup threshold |
| `3` failures | `scheduler.ts:130` | Quarantine threshold |

---

## Phase 2: Knowledge Graph (Neo4j)

### Flow
```
events table ──→ event-graph-builder.ts ──→ Neo4j (Event, Country, Story nodes)
                                                   │
                                                   ├── contradiction-detector.ts (finds conflicting events)
                                                   ├── story-emergence.ts (Louvain clustering → Story nodes)
                                                   ├── narrative-drift.ts (tracks narrative evolution)
                                                   └── channel-recalibration.ts (quarterly Pearson correlation)
```

### Key Details
- **Graph Schema**: `Story → CONTAINS → Event → ACTED_ON → Country`, `Event → CONTRADICTS → Event`, `Story → TRANSMITS_TO → Channel`
- **Story Emergence**: Uses Louvain community detection algorithm to cluster related events into stories
- **Channel Recalibration**: Quarterly Pearson correlation of transmission channel weights
- **Cadence**: Graph scheduler runs every 30 minutes

---

## Phase 3: 4-Agent Reasoning Pipeline

### Flow
```
Story (from Neo4j) ──→ runPipeline(storyId)
                         │
                         ├── Stage 0: Feedback Injection (lessons from past resolutions)
                         ├── Stage 1: Fetch Story Subgraph (Neo4j Cypher query)
                         ├── Stage 2: Analyst Agent (LLM call → situation report)
                         ├── Stage 3: Historian Agent (LLM call → historical analogues)
                         ├── Stage 4: Forecaster Agent (LLM call → scenario tree)
                         │              └── Self-calibration warning if Brier > 0.22
                         ├── Stage 5: Devil's Advocate Agent (LLM call → critique + adjusted scenarios)
                         └── Stage 6: Write to prediction_v2 table + Neo4j TRANSMITS_TO edge
```

### Key Details
- **LLM**: All 4 agents use `chatComplete()` → routes to Bedrock Mistral Large on AWS
- **Skip Guard**: If prediction exists within 5 hours, skip pipeline
- **Flags**: `no_historical_analogue`, `calibration_penalty_active`, `active_contradiction`, `narrative_drifting`
- **Resolution**: `resolveAfter = now + min(timeframeDays) × 24h`
- **Cadence**: Reasoning scheduler runs every 5 minutes, picks up stories without recent predictions

### Hardcoded Values
| Value | Location | Description |
|-------|----------|-------------|
| `5h` | `pipeline.ts:88` | Skip if recent prediction exists |
| `0.45` | `pipeline.ts:166` | Historian analogue confidence threshold for `narrative_drifting` flag |
| `0.22` | `self-calibration.ts` | Brier score penalty threshold |

---

## Phase 4: Market Engine (Signal Generation + Auto-Trading)

This is the core trading system. It has multiple sub-systems running on different cadences:

### 4A. Market Scheduler (Slow Path — 5 min cycles)

```
                    ┌──────────────────────────────────────────────────┐
                    │           Market Scheduler (runCycle)             │
                    │                                                  │
                    │  1. HMM Regime Detection                         │
                    │     fetchRegimeFeatures() → detectRegime()       │
                    │     → market_regimes table                       │
                    │                                                  │
                    │  2. Session Priors (load once at open)           │
                    │     fetchSessionPriors() → in-memory             │
                    │     (FII/DII flows, delivery %, participant OI)  │
                    │                                                  │
                    │  3. Reset Flip Guards (new trading day)          │
                    │                                                  │
                    │  4. For each of 7 assets:                        │
                    │     a. Fetch OHLCV from Yahoo Finance            │
                    │     b. runMarketAgent() → AI ensemble             │
                    │     c. Persist to market_snapshots table          │
                    │     d. Publish to hot context (in-memory)        │
                    └──────────────────────────────────────────────────┘
```

**Cadence (IST):**
| Window | Time | Interval |
|--------|------|----------|
| Pre-market | 08:45–09:15 | 15 min |
| Open | 09:15–15:30 | 5 min |
| Post-close | 15:30–16:30 | 15 min |
| Off-hours | 16:30–08:45 | 60 min |

**Tracked Assets (hardcoded):**
| Asset ID | Symbol | Yahoo Symbol |
|----------|--------|-------------|
| nifty50 | NIFTY | ^NSEI |
| sensex | SENSEX | ^BSESN |
| reliance | RELIANCE | RELIANCE.NS |
| tcs | TCS | TCS.NS |
| hdfc-bank | HDFCBANK | HDFCBANK.NS |
| gold | GOLD | GC=F |
| silver | SILVER | SI=F |

### 4B. HMM Regime Detection

**3-State Gaussian Hidden Markov Model:**

States: `RISK_ON`, `RISK_OFF`, `CRISIS`

**Feature Vector (5-dim):** `[vixLevel, vixChange5d, pcrIntraday, niftyRealVol10d, inrUsdChange5d]`

**Hardcoded Parameters (calibrated for NSE 2010–2024):**

```
MU (means):
  RISK_ON:   [13.5,  -0.5,  0.85,  11.0,  -0.05]
  RISK_OFF:  [19.0,   1.5,  1.15,  18.0,   0.25]
  CRISIS:    [28.0,   5.0,  1.45,  30.0,   1.20]

SIGMA (std devs):
  RISK_ON:   [3.0,  1.0,  0.15,  3.5,  0.20]
  RISK_OFF:  [4.0,  1.5,  0.20,  5.0,  0.35]
  CRISIS:    [6.0,  3.0,  0.30,  8.0,  0.80]

Transition Matrix A[i][j] = P(j|i):
  RISK_ON →  [0.88, 0.10, 0.02]
  RISK_OFF → [0.08, 0.84, 0.08]
  CRISIS →   [0.03, 0.15, 0.82]

Initial Prior: [0.55, 0.30, 0.15]
```

**Algorithm:**
1. **Viterbi** — decodes most likely state sequence from 30 days of features
2. **Forward Algorithm** — computes P(state | all observations) for current timestep
3. **Drift Detection** — alerts if avg log-likelihood drops below threshold

**Example:**
```
Input: VIX=14.2, VIX5d=-0.3, PCR=0.88, RealVol=12.1, INR5d=-0.02
→ RISK_ON (probability ~0.82)
→ Used as input to ensemble + tier3 score
```

### 4C. AI Ensemble (3-Window GPT/LLM Inference)

```
                    ┌──────────────────────────────────────────────┐
                    │           runMarketAgent()                    │
                    │                                              │
                    │  1. Fetch Tier-3 Snapshot                    │
                    │     (PCR, VIX, A/D ratio, FII/DII, etc.)     │
                    │                                              │
                    │  2. Fetch OHLCV + Candle Trust               │
                    │     checkCandleTrust() → trustScore, flags   │
                    │                                              │
                    │  3. Run AI Ensemble (3 parallel LLM calls)   │
                    │     ├── 6h context  → vote (weight 0.35)     │
                    │     ├── 24h context → vote (weight 0.40)     │
                    │     └── 72h context → vote (weight 0.25)     │
                    │                                              │
                    │  4. Confidence-Weighted Vote                 │
                    │     → BULLISH / BEARISH / NEUTRAL / UNCERTAIN│
                    │                                              │
                    │  5. Compute priceScore                       │
                    │     priceScore = tier3Score×0.7 + tier1×0.3  │
                    │                                              │
                    │  6. Apply FlipGuard                          │
                    │     → confirmed direction                    │
                    │                                              │
                    │  7. Compute Tier-3 Score (broad market)      │
                    │     → tier3Evidence JSON                     │
                    │                                              │
                    │  8. Return MarketSignal                      │
                    └──────────────────────────────────────────────┘
```

**Ensemble Vote Weights (hardcoded):**
| Window | Weight |
|--------|--------|
| 6h | 0.35 |
| 24h | 0.40 |
| 72h | 0.25 |

**Confidence-Weighted Vote Formula:**
```
weightedScore = Σ (dirScore × windowWeight × confidence) / Σ (windowWeight × confidence)

where:
  dirScore = BULLISH→+1, BEARISH→-1, NEUTRAL/UNCERTAIN→0
  windowWeight = {6h: 0.35, 24h: 0.40, 72h: 0.25}

if normalizedScore > 0.20 → BULLISH
if normalizedScore < -0.20 → BEARISH
if ≥2 HIGH-confidence votes disagree → UNCERTAIN
else → NEUTRAL
```

**Geopolitical Tiebreaker:** If `decayedWeight > 0.2`, adds ±0.15 to score.

**CRISIS Override:** If regime=CRISIS and crisisProbability > 0.6 → forced UNCERTAIN.

**LLM on AWS:** `LLM_PROVIDER=bedrock`, `LLM_MODEL_CHAT=mistral.mistral-large-2402-v1:0`
- Ensemble code hardcodes `model: "gpt-4o"` but Bedrock ignores this and uses env var model
- All `chatComplete()` calls route through `bedrockChat()` which uses `ConverseCommand`

### 4D. PriceScore Computation

**Formula:**
```
priceScore = (tier3Score × 0.7) + (tier1Contribution × 0.3)

where:
  tier1Contribution = candleTrust.tier1Score × candleTrust.trustScore × avgConfidence
  avgConfidence = mean(vote.confidence for all votes)

Direction thresholds:
  priceScore > 0.20  → "up"
  priceScore < -0.20 → "down"
  else → fall back to ensemble majority vote
```

**Example:**
```
tier3Score = 0.45, tier1Score = 1 (close > open), trustScore = 0.7, avgConfidence = 0.6
tier1Contribution = 1 × 0.7 × 0.6 = 0.42
priceScore = (0.45 × 0.7) + (0.42 × 0.3) = 0.315 + 0.126 = 0.441 → "up"
```

### 4E. Candle Trust Filter (Tier 1)

```
checkCandleTrust(currentCandle, rollingAvgVolume20d, deliveryPct)
```

**Rules:**
| Flag | Condition | Trust Penalty |
|------|-----------|---------------|
| `volume_anomaly` | Volume > 3× 20-day average | -0.5 |
| `low_delivery_high_move` | Price moved >0.5% but delivery <20% | -0.3 |
| `wash_trade_suspected` | (not currently triggered) | -0.4 |

**Trust score:** Starts at 1.0, minimum 0.1.

**Tier1 directional score:** `close > open → +1`, `close < open → -1`, `|move| < 0.05% → 0`

### 4F. FlipGuard (Anti-Whipsaw)

```
applyFlipGuard(guard, newDirection)
```

**Rules:**
1. If `newDirection === confirmedDirection` → no flip, reset pending
2. If `confirmedDirection === "uncertain"` and new is clear → **flip immediately**
3. If `newDirection === pendingDirection` and `pendingCount ≥ 1` → **flip confirmed** (requires 2 consecutive confirmations)
4. If `newDirection !== pendingDirection` → set new pending, count=1

**State:** Persisted in `flip_guards` table (survives restarts), cached in-memory.

**Reset:** At start of each new trading day (pre-market), all flip guards reset to `uncertain`.

### 4G. Tier-3 Score (Broad Market Composite)

```
computeTier3Score(snapshot) → [-1, +1]
```

**Live Signals (weight 0.85):**
| Signal | Weight | Formula |
|--------|--------|---------|
| PCR | 0.30 | `clamp((1.0 - PCR) / 0.5, -1, 1)` (inverted if short covering) |
| Advance/Decline Ratio | 0.25 | `clamp((ADR - 1.0) / 0.5, -1, 1)` |
| India VIX 5d Change | 0.18 | `clamp(-vix5dChange / 2.0, -1, 1)` |
| Sectoral Divergence | 0.12 | `clamp(sectorDeltaScore, -1, 1)` |

**Session Priors (weight 0.15):**
| Signal | Weight | Formula |
|--------|--------|---------|
| FII Net Flow | 0.09 | `clamp(fiiNetCrore / 3000, -1, 1)` |
| Delivery % | 0.03 | `clamp((deliveryPct - 35) / 15, -1, 1)` |
| FII Participant OI | 0.03 | `clamp(fiiParticipantOINet / 50000, -1, 1)` |
| Max Pain Penalty | 0.10 | `clamp(-maxPainDistancePct / 3.0, -1, 1)` (if >1.5% away) |
| SGX Nifty Divergence | 0.08 | `clamp(sgxNiftyChangePct / 1.5, -1, 1)` (if >0.5%) |

**Final:** `clamp((liveScore + priorScore) / totalWeight, -1, 1)`

**Example:**
```
PCR=0.83, ADR=15.3, VIX5d=-0.5, sectorDelta=0.2
FII=-311.82 Cr, delivery=null, maxPainDist=-3.09%

liveScore = clamp((1.0-0.83)/0.5, -1, 1)×0.30 + clamp((15.3-1)/0.5, -1, 1)×0.25
           + clamp(0.5/2.0, -1, 1)×0.18 + clamp(0.2, -1, 1)×0.12
         = 0.34×0.30 + 1.0×0.25 + 0.25×0.18 + 0.2×0.12
         = 0.102 + 0.25 + 0.045 + 0.024 = 0.421

priorScore = clamp(-311.82/3000, -1, 1)×0.09 + clamp(3.09/3.0, -1, 1)×0.10
           = -0.104×0.09 + 1.0×0.10
           = -0.009 + 0.10 = 0.091

tier3Score = clamp((0.421 + 0.091) / 0.85, -1, 1) ≈ 0.46
```

### 4H. Tier-3 Intraday Microstructure Signal Engine

This is the **pure math** intraday signal that acts as a gate for trades.

```
recordObservation({t, price, callOI, putOI, optionVolume, atmIV, atmGamma})
    │
    │  (every 5 seconds from KiteTicker WebSocket)
    │
    ▼
computeIntradaySignal() → {signal: CALL|PUT|NONE, D, P, regime, signalRaw}
```

**Buffer:** Rolling 12.5 minutes of observations (~150 samples at 5s cadence)

**Direction Score (D):**
```
1. Price momentum:
   ret = ln(latestPrice / pastPrice)         // log return over 5-min window
   realizedVol = sqrt(Σ(logRets²))           // realized volatility
   Dp = clamp(ret / realizedVol, -1, 1)      // Sharpe-like ratio

2. OI positioning:
   priceWeight = tanh(3 × Dp)                // continuous direction weighting
   dCall = latestCallOI - pastCallOI
   dPut  = latestPutOI  - pastPutOI
   doRaw = ((dCall - dPut) × priceWeight) / (latestCallOI + latestPutOI)
   doScale = 90th percentile of |doRaw| history (or 0.02 fallback)
   Do = clamp(doRaw / doScale, -1, 1)

3. Combine + EMA smooth:
   dInst = 0.4×Dp + 0.6×Do
   emaD = emaD + α×(dInst - emaD)           // α = 2/(30+1) ≈ 0.065
   D = emaD
```

**Power Score (P):**
```
1. Volume velocity:
   Pv = min(volNow / meanVol, 2) / 2        // current tick volume vs 10-min avg

2. OI velocity:
   Poi = min(oiNow / meanOi, 2) / 2         // current OI change vs 10-min avg

3. Gamma ratio:
   Pg = min(latestGamma / meanGamma, 2) / 2 // current gamma vs 10-min avg

4. Raw power:
   pRaw = 0.4×Pv + 0.4×Poi + 0.2×Pg

5. IV confirmation gate:
   deltaIvPct = latestIV / pastIV - 1       // IV change over 2.5 min
   gate = 0.45 + 0.55 × clamp(deltaIvPct / 0.08, 0, 1)

6. OI-skew disagreement penalty:
   if tilt ≠ sign(D): P = pRaw × gate × 0.8
   else:              P = pRaw × gate
```

**Regime Switch:**
```
if |D| > 0.30 and P < 0.30:
    signalRaw = -D × 0.5          // FADE: fade unsupported move
    regime = "fade"

elif |D| ≤ 0.30 and P > 0.55:
    signalRaw = tilt × P           // TILT: ride positioning when power high but direction flat
    regime = "tilt_on_power"

else:
    signalRaw = D × P              // ALIGNED: direction and power agree
    regime = "aligned"
```

**Deadzone:**
```
if signalRaw > 0.08  → CALL
if signalRaw < -0.08 → PUT
else                 → NONE
```

**Hardcoded Tunables:**
| Parameter | Value | Description |
|-----------|-------|-------------|
| `WINDOW_MS` | 300,000 (5 min) | Direction window |
| `IV_WINDOW_MS` | 150,000 (2.5 min) | IV confirmation lookback |
| `LONG_WINDOW_MS` | 600,000 (10 min) | Power/scale window |
| `BUFFER_MAX_MS` | 750,000 (12.5 min) | Buffer retention |
| `EMA_SPAN` | 30 | EMA smoothing span (~150s) |
| `READY_FRACTION` | 0.5 | Buffer must cover 50% of window |
| `THETA_D` | 0.30 | Direction threshold for fade |
| `THETA_P_LOW` | 0.30 | Low power threshold for fade |
| `THETA_P_HIGH` | 0.55 | High power threshold for tilt |
| `K_FADE` | 0.5 | Fade multiplier |
| `TAU` | 0.08 | Deadzone threshold |

### 4I. Option Chain Metrics (Kite Connect)

**Data Source:** KiteTicker WebSocket → real-time LTP, OI, volume for NIFTY options

**Chain Resolution:**
- Strike interval: **50 points** (hardcoded)
- Strike range: **±15 strikes** from ATM (30 strikes × 2 CE/PE = 60 instruments)
- Expiry: Nearest weekly expiry (Thursday)
- Re-resolve when spot drifts **250 points** from current ATM

**Implied Volatility (Newton-Raphson):**
```
solveIV(marketPrice, S, K, T, r=0.065, isCall=true)

Initial guess: σ = 0.20 (20%)
Max iterations: 50
Tolerance: 1e-4

Iteration:
  price = BSCall(S, K, σ, T, r)
  diff = price - marketPrice
  if |diff| < tolerance → return σ
  d1 = (ln(S/K) + (r + 0.5σ²)T) / (σ√T)
  vega = S√T × exp(-0.5d1²) / √(2π)
  σ = σ - diff/vega
  σ = clamp(σ, 0.01, 5.0)    // floor 1%, cap 500%
```

**Black-Scholes Call Price:**
```
d1 = (ln(S/K) + (r + 0.5σ²)T) / (σ√T)
d2 = d1 - σ√T
CallPrice = S×N(d1) - K×e^(-rT)×N(d2)
```

**Black-Scholes Gamma:**
```
d1 = (ln(S/K) + (r + 0.5σ²)T) / (σ√T)
Gamma = φ(d1) / (S × σ × √T)

where φ(x) = exp(-0.5x²) / √(2π)
```

**Time to Expiry:**
```
T = max(msUntilThursday, 2h) / (365 × 24 × 60 × 60 × 1000)
```
Minimum 2 hours to avoid division-by-zero on expiry day.

**Risk-free rate:** `r = 0.065` (6.5%, hardcoded)

**PCR:**
```
PCR = totalPutOI / totalCallOI
```

**Max Pain:**
```
For each strike K:
  pain(K) = K × (CE_OI_at_K + PE_OI_at_K)
maxPainStrike = argmin(pain(K))
```

**Example:**
```
Spot = 24,268, ATM strike = 24,250
ATM call LTP = ₹85, T = 3 days / 365 = 0.00822 years

solveIV(85, 24268, 24250, 0.00822, 0.065, true)
→ σ ≈ 0.12 (12% IV)

gamma = φ(d1) / (24268 × 0.12 × √0.00822) ≈ 0.00045
```

### 4J. Base Option Signal Decision Tree

```
deriveBaseFromInputs({aiDirection, maxPainDistancePct, putCallRatio, shortCoveringSignal, sgxNiftyChangePct, realPrice})
```

**Decision priority (first match wins):**

| # | Condition | Signal | Reason |
|---|-----------|--------|--------|
| 1 | No maxPain AND no PCR AND no SGX | NO_TRADE | Insufficient data |
| 2 | maxPainDist > +1.5% | BUY_PUT | Max pain stretch (price above pin) |
| 3 | maxPainDist < -1.5% | BUY_CALL | Max pain stretch (price below pin) |
| 4 | PCR < 0.65 | BUY_PUT | Too bullish (contrarian) |
| 5 | PCR > 1.35 | BUY_CALL | Too bearish (contrarian) |
| 6 | shortCovering = "covering" | BUY_CALL | Short covering active |
| 7 | shortCovering = "unwinding" | BUY_PUT | Fresh shorts entering |
| 8 | AI=up AND SGX < -0.8% | NO_TRADE | SGX divergence |
| 9 | AI=down AND SGX > +0.8% | NO_TRADE | SGX divergence |
| 10 | |maxPainDist| > 1.0% | NO_TRADE | Mild max pain conflict |
| 11 | AI = "up" | BUY_CALL | AI bullish + tier-3 neutral |
| 12 | AI = "down" | BUY_PUT | AI bearish + tier-3 neutral |
| 13 | (else) | NO_TRADE | AI direction neutral |

**Suggested strike:** `round(realPrice / 50) × 50` (nearest 50-point strike)

### 4K. Tier-3 Gate

```
applyTier3Gate(baseSignal, intradaySignal)
```

| Condition | Result |
|-----------|--------|
| base = NO_TRADE | Return NO_TRADE (no gate needed) |
| intraday not ready (warmup) | **Pass through** base signal |
| intraday.signal = NONE | **Pass through** base signal |
| intraday.signal = same side as base | **Pass through** (confirmed) |
| intraday.signal = opposite side | **BLOCK** → NO_TRADE |

### 4L. Tick Evaluator (Edge-Triggered Execution)

```
KiteTicker tick ──→ evaluate() (throttled 1s)
                      │
                      ├── computeLiveOptionSide("nifty50")
                      │     (uses hot context + live metrics + intraday gate)
                      │
                      ├── if optionSide changed (edge):
                      │     └── dispatchEntryForSide() for all users
                      │
                      └── for spot assets (RELIANCE, TCS, HDFCBANK):
                          if AI direction changed:
                            └── dispatchSpotForDirection()
```

**Key design:** Edge-triggered, not level-triggered. Only fires on **transitions** (e.g., NO_TRADE → BUY_CALL), not on every tick where signal is steady. This prevents re-entry after exits from a single signal.

### 4M. Signal Executor (Order Placement)

```
dispatchEntryForSide(assetId, signal)
  │
  ├── For each user with auto-trade enabled:
  │     ├── Check position state (can enter?)
  │     ├── Check trade preferences (enabled, confidence threshold, intraday-only)
  │     ├── Derive option signal (base + tier-3 gate)
  │     ├── Build strike candidates (±10 strikes from ATM)
  │     ├── Fetch live quotes from Kite
  │     ├── Select best option (score = lots × delta)
  │     ├── Place LIMIT order (1% above LTP, rounded to ₹0.05 tick)
  │     └── Record execution in signal_executions table
  │
  └── Strike candidates for BUY_CALL:
        ITM: ATM-100 (δ≈0.80), ATM-50 (δ≈0.65)
        OTM: ATM+0 (δ≈0.50), ATM+50 (δ≈0.35), ..., ATM+500 (δ≈0.008)
```

**Option Selection Formula:**
```
score = lots × deltaEstimate
  (maximize: more lots × higher delta = better)

Capital: 95% of available cash (leaves buffer for Kite margin)
Filter: ₹5 ≤ premium ≤ ₹400, lots ≥ 1, lots ≤ 20
High capital (≥₹50k): only δ ≥ 0.50
```

**Hardcoded Values:**
| Value | Location | Description |
|-------|----------|-------------|
| `65` | `signal-executor.ts:37` | NIFTY lot size |
| `5` | `signal-executor.ts:38` | Min option premium (₹5) |
| `400` | `signal-executor.ts:39` | Max option premium (₹400) |
| `20` | `signal-executor.ts:40` | Max option lots |
| `30%` | `signal-executor.ts:44` | ATM/ITM hard stop |
| `15%` | `signal-executor.ts:45` | ATM/ITM trail gap |
| `10%` | `signal-executor.ts:46` | ATM/ITM milestone step |
| `15%` | `signal-executor.ts:48` | Far OTM hard stop |
| `8%` | `signal-executor.ts:49` | Far OTM trail gap |
| `5%` | `signal-executor.ts:50` | Far OTM milestone step |
| `15 min` | `signal-executor.ts:51` | Far OTM time stop |
| `0.15` | `signal-executor.ts:52` | Far OTM delta threshold |
| `50` | `signal-executor.ts:54` | NIFTY strike interval |
| `0.065` | `kite-option-chain.ts:298` | Risk-free rate (6.5%) |

### 4N. Position Monitor (Exit Management)

```
KiteTicker tick ──→ evaluatePositions() (throttled 2s)
                      │
                      ├── For each open execution:
                      │     ├── Get current LTP from tick map
                      │     ├── Update peak price
                      │     ├── Compute ratchet stop:
                      │     │     profitPct = (peak - entry) / entry × 100
                      │     │     milestoneLevel = floor(profitPct / milestoneStep) × milestoneStep
                      │     │     if milestoneLevel = 0: stop = entry × (1 - hardStopPct/100)
                      │     │     else: stop = milestonePrice × (1 - trailGapPct/100)
                      │     │           stop = max(stop, entry)  // never below entry after first milestone
                      │     │
                      │     ├── If LTP ≤ stop: place exit order
                      │     ├── Far OTM time stop: if 15 min elapsed and gain < 5% → exit
                      │     └── Update SL-M order on exchange (zero-latency backstop)
                      │
                      └── Heartbeat every 30s (in case ticks stop)
```

**Ratchet Example (ATM/ITM):**
```
Entry = ₹100, peak = ₹130
profitPct = (130-100)/100 × 100 = 30%
milestoneLevel = floor(30/10) × 10 = 30
milestonePrice = 100 × (1 + 30/100) = ₹130
stopPrice = 130 × (1 - 15/100) = ₹110.50
→ Stop never below ₹100 (entry) after first milestone
```

**Exit Reasons:**
| Reason | Description |
|--------|-------------|
| `trailing_stop` | LTP hit ratcheted trailing stop |
| `time_stop` | Far OTM: 15 min elapsed without +5% gain |
| `manual` | User manually closed position |
| `order_rejected` | Kite rejected the entry order |

### 4O. Tier-3 Refresh Timer (5s Fast Path)

```
Every 5 seconds (during market hours):
  ├── Every 6th tick (30s): fetchTier3Snapshot() from Firecrawl
  │     (VIX, A/D ratio, sector deltas, FII/DII)
  │
  ├── Read latest chain metrics from KiteTicker (in-memory)
  ├── Compute intraday signal
  ├── Fetch live prices from Yahoo Finance for all 7 assets
  └── Update market_snapshots with fresh tier3Evidence + price
```

---

## Phase 5: Resolution & Self-Calibration

### Resolution Watcher
- Runs every 6 hours
- Checks `prediction_v2` entries where `resolveAfter < now` and `resolutionStatus = pending`
- Fetches actual price data for the prediction's asset and timeframe
- Marks prediction as correct/incorrect based on whether the predicted direction matched
- Computes Brier score contribution

### Market Resolution Scheduler
- Runs at 15:30 IST (market close)
- Resolves all `market_snapshots` for the day
- Compares `predictedDirection` vs actual price change (`realPriceAtSnapshot` vs close price)
- Records `is_correct`, `price_change_pct`, `resolution_direction`

### Self-Calibration
- Runs daily
- Computes rolling Brier score per transmission channel
- If Brier > 0.22, injects calibration penalty into future forecaster agent calls
- Tracks which channels are over/underconfident

---

## Infrastructure

### Docker Services
| Service | Image | Port | Purpose |
|---------|-------|------|---------|
| postgres | postgres:16 | 5432 | Primary database |
| neo4j | neo4j:5 | 7687 | Knowledge graph |
| chromadb | chromadb/chroma | 8000 | Vector embeddings |
| api-server | gnm/api-server | 3000 | Backend (Node.js) |
| frontend | gnm/frontend | 80 | React/Vite SPA |
| caddy | caddy:2-alpine | 80/443 | Reverse proxy + TLS |

### LLM Provider Configuration (AWS)
| Setting | Value |
|---------|-------|
| `LLM_PROVIDER` | `bedrock` |
| `LLM_MODEL_CHAT` | `mistral.mistral-large-2402-v1:0` |
| `LLM_MODEL_FAST` | `amazon.nova-lite-v1:0` |
| `LLM_MODEL_EMBED` | `amazon.titan-embed-text-v2:0` |
| Bedrock retries | 10 (SDK) + 6 (manual backoff, up to 32s) |
| Anthropic key | Also set (fallback/other tasks) |

### Kite Connect Configuration
| Setting | Value |
|---------|-------|
| API timeout | 7000ms |
| WebSocket | KiteTicker (full mode for OI + volume) |
| Spot token | 256265 (NIFTY 50) |
| Strike interval | 50 |
| Strike range | ±15 (30 strikes) |
| Instrument cache | 6 hours |
| Observation interval | 5 seconds |
| Chain re-resolve | When spot drifts 250 points |
| Token refresh | Every 6 hours |

---

## Complete Signal-to-Trade Flow (End-to-End)

```
  ┌─────────────────────────────────────────────────────────────────────────┐
  │                        SLOW PATH (5 min cycle)                          │
  │                                                                         │
  │  Yahoo Finance ──→ OHLCV ──→ Candle Trust ──┐                          │
  │                                              │                          │
  │  Firecrawl ──→ NSE Scraper ──→ Tier-3 ──┐   │                          │
  │  (VIX, ADR, FII/DII, sectors)            │   │                          │
  │                                          ▼   ▼                          │
  │  HMM Regime ──→ runMarketAgent() ──→ AI Ensemble (3 LLM calls)         │
  │  (RISK_ON/                                 │                           │
  │   RISK_OFF/                                ▼                           │
  │   CRISIS)                         Confidence-Weighted Vote              │
  │                                          │                           │
  │                                          ▼                           │
  │                                  computePriceScore()                   │
  │                                  (tier3×0.7 + tier1×0.3)               │
  │                                          │                           │
  │                                          ▼                           │
  │                                    FlipGuard                            │
  │                                  (anti-whipsaw)                        │
  │                                          │                           │
  │                                          ▼                           │
  │                                  MarketSignal                          │
  │                                  → market_snapshots table              │
  │                                  → hot context (in-memory)             │
  └─────────────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────────────┐
  │                        FAST PATH (5s tick)                              │
  │                                                                         │
  │  KiteTicker WebSocket                                                   │
  │  ├── NIFTY spot + 60 option instruments                                 │
  │  │                                                                      │
  │  │   ┌──────────────────────────────────────────────────────┐          │
  │  │   │  computeChainMetrics()  (every tick)                  │          │
  │  │   │  → PCR, maxPain, IV, gamma                            │          │
  │  │   └──────────────────┬───────────────────────────────────┘          │
  │  │                      │                                              │
  │  │                      ▼                                              │
  │  │   ┌──────────────────────────────────────────────────────┐          │
  │  │   │  recordObservation()  (every 5s)                      │          │
  │  │   │  → tier3-signal buffer                                 │          │
  │  │   └──────────────────┬───────────────────────────────────┘          │
  │  │                      │                                              │
  │  │                      ▼                                              │
  │  │   ┌──────────────────────────────────────────────────────┐          │
  │  │   │  computeIntradaySignal()  (every 5s)                  │          │
  │  │   │  → D, P, regime, signal (CALL/PUT/NONE)               │          │
  │  │   └──────────────────┬───────────────────────────────────┘          │
  │  │                      │                                              │
  │  │                      ▼                                              │
  │  │   ┌──────────────────────────────────────────────────────┐          │
  │  │   │  Tick Evaluator  (throttled 1s)                       │          │
  │  │   │                                                       │          │
  │  │   │  computeLiveOptionSide() =                            │          │
  │  │   │    deriveBaseFromInputs(hot context + live metrics)   │          │
  │  │   │    + applyTier3Gate(intraday signal)                  │          │
  │  │   │                                                       │          │
  │  │   │  If side CHANGED (edge-triggered):                    │          │
  │  │   │    → dispatchEntryForSide()                           │          │
  │  │   │       → for each user:                                │          │
  │  │   │          → strike selection + quote fetch + order     │          │
  │  │   └──────────────────┬───────────────────────────────────┘          │
  │  │                      │                                              │
  │  │                      ▼                                              │
  │  │   ┌──────────────────────────────────────────────────────┐          │
  │  │   │  Position Monitor  (throttled 2s)                     │          │
  │  │   │                                                       │          │
  │  │   │  For each open position:                               │          │
  │  │   │    → Update peak price                                 │          │
  │  │   │    → Compute ratchet trailing stop                     │          │
  │  │   │    → If LTP ≤ stop: place exit order                   │          │
  │  │   │    → Far OTM time stop (15 min, +5% required)          │          │
  │  │   │    → Update exchange-side SL-M order                   │          │
  │  │   └──────────────────────────────────────────────────────┘          │
  │  └──────────────────────────────────────────────────────────────────────┘
  └─────────────────────────────────────────────────────────────────────────┘
```

---

## Database Schema (Key Tables)

| Table | Purpose |
|-------|---------|
| `raw_articles` | Ingested news articles with embeddings |
| `feed_registry` | RSS feed sources with credibility tiers |
| `events` | CAMEO-coded events extracted from articles |
| `prediction_v2` | 4-agent reasoning pipeline output |
| `market_regimes` | HMM regime detection results |
| `market_snapshots` | Per-asset AI predictions with tier3 evidence |
| `flip_guards` | Anti-whipsaw state per asset |
| `signal_executions` | Trade execution records |
| `broker_accounts` | Kite Connect broker accounts |
| `broker_orders` | Placed orders |
| `broker_positions` | Current positions |
| `user_trade_preferences` | Per-user per-asset auto-trade settings |

---

## All Hardcoded Values Summary

| Value | File | Description |
|-------|------|-------------|
| `0.065` | `kite-option-chain.ts` | Risk-free rate (r) for Black-Scholes |
| `50` | `kite-option-chain.ts` | NIFTY strike interval |
| `15` | `kite-option-chain.ts` | Strike range (±15 from ATM) |
| `256265` | `kite-option-chain.ts` | NIFTY 50 spot instrument token |
| `0.20` | `kite-option-chain.ts` | IV solver initial guess (20%) |
| `50` | `solveIV` | Max Newton-Raphson iterations |
| `1e-4` | `solveIV` | IV solver tolerance |
| `0.01, 5.0` | `solveIV` | IV floor (1%) and cap (500%) |
| `65` | `signal-executor.ts` | NIFTY lot size |
| `5, 400` | `signal-executor.ts` | Min/max option premium |
| `20` | `signal-executor.ts` | Max option lots |
| `30%, 15%, 10%` | `signal-executor.ts` | ATM/ITM stop/trail/milestone |
| `15%, 8%, 5%` | `signal-executor.ts` | Far OTM stop/trail/milestone |
| `15 min` | `signal-executor.ts` | Far OTM time stop |
| `0.15` | `signal-executor.ts` | Far OTM delta threshold |
| `5%` | `signal-executor.ts` | Far OTM min gain within time stop |
| `0.08` | `tier3-signal.ts` | Deadzone (TAU) |
| `0.30` | `tier3-signal.ts` | THETA_D (direction threshold for fade) |
| `0.30, 0.55` | `tier3-signal.ts` | THETA_P_LOW, THETA_P_HIGH |
| `0.5` | `tier3-signal.ts` | K_FADE (fade multiplier) |
| `300s, 150s, 600s` | `tier3-signal.ts` | Window sizes (direction, IV, long) |
| `30` | `tier3-signal.ts` | EMA span |
| `0.35, 0.40, 0.25` | `ensemble.ts` | Ensemble window weights (6h, 24h, 72h) |
| `0.20` | `market-agent.ts` | priceScore direction threshold |
| `0.7, 0.3` | `market-agent.ts` | priceScore weights (tier3, tier1) |
| `1.5%, 1.0%` | `signal-executor.ts` | Max pain stretch thresholds |
| `0.65, 1.35` | `signal-executor.ts` | PCR extreme thresholds |
| `0.8%` | `signal-executor.ts` | SGX divergence threshold |
| `50000` | `signal-executor.ts` | High capital threshold (₹50k) |
| `95%` | `signal-executor.ts` | Capital deployment (leaves 5% buffer) |
| `1%` | `signal-executor.ts` | LIMIT order price buffer above LTP |
| `₹0.05` | `signal-executor.ts` | Tick size for price rounding |
| `2s, 30s` | `position-monitor.ts` | Eval throttle, safety heartbeat |
| `1s, 10s` | `tick-evaluator.ts` | Eval throttle, reconcile interval |
| `5s` | `market-ticker.ts` | Observation interval for tier3 buffer |
| `250` | `market-ticker.ts` | Chain re-resolve drift (points) |
| `6h` | `kite-option-chain.ts` | Instrument list cache TTL |
| `2 min` | `scheduler.ts` | First run delay after startup |
| `5, 15, 60 min` | `scheduler.ts` | Cadence (open, pre/post, off-hours) |
| `0.88, 0.10, 0.02` | `hmm-regime.ts` | RISK_ON transition probabilities |
| `0.08, 0.84, 0.08` | `hmm-regime.ts` | RISK_OFF transition probabilities |
| `0.03, 0.15, 0.82` | `hmm-regime.ts` | CRISIS transition probabilities |
| `0.55, 0.30, 0.15` | `hmm-regime.ts` | Initial state prior |
| `0.22` | `self-calibration.ts` | Brier score penalty threshold |
| `5h` | `pipeline.ts` | Skip reasoning if recent prediction exists |

---

## Startup Sequence

```
index.ts → app.listen(port)
  │
  ├── startIngestionScheduler()          // Phase 1: RSS + GDELT news ingestion
  ├── startGraphScheduler()              // Phase 2: Neo4j graph building
  ├── startReasoningScheduler()          // Phase 3: 4-agent pipeline
  ├── startMarketScheduler()             // Phase 4: HMM + ensemble + snapshots
  │    ├── First cycle after 2 min delay
  │    └── startTier3RefreshTimer()      // 5s fast-path refresh
  ├── startMarketTicker()                // KiteTicker WebSocket connection
  ├── startMarketSignalScheduler()       // 09:00 IST daily signal snapshot
  ├── startMarketResolutionScheduler()   // 15:30 IST daily resolution
  ├── startResolutionScheduler()         // Every 6h: resolve predictions
  ├── startSelfCalibrationScheduler()    // Daily: Brier score calibration
  ├── startMarketCloseSummaryScheduler() // 15:30 IST: push notifications
  ├── startChannelRecalibrationScheduler() // Quarterly: Pearson recalibration
  ├── startTickEvaluator()               // Edge-triggered auto-trade executor
  ├── startPositionMonitor()             // Tick-driven exit management
  └── startTokenRefreshScheduler()       // Every 6h: refresh Kite tokens
```

**Kill switch:** `DISABLE_BG_SCHEDULERS=true` → boots HTTP server only, skips all schedulers.

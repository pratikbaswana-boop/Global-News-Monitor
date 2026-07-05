# Global News Monitor — Complete System Blueprint

> Auto-trading system for NIFTY options with AI ensemble + microstructure signals.
> Last updated: July 4, 2026

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         AWS EC2 (13.53.173.142)                             │
│                                                                             │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌─────────────┐ │
│  │  api-server  │   │  global-news │   │  postgres    │   │  chroma     │ │
│  │  (Node.js)   │   │  (React/Vite)│   │  (Drizzle)   │   │  (vector)   │ │
│  │  port 3001   │   │  port 5173   │   │  port 5432   │   │  port 8000  │ │
│  └──────┬───────┘   └──────────────┘   └──────────────┘   └─────────────┘ │
│         │                                                                   │
│  ┌──────┴──────────────────────────────────────────────────────────────┐   │
│  │                     API SERVER INTERNAL SCHEDULERS                   │   │
│  │                                                                      │   │
│  │  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────┐ │   │
│  │  │ News        │  │ Market       │  │ Signal       │  │ Position │ │   │
│  │  │ Ingestion   │  │ Scheduler    │  │ Executor     │  │ Monitor  │ │   │
│  │  │ (5-30 min)  │  │ (5 min)      │  │ (5 sec)      │  │ (5 sec)  │ │   │
│  │  └──────┬──────┘  └──────┬───────┘  └──────┬───────┘  └────┬─────┘ │   │
│  │         │                │                 │               │       │   │
│  │         ▼                ▼                 ▼               ▼       │   │
│  │  ┌──────────┐    ┌──────────────┐  ┌───────────────┐  ┌────────┐  │   │
│  │  │ Neo4j    │    │ HMM Regime   │  │ Kite API      │  │ Kite   │  │   │
│  │  │ Graph    │    │ + AI Ensemble│  │ (place orders)│  │ (LTP)  │  │   │
│  │  │ (stories)│    │ + Tier-3     │  │               │  │        │  │   │
│  │  └──────────┘    │   Signal     │  └───────────────┘  └────────┘  │   │
│  │                  └──────┬───────┘                                │   │
│  │                  ┌──────┴───────┐                                │   │
│  │                  │  PostgreSQL  │                                │   │
│  │                  │  market_     │                                │   │
│  │                  │  snapshots   │                                │   │
│  │                  └──────────────┘                                │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  External APIs:                                                         │
│  ├── Kite Connect (Zerodha) — option chain, quotes, orders, positions  │
│  ├── Yahoo Finance — OHLCV daily candles                                │
│  ├── AWS Bedrock — LLM (Mistral Large / Nova Lite / Titan Embed)       │
│  ├── Firecrawl — NSE scraping (VIX, FII/DII, ADR, sector deltas)       │
│  ├── Neo4j — geopolitical story graph                                   │
│  └── ChromaDB — vector search for historical analogues                  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Timer-Driven Schedulers (7 concurrent loops)

| # | Scheduler | Interval | IST Window | Purpose |
|---|-----------|----------|------------|---------|
| 1 | **News Ingestion** | 5–30 min per feed | 24/7 | RSS/GDELT → events → Neo4j graph |
| 2 | **Market Scheduler** | 5 min (open) / 15 min (pre/post) / 60 min (off) | 08:45–15:30 | HMM regime + AI ensemble + snapshot creation |
| 3 | **Tier-3 Refresh** | 5 seconds | 09:15–15:30 | Kite option chain → intraday signal engine + DB update |
| 4 | **Signal Executor** | 5 seconds | 09:15–15:30 | Scan snapshots → derive trade → place Kite orders |
| 5 | **Position Monitor** | 5 seconds | 09:15–15:30 | Check open positions → trailing stop / time stop exits |
| 6 | **Token Refresh** | 6 hours | 24/7 | Refresh Kite access tokens before expiry |
| 7 | **Resolution** | 24 hours | Post-close | Mark snapshots correct/incorrect vs actual price move |

### IST Market Windows (hardcoded)
```
pre-market : 08:45–09:15 IST (03:15–03:45 UTC)
open       : 09:15–15:30 IST (03:45–10:00 UTC)
closed     : everything else + weekends
```
Source: `scheduler.ts:56-66`, `signal-executor-scheduler.ts:17-25`

---

## 3. Complete Signal Pipeline — Data to Trade

```
STAGE 1: DATA COLLECTION
├── 1a. Kite Option Chain (every 5s)
├── 1b. Yahoo OHLCV (every 5 min)
├── 1c. Firecrawl NSE scrape (every 30s)
├── 1d. Session Priors (once at open)
├── 1e. News + Geopolitical (continuous)
│
STAGE 2: REGIME DETECTION (every 5 min)
├── HMM Viterbi on 30-day features
│
STAGE 3: AI ENSEMBLE (every 5 min)
├── 3× LLM calls (6h / 24h / 72h context)
├── Confidence-weighted vote
├── PriceScore computation
├── FlipGuard anti-whipsaw
│
STAGE 4: TIER-3 INTRADAY ENGINE (every 5s)
├── Direction score D (price momentum + OI positioning)
├── Power score P (volume + OI velocity + gamma ratio + IV gate)
├── Regime switch (fade / tilt_on_power / aligned)
├── Deadzone → CALL / PUT / NONE
│
STAGE 5: SNAPSHOT PERSISTENCE (every 5s)
├── Merge AI direction + tier3 evidence + live price
├── Write to market_snapshots table
│
STAGE 6: SIGNAL EXECUTION (every 5s)
├── 6a. Base signal (AI direction + max pain + PCR + short covering)
├── 6b. Tier-3 gate (block if intraday disagrees)
├── 6c. Strike selection (13 candidates, hardcoded deltas)
├── 6d. Capital allocation (95% of available cash)
├── 6e. Place Kite order
│
STAGE 7: POSITION MONITORING (every 5s)
├── Trailing ratchet stop
├── Time stop (far OTM only)
├── Exit order placement
└── P&L recording
```

---

## 4. Stage-by-Stage Detail

### STAGE 1: Data Collection

#### 1a. Kite Option Chain (every 5 seconds)
**File:** `services/kite/kite-option-chain.ts` → `fetchKiteOptionChain()`

Fetches real-time NIFTY option chain from Kite Connect API:

```
1. Get global Kite client (paid account, has market data permissions)
2. Fetch NFO instrument list → filter NIFTY → nearest weekly expiry
3. Determine ATM strike = round(spotPrice / 50) × 50
4. Build ±15 strikes (30 strikes × 2 CE/PE = 60 instruments)
5. Fetch quotes for all 60 instruments via kite.getQuote()
6. Aggregate: callOI, putOI, optionVolume, atmCallLtp, atmPutLtp
7. Compute ATM IV via Newton-Raphson on Black-Scholes
8. Compute ATM gamma via Black-Scholes gamma formula
9. Compute PCR = putOI / callOI
10. Compute max pain = strike minimizing Σ(strike × (ceOI + peOI))
```

**Hardcoded constants:**
| Constant | Value | File:Line |
|----------|-------|-----------|
| `STRIKE_INTERVAL` | 50 | `kite-option-chain.ts:23` |
| `STRIKE_RANGE` | 15 (±15 strikes) | `kite-option-chain.ts:25` |
| Risk-free rate `r` | 0.065 (6.5%) | `kite-option-chain.ts:277` |
| IV initial guess | 0.20 (20%) | `kite-option-chain.ts:279` |
| IV max iterations | 50 | `kite-option-chain.ts:280` |
| IV tolerance | 1e-4 | `kite-option-chain.ts:281` |
| IV floor | 0.01 (1%) | `kite-option-chain.ts:294` |
| IV cap | 5.0 (500%) | `kite-option-chain.ts:295` |
| Kite SDK timeout | 7000ms | `kite-option-chain.ts:70` |

**IV Solver (Newton-Raphson):**
```
solveIV(marketPrice, S, K, T, r=0.065, isCall=true):
  sigma = 0.20  // initial guess
  for i in 0..50:
    price = bsCallPrice(S, K, sigma, T, r)
    diff = price - marketPrice
    if |diff| < 1e-4: return sigma
    d1 = (ln(S/K) + (r + 0.5σ²)T) / (σ√T)
    vega = S√T × e^(-d1²/2) / √(2π)
    if vega < 1e-8: break
    sigma = sigma - diff/vega
    sigma = clamp(sigma, 0.01, 5.0)
  return sigma
```

**Black-Scholes Call Price:**
```
bsCallPrice(S, K, sigma, T, r):
  if T ≤ 0 or sigma ≤ 0: return max(S - K, 0)
  d1 = (ln(S/K) + (r + 0.5σ²)T) / (σ√T)
  d2 = d1 - σ√T
  return S × N(d1) - K × e^(-rT) × N(d2)
```
where N(x) = Abramowitz & Stegun approximation of normal CDF.

**Black-Scholes Gamma:**
```
bsGamma(S, K, sigma, T, r=0.065):
  if S≤0 or K≤0 or sigma≤0 or T≤0: return 0
  d1 = (ln(S/K) + (r + 0.5σ²)T) / (σ√T)
  return φ(d1) / (S × σ × √T)
```
where φ(x) = e^(-x²/2) / √(2π) (normal PDF).

**Example (from Jul 4 live data):**
```
T = 0.01370 years (5 days to expiry)
marketPrice = ₹102.15 (ATM call LTP)
strike = 24,250
spot = 24,270.85
→ IV = 6.99% (sigma = 0.0699)
→ Gamma = φ(d1) / (24270.85 × 0.0699 × √0.0137)
```

#### 1b. Yahoo Finance OHLCV (every 5 min)
**File:** `market-agent.ts:295-356` → `fetchYahooOHLCV()`

Fetches 25-day daily candles from Yahoo Finance:
- NIFTY → `^NSEI`
- SENSEX → `^BSESN`
- GOLD → `GC=F`
- SILVER → `SI=F`
- Stocks → `{SYMBOL}.NS`

Used for: candle trust scoring, 7-day trend, rolling 20-day average volume.

#### 1c. Firecrawl NSE Scrape (every 30s = every 6th 5s tick)
**File:** `tier3-fetcher.ts` → `fetchTier3Snapshot()`

Scrapes broader market data not available from Kite:
- India VIX + 5-day change
- Advance/Decline ratio
- FII/DII net flows (₹ crore)
- Delivery %
- FII participant OI net
- Sector deltas (Bank Nifty vs NIFTY, Nifty IT vs NIFTY)
- INR/USD rate + 5-day change
- 10Y yield + 5-day change
- Brent crude + 5-day change

#### 1d. Session Priors (once at open, frozen all day)
**File:** `scheduler.ts:483-502` → `onMarketOpen()`
- FII/DII net flows, delivery %, FII participant OI — loaded once, held in memory.

#### 1e. News + Geopolitical (continuous)
- RSS/GDELT → event extraction (Nova Lite) → Neo4j graph → story emergence
- Geopolitical signal with recency decay + sentiment

---

### STAGE 2: Regime Detection (every 5 min)
**File:** `hmm-regime.ts` → `detectRegime()`

3-state Gaussian HMM on 30-day features: `[vixLevel, vixChange5d, pcrIntraday, niftyRealVol10d, inrUsdChange5d]`

**Hardcoded parameters (NSE-calibrated 2010-2024):**

| Parameter | RISK_ON | RISK_OFF | CRISIS |
|-----------|---------|----------|--------|
| μ(VIX) | 13.5 | 19.0 | 28.0 |
| μ(PCR) | 0.85 | 1.15 | 1.45 |
| σ(VIX) | 3.0 | 4.0 | 6.0 |

**Transition matrix:**
```
RISK_ON  [0.88, 0.10, 0.02]
RISK_OFF [0.08, 0.84, 0.08]
CRISIS   [0.03, 0.15, 0.82]
```
**Initial prior:** π = [0.55, 0.30, 0.15]

Viterbi decodes state sequence → forward algorithm gives P(state|obs) → argmax = regime.

---

### STAGE 3: AI Ensemble (every 5 min)
**File:** `ensemble.ts` → `runEnsembleInference()`

#### 3a. Three LLM Calls
| Window | Weight | Context |
|--------|--------|---------|
| 6h | 0.35 | Recent news + price action |
| 24h | 0.40 | Full day context |
| 72h | 0.25 | Macro + geopolitical |

**AWS Bedrock config:**
- Chat: `mistral.mistral-large-2402-v1:0`
- Fast: `amazon.nova-lite-v1:0`
- Embed: `amazon.titan-embed-text-v2:0`
- Temp: 0.2, max_tokens: 300, JSON response

> Code hardcodes `model: "gpt-4o"` but Bedrock ignores it, uses env `LLM_MODEL_CHAT`.

#### 3b. Confidence-Weighted Vote
```
weightedScore = Σ (dirScore × windowWeight × confidence)
  dirScore: BULLISH=+1, BEARISH=-1, else=0
normalizedScore = weightedScore / totalWeight

if geoSignal.decayedWeight > 0.2:
  normalizedScore += bearish ? -0.15 : +0.15

> 0.20 → BULLISH | < -0.20 → BEARISH
≥2 high-conf disagree → UNCERTAIN | else NEUTRAL
CRISIS + crisisProb > 0.6 → force UNCERTAIN
```

#### 3c. PriceScore
```
priceScore = clamp(tier3Score × 0.70 + candleTrust × tier1Score × 0.30, -1, +1)
```

**Tier3Score** (`tier3-fetcher.ts:862`):
```
Live (0.85): PCR×0.30, ADR×0.25, VIX5d×0.18, sectorDelta×0.12
Priors (0.15): FII×0.09, delivery×0.03, FIIOI×0.03, maxPain×0.10, SGX×0.08
→ normalize to [-1, +1]
```

#### 3d. FlipGuard
**File:** `market-agent.ts` → anti-whipsaw
- Requires **2 consecutive confirmations** before flipping direction
- Stored in `flip_guards` table: `{ pendingDirection, pendingCount, confirmedDirection }`
- Reset at start of each trading day

---

### STAGE 4: Tier-3 Intraday Microstructure Engine (every 5s)
**File:** `tier3-signal.ts` → `computeIntradaySignal()`

Pure math — no AI calls. Maintains a rolling buffer of `Tier3Observation` objects fed every 5s from Kite option chain.

#### Input (per tick)
```
{ t, price, callOI, putOI, optionVolume, atmIV, atmGamma }
```

#### 4a. Direction Score (D)
```
logReturn = ln(price_t / price_{t-1})
realizedVol = stdev(logReturns, last 20) × √252
emaFast = EMA(logReturns, 5)
emaSlow = EMA(logReturns, 20)

priceMomentum = clamp(emaFast / (realizedVol + ε), -1, +1)

oiChange = (callOI_t - callOI_{t-1}) / callOI_{t-1}
oiPositioning = clamp((putOI_change - callOI_change) / max(callOI, putOI), -1, +1)

D = clamp(priceMomentum × 0.60 + oiPositioning × 0.40, -1, +1)
```

#### 4b. Power Score (P)
```
volumeSpike = clamp(optionVolume_t / (avgVolume_20 + ε), 0, 3) / 3
oiVelocity = clamp(|oiChange| × 10, 0, 1)
gammaRatio = clamp(atmGamma × spotPrice × 100, 0, 1)
ivGate = atmIV > 30 ? 0.5 : 1.0   // high IV dampens power

P = clamp((volumeSpike × 0.35 + oiVelocity × 0.35 + gammaRatio × 0.30) × ivGate, 0, 1)
```

#### 4c. Regime Switch
```
if P > 0.65 and |D| > 0.5:
  regime = "fade"          // strong power + strong direction → contrarian fade
elif P > 0.65 and |D| < 0.2:
  regime = "tilt_on_power" // strong power, no direction → tilt by OI
else:
  regime = "aligned"       // normal: follow direction
```

#### 4d. Signal Computation
```
TAU = 0.08  // deadzone threshold (hardcoded)

if regime == "fade":
  signalRaw = -D × 0.5     // fade the direction
elif regime == "tilt_on_power":
  signalRaw = oiPositioning × P × 0.5
else:  // aligned
  signalRaw = D × P

if |signalRaw| < TAU:
  signal = "NONE"
elif signalRaw > 0:
  signal = "CALL"
else:
  signal = "PUT"
```

**Hardcoded constants:**
| Constant | Value | File:Line |
|----------|-------|-----------|
| `TAU` (deadzone) | 0.08 | `tier3-signal.ts:38` |
| Buffer size | 130 samples | `tier3-signal.ts:25` |
| Warmup samples | 100 | `tier3-signal.ts:28` |
| EMA fast period | 5 | `tier3-signal.ts:180` |
| EMA slow period | 20 | `tier3-signal.ts:181` |
| Vol window | 20 | `tier3-signal.ts:175` |
| Fade threshold P | 0.65 | `tier3-signal.ts:215` |
| Fade threshold D | 0.50 | `tier3-signal.ts:216` |

**Example (from Jul 3 live data):**
```
11:49 IST — PUT signal
  D = -0.173, P = 0.464, regime = "aligned"
  signalRaw = -0.173 × 0.464 = -0.080
  |signalRaw| = 0.080 ≥ TAU (0.08) → PUT ✓

13:28 IST — CALL signal (fade)
  D = -0.892, P = 0.216, regime = "fade"
  signalRaw = -(-0.892) × 0.5 = +0.446
  → CALL (contrarian fade of strong bearish move)
```

---

### STAGE 5: Snapshot Persistence (every 5s)
**File:** `scheduler.ts:618-804` → `refreshSnapshotTier3()`

Merges AI ensemble output with live tier-3 data and writes to `market_snapshots`:

```
For each asset:
  1. Find today's latest snapshot
  2. Update with fresh Kite data:
     - putCallRatio (from Kite)
     - maxPainStrike, maxPainDistancePct (from Kite)
     - realPriceAtSnapshot (from Yahoo live)
     - intradaySignal (from tier-3 engine)
  3. Only update if material change:
     - PCR changed > 0.02
     - maxPain changed > 0.10%
     - price changed > 0.1%
     - intraday signal or sample count changed
```

**Snapshot fields persisted:**
`predictedDirection, predictedConfidence, priceScore, flipConfirmed, regimeAtSnapshot, tier3Evidence (JSON), candleTrustScore, maxPainStrike, maxPainDistancePct, shortCoveringSignal, sgxNiftyChangePct, ensembleVotes, uncertaintyFlag`

---

### STAGE 6: Signal Execution (every 5s)
**File:** `signal-executor.ts` → `scanAndExecutePendingSignals()`

#### 6a. Snapshot Scan
- Find snapshots from last 30 min with direction up/down/neutral
- For each, find users with active auto-trade accounts who haven't been processed
- Call `processSignalForAutoTrade()` per unprocessed user

#### 6b. Base Signal (`deriveBaseOptionSignal`)
Decision tree (in order):
1. No data → NO_TRADE
2. maxPain > +1.5% → BUY_PUT (reversal)
3. maxPain < -1.5% → BUY_CALL (reversal)
4. PCR < 0.65 → BUY_PUT (too bullish)
5. PCR > 1.35 → BUY_CALL (too bearish)
6. shortCovering="covering" → BUY_CALL
7. shortCovering="unwinding" → BUY_PUT
8. SGX divergence > 0.8% vs AI → NO_TRADE
9. |maxPain| > 1.0% mild → NO_TRADE
10. AI "up" → BUY_CALL | AI "down" → BUY_PUT | else NO_TRADE

`suggestedStrike = round(realPrice / 50) × 50`

**Hardcoded thresholds:** maxPain ±1.5%, PCR 0.65/1.35, SGX 0.8%, mild maxPain 1.0%

#### 6c. Tier-3 Gate (`deriveOptionSignalFromSnapshot`)
- If base=NO_TRADE → return NO_TRADE
- If intraday engine not ready → pass-through
- If intraday.signal == oppositeSide → **BLOCK** (NO_TRADE)
- If intraday.signal == NONE or same side → **pass through**
- **Tier-3 only blocks, never initiates**

#### 6d. Strike Selection (`buildStrikeCandidates`)
13 candidates around ATM with hardcoded delta estimates:
```
ATM(0)→0.50, ±50→0.45/0.55, ±100→0.35/0.65, ±150→0.25/0.75,
±200→0.18/0.82, ±250→0.12/0.88, ±300→0.08/0.92
```

#### 6e. Option Selection (`selectBestOption`)
```
Filter: ₹5 ≤ premium ≤ ₹400
lots = min(floor(maxCapital / (premium × 65)), 20)
If capital ≥ ₹50k: only delta ≥ 0.50
Score = lots × deltaEstimate → pick highest
```

**Hardcoded constants:**
| Constant | Value |
|----------|-------|
| NIFTY_LOT_SIZE | 65 |
| MIN_OPTION_PREMIUM | ₹5 |
| MAX_OPTION_PREMIUM | ₹400 |
| MAX_OPTION_LOTS | 20 |
| Capital used | 95% of available cash |

#### 6f. Order Placement
```
Kite MARKET BUY order:
  exchange: NFO, product: MIS, orderType: MARKET
  tradingsymbol: e.g. NIFTY2670724250CE
  quantity: lots × 65
→ Record in signal_executions table
```

---

### STAGE 7: Position Monitoring (every 5s)
**File:** `position-monitor.ts` → `monitorOpenPositions()`

#### 7a. Trailing Ratchet Stop (`computeRatchetStop`)
```
profitPct = ((peak - entry) / entry) × 100
milestoneLevel = floor(profitPct / milestoneStep) × milestoneStep

if milestoneLevel == 0:
  stop = entry × (1 - hardStopPct/100)
else:
  milestonePrice = entry × (1 + milestoneLevel/100)
  stop = milestonePrice × (1 - trailGapPct/100)
  stop = max(stop, entry)  // breakeven cap
```

**Example (entry=₹100, ATM, trail=15%, step=10%):**
```
Peak ₹115 → milestone=10%, stop=110×0.85=₹93.5 → capped at ₹100
Peak ₹125 → milestone=20%, stop=120×0.85=₹102
```

#### 7b. Time Stop (Far OTM only, delta < 0.15)
```
if elapsed ≥ 15min AND profit < 5% → EXIT (theta decay)
```

#### 7c. Stop Parameters
| Parameter | ATM/ITM | Far OTM |
|-----------|---------|---------|
| Hard stop | 30% | 15% |
| Trail gap | 15% | 8% |
| Milestone step | 10% | 5% |
| Time stop | — | 15 min |
| Min gain | — | 5% |

#### 7d. Exit Order
```
LIMIT SELL at progressively aggressive price:
  Attempt 1: LTP × 0.99
  Attempt 2: LTP × 0.97
  Attempt 3+: LTP × 0.95
Round to tick 0.05. When position qty=0 → close execution, record P&L.
```

---

## 5. Database Schema (Key Tables)

### `market_snapshots`
Core signal table. One row per asset per material change per cycle.
- `predicted_direction`: up / down / neutral
- `predicted_confidence`: high / medium / low
- `price_score`: confidence-weighted score [-1, +1]
- `flip_confirmed`: boolean (FlipGuard state)
- `regime_at_snapshot`: RISK_ON / RISK_OFF / CRISIS
- `tier3_evidence`: JSON with PCR, ADR, VIX, FII, maxPain, intradaySignal
- `max_pain_strike`, `max_pain_distance_pct`
- `short_covering_signal`: none / covering / unwinding
- `sgx_nifty_change_pct`
- `ensemble_votes`: JSON array of 3 votes
- `candle_trust_score`: 0.1–1.0
- `real_price_at_snapshot`: live price
- `resolve_after`: 15:30 IST of trading day

### `signal_executions`
Trade records. One row per user per trade.
- `signal_snapshot_id`: FK to market_snapshots
- `user_id`, `broker_account_id`, `broker_order_id`
- `direction`: up / down
- `entry_price`, `exit_price`, `quantity`
- `status`: open / closed
- `realised_pnl`
- `exit_reason`: manual / trailing_stop / time_stop / order_rejected
- `highest_price_reached`: peak for ratchet computation
- `trail_gap_pct`, `stop_loss_price`
- `notes`: JSON with farOTM config, exit order info

### `market_regimes`
HMM regime history.
- `regime`: RISK_ON / RISK_OFF / CRISIS
- `risk_on_probability`, `risk_off_probability`, `crisis_probability`
- `vix_level`, `vix_change_5d`, `fii_net_flow_5d` (actually PCR)
- `nifty_real_vol_10d`, `inr_usd_change_5d`

### `flip_guards`
Anti-whipsaw state per asset.
- `pending_direction`, `pending_count`, `confirmed_direction`
- Reset daily at pre-market

### `broker_accounts`
User broker connections.
- `user_id`, `kite_api_key`, `kite_access_token` (encrypted)
- `is_active`, `auto_trade_enabled`

### `users`
- `firebase_uid`, `email`, `display_name`

---

## 6. Complete Hardcoded Values Reference

### Option Chain
| Value | Description |
|-------|-------------|
| 50 | NIFTY strike interval |
| ±15 | Strikes around ATM (30 total) |
| 0.065 | Risk-free rate (r) |
| 0.20 | IV initial guess |
| 50 | IV max iterations |
| 1e-4 | IV tolerance |
| 0.01–5.0 | IV floor/cap |
| 7000ms | Kite timeout |

### HMM Regime
| Value | Description |
|-------|-------------|
| [0.55, 0.30, 0.15] | Initial state prior π |
| 0.88/0.84/0.82 | Diagonal transition probs |
| 30 days | Feature window |

### AI Ensemble
| Value | Description |
|-------|-------------|
| 0.35/0.40/0.25 | Window weights (6h/24h/72h) |
| 0.20 | Score threshold for BULLISH/BEARISH |
| 0.6 | CRISIS override threshold |
| 0.15 | Geopolitical tiebreak adjustment |
| 0.2 | LLM temperature |
| 300 | Max tokens |

### Tier-3 Intraday
| Value | Description |
|-------|-------------|
| 0.08 | Deadzone (TAU) |
| 130 | Buffer size (samples) |
| 100 | Warmup samples |
| 5/20 | EMA fast/slow periods |
| 0.65 | Fade power threshold |
| 0.50 | Fade direction threshold |

### Signal Execution
| Value | Description |
|-------|-------------|
| ±1.5% | Max pain stretch threshold |
| 0.65/1.35 | PCR extremes |
| 0.8% | SGX divergence threshold |
| 1.0% | Mild max pain conflict |
| 65 | NIFTY lot size |
| ₹5–₹400 | Premium range |
| 20 | Max lots |
| 95% | Capital used |
| 13 | Strike candidates |

### Position Monitor
| Value | Description |
|-------|-------------|
| 30%/15% | Hard stop (ATM/far OTM) |
| 15%/8% | Trail gap (ATM/far OTM) |
| 10%/5% | Milestone step (ATM/far OTM) |
| 15 min | Time stop (far OTM) |
| 5% | Min gain for time stop |
| 0.15 | Far OTM delta threshold |
| 0.99/0.97/0.95 | Exit order aggression |

### Scheduler Timing
| Value | Description |
|-------|-------------|
| 5 min | Ensemble cycle (market open) |
| 15 min | Ensemble cycle (pre/post market) |
| 60 min | Ensemble cycle (off hours) |
| 5 sec | Tier-3 refresh |
| 5 sec | Signal executor |
| 5 sec | Position monitor |
| 6 hours | Token refresh |
| 2 min | First run delay after startup |

---

## 7. Trade Flow Summary — How 20 Trades Happened

```
1 AI direction (up) × 3 trading days × 4 users × re-entry after exits = 20 trades

Jul 1: 3 trades (1 user, pratik)
Jul 2: 6 trades (1 user, consistenthasher)
Jul 3: 11 trades (4 users)

All 20 trades were BUY_CALL (direction="up")
All 20 are now closed
Net P&L: -₹1,020.50

Why so many from 1 signal direction:
1. Base signal fires BUY_CALL on every snapshot (AI says "up" + max pain stretched -2.5% to -3%)
2. Each snapshot → trades for ALL users with auto-trade enabled
3. When a position exits (manual/stop), next executor cycle sees no open position → re-enters
4. Tier-3 gate rarely blocks: NONE passes through, and PUT signals fired at different times
```

---

## 8. File Map

| File | Purpose |
|------|---------|
| `services/market/scheduler.ts` | Main market scheduler (ensemble + tier3 refresh) |
| `services/market/hmm-regime.ts` | HMM regime detection |
| `services/market/ensemble.ts` | AI ensemble (3 LLM calls + vote) |
| `services/market/market-agent.ts` | Orchestrates ensemble + priceScore + FlipGuard |
| `services/market/tier3-signal.ts` | Intraday microstructure engine (pure math) |
| `services/market/tier3-fetcher.ts` | Firecrawl NSE scrape + tier3Score computation |
| `services/market/candle-trust.ts` | Volume anomaly + delivery check |
| `services/kite/kite-option-chain.ts` | Kite option chain fetch + IV/gamma/PCR/maxPain |
| `services/kite/signal-executor.ts` | Signal → trade execution |
| `services/kite/signal-executor-scheduler.ts` | 5s executor loop |
| `services/kite/position-monitor.ts` | Trailing stop + time stop + exit orders |
| `services/kite/position-monitor-scheduler.ts` | 5s position monitor loop |
| `services/kite/token-refresh-scheduler.ts` | 6h Kite token refresh |
| `lib/integrations-openai-ai-server/src/llm.ts` | Provider-agnostic LLM (Bedrock/OpenAI/Anthropic) |
| `routes/trading.ts` | REST API for frontend |

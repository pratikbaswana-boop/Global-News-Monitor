# Prediction System — Complete Engineering Change Specification

**Document purpose:** Exact, file-by-file, function-by-function specification of every change required. No vague instructions. Every field name, threshold value, formula, and prompt string is written out in full. Implement in the order given in Section 9.

---

## Table of Contents

1. [Change 1 — Tier 3 Data Fetcher (new file)](#change-1)
2. [Change 2 — Tier 1 Candle Trust Filter (new file)](#change-2)
3. [Change 3 — Context Gather Rebuild (market-agent.ts)](#change-3)
4. [Change 4 — Ensemble Window Split (ensemble.ts)](#change-4)
5. [Change 5 — priceScore Formula (ensemble.ts)](#change-5)
6. [Change 6 — Neo4j Channel Decay (pipeline.ts)](#change-6)
7. [Change 7 — Pipeline A Priced-In Detector (agent-forecaster.ts + agent-devil.ts)](#change-7)
8. [Change 8 — MarketSignal Output Fields (market-agent.ts)](#change-8)
9. [Build Order and Testing Checkpoints](#build-order)

---

## Change 1 — Tier 3 Data Fetcher {#change-1}

**New file:** `tier3-fetcher.ts`  
**Called from:** `market-agent.ts` in the context gather step, before ensemble runs  
**Cadence:** Every scheduler cycle (same as existing OHLCV fetch)

### What this file must do

Fetch six data points. Each has a specific source, update frequency, and field name. Do not rename fields — downstream code references them exactly as named here.

```typescript
export interface Tier3Snapshot {
  // --- Institutional flows ---
  fiiNetCrore: number;           // FII net buy/sell in ₹ crore. Positive = buying. Negative = selling.
  diiNetCrore: number;           // DII net buy/sell in ₹ crore.
  fiiDataDate: string;           // ISO date string. Must be checked — if > 1 day old, mark as stale.
  fiiIsStale: boolean;           // true if fiiDataDate is before yesterday's date.

  // --- Delivery quality ---
  deliveryPct: number | null;    // NSE bhav copy delivery %. null during intraday (not yet available).
  deliveryDate: string | null;   // ISO date of the bhav copy used.

  // --- Options market ---
  putCallRatio: number;          // NIFTY put/call OI ratio. Fetched live from NSE options chain.
  impliedVolPct: number;         // ATM implied volatility %. Used as fear proxy.
  openInterestChange: number;    // % change in total NIFTY OI vs prior session. Positive = new positions.

  // --- Breadth ---
  advanceCount: number;          // Number of NSE 500 stocks advancing.
  declineCount: number;          // Number of NSE 500 stocks declining.
  advanceDeclineRatio: number;   // advanceCount / declineCount. Computed, not fetched.

  // --- Macro anchors ---
  inrUsdRate: number;            // Current INR per 1 USD spot rate.
  inrUsd5dChangePct: number;     // 5-day % change. Positive = INR weakening.
  yield10Y: number;              // India 10-year government bond yield %.
  yield10Y5dChangeBps: number;   // 5-day change in basis points.
  crudeBrent: number;            // Brent crude USD per barrel.
  crude5dChangePct: number;      // 5-day % change.

  // --- VIX ---
  indiaVix: number;              // India VIX current level.
  indiaVix5dChange: number;      // 5-day absolute change in VIX points.

  fetchedAt: string;             // ISO timestamp of when this snapshot was fetched.
}
```

### Data sources (exact)

| Field | Source | URL / Method | Notes |
|---|---|---|---|
| `fiiNetCrore`, `diiNetCrore` | NSE India | `https://www.nseindia.com/api/fiidiiTradeReact` | Requires NSE session cookie. Returns JSON with `date`, `fiiNet`, `diiNet`. |
| `deliveryPct` | NSE bhav copy | `https://www.nseindia.com/products/content/sec_bhavdata_dnld.htm` | CSV download. Parse `DELIV_PER` column for NIFTY50 constituents. Only available after 18:00 IST. Return `null` before that. |
| `putCallRatio` | NSE options chain | `https://www.nseindia.com/api/option-chain-indices?symbol=NIFTY` | Parse `filtered.CE.totOI` and `filtered.PE.totOI`. PCR = PE_OI / CE_OI. |
| `impliedVolPct` | Same options chain call | Same URL as above | Use ATM strike IV from the CE side. |
| `openInterestChange` | NSE option chain + prior cache | Compute from consecutive calls | `(currentTotalOI - priorTotalOI) / priorTotalOI * 100` |
| `advanceCount`, `declineCount` | NSE market data | `https://www.nseindia.com/api/live-analysis-variations?index=nse500` | Returns advancing/declining counts. |
| `inrUsdRate`, `inrUsd5dChangePct` | RBI reference rate or Yahoo Finance `USDINR=X` | Yahoo Finance ticker `USDINR=X` | Fetch once per hour off-hours, every 15 min during session. |
| `yield10Y`, `yield10Y5dChangeBps` | CCIL or investing.com scrape | `https://www.ccil.com` or Yahoo Finance `^IRX` equivalent | India 10Y GSEC. Update every 60 min. |
| `crudeBrent`, `crude5dChangePct` | Yahoo Finance | Ticker `BZ=F` | Update every 15 min. |
| `indiaVix`, `indiaVix5dChange` | NSE | `https://www.nseindia.com/api/allIndices` | Filter for `indexSymbol === "INDIA VIX"`. |

### Staleness rules

```typescript
// Apply these checks after fetching. Mark fields stale, never throw.
if (daysSince(fiiDataDate) > 1) snapshot.fiiIsStale = true;
if (snapshot.deliveryDate && daysSince(snapshot.deliveryDate) > 1) snapshot.deliveryPct = null;
```

### Tier3Score computation

This function runs after fetching the snapshot. Output is a number from -1.0 to +1.0.

```typescript
export function computeTier3Score(s: Tier3Snapshot): number {
  let score = 0;
  let totalWeight = 0;

  // FII flows (weight: 0.25)
  if (!s.fiiIsStale) {
    const fiiScore = clamp(s.fiiNetCrore / 3000, -1, 1); // 3000 cr = full signal
    score += fiiScore * 0.25;
    totalWeight += 0.25;
  }

  // Put/call ratio (weight: 0.20)
  // PCR < 0.7 = bullish (more calls), PCR > 1.2 = bearish (more puts)
  const pcrScore = clamp((1.0 - s.putCallRatio) / 0.5, -1, 1);
  score += pcrScore * 0.20;
  totalWeight += 0.20;

  // Advance/decline ratio (weight: 0.20)
  // ADR > 1.5 = bullish, ADR < 0.67 = bearish
  const adrScore = clamp((s.advanceDeclineRatio - 1.0) / 0.5, -1, 1);
  score += adrScore * 0.20;
  totalWeight += 0.20;

  // Delivery % (weight: 0.15) — only if available
  if (s.deliveryPct !== null) {
    // > 45% = strong conviction, < 25% = intraday noise
    const delScore = clamp((s.deliveryPct - 35) / 15, -1, 1);
    score += delScore * 0.15;
    totalWeight += 0.15;
  }

  // India VIX direction (weight: 0.10)
  // Falling VIX = bullish. 5d change < -1.5 = bullish, > +1.5 = bearish
  const vixScore = clamp(-s.indiaVix5dChange / 2.0, -1, 1);
  score += vixScore * 0.10;
  totalWeight += 0.10;

  // INR strength (weight: 0.10)
  // INR weakening (positive change) = bearish for equities
  const inrScore = clamp(-s.inrUsd5dChangePct / 2.0, -1, 1);
  score += inrScore * 0.10;
  totalWeight += 0.10;

  // Normalise if some weights were skipped (e.g. delivery not available)
  return totalWeight > 0 ? clamp(score / totalWeight, -1, 1) : 0;
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}
```

---

## Change 2 — Tier 1 Candle Trust Filter {#change-2}

**New file:** `candle-trust.ts`  
**Called from:** `market-agent.ts` after OHLCV fetch, before context assembly  

### Interface

```typescript
export interface CandleTrustResult {
  trustScore: number;           // 0.0 to 1.0. 1.0 = clean. 0.2 = flagged.
  flags: CandleFlag[];          // List of flags that fired.
  tier1Score: number;           // Directional score from price: +1 up, -1 down, 0 flat.
}

export type CandleFlag =
  | 'volume_anomaly'            // Volume > 3x 20-day average
  | 'wash_trade_suspected'      // Large buy and sell at same price within same candle
  | 'low_delivery_high_move';   // Price moved > 0.5% but delivery % < 20% (intraday noise)
```

### Volume anomaly check

```typescript
export function checkCandleTrust(
  currentCandle: OHLCV,
  rollingAvgVolume20d: number,
  deliveryPct: number | null
): CandleTrustResult {
  const flags: CandleFlag[] = [];

  // Rule 1: Volume anomaly
  if (currentCandle.volume > rollingAvgVolume20d * 3) {
    flags.push('volume_anomaly');
  }

  // Rule 2: Low delivery on big move (intraday noise indicator)
  const priceMovePct = Math.abs(
    (currentCandle.close - currentCandle.open) / currentCandle.open * 100
  );
  if (priceMovePct > 0.5 && deliveryPct !== null && deliveryPct < 20) {
    flags.push('low_delivery_high_move');
  }

  // Trust score: each flag reduces trust
  let trustScore = 1.0;
  if (flags.includes('volume_anomaly')) trustScore -= 0.5;
  if (flags.includes('low_delivery_high_move')) trustScore -= 0.3;
  if (flags.includes('wash_trade_suspected')) trustScore -= 0.4;
  trustScore = Math.max(0.1, trustScore); // Never zero — price still carries some information

  // Tier1 directional score from candle
  const tier1Score = priceMovePct < 0.05 ? 0
    : currentCandle.close > currentCandle.open ? 1
    : -1;

  return { trustScore, flags, tier1Score };
}
```

**Important:** Do NOT implement the spoofing check (order-placed-then-cancelled within 30s) unless you have NSE tick-by-tick order book feed. The above two rules work with OHLCV + delivery data you already have.

---

## Change 3 — Context Gather Rebuild {#change-3}

**File:** `market-agent.ts`  
**Function:** The context assembly block that runs before `runEnsemble()`

### Current code pattern to find and replace

Find the block where `activeChannels`, `activeScenarios`, and `ohlcvSummary` are assembled into a single context string and passed to all three ensemble windows. This is the block that creates one shared context. Replace it entirely with the three-context structure below.

### New context assembly — three separate objects

```typescript
// Fetch these before building contexts
const tier3 = await fetchTier3Snapshot();               // from tier3-fetcher.ts
const tier3Score = computeTier3Score(tier3);            // from tier3-fetcher.ts
const candleTrust = checkCandleTrust(                   // from candle-trust.ts
  latestCandle,
  rollingAvgVolume20d,
  tier3.deliveryPct
);
const regimeAge = await getRegimeAge();                 // see below

// ── 6h window context (intraday only — NO closing prices) ──
const context6h = `
HORIZON: 6 hours (intraday)
CURRENT SESSION DATA (use this, not historical closes):
- Session open price: ${sessionOpenPrice}
- Current price vs open: ${((latestCandle.close - sessionOpenPrice) / sessionOpenPrice * 100).toFixed(2)}%
- Candle trust score: ${candleTrust.trustScore.toFixed(2)} (1.0=clean, <0.5=flagged)
- Candle flags: ${candleTrust.flags.length > 0 ? candleTrust.flags.join(', ') : 'none'}
- Live put/call ratio: ${tier3.putCallRatio.toFixed(2)} (below 0.8=bullish, above 1.1=bearish)
- Advance/decline ratio: ${tier3.advanceDeclineRatio.toFixed(2)} (above 1.5=bullish breadth)
- India VIX: ${tier3.indiaVix.toFixed(1)} (5d change: ${tier3.indiaVix5dChange > 0 ? '+' : ''}${tier3.indiaVix5dChange.toFixed(1)})
- Live implied volatility: ${tier3.impliedVolPct.toFixed(1)}%
HMM REGIME: ${currentRegime} (active for ${regimeAge} consecutive cycles)
REGIME INSTRUCTION: If regime says RISK_OFF but put/call ratio is below 0.85 AND advance/decline is above 1.3, explicitly state this contradiction in your rationale and do not let the regime label be the sole driver of your call.
ACTIVE GEOPOLITICAL CHANNELS (only channels with daysSinceTrigger <= 3 and decayedWeight > 0.3):
${activeChannels.filter(c => c.decayedWeight > 0.3).map(c => `- ${c.name}: weight ${c.decayedWeight.toFixed(2)}`).join('\n') || '- none active'}
Return JSON: { "call": "BULLISH" | "BEARISH" | "NEUTRAL", "confidence": 0.0-1.0, "rationale": "string max 80 words" }
`.trim();

// ── 24h window context (yesterday + Tier 3 conviction — no intraday price) ──
const context24h = `
HORIZON: 24 hours (next session)
YESTERDAY'S CLOSE DATA:
- NIFTY close: ${yesterdayClose.nifty}
- SENSEX close: ${yesterdayClose.sensex}
- Session return: ${yesterdayClose.returnPct.toFixed(2)}%
INSTITUTIONAL CONVICTION (this is the primary signal for this window):
- FII net flow: ₹${tier3.fiiNetCrore.toFixed(0)} crore ${tier3.fiiIsStale ? '[WARNING: stale data]' : ''}
- DII net flow: ₹${tier3.diiNetCrore.toFixed(0)} crore
- Delivery %: ${tier3.deliveryPct !== null ? tier3.deliveryPct.toFixed(1) + '%' : 'not yet available (intraday)'}
- Open interest change: ${tier3.openInterestChange > 0 ? '+' : ''}${tier3.openInterestChange.toFixed(1)}% (positive=new positions=conviction)
- Put/call ratio: ${tier3.putCallRatio.toFixed(2)}
MACRO (secondary signal):
- INR/USD: ${tier3.inrUsdRate.toFixed(2)} (5d change: ${tier3.inrUsd5dChangePct > 0 ? '+' : ''}${tier3.inrUsd5dChangePct.toFixed(2)}%)
- 10Y yield: ${tier3.yield10Y.toFixed(2)}% (5d change: ${tier3.yield10Y5dChangeBps > 0 ? '+' : ''}${tier3.yield10Y5dChangeBps.toFixed(0)} bps)
HMM REGIME: ${currentRegime} (active for ${regimeAge} cycles)
REGIME INSTRUCTION: If FII net is positive AND delivery % exceeds 38%, treat this as a potential regime transition away from RISK_OFF regardless of the HMM label. State this explicitly in your rationale.
PRICED-IN CONTEXT:
${activeScenariosWithDecay.map(s => `- ${s.label}: ${s.alreadyTransmitted ? '[ALREADY TRANSMITTED to market on ' + s.transmissionDate + ', decay factor ' + s.decayFactor.toFixed(2) + ']' : 'active'}`).join('\n') || '- no active scenarios'}
Return JSON: { "call": "BULLISH" | "BEARISH" | "NEUTRAL", "confidence": 0.0-1.0, "rationale": "string max 80 words" }
`.trim();

// ── 72h window context (macro only — ZERO recent price data) ──
const context72h = `
HORIZON: 72 hours (3 sessions)
IMPORTANT: Do not use recent price action. Your signal comes from structural macro and options market only.
MACRO STRUCTURAL SIGNALS:
- Brent crude: $${tier3.crudeBrent.toFixed(1)} (5d change: ${tier3.crude5dChangePct > 0 ? '+' : ''}${tier3.crude5dChangePct.toFixed(1)}%)
- INR/USD 5d trend: ${tier3.inrUsd5dChangePct > 0 ? 'INR weakening +' : 'INR strengthening '}${Math.abs(tier3.inrUsd5dChangePct).toFixed(2)}%
- 10Y yield 5d trend: ${tier3.yield10Y5dChangeBps > 0 ? 'rising +' : 'falling '}${Math.abs(tier3.yield10Y5dChangeBps).toFixed(0)} bps
- India VIX 5d change: ${tier3.indiaVix5dChange > 0 ? '+' : ''}${tier3.indiaVix5dChange.toFixed(1)} points
OPTIONS STRUCTURE (3-day view):
- Put/call ratio: ${tier3.putCallRatio.toFixed(2)}
- Implied volatility: ${tier3.impliedVolPct.toFixed(1)}%
- OI change trend: ${tier3.openInterestChange > 0 ? 'building' : 'unwinding'} (${tier3.openInterestChange > 0 ? '+' : ''}${tier3.openInterestChange.toFixed(1)}%)
ACTIVE GEOPOLITICAL SCENARIOS (structural, 72h view):
${activeScenariosWithDecay.map(s => `- ${s.label} (prob: ${(s.probability * 100).toFixed(0)}%, channel: ${s.channel}, decay: ${s.decayFactor.toFixed(2)})`).join('\n') || '- none'}
HMM REGIME: ${currentRegime} (${regimeAge} cycles). Weight this at 30% of your reasoning. Macro signals above are 70%.
Return JSON: { "call": "BULLISH" | "BEARISH" | "NEUTRAL", "confidence": 0.0-1.0, "rationale": "string max 80 words" }
`.trim();
```

### regimeAge implementation

Add this function to `market-agent.ts` or a shared utility:

```typescript
async function getRegimeAge(): Promise<number> {
  // Query market_regimes table. Count consecutive rows where regime = currentRegime
  // ordered by createdAt DESC. Stop counting when regime changes.
  const rows = await db.query(`
    SELECT regime FROM market_regimes
    ORDER BY created_at DESC
    LIMIT 200
  `);
  const current = rows[0]?.regime;
  let age = 0;
  for (const row of rows) {
    if (row.regime === current) age++;
    else break;
  }
  return age;
}
```

---

## Change 4 — Ensemble Window Split {#change-4}

**File:** `ensemble.ts`  
**Function:** The function that runs three parallel GPT-4o calls

### Current pattern to find

Find where three GPT-4o calls are made with the same `systemPrompt` and same `userContent`. All three currently receive identical context.

### Change

Pass each window its own context string (built in Change 3). The system prompt per window changes. Replace the single system prompt with three:

```typescript
// System prompts — one per window. Do not share.

const systemPrompt6h = `You are a quantitative analyst assessing Indian equity market direction for the INTRADAY (6 hour) horizon. You specialise in reading live market microstructure: candle quality, options flow, and breadth. You do not extrapolate multi-day trends. You assess only what the next 6 hours look like based on the data given. If candle trust score is below 0.5, heavily discount the price signal and rely on put/call ratio and advance/decline instead. Return only valid JSON with fields: call, confidence, rationale.`;

const systemPrompt24h = `You are a quantitative analyst assessing Indian equity market direction for the NEXT SESSION (24 hour) horizon. Your primary inputs are institutional conviction signals: FII/DII flows, delivery percentage, and open interest change. Price action from yesterday is context only — not your primary signal. If FII net is positive and delivery % exceeds 38%, this is strong bullish conviction even if yesterday's price was flat or down. If regime says RISK_OFF but institutional signals are bullish, explicitly flag the contradiction and lean toward the institutional data. Return only valid JSON with fields: call, confidence, rationale.`;

const systemPrompt72h = `You are a macro analyst assessing Indian equity market direction for the 72 HOUR (3 session) horizon. You must not use recent price action in your reasoning. Your inputs are structural: crude oil trend, INR direction, bond yield direction, VIX trend, options structure, and geopolitical scenario probabilities. A falling VIX + stable INR + flat crude = structurally supportive regardless of recent price. Weight macro signals at 70% and the HMM regime label at 30%. Return only valid JSON with fields: call, confidence, rationale.`;

// Run in parallel — each window gets its own system prompt and its own context
const [vote6h, vote24h, vote72h] = await Promise.all([
  callGPT4o(systemPrompt6h, context6h),
  callGPT4o(systemPrompt24h, context24h),
  callGPT4o(systemPrompt72h, context72h),
]);
```

---

## Change 5 — priceScore Formula {#change-5}

**File:** `ensemble.ts`  
**Location:** The scoring block after votes are collected, before `MarketSignal` is assembled

### Remove entirely

```typescript
// DELETE THIS — do not keep any version of it
const bullScore = bullVotes * 3 + (finalCall === 'BULLISH' ? 1 : 0);
const bearScore = bearVotes * 3 + (finalCall === 'BEARISH' ? 1 : 0);
```

### Replace with

```typescript
// Tier3Score comes from computeTier3Score() called in context gather (Change 3)
// candleTrust comes from checkCandleTrust() called in context gather (Change 3)
// Both must be passed into this scoring function.

function computePriceScore(
  tier3Score: number,
  candleTrust: CandleTrustResult,
  votes: { call: string; confidence: number }[]
): { priceScore: number; direction: 'up' | 'down' | 'uncertain'; flipReady: boolean } {

  // Tier1 contribution: directional vote from candle, scaled by trust and confidence
  const avgConfidence = votes.reduce((s, v) => s + v.confidence, 0) / votes.length;
  const tier1Contribution = candleTrust.tier1Score * candleTrust.trustScore * avgConfidence;

  // Final weighted score
  const priceScore = (tier3Score * 0.7) + (tier1Contribution * 0.3);

  // Direction thresholds
  let direction: 'up' | 'down' | 'uncertain';
  if (priceScore > 0.20) direction = 'up';
  else if (priceScore < -0.20) direction = 'down';
  else direction = 'uncertain';

  return { priceScore, direction, flipReady: true }; // flipReady used by Change 5b below
}
```

### Change 5b — Two-cycle flip confirmation

Add a flip guard. This runs after `computePriceScore()`.

```typescript
// In market-agent.ts, maintain this state across cycles (store in memory or DB)
interface FlipGuard {
  pendingDirection: 'up' | 'down' | 'uncertain' | null;
  pendingCount: number;   // How many consecutive cycles this pending direction has held
  confirmedDirection: 'up' | 'down' | 'uncertain';
}

function applyFlipGuard(
  guard: FlipGuard,
  newDirection: 'up' | 'down' | 'uncertain'
): { emitFlip: boolean; confirmedDirection: 'up' | 'down' | 'uncertain'; updatedGuard: FlipGuard } {

  if (newDirection === guard.confirmedDirection) {
    // No change — reset pending
    return {
      emitFlip: false,
      confirmedDirection: guard.confirmedDirection,
      updatedGuard: { pendingDirection: null, pendingCount: 0, confirmedDirection: guard.confirmedDirection }
    };
  }

  if (newDirection === guard.pendingDirection) {
    // Second consecutive cycle pointing same new direction — confirm the flip
    if (guard.pendingCount >= 1) {
      return {
        emitFlip: true,
        confirmedDirection: newDirection,
        updatedGuard: { pendingDirection: null, pendingCount: 0, confirmedDirection: newDirection }
      };
    } else {
      // First cycle with this new direction — hold, wait for next
      return {
        emitFlip: false,
        confirmedDirection: guard.confirmedDirection,
        updatedGuard: { pendingDirection: newDirection, pendingCount: guard.pendingCount + 1, confirmedDirection: guard.confirmedDirection }
      };
    }
  }

  // Different new direction than pending — reset pending to this new one
  return {
    emitFlip: false,
    confirmedDirection: guard.confirmedDirection,
    updatedGuard: { pendingDirection: newDirection, pendingCount: 1, confirmedDirection: guard.confirmedDirection }
  };
}
```

**Store `FlipGuard` per asset.** Seven assets = seven FlipGuard instances. Store in a `Map<string, FlipGuard>` keyed by asset symbol (e.g. `'NIFTY'`, `'HDFCBANK'`). Persist to `market_regimes` table or a new `flip_guards` table with columns: `asset`, `pending_direction`, `pending_count`, `confirmed_direction`, `updated_at`.

---

## Change 6 — Neo4j Channel Decay {#change-6}

**File:** `pipeline.ts`  
**Location:** Stage 1 (Neo4j Subgraph Fetch) and wherever `activeChannels` are loaded for Pipeline B

### Add to the Neo4j query result processing

After fetching active transmission channels from Neo4j, apply decay before passing to any downstream consumer:

```typescript
interface ActiveChannel {
  channelId: string;
  name: string;
  rawWeight: number;
  storyId: string;
  triggerDate: string;       // ISO date when this story first activated this channel
  daysSinceTrigger: number;  // Computed field — add this
  decayedWeight: number;     // Computed field — add this
  isActive: boolean;         // decayedWeight > 0.1
}

function applyChannelDecay(channels: RawChannel[]): ActiveChannel[] {
  const today = new Date();
  return channels.map(ch => {
    const triggerDate = new Date(ch.triggerDate);
    const daysSinceTrigger = Math.floor(
      (today.getTime() - triggerDate.getTime()) / (1000 * 60 * 60 * 24)
    );

    // Decay: 50% per day after day 0. Day 0 = full weight. Day 1 = 50%. Day 2 = 25%. Day 3 = 12.5%.
    const decayFactor = Math.pow(0.5, Math.max(0, daysSinceTrigger - 1));
    const decayedWeight = ch.rawWeight * decayFactor;

    return {
      ...ch,
      daysSinceTrigger,
      decayedWeight,
      isActive: decayedWeight > 0.1
    };
  }).filter(ch => ch.isActive); // Drop channels that have decayed below threshold
}
```

**Where to call this:**

1. In `pipeline.ts` Stage 1 — after Neo4j subgraph fetch, before passing channels to Agent A.
2. In `market-agent.ts` context gather — after fetching `activeChannels` from Neo4j, before building context strings.

**Neo4j schema change required:** The `TRANSMITS_TO` relationship between Story nodes and Channel nodes must store a `triggerDate` property. If it does not currently exist, add it when the relationship is created in `pipeline.ts` Stage 6 (Pipeline Write to DB). Set `triggerDate = new Date().toISOString()` at write time.

```typescript
// In pipeline.ts Stage 6, when writing dominantChannel to DB and Neo4j:
await neo4j.run(`
  MATCH (s:Story {id: $storyId})-[r:TRANSMITS_TO]->(c:Channel {id: $channelId})
  SET r.triggerDate = $triggerDate, r.rawWeight = $weight
`, {
  storyId,
  channelId: dominantChannel,
  triggerDate: new Date().toISOString(),
  weight: dominantChannelWeight
});
```

---

## Change 7 — Pipeline A Priced-In Detector + News-to-Price Gate {#change-7}

### Change 7a — Priced-In Detector

**File:** `agent-forecaster.ts`  
**Location:** Before Agent C system prompt is assembled, add a pre-check

```typescript
interface PricedInResult {
  alreadyTransmitted: boolean;
  transmissionDate: string | null;   // Date when market reacted
  marketMoveOnTriggerDay: number;    // NIFTY % move on the story's trigger date
  decayFactor: number;               // How much to discount forward bearishness
}

async function checkIfPricedIn(storyId: string, storyTriggerDate: string): Promise<PricedInResult> {
  // Fetch NIFTY OHLCV for the storyTriggerDate
  const niftyOnTriggerDay = await fetchNiftyClose(storyTriggerDate);
  const marketMovePct = niftyOnTriggerDay.returnPct; // % change that day

  const alreadyTransmitted = Math.abs(marketMovePct) > 0.5;
  const daysSince = daysBetween(storyTriggerDate, new Date().toISOString());

  // If already transmitted, decay increases with days since trigger
  const decayFactor = alreadyTransmitted
    ? Math.max(0.1, 1.0 - (daysSince * 0.3))   // Day 0: 1.0, Day 1: 0.7, Day 2: 0.4, Day 3: 0.1
    : 1.0;

  return {
    alreadyTransmitted,
    transmissionDate: alreadyTransmitted ? storyTriggerDate : null,
    marketMoveOnTriggerDay: marketMovePct,
    decayFactor
  };
}
```

**Inject into Agent C (Forecaster) system prompt:**

Find the current Agent C system prompt string in `agent-forecaster.ts`. It currently reads:

> "You are a probabilistic forecaster specialising in geopolitical risk. You generate exactly 3 scenarios covering the full probability space. Probabilities must sum to 1.0."

Append the following block to this system prompt. Do not replace the existing text — add after it:

```
PRICED-IN RULE (mandatory):
You will be given a field called pricedInContext. If alreadyTransmitted is true, it means the market already reacted to this story with a move of {marketMoveOnTriggerDay}% on {transmissionDate}. In this case:
1. Do not forecast continued directional impact in the same direction as the initial move.
2. Reduce the probability of your dominant bearish or bullish scenario by the decayFactor ({decayFactor}).
3. Increase the probability of your "status_quo" or "consolidation" scenario accordingly.
4. In the narrative field for the dominant scenario, explicitly write: "Note: market already absorbed {marketMoveOnTriggerDay}% move on {transmissionDate}. Residual impact estimated at {decayFactor * 100}% of original."
If alreadyTransmitted is false, proceed normally.
```

**Pass pricedInContext into Agent C call:**

```typescript
// In agent-forecaster.ts, before calling GPT-4o:
const pricedIn = await checkIfPricedIn(story.id, story.triggerDate);

const userContent = `
${existingForecasterUserContent}

pricedInContext: ${JSON.stringify(pricedIn)}
`;
```

### Change 7b — News-to-Price Correlation Gate (Agent D)

**File:** `agent-devil.ts`  
**Location:** Add to Agent D system prompt and user content

Find the current Agent D system prompt:

> "You are a Devil's Advocate analyst. You receive a probabilistic forecast and systematically identify its weakest points. You do not see the underlying intelligence — only the forecast. Your job is to stress-test it."

Append to Agent D system prompt:

```
CHANNEL VALIDATION RULE (mandatory):
You will be given a field called channelValidation — a list of transmission channels the Forecaster cited, each with a priceMovedOnChannel boolean.
For each channel where priceMovedOnChannel is false: the Forecaster cited this channel but the market did not actually react to it during the story's active window. You MUST flag this in ignoredSignals. Write: "Channel [{channelName}] was cited but market showed no reaction (0.0% move in relevant window). This channel may be inactive for this story."
Reduce the probability of any scenario that depends primarily on an unvalidated channel by 15 percentage points and redistribute to the status_quo scenario.
```

**Add channelValidation to Agent D user content:**

```typescript
// In agent-devil.ts, build channel validation before calling GPT-4o:
const channelValidation = await Promise.all(
  forecasterTree.scenarios
    .flatMap(s => s.transmissionChannelIds)
    .filter((v, i, a) => a.indexOf(v) === i) // deduplicate
    .map(async channelId => {
      const channelMove = await fetchMarketMoveForChannel(channelId, story.triggerDate);
      return {
        channelId,
        channelName: channelId,
        priceMovedOnChannel: Math.abs(channelMove) > 0.3,   // 0.3% threshold
        actualMove: channelMove
      };
    })
);

// Add to Agent D user content:
const devilUserContent = `
${existingDevilUserContent}

channelValidation: ${JSON.stringify(channelValidation)}
`;
```

**`fetchMarketMoveForChannel` implementation:**

```typescript
// Maps channel IDs to the relevant market instrument to check
const CHANNEL_TO_INSTRUMENT: Record<string, string> = {
  'crude_oil_spike':         'BZ=F',
  'crude_oil_drop':          'BZ=F',
  'usd_inr_depreciation':    'USDINR=X',
  'fii_risk_off':            'fiiNetCrore',    // check FII data, not a price ticker
  'global_risk_off':         'NIFTY',
  'fed_hawkish_signal':      'yield10Y',
  'middle_east_conflict':    'BZ=F',
  'rbi_surprise_action':     'NIFTY',
  'china_trade_escalation':  'NIFTY',
  'russia_sanctions_tighten':'BZ=F',
};

async function fetchMarketMoveForChannel(
  channelId: string,
  triggerDate: string
): Promise<number> {
  const instrument = CHANNEL_TO_INSTRUMENT[channelId];
  if (!instrument) return 0;
  if (instrument === 'fiiNetCrore') {
    const fii = await fetchFiiForDate(triggerDate);
    return fii.netCrore / 1000; // scale to percentage-like for comparison
  }
  return await fetchInstrumentReturnOnDate(instrument, triggerDate);
}
```

---

## Change 8 — MarketSignal Output Fields {#change-8}

**File:** `market-agent.ts`  
**Interface:** `MarketSignal`

### Add these fields to the existing MarketSignal interface

```typescript
export interface MarketSignal {
  // ── Existing fields (do not remove) ──
  direction: 'up' | 'down' | 'neutral' | 'uncertain';
  magnitude: 'strong' | 'moderate' | 'mild';
  confidence: 'high' | 'medium' | 'low';
  timeframe: 'intraday' | 'next-session';
  regime: string;
  regimeProbabilities: { riskOn: number; riskOff: number; crisis: number };
  activeGeopoliticalScenarios: any[];
  ensembleVotes: { call: string; confidence: number; rationale: string }[];
  uncertaintyFlag: boolean;

  // ── New fields (add these) ──
  priceScore: number;              // -1.0 to +1.0. The weighted score before thresholding.
  flipConfirmed: boolean;          // True only if direction changed AND held for 2 consecutive cycles.
  tier3Evidence: {                 // Which Tier 3 signals drove the score. Auditable.
    fiiNetCrore: number;
    fiiIsStale: boolean;
    putCallRatio: number;
    advanceDeclineRatio: number;
    deliveryPct: number | null;
    indiaVix5dChange: number;
    tier3Score: number;            // The computed Tier3Score before weighting.
  };
  candleTrustScore: number;        // 0.0–1.0. From Tier 1 filter.
  candleFlags: string[];           // List of flags that fired on this cycle's candle.
  regimeAge: number;               // Consecutive cycles HMM has been in current state.
  channelDecaySummary: {           // Active channels after decay.
    channelId: string;
    decayedWeight: number;
    daysSinceTrigger: number;
  }[];
}
```

### Remove from MarketSignal output display (keep in interface for backward compat but stop using for decisions)

```typescript
// These are now computed internally only. Do not use them as the signal.
// bullScore and bearScore remain in the interface for logging only.
// They must NOT drive direction or magnitude decisions.
bullScore: number;   // deprecated — log only
bearScore: number;   // deprecated — log only
```

---

## Change 9 — Build Order and Testing Checkpoints {#build-order}

### Week 1 — Data foundation

**Day 1–2:** Build `tier3-fetcher.ts`. Test each data source independently. Confirm `Tier3Snapshot` populates without null values during market hours. Log every fetch. Do not connect to ensemble yet.

**Day 3:** Build `candle-trust.ts`. Unit test with synthetic candles: (a) normal candle → trust=1.0, (b) 4× volume candle → trust=0.5, (c) big move + low delivery → trust=0.7.

**Day 4–5:** Implement channel decay in `pipeline.ts` and `market-agent.ts`. Verify with a query: pick any story older than 3 days in Neo4j, confirm its channel weight is below 0.15 after decay.

**Testing checkpoint Week 1:** Run the system in shadow mode — existing system still drives decisions, new Tier 3 fetch runs in parallel and logs its output. Compare: on days when Tier 3Score is positive but old system says DOWN, flag these as "would-have-flipped" cases. Log for 5 trading days before proceeding.

### Week 2 — Context and scoring

**Day 1–3:** Rebuild context gather with three temporal slices. Deploy new system prompts per window. Run shadow mode — log all three window votes and new priceScore alongside old bullScore/bearScore.

**Day 4–5:** Replace `bullScore` formula with `priceScore` formula. Implement FlipGuard. Test: on a day with intraday oscillation, confirm flip count is ≤ 2 (was likely 4–6 before).

**Testing checkpoint Week 2:** Count: how many times did `flipConfirmed = true` fire in a week? Target is 0–2 per asset per day. If higher, the +0.20 threshold needs adjusting upward.

### Week 3 — Pipeline A fixes

**Day 1–3:** Build `checkIfPricedIn()`. Test with May 15 NIFTY data (the crash day). On May 16, the function should return `alreadyTransmitted: true`, `marketMoveOnTriggerDay: -1.58`, `decayFactor: 0.7`. On May 17 it should return `decayFactor: 0.4`. On May 18: `decayFactor: 0.1`.

**Day 4–5:** Add `channelValidation` to Agent D. Test with the H-1B / TCS case: fetch TCS return on the day the H-1B story triggered. Confirm `priceMovedOnChannel: false` fires when TCS moved less than 0.3%.

**Testing checkpoint Week 3:** For the last 10 resolved predictions in `prediction_v2`, compute what the `channelValidation` would have returned. How many cited channels were actually inactive? If > 40%, the system was consistently hallucinating transmission.

### Week 4 — Hardening

**Day 1–2:** Add `regimeAge` counter. Add `tier3Evidence` and `channelDecaySummary` to MarketSignal output. Verify these fields appear in API responses and are stored to DB.

**Day 3–4:** Backtest on May 16–18 data manually. Feed the real FII, delivery %, put/call, advance/decline numbers from those days into the new system. Verify priceScore comes out positive or neutral (not negative) on May 17 morning.

**Day 5:** Performance review. Run the "echo test" described below.

### Echo test (run after Week 4)

For every direction change emitted in the past 30 trading days (using old system logs):

```
For each flip in history:
  Look at the candle BEFORE the flip.
  Did price already move in the flip direction in that candle?
  If yes → that flip was an echo.

echoRate = echFlips / totalFlips
```

Target: echo rate below 40% for the new system (vs likely 60–80% for old system). If echo rate is still above 40%, tighten the direction threshold from 0.20 to 0.25.

---

## Summary of All Field and Formula Changes

| Location | What changed | Old value | New value |
|---|---|---|---|
| `ensemble.ts` | Score formula | `bullVotes * 3 + bonus` | `tier3Score * 0.7 + trust * tier1 * 0.3` |
| `ensemble.ts` | Direction threshold | majority vote categorical | priceScore > +0.20 = UP, < -0.20 = DOWN |
| `ensemble.ts` | Flip rule | every cycle | 2 consecutive cycles required |
| `ensemble.ts` | Window context | all three identical | three separate temporal slices |
| `market-agent.ts` | Context: 6h | last close price | session open price only |
| `market-agent.ts` | Context: 72h | OHLCV + news | Tier 3 macro only, zero price |
| `pipeline.ts` | Channel weight | static rawWeight | rawWeight × 0.5^(daysSinceTrigger-1) |
| `agent-forecaster.ts` | Scenario probabilities | unconstrained | decayed by pricedIn.decayFactor if transmitted |
| `agent-devil.ts` | Critique inputs | forecast only | forecast + channelValidation |
| `MarketSignal` | Output fields | bullScore, bearScore | priceScore, flipConfirmed, tier3Evidence, candleTrustScore, regimeAge |
| Neo4j | Channel relationship | no triggerDate | triggerDate property added at write time |

---

*End of specification. Total changes: 8 functional changes across 6 files, 2 new files, 1 schema change.*

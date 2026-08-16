# AMF Decision Log — Aumorphic Future Maker

All product decisions, technical choices, and their reasoning are documented here
so future decisions can reference the full context.

---

## 2026-08-15 — Crypto Trading System: Architecture & Implementation Plan

### Context

The existing system is a mature, production-grade **Indian NSE/NIFTY options + equity
swing trading platform** with deep Kite/NSE coupling at every layer — data feed
(KiteTicker WebSocket), signal engine (option-chain microstructure: OI/IV/gamma/PCR),
order execution (Kite placeOrder), and HMM regime detection (India VIX/INR-USD/PCR).

User asked: "how far is our system from crypto trading" and then
"re-use as much as we can, high performance, learn from open-source algo trading,
plan for maximum profit, and don't hurt the existing working thing."

### Research conducted

1. **Open-source framework survey**: Freqtrade (53K stars, Python, CCXT-based),
   Hummingbot (19K stars, Python/Cython, HFT market-making focus, Apache-2.0),
   NautilusTrader (Rust core + Python control plane, event-driven actor model),
   NexusTrader (execution reliability layer, idempotent orders, ACK timeout recovery),
   Gryphon (battle-tested market-making, $8B traded).

2. **Academic microstructure research**:
   - Frontiers paper: OFI, Corwin-Schultz spread, realized vol, momentum are top
     predictors. At 5-min horizon with retail fees (20bps), all signals produce
     negative Sharpe — maker execution is mandatory.
   - arxiv 2602.00776: Same feature families dominate across BTC/LTC/ETC/ENJ/ROSE.
     OFI has monotone effect, SHAP dependence shapes consistent across assets.
   - ScienceDirect: Order flow explains crypto returns cross-sectionally.
     Weekly long-short alpha 1.83%, Sharpe 1.93.

3. **India crypto tax analysis**: 1% TDS per sell (Section 115BBH) makes HFT from
   Indian exchanges capital-prohibitive. Workaround: trade on Binance Global / Bybit
   (no TDS at source), owe 30% flat tax at filing.

### Decision

Build a **parallel crypto trading module** that reuses ~70% of existing intelligence
(news pipeline, embeddings, ChromaDB, Neo4j, HMM structure, position management,
direction EMA, backtest framework, UI broadcast) and builds ~30% new (exchange
connectors, order book feed, crypto-native signal engine, execution layer).

### Architecture principles

1. **Additive only** — crypto code lives in `services/crypto/`, NSE code in
   `services/kite/` and `services/market/` is never modified.
2. **Direct WebSocket** to Binance/Bybit (not CCXT) for the hot path — CCXT adds
   5-20ms overhead. CCXT only for REST fallback/admin.
3. **Actor-model event bus** — adapt the existing `marketTicker` EventEmitter
   pattern. Each component (feed, signal, executor, risk) subscribes to events.
4. **Order tracking before ACK** (Hummingbot/NexusTrader pattern) — track orders
   locally before exchange confirms. REST-confirm on timeout.
5. **Idempotent orders** — use `clientOrderId` to prevent duplicates on retry.
6. **Maker-only execution** for HFT signals — taker fees kill the microstructure
   edge per the research.
7. **News + microstructure fusion** — our unique moat. No open-source bot
   combines LLM news analysis with order-book microstructure.

### Signal engine design

**Microstructure signals (fast path, 1-5 min):**
- Order Flow Imbalance (OFI) — top-5 bid/ask depth ratio
- Momentum — 5/30/60-min (reuse direction EMA math from tier3-signal.ts)
- Corwin-Schultz spread proxy
- Funding rate (perps) — replaces PCR as sentiment
- Liquidation cascade detection

**News intelligence (medium path, 15min-4hr):**
- Reuse existing ingestion → embedding → ChromaDB → GPT-4o pipeline
- Add crypto RSS feeds (CoinDesk, The Block, CoinTelegraph, Decrypt)
- Add crypto keywords to BREAKING_DRIVERS and ASSET_MATCHERS

**Fusion gate:** Microstructure signal must align with news bias. Disagree → no
trade. Agree → high conviction, larger size.

### Profit strategies

1. **News-momentum fusion** (primary alpha, 15min-4hr hold, Sharpe 1.5-2.5)
2. **Order book imbalance** (HFT alpha, 1-5min hold, maker-only, Sharpe 0.5-1.5)
3. **Funding rate arbitrage** (low-risk income, 8hr-7day hold, Sharpe 2-4)
4. **Liquidation cascade prediction** (tail event, 5-30min hold, rare but high payoff)

### Risk controls

- Start on Binance testnet for 2 weeks
- Max 5% capital per trade, 3x leverage initially, scale to 10x after Sharpe > 1.5
- Max 3% daily drawdown → halt
- Max 3 concurrent positions
- Kill switch on WS feed drop > 30s

### NSE safety guarantee

These files are NEVER modified:
- `kite/**`, `market/tier3-signal.ts`, `market/scheduler.ts`, `market/hmm-regime.ts`
- `kite/signal-executor.ts`, `kite/market-ticker.ts`
- All NSE DB tables

Only additive changes to shared files:
- `ingestion/feed-registry-seed.ts` — add crypto feeds
- `ingestion/scheduler.ts` — add crypto keywords to BREAKING_DRIVERS
- `market/stock-news.ts` — add crypto asset matchers
- DB schema — add new tables, don't modify existing

### Implementation phases

- **Phase 1 (Week 1)**: Data foundation — exchange WS connectors, order book feed,
  crypto universe, crypto news feeds. No trading.
- **Phase 2 (Week 2)**: Signal engine — OFI, momentum, funding, liquidation signals,
  crypto HMM, news fusion gate. Paper trading only.
- **Phase 3 (Week 3)**: Execution — broker adapter, Binance REST, order tracker,
  risk engine. Live trading with small size.
- **Phase 4 (Week 4)**: Optimization — backtest, fee optimization, multi-exchange
  arbitrage, funding arb, performance dashboard.

---

## Phase 1-2 Implementation Log (Aug 2026)

### Phase 1: Data Foundation — COMPLETE

**Files created:**
- `services/crypto/universe.ts` — 9 crypto assets (BTC, ETH, SOL, BNB, XRP + 4 inactive) with news drivers
- `services/crypto/types.ts` — All normalized domain types
- `services/crypto/event-bus.ts` — Actor-model typed event dispatch
- `services/crypto/exchanges/binance-ws.ts` — Direct Binance WS connector with watchdog + auto-reconnect
- `services/crypto/feeds/orderbook-feed.ts` — Order book normalizer (OFI, spread, depth imbalance, trade flow)

**Additive changes to shared files (no NSE logic modified):**
- `feed-registry-seed.ts` — 7 crypto RSS feeds added (CoinDesk, CoinTelegraph, The Block, Decrypt, Bitcoinist, CryptoSlate, NewsBTC)
- `ingestion/scheduler.ts` — 15 crypto breaking news keywords added to BREAKING_DRIVERS
- `market/stock-news.ts` — 5 crypto asset matchers (btc, eth, sol, bnb, xrp) added to ASSET_NEWS_DRIVERS

### Phase 2: Signal Engine + Paper Trading — COMPLETE

**Signal engine (`services/crypto/signals/crypto-signal-engine.ts`):**
- Fused score: OFI (30%) + momentum (25%) + funding (10%) + liquidation (10%) + news (15%) + regime (10%)
- Momentum: 5/30/60-min EMA blend, vol-scaled
- News-microstructure fusion gate: if news and microstructure disagree → NO_TRADE
- Confidence threshold: 0.45, deadzone: 0.08
- Outputs: direction (LONG/SHORT/NO_TRADE), confidence, entry/SL/TP, component breakdown

**HMM regime detector (`services/crypto/regime/crypto-hmm.ts`):**
- 4-state Gaussian HMM: trending_bull, trending_bear, ranging, volatile
- Viterbi decoding with 24-observation lookback
- Features: BTC realized vol (24h), BTC dominance, avg funding rate, DXY
- Initial parameters are educated priors — to be retrained with Baum-Welch on historical data

**Macro feature fetcher (`services/crypto/feeds/macro-fetcher.ts`):**
- Polls CoinGecko for BTC dominance (free, no key)
- Computes BTC realized vol from Binance 1h klines
- Tracks avg funding rate from WS stream
- DXY from FRED API (if key configured, else fallback)
- Runs every 5 minutes

**News bias bridge (`services/crypto/feeds/news-bias-bridge.ts`):**
- Queries crypto-tagged articles from existing DB (reuses articleAssetTagsTable)
- GPT-4o classifies sentiment as bullish/bearish/neutral per asset
- Feeds bias score (-1..1) into signal engine via setNewsBias()
- Runs every 15 minutes

**Risk engine (`services/crypto/risk/crypto-risk-engine.ts`):**
- Max position: 5% of capital (configurable)
- Max leverage: 3x (configurable)
- Max daily drawdown: 3% (configurable)
- Max concurrent positions: 3
- Kill switch on data feed stall (30s) or drawdown breach
- Position sizing scales with confidence (0.5x at threshold, 1.5x at high confidence)

**Position manager (`services/crypto/execution/position-manager.ts`):**
- Trailing stop ratchet (0.5% trail)
- Take profit at 1.5% (3:1 RR)
- Client-side stop management (not exchange-side)
- No EOD squareoff (crypto is 24/7)

**Binance REST executor (`services/crypto/exchanges/binance-rest.ts`):**
- HMAC-SHA256 signed requests
- Order placement, cancellation, balance/position queries
- Persists orders to `crypto_orders` table
- Maker-only orders (GTX timeInForce) to minimize fees

**DB schema:**
- `lib/db/src/schema/crypto-orders.ts` — `crypto_orders` table
- `lib/db/src/schema/crypto-positions.ts` — `crypto_positions` table
- `lib/db/drizzle/crypto_tables.sql` — Migration SQL with indexes

**Backtest engine (`services/crypto/backtest/`):**
- `klines-downloader.ts` — Downloads historical OHLCV from Binance public API
- `backtest-engine.ts` — Replays candles through signal logic, computes Sharpe/win-rate/max-DD/P&L
- Approximates OFI from candle data (body ratio × volume weight × direction)
- Fee model: 10bps taker + 2bps slippage

**API routes (`routes/crypto.ts`):**
- GET /crypto/status — module status
- GET /crypto/positions — open positions
- GET /crypto/signals — signal state per symbol
- GET /crypto/regime — current market regime
- GET /crypto/risk — risk engine status
- GET /crypto/balance — exchange balance
- POST /crypto/backtest — run backtest
- GET /crypto/performance — aggregate metrics

**WebSocket broadcast (`services/crypto/crypto-ws-broadcaster.ts`):**
- New "crypto" channel added to ws-hub
- Broadcasts signals, regime changes, position updates, order updates to UI

**Configuration (`.env`):**
- CRYPTO_TRADING_ENABLED=true
- CRYPTO_PAPER_MODE=true (paper trading, no real orders)
- CRYPTO_CAPITAL_USDT=10000 (virtual capital)
- BINANCE_TESTNET=false (mainnet keys verified, account active with 0 balance)
- BINANCE_API_KEY/SECRET configured
- Risk limits: 5% position, 3x leverage, 3% drawdown, 3 concurrent

### Safety verification
- TypeScript: zero new errors from crypto code (one pre-existing TS6305 from integrations package also affects existing intelligence.ts)
- NSE code: zero modifications to kite/, market/tier3-signal.ts, market/hmm-regime.ts, or any NSE-specific file
- Crypto module only starts when CRYPTO_TRADING_ENABLED=true
- Paper mode is default — no real orders placed
- All crypto code lives in services/crypto/ — fully isolated

### Next steps
- Run `drizzle-kit push` to create the DB tables on EC2
- Deploy to EC2 and verify live Binance WS data ingestion
- Run backtest via POST /crypto/backtest to validate signal logic
- Retrain HMM parameters with Baum-Welch on downloaded historical data
- Build frontend crypto dashboard (Phase 4)

// Core types for the crypto trading module.
// These are the internal normalized representations that all crypto components use.
// Exchange connectors translate raw exchange messages into these types.

// ── Order Book ────────────────────────────────────────────────────────────────

export interface OrderBookLevel {
  price: number;
  quantity: number;
}

export interface OrderBookSnapshot {
  symbol: string;
  bids: OrderBookLevel[];   // sorted descending by price
  asks: OrderBookLevel[];   // sorted ascending by price
  timestamp: number;        // exchange timestamp (ms)
  lastUpdateId: number;     // exchange sequence ID for gap detection
}

// ── Trade Tick ────────────────────────────────────────────────────────────────

export interface TradeTick {
  symbol: string;
  price: number;
  quantity: number;
  isBuyerMaker: boolean;    // true = sell-side aggressor (taker hit bid)
  timestamp: number;        // exchange timestamp (ms)
  tradeId: number;
}

// ── Aggregated Ticker (best bid/ask) ──────────────────────────────────────────

export interface BookTicker {
  symbol: string;
  bidPrice: number;
  bidQty: number;
  askPrice: number;
  askQty: number;
  timestamp: number;
}

// ── Funding Rate (perps only) ─────────────────────────────────────────────────

export interface FundingRate {
  symbol: string;
  fundingRate: number;       // 8h rate, e.g. 0.0001 = 0.01%
  fundingTime: number;       // next funding timestamp (ms)
  markPrice: number;
  timestamp: number;
}

// ── Liquidation Event ─────────────────────────────────────────────────────────

export interface LiquidationEvent {
  symbol: string;
  side: "BUY" | "SELL";      // BUY = long liquidated, SELL = short liquidated
  price: number;
  quantity: number;
  timestamp: number;
}

// ── Signal Output ─────────────────────────────────────────────────────────────

export type CryptoSignalDirection = "LONG" | "SHORT" | "NO_TRADE";

export interface CryptoSignal {
  symbol: string;
  assetId: string;
  direction: CryptoSignalDirection;
  confidence: number;        // 0..1
  reason: string;
  components: {
    ofi: number;             // order flow imbalance score (-1..1)
    momentum: number;        // momentum score (-1..1)
    fundingBias: number;     // funding rate signal (-1..1)
    liquidationPressure: number; // liquidation cascade signal (-1..1)
    newsBias: number;        // news intelligence bias (-1..1), 0 if no news
    regime: CryptoRegime;
  };
  suggestedEntryPrice: number | null;
  suggestedStopLoss: number | null;
  suggestedTakeProfit: number | null;
  timestamp: number;
}

// ── Market Regime ─────────────────────────────────────────────────────────────

export type CryptoRegime = "trending_bull" | "trending_bear" | "ranging" | "volatile" | "unknown";

export interface CryptoRegimeState {
  regime: CryptoRegime;
  confidence: number;        // 0..1
  btcDominance: number;
  realizedVol: number;       // BTC 24h realized volatility
  dxy: number;               // US Dollar Index
  fundingRateAvg: number;    // average funding across major perps
  timestamp: number;
}

// ── Order ─────────────────────────────────────────────────────────────────────

export type CryptoOrderSide = "BUY" | "SELL";
export type CryptoOrderType = "MARKET" | "LIMIT" | "STOP_MARKET" | "TAKE_PROFIT_MARKET";
export type CryptoOrderStatus = "PENDING" | "NEW" | "PARTIALLY_FILLED" | "FILLED" | "CANCELLED" | "REJECTED" | "EXPIRED";
export type CryptoTimeInForce = "GTC" | "IOC" | "FOK" | "GTX"; // GTX = maker-only

export interface CryptoOrderRequest {
  symbol: string;
  side: CryptoOrderSide;
  type: CryptoOrderType;
  quantity: number;
  price?: number;            // required for LIMIT
  stopPrice?: number;        // required for STOP_MARKET / TAKE_PROFIT_MARKET
  timeInForce?: CryptoTimeInForce;
  clientOrderId: string;     // idempotency key
  reduceOnly?: boolean;      // perps: close position only
  leverage?: number;         // perps: set leverage before order
}

export interface CryptoOrderResponse {
  orderId: string;
  clientOrderId: string;
  status: CryptoOrderStatus;
  executedQty: number;
  avgPrice: number | null;
  symbol: string;
  side: CryptoOrderSide;
  type: CryptoOrderType;
  quantity: number;
  price: number | null;
  timestamp: number;
}

// ── Position ──────────────────────────────────────────────────────────────────

export interface CryptoPosition {
  symbol: string;
  side: "LONG" | "SHORT" | "NONE";
  quantity: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  leverage: number;
  marginType: "ISOLATED" | "CROSS";
  liquidationPrice: number | null;
  timestamp: number;
}

// ── Account Balance ───────────────────────────────────────────────────────────

export interface CryptoBalance {
  asset: string;             // e.g. "USDT"
  free: number;
  locked: number;
  timestamp: number;
}

// ── Events (actor-model message bus) ──────────────────────────────────────────

export type CryptoEvent =
  | { type: "orderbook"; data: OrderBookSnapshot }
  | { type: "trade"; data: TradeTick }
  | { type: "bookTicker"; data: BookTicker }
  | { type: "funding"; data: FundingRate }
  | { type: "liquidation"; data: LiquidationEvent }
  | { type: "signal"; data: CryptoSignal }
  | { type: "order_update"; data: CryptoOrderResponse }
  | { type: "position_update"; data: CryptoPosition }
  | { type: "regime"; data: CryptoRegimeState };

export type CryptoEventHandler = (event: CryptoEvent) => void;

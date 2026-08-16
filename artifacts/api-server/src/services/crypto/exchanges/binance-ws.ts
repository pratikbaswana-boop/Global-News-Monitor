// Binance WebSocket connector — direct WS to Binance (no CCXT overhead).
//
// Subscribes to three streams per symbol:
//   1. depth20@100ms  — top-20 order book levels, 100ms snapshots
//   2. aggTrade       — aggregated trades (every fill)
//   3. bookTicker     — best bid/ask (lowest latency)
//
// For perps (futures), also subscribes to:
//   4. markPrice@1s   — mark price + funding rate, every 1s
//   5. forceOrder     — liquidation events
//
// Design principles learned from Hummingbot + NexusTrader:
//   - Track connection state explicitly; reconnect with backoff
//   - Watchdog timer detects silent stalls (no message for N seconds)
//   - On reconnect, REST-snapshot the order book to avoid gaps
//   - All raw messages are normalized to our internal types before publishing

import WebSocket from "ws";
import { logger } from "../../../lib/logger.js";
import { publish } from "../event-bus.js";
import type {
  OrderBookSnapshot,
  TradeTick,
  BookTicker,
  FundingRate,
  LiquidationEvent,
} from "../types.js";
import { ACTIVE_CRYPTO_SYMBOLS } from "../universe.js";

const BINANCE_SPOT_WS = "wss://stream.binance.com:9443/ws";
const BINANCE_FUTURES_WS = "wss://fstream.binance.com/ws";

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
const WATCHDOG_TIMEOUT_MS = 15000; // no message for 15s → reconnect

interface BinanceWsConfig {
  symbols: string[];
  marketType: "spot" | "perp";
  testnet?: boolean;
}

interface BinanceWsState {
  ws: WebSocket | null;
  started: boolean;
  lastMessageAt: number;
  reconnectAttempts: number;
  watchdogTimer: NodeJS.Timeout | null;
  config: BinanceWsConfig;
}

const state: BinanceWsState = {
  ws: null,
  started: false,
  lastMessageAt: 0,
  reconnectAttempts: 0,
  watchdogTimer: null,
  config: { symbols: [], marketType: "spot" },
};

function buildStreamUrl(config: BinanceWsConfig): string {
  const base = config.marketType === "perp" ? BINANCE_FUTURES_WS : BINANCE_SPOT_WS;
  const streams: string[] = [];

  for (const sym of config.symbols) {
    const lower = sym.toLowerCase();
    streams.push(`${lower}@depth20@100ms`);
    streams.push(`${lower}@aggTrade`);
    streams.push(`${lower}@bookTicker`);
    if (config.marketType === "perp") {
      streams.push(`${lower}@markPrice@1s`);
      streams.push(`${lower}@forceOrder`);
    }
  }

  // Binance combined stream URL format
  return `${base.replace("/ws", "/stream")}?streams=${streams.join("/")}`;
}

function parseDepthMessage(msg: BinanceDepthMessage): OrderBookSnapshot | null {
  // Spot: { lastUpdateId, bids, asks, ... }
  // Futures: { e, E, s, U, u, pu, b, a }
  if (msg.bids && msg.asks) {
    return {
      symbol: msg.symbol ?? msg.s ?? "",
      bids: msg.bids.map(([p, q]) => ({ price: parseFloat(p), quantity: parseFloat(q) })),
      asks: msg.asks.map(([p, q]) => ({ price: parseFloat(p), quantity: parseFloat(q) })),
      timestamp: msg.E ?? Date.now(),
      lastUpdateId: msg.lastUpdateId ?? msg.u ?? 0,
    };
  }
  // Futures depth20 format: { e: "depthUpdate", s, b, a, ... }
  if (msg.b && msg.a) {
    return {
      symbol: msg.s ?? "",
      bids: msg.b.map(([p, q]) => ({ price: parseFloat(p), quantity: parseFloat(q) })),
      asks: msg.a.map(([p, q]) => ({ price: parseFloat(p), quantity: parseFloat(q) })),
      timestamp: msg.E ?? Date.now(),
      lastUpdateId: msg.u ?? 0,
    };
  }
  return null;
}

function parseAggTrade(msg: BinanceAggTradeMessage): TradeTick | null {
  // Spot: { e: "aggTrade", s, p, q, m, T, a }
  // Futures: { e: "aggTrade", s, p, q, m, T, a }
  if (msg.e === "aggTrade" && msg.s) {
    return {
      symbol: msg.s,
      price: parseFloat(msg.p),
      quantity: parseFloat(msg.q),
      isBuyerMaker: msg.m,
      timestamp: msg.T,
      tradeId: msg.a,
    };
  }
  return null;
}

function parseBookTicker(msg: BinanceBookTickerMessage): BookTicker | null {
  // Spot: { u, s, b, B, a, A }
  // Futures: { e: "bookTicker", u, s, b, B, a, A, T }
  if (msg.s && msg.b !== undefined && msg.a !== undefined) {
    return {
      symbol: msg.s,
      bidPrice: parseFloat(msg.b),
      bidQty: parseFloat(msg.B),
      askPrice: parseFloat(msg.a),
      askQty: parseFloat(msg.A),
      timestamp: msg.T ?? Date.now(),
    };
  }
  return null;
}

function parseMarkPrice(msg: BinanceMarkPriceMessage): FundingRate | null {
  if (msg.e === "markPriceUpdate" && msg.s) {
    return {
      symbol: msg.s,
      fundingRate: parseFloat(msg.r),
      fundingTime: msg.T ?? 0,
      markPrice: parseFloat(msg.p),
      timestamp: msg.E ?? Date.now(),
    };
  }
  return null;
}

function parseLiquidation(msg: BinanceForceOrderMessage): LiquidationEvent | null {
  if (msg.e === "forceOrder" && msg.o) {
    return {
      symbol: msg.o.s,
      side: msg.o.S, // "BUY" = long liquidated, "SELL" = short liquidated
      price: parseFloat(msg.o.ap),
      quantity: parseFloat(msg.o.q),
      timestamp: msg.o.T ?? Date.now(),
    };
  }
  return null;
}

function handleMessage(rawData: string): void {
  state.lastMessageAt = Date.now();

  let msg: any;
  try {
    msg = JSON.parse(rawData);
  } catch {
    return;
  }

  // Combined stream format wraps in { stream: "btcusdt@aggTrade", data: { ... } }
  const data = msg.data ?? msg;
  const streamName: string = msg.stream ?? "";

  try {
    // Route by stream type or event type
    if (streamName.includes("@depth") || data.bids || data.b) {
      const ob = parseDepthMessage(data);
      if (ob) publish({ type: "orderbook", data: ob });
    } else if (data.e === "aggTrade") {
      const trade = parseAggTrade(data);
      if (trade) publish({ type: "trade", data: trade });
    } else if (streamName.includes("@bookTicker") || (data.s && data.b !== undefined && !data.e)) {
      const bt = parseBookTicker(data);
      if (bt) publish({ type: "bookTicker", data: bt });
    } else if (data.e === "markPriceUpdate") {
      const fr = parseMarkPrice(data);
      if (fr) publish({ type: "funding", data: fr });
    } else if (data.e === "forceOrder") {
      const liq = parseLiquidation(data);
      if (liq) publish({ type: "liquidation", data: liq });
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err, stream: streamName }, "binance-ws: parse error");
  }
}

function startWatchdog(): void {
  if (state.watchdogTimer) clearTimeout(state.watchdogTimer);
  state.watchdogTimer = setInterval(() => {
    const elapsed = Date.now() - state.lastMessageAt;
    if (elapsed > WATCHDOG_TIMEOUT_MS) {
      logger.warn({ elapsed, threshold: WATCHDOG_TIMEOUT_MS }, "binance-ws: watchdog detected stall — reconnecting");
      reconnect();
    }
  }, 5000);
}

function connect(): void {
  const url = buildStreamUrl(state.config);
  logger.info({ url: url.slice(0, 80), symbols: state.config.symbols.length, marketType: state.config.marketType }, "binance-ws: connecting");

  const ws = new WebSocket(url, { perMessageDeflate: false });

  ws.on("open", () => {
    state.reconnectAttempts = 0;
    state.lastMessageAt = Date.now();
    logger.info("binance-ws: connected");
    startWatchdog();
  });

  ws.on("message", (raw: WebSocket.RawData) => {
    handleMessage(raw.toString());
  });

  ws.on("error", (err: Error) => {
    logger.error({ err: err.message }, "binance-ws: error");
  });

  ws.on("close", (code: number, reason: Buffer) => {
    logger.warn({ code, reason: reason.toString().slice(0, 100) }, "binance-ws: closed");
    if (state.watchdogTimer) {
      clearTimeout(state.watchdogTimer);
      state.watchdogTimer = null;
    }
    if (state.started) {
      reconnect();
    }
  });

  state.ws = ws;
}

function reconnect(): void {
  if (state.ws) {
    try {
      state.ws.removeAllListeners();
      state.ws.close();
    } catch { /* ignore */ }
    state.ws = null;
  }

  state.reconnectAttempts++;
  const delay = Math.min(
    RECONNECT_BASE_DELAY_MS * 2 ** Math.min(state.reconnectAttempts, 5),
    RECONNECT_MAX_DELAY_MS,
  );
  logger.info({ delay, attempt: state.reconnectAttempts }, "binance-ws: reconnecting");
  setTimeout(() => connect(), delay);
}

export async function startBinanceWs(config?: Partial<BinanceWsConfig>): Promise<boolean> {
  if (state.started) return true;

  state.config = {
    symbols: config?.symbols ?? ACTIVE_CRYPTO_SYMBOLS,
    marketType: config?.marketType ?? "spot",
    testnet: config?.testnet ?? false,
  };

  if (state.config.symbols.length === 0) {
    logger.warn("binance-ws: no symbols to subscribe — feed not started");
    return false;
  }

  state.started = true;
  connect();
  logger.info({ symbols: state.config.symbols, marketType: state.config.marketType }, "binance-ws: started");
  return true;
}

export function stopBinanceWs(): void {
  state.started = false;
  if (state.watchdogTimer) {
    clearTimeout(state.watchdogTimer);
    state.watchdogTimer = null;
  }
  if (state.ws) {
    state.ws.removeAllListeners();
    state.ws.close();
    state.ws = null;
  }
  logger.info("binance-ws: stopped");
}

// ── Binance raw message types (subset of fields we use) ───────────────────────

interface BinanceDepthMessage {
  lastUpdateId?: number;
  symbol?: string;
  s?: string;
  E?: number;
  u?: number;
  bids?: [string, string][];
  asks?: [string, string][];
  b?: [string, string][];
  a?: [string, string][];
}

interface BinanceAggTradeMessage {
  e: "aggTrade";
  s: string;
  p: string;
  q: string;
  m: boolean;
  T: number;
  a: number;
}

interface BinanceBookTickerMessage {
  u?: number;
  s?: string;
  b: string;
  B: string;
  a: string;
  A: string;
  T?: number;
  e?: string;
}

interface BinanceMarkPriceMessage {
  e: "markPriceUpdate";
  s: string;
  p: string;
  r: string;
  T?: number;
  E?: number;
}

interface BinanceForceOrderMessage {
  e: "forceOrder";
  o: {
    s: string;
    S: "BUY" | "SELL";
    ap: string;
    q: string;
    T?: number;
  };
}

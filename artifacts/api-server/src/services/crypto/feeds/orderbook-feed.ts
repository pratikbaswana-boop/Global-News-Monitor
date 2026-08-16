// Order book feed — maintains rolling order book state per symbol and computes
// real-time microstructure features that the signal engine consumes.
//
// This is the crypto equivalent of kite-option-chain.ts + market-ticker.ts's
// tick processing, but for crypto L2 order book data.
//
// Features computed on each book update:
//   - Order Flow Imbalance (OFI) — bid/ask volume imbalance at top-N levels
//   - Spread — best bid/ask spread in bps
//   - Mid price — (best bid + best ask) / 2
//   - Depth imbalance — cumulative bid depth vs ask depth
//   - Trade flow imbalance — buy vs sell aggressor volume (from trade ticks)

import { logger } from "../../../lib/logger.js";
import { onOrderBook, onTrade, onBookTicker } from "../event-bus.js";
import type { OrderBookSnapshot, TradeTick, BookTicker } from "../types.js";
import { ACTIVE_CRYPTO_SYMBOLS, CRYPTO_BY_SYMBOL } from "../universe.js";

const DEPTH_LEVELS = 5;       // top-N levels for OFI computation
const TRADE_WINDOW_MS = 60000; // 1 min rolling trade window
const MAX_TRADE_BUFFER = 500;  // cap trades per symbol

interface OrderBookState {
  symbol: string;
  bids: { price: number; quantity: number }[];
  asks: { price: number; quantity: number }[];
  midPrice: number;
  spreadBps: number;
  lastUpdate: number;
}

interface TradeFlowState {
  symbol: string;
  buyVolume: number;    // aggressor buy volume in window
  sellVolume: number;   // aggressor sell volume in window
  trades: { price: number; qty: number; isBuyerMaker: boolean; ts: number }[];
}

interface BookFeatureSnapshot {
  symbol: string;
  assetId: string;
  midPrice: number;
  spreadBps: number;
  ofi: number;           // -1..1 (positive = bid pressure)
  depthImbalance: number; // -1..1
  tradeFlowImbalance: number; // -1..1
  timestamp: number;
}

const bookStates = new Map<string, OrderBookState>();
const tradeStates = new Map<string, TradeFlowState>();
const featureCallbacks = new Set<(snapshot: BookFeatureSnapshot) => void>();

function initSymbol(symbol: string): void {
  if (!bookStates.has(symbol)) {
    bookStates.set(symbol, {
      symbol,
      bids: [],
      asks: [],
      midPrice: 0,
      spreadBps: 0,
      lastUpdate: 0,
    });
  }
  if (!tradeStates.has(symbol)) {
    tradeStates.set(symbol, {
      symbol,
      buyVolume: 0,
      sellVolume: 0,
      trades: [],
    });
  }
}

function computeOfi(bids: { price: number; quantity: number }[], asks: { price: number; quantity: number }[]): number {
  const topBids = bids.slice(0, DEPTH_LEVELS);
  const topAsks = asks.slice(0, DEPTH_LEVELS);
  const bidVol = topBids.reduce((sum, l) => sum + l.quantity, 0);
  const askVol = topAsks.reduce((sum, l) => sum + l.quantity, 0);
  const total = bidVol + askVol;
  if (total === 0) return 0;
  return (bidVol - askVol) / total; // -1..1
}

function computeDepthImbalance(bids: { price: number; quantity: number }[], asks: { price: number; quantity: number }[]): number {
  const bidVol = bids.slice(0, DEPTH_LEVELS).reduce((s, l) => s + l.quantity, 0);
  const askVol = asks.slice(0, DEPTH_LEVELS).reduce((s, l) => s + l.quantity, 0);
  const total = bidVol + askVol;
  if (total === 0) return 0;
  return (bidVol - askVol) / total;
}

function pruneTrades(state: TradeFlowState, now: number): void {
  const cutoff = now - TRADE_WINDOW_MS;
  while (state.trades.length > 0 && state.trades[0]!.ts < cutoff) {
    const old = state.trades.shift()!;
    if (old.isBuyerMaker) {
      state.sellVolume -= old.qty;
    } else {
      state.buyVolume -= old.qty;
    }
  }
  // Also cap by count
  while (state.trades.length > MAX_TRADE_BUFFER) {
    const old = state.trades.shift()!;
    if (old.isBuyerMaker) {
      state.sellVolume -= old.qty;
    } else {
      state.buyVolume -= old.qty;
    }
  }
}

function computeTradeFlowImbalance(state: TradeFlowState): number {
  const total = state.buyVolume + state.sellVolume;
  if (total === 0) return 0;
  return (state.buyVolume - state.sellVolume) / total; // -1..1
}

function emitFeatures(symbol: string): void {
  const bookState = bookStates.get(symbol);
  const tradeState = tradeStates.get(symbol);
  if (!bookState || !tradeState) return;

  const asset = CRYPTO_BY_SYMBOL.get(symbol);
  if (!asset) return;

  pruneTrades(tradeState, Date.now());

  const snapshot: BookFeatureSnapshot = {
    symbol,
    assetId: asset.assetId,
    midPrice: bookState.midPrice,
    spreadBps: bookState.spreadBps,
    ofi: computeOfi(bookState.bids, bookState.asks),
    depthImbalance: computeDepthImbalance(bookState.bids, bookState.asks),
    tradeFlowImbalance: computeTradeFlowImbalance(tradeState),
    timestamp: bookState.lastUpdate,
  };

  for (const cb of featureCallbacks) {
    try {
      cb(snapshot);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err, symbol }, "orderbook-feed: feature callback error");
    }
  }
}

function handleOrderBook(data: OrderBookSnapshot): void {
  initSymbol(data.symbol);
  const state = bookStates.get(data.symbol)!;
  state.bids = data.bids;
  state.asks = data.asks;
  state.lastUpdate = data.timestamp;

  if (data.bids.length > 0 && data.asks.length > 0) {
    const bestBid = data.bids[0]!.price;
    const bestAsk = data.asks[0]!.price;
    state.midPrice = (bestBid + bestAsk) / 2;
    state.spreadBps = state.midPrice > 0 ? ((bestAsk - bestBid) / state.midPrice) * 10000 : 0;
  }

  emitFeatures(data.symbol);
}

function handleTrade(data: TradeTick): void {
  initSymbol(data.symbol);
  const state = tradeStates.get(data.symbol)!;
  state.trades.push({
    price: data.price,
    qty: data.quantity,
    isBuyerMaker: data.isBuyerMaker,
    ts: data.timestamp,
  });
  if (data.isBuyerMaker) {
    state.sellVolume += data.quantity;
  } else {
    state.buyVolume += data.quantity;
  }
  // Don't emit features on every trade — too noisy. Features emit on book updates.
}

function handleBookTicker(data: BookTicker): void {
  initSymbol(data.symbol);
  const state = bookStates.get(data.symbol)!;
  if (state.bids.length === 0 || state.asks.length === 0) {
    // Initialize from bookTicker if we don't have full depth yet
    state.bids = [{ price: data.bidPrice, quantity: data.bidQty }];
    state.asks = [{ price: data.askPrice, quantity: data.askQty }];
    state.midPrice = (data.bidPrice + data.askPrice) / 2;
    state.spreadBps = state.midPrice > 0 ? ((data.askPrice - data.bidPrice) / state.midPrice) * 10000 : 0;
    state.lastUpdate = data.timestamp;
  }
}

export function startOrderBookFeed(): boolean {
  for (const sym of ACTIVE_CRYPTO_SYMBOLS) {
    initSymbol(sym);
  }

  onOrderBook(handleOrderBook);
  onTrade(handleTrade);
  onBookTicker(handleBookTicker);

  logger.info({ symbols: ACTIVE_CRYPTO_SYMBOLS.length }, "orderbook-feed: started");
  return true;
}

export function onBookFeatures(cb: (snapshot: BookFeatureSnapshot) => void): void {
  featureCallbacks.add(cb);
}

export function getOrderBookState(symbol: string): OrderBookState | undefined {
  return bookStates.get(symbol);
}

export function getTradeFlowState(symbol: string): TradeFlowState | undefined {
  return tradeStates.get(symbol);
}

export type { BookFeatureSnapshot };

// Crypto event bus — actor-model message dispatch for the crypto module.
//
// Adapted from the existing marketTicker EventEmitter pattern but with typed
// events. Each component (feed, signal, executor, risk) subscribes to the
// events it cares about. This decouples producers from consumers.
//
// Design borrowed from NautilusTrader's MessageBus: single-threaded dispatch,
// no shared state between subscribers, each subscriber owns its own state.

import type {
  CryptoEvent,
  CryptoEventHandler,
  OrderBookSnapshot,
  TradeTick,
  BookTicker,
  FundingRate,
  LiquidationEvent,
  CryptoSignal,
  CryptoOrderResponse,
  CryptoPosition,
  CryptoRegimeState,
} from "./types.js";

type HandlerMap = Map<string, Set<CryptoEventHandler>>;

const handlers: HandlerMap = new Map();

export function subscribe(eventType: string, handler: CryptoEventHandler): void {
  if (!handlers.has(eventType)) {
    handlers.set(eventType, new Set());
  }
  handlers.get(eventType)!.add(handler);
}

export function unsubscribe(eventType: string, handler: CryptoEventHandler): void {
  handlers.get(eventType)?.delete(handler);
}

export function publish(event: CryptoEvent): void {
  const set = handlers.get(event.type);
  if (!set) return;
  for (const handler of set) {
    try {
      handler(event);
    } catch (err) {
      console.error(`[crypto-bus] handler error for ${event.type}:`, err);
    }
  }
}

export function clearAllHandlers(): void {
  handlers.clear();
}

// Convenience typed subscribers
export const onOrderBook = (h: (data: OrderBookSnapshot) => void) =>
  subscribe("orderbook", (e: CryptoEvent) => e.type === "orderbook" && h(e.data));

export const onTrade = (h: (data: TradeTick) => void) =>
  subscribe("trade", (e: CryptoEvent) => e.type === "trade" && h(e.data));

export const onBookTicker = (h: (data: BookTicker) => void) =>
  subscribe("bookTicker", (e: CryptoEvent) => e.type === "bookTicker" && h(e.data));

export const onFunding = (h: (data: FundingRate) => void) =>
  subscribe("funding", (e: CryptoEvent) => e.type === "funding" && h(e.data));

export const onLiquidation = (h: (data: LiquidationEvent) => void) =>
  subscribe("liquidation", (e: CryptoEvent) => e.type === "liquidation" && h(e.data));

export const onSignal = (h: (data: CryptoSignal) => void) =>
  subscribe("signal", (e: CryptoEvent) => e.type === "signal" && h(e.data));

export const onOrderUpdate = (h: (data: CryptoOrderResponse) => void) =>
  subscribe("order_update", (e: CryptoEvent) => e.type === "order_update" && h(e.data));

export const onPositionUpdate = (h: (data: CryptoPosition) => void) =>
  subscribe("position_update", (e: CryptoEvent) => e.type === "position_update" && h(e.data));

export const onRegime = (h: (data: CryptoRegimeState) => void) =>
  subscribe("regime", (e: CryptoEvent) => e.type === "regime" && h(e.data));

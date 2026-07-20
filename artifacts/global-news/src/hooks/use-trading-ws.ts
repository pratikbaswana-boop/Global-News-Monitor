import { useEffect, useRef, useCallback, useState } from "react";

type Channel = "market-data" | "executions" | "orders" | "paper-trading" | "condor";

interface WsMessage {
  channel: Channel;
  data: unknown;
  timestamp: number;
}

let globalWs: WebSocket | null = null;
let refCount = 0;
const channelHandlers = new Map<Channel, Set<(data: unknown) => void>>();

function getWsUrl(userId?: string, channels?: Channel[]): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const base = `${proto}//${window.location.host}/ws`;
  const params = new URLSearchParams();
  if (userId) params.set("userId", userId);
  if (channels && channels.length > 0) params.set("channels", channels.join(","));
  return `${base}?${params.toString()}`;
}

function ensureWs(userId?: string): WebSocket {
  if (globalWs && globalWs.readyState === WebSocket.OPEN) return globalWs;
  if (globalWs && globalWs.readyState === WebSocket.CLOSING) globalWs = null;
  if (globalWs && globalWs.readyState === WebSocket.CONNECTING) return globalWs;

  const allChannels: Channel[] = ["market-data", "executions", "orders", "paper-trading", "condor"];
  globalWs = new WebSocket(getWsUrl(userId, allChannels));

  globalWs.onmessage = (event) => {
    try {
      const msg: WsMessage = JSON.parse(event.data);
      const handlers = channelHandlers.get(msg.channel);
      if (handlers) {
        for (const handler of handlers) {
          handler(msg.data);
        }
      }
    } catch {
      // ignore malformed messages
    }
  };

  globalWs.onclose = () => {
    globalWs = null;
    // Reconnect after 3s
    setTimeout(() => {
      if (refCount > 0) ensureWs(userId);
    }, 3000);
  };

  globalWs.onerror = () => {
    globalWs?.close();
  };

  return globalWs;
}

export function useTradingWs<T>(
  channel: Channel,
  handler: (data: T) => void,
  userId?: string
): { connected: boolean } {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const stableHandler = (data: unknown) => handlerRef.current(data as T);

    if (!channelHandlers.has(channel)) {
      channelHandlers.set(channel, new Set());
    }
    channelHandlers.get(channel)!.add(stableHandler);

    refCount++;
    const ws = ensureWs(userId);

    const checkConn = setInterval(() => {
      setConnected(globalWs?.readyState === WebSocket.OPEN);
    }, 500);

    return () => {
      channelHandlers.get(channel)?.delete(stableHandler);
      refCount = Math.max(0, refCount - 1);
      clearInterval(checkConn);
      if (refCount === 0 && globalWs) {
        globalWs.close();
        globalWs = null;
      }
    };
  }, [channel, userId]);

  return { connected };
}

export function useMarketDataWs(userId?: string): { data: any | null; connected: boolean } {
  const [data, setData] = useState<any | null>(null);
  const { connected } = useTradingWs<any>("market-data", useCallback((d: any) => setData(d), []), userId);
  return { data, connected };
}

export function useExecutionsWs(userId?: string): { data: { executions: any[] } | null; connected: boolean } {
  const [data, setData] = useState<{ executions: any[] } | null>(null);
  const { connected } = useTradingWs<{ executions: any[] }>("executions", useCallback((d: any) => setData(d), []), userId);
  return { data, connected };
}

export function useOrdersWs(userId?: string): { data: { orders: any[] } | null; connected: boolean } {
  const [data, setData] = useState<{ orders: any[] } | null>(null);
  const { connected } = useTradingWs<{ orders: any[] }>("orders", useCallback((d: any) => setData(d), []), userId);
  return { data, connected };
}

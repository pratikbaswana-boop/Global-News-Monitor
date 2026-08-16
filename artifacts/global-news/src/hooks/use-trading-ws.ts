import { useEffect, useRef, useCallback, useState } from "react";

type Channel = "market-data" | "executions" | "orders" | "paper-trading" | "condor" | "condor-user";

interface WsMessage {
  channel: Channel;
  data: unknown;
  timestamp: number;
}

let globalWs: WebSocket | null = null;
let globalWsUserId: string | undefined = undefined;
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
  // If existing connection was created without a userId (or a different one),
  // and now we have a userId, reconnect so the server can filter broadcasts to us.
  // Handle both OPEN and CONNECTING states — if the WS is still connecting without
  // userId, close it and create a new one with userId before it finishes connecting.
  if (globalWs && globalWsUserId !== userId && userId) {
    if (globalWs.readyState === WebSocket.OPEN || globalWs.readyState === WebSocket.CONNECTING) {
      const oldWs = globalWs;
      globalWs = null;
      oldWs.onclose = null;
      oldWs.onerror = null;
      oldWs.onmessage = null;
      oldWs.close();
    }
  }

  if (globalWs && globalWs.readyState === WebSocket.OPEN) return globalWs;
  if (globalWs && globalWs.readyState === WebSocket.CLOSING) globalWs = null;
  if (globalWs && globalWs.readyState === WebSocket.CONNECTING) return globalWs;

  globalWsUserId = userId;
  const allChannels: Channel[] = ["market-data", "executions", "orders", "paper-trading", "condor", "condor-user"];
  const ws = new WebSocket(getWsUrl(userId, allChannels));
  globalWs = ws;

  ws.onmessage = (event) => {
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

  ws.onclose = () => {
    // Only nullify if this is still the current WS (a newer one may have replaced it)
    if (globalWs === ws) {
      globalWs = null;
      // Reconnect after 3s with the last userId
      setTimeout(() => {
        if (refCount > 0) ensureWs(globalWsUserId);
      }, 3000);
    }
  };

  ws.onerror = () => {
    if (globalWs === ws) ws.close();
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

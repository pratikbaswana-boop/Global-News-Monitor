import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { logger } from "./logger.js";

type Channel = "market-data" | "executions" | "orders" | "paper-trading" | "condor";

interface ClientMeta {
  userId: string | null;
  channels: Set<Channel>;
}

const clients = new Map<WebSocket, ClientMeta>();
let wss: WebSocketServer | null = null;

export function attachWebSocketServer(server: Server): void {
  wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws: WebSocket, req) => {
    const url = new URL(req.url ?? "", "http://localhost");
    const userId = url.searchParams.get("userId") ?? null;
    const channelsParam = url.searchParams.get("channels") ?? "";
    const channels = new Set<Channel>(
      channelsParam
        ? (channelsParam.split(",") as Channel[])
        : ["market-data", "executions", "orders", "paper-trading", "condor"]
    );

    clients.set(ws, { userId, channels });
    logger.info({ userId, channels: [...channels], totalClients: clients.size }, "ws-hub: client connected");

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "subscribe" && Array.isArray(msg.channels)) {
          const meta = clients.get(ws);
          if (meta) {
            for (const ch of msg.channels) {
              meta.channels.add(ch as Channel);
            }
          }
        } else if (msg.type === "unsubscribe" && Array.isArray(msg.channels)) {
          const meta = clients.get(ws);
          if (meta) {
            for (const ch of msg.channels) {
              meta.channels.delete(ch as Channel);
            }
          }
        }
      } catch {
        // ignore malformed messages
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
      logger.info({ totalClients: clients.size }, "ws-hub: client disconnected");
    });

    ws.on("error", () => {
      clients.delete(ws);
    });
  });

  logger.info("ws-hub: WebSocket server attached at /ws");
}

function broadcast(channel: Channel, payload: unknown, userIdFilter?: string): void {
  const msg = JSON.stringify({ channel, data: payload, timestamp: Date.now() });
  for (const [ws, meta] of clients) {
    if (!meta.channels.has(channel)) continue;
    if (userIdFilter && meta.userId !== userIdFilter) continue;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

// ── Public broadcast helpers ──────────────────────────────────────────────────

export function broadcastMarketData(data: unknown): void {
  broadcast("market-data", data);
}

export function broadcastExecutions(userId: string, data: unknown): void {
  broadcast("executions", data, userId);
}

export function broadcastOrders(userId: string, data: unknown): void {
  broadcast("orders", data, userId);
}

export function broadcastPaperTrading(data: unknown): void {
  broadcast("paper-trading", data);
}

export function broadcastCondor(data: unknown): void {
  broadcast("condor", data);
}

export function getConnectedClientCount(): number {
  return clients.size;
}

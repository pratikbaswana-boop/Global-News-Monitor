import { broadcastPaperTrading } from "./ws-hub.js";

export type TradeNotificationType = "skip" | "entry" | "exit" | "info" | "warning";
export type TradeEngine = "paper" | "condor" | "tick-evaluator" | "signal-executor";

export interface TradeNotification {
  id: string;
  timestamp: number;
  engine: TradeEngine;
  type: TradeNotificationType;
  message: string;
  details?: Record<string, unknown>;
}

const MAX_NOTIFICATIONS = 100;
const notifications: TradeNotification[] = [];
let nextId = 1;

export function pushTradeNotification(
  engine: TradeEngine,
  type: TradeNotificationType,
  message: string,
  details?: Record<string, unknown>,
): void {
  const notification: TradeNotification = {
    id: `tn-${nextId++}`,
    timestamp: Date.now(),
    engine,
    type,
    message,
    details,
  };

  notifications.unshift(notification);
  if (notifications.length > MAX_NOTIFICATIONS) {
    notifications.length = MAX_NOTIFICATIONS;
  }

  broadcastPaperTrading({
    type: "trade-notification",
    notification,
  });
}

export function getTradeNotifications(limit = 50): TradeNotification[] {
  return notifications.slice(0, limit);
}

export function clearTradeNotifications(): void {
  notifications.length = 0;
}

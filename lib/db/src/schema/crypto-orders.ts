// Crypto orders database schema.
// Mirrors broker-orders.ts but for crypto exchange orders.

import { pgTable, text, timestamp, integer, numeric, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const cryptoOrdersTable = pgTable("crypto_orders", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  exchange: text("exchange").notNull().default("binance"),
  exchangeOrderId: text("exchange_order_id"),
  clientOrderId: text("client_order_id").notNull(),
  symbol: text("symbol").notNull(),
  assetId: text("asset_id").notNull(),
  side: text("side").notNull(),
  type: text("type").notNull(),
  timeInForce: text("time_in_force").notNull().default("GTC"),
  quantity: numeric("quantity").notNull(),
  price: numeric("price"),
  stopPrice: numeric("stop_price"),
  executedQty: numeric("executed_qty").default("0"),
  avgPrice: numeric("avg_price"),
  status: text("status").notNull().default("PENDING"),
  statusMessage: text("status_message"),
  reduceOnly: boolean("reduce_only").default(false),
  leverage: integer("leverage").default(1),
  marketType: text("market_type").notNull().default("spot"),
  signalSnapshotId: text("signal_snapshot_id"),
  isPaperTrade: boolean("is_paper_trade").notNull().default(false),
  placedAt: timestamp("placed_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertCryptoOrderSchema = createInsertSchema(cryptoOrdersTable).omit({ id: true });
export type InsertCryptoOrder = z.infer<typeof insertCryptoOrderSchema>;
export type CryptoOrder = typeof cryptoOrdersTable.$inferSelect;

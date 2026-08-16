// Crypto positions database schema.
// Mirrors broker-positions.ts but for crypto exchange positions.

import { pgTable, text, timestamp, numeric, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const cryptoPositionsTable = pgTable("crypto_positions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  exchange: text("exchange").notNull().default("binance"),
  symbol: text("symbol").notNull(),
  assetId: text("asset_id").notNull(),
  side: text("side").notNull(),
  quantity: numeric("quantity").notNull(),
  entryPrice: numeric("entry_price").notNull(),
  markPrice: numeric("mark_price"),
  unrealizedPnl: numeric("unrealized_pnl"),
  realizedPnl: numeric("realized_pnl"),
  leverage: integer("leverage").default(1),
  marginType: text("margin_type").notNull().default("ISOLATED"),
  liquidationPrice: numeric("liquidation_price"),
  isPaperTrade: boolean("is_paper_trade").notNull().default(false),
  signalSnapshotId: text("signal_snapshot_id"),
  stopLossPrice: numeric("stop_loss_price"),
  takeProfitPrice: numeric("take_profit_price"),
  trailingStopHigh: numeric("trailing_stop_high"),
  status: text("status").notNull().default("OPEN"),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertCryptoPositionSchema = createInsertSchema(cryptoPositionsTable).omit({ id: true });
export type InsertCryptoPosition = z.infer<typeof insertCryptoPositionSchema>;
export type CryptoPosition = typeof cryptoPositionsTable.$inferSelect;

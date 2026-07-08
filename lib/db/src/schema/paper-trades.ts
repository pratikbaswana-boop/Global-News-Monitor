import { pgTable, text, timestamp, integer, numeric, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const paperTradesTable = pgTable("paper_trades", {
  id: text("id").primaryKey(),
  signalSnapshotId: text("signal_snapshot_id"),
  assetId: text("asset_id").notNull(),
  assetSymbol: text("asset_symbol").notNull(),
  direction: text("direction").notNull(), // up | down
  signal: text("signal").notNull(), // BUY_CALL | BUY_PUT
  strike: numeric("strike"),
  quantity: integer("quantity").notNull(),
  entryPrice: numeric("entry_price").notNull(),
  exitPrice: numeric("exit_price"),
  realisedPnl: numeric("realised_pnl"),
  status: text("status").notNull().default("open"), // open | closed
  stopLossPrice: numeric("stop_loss_price"),
  highestPriceReached: numeric("highest_price_reached"),
  trailGapPct: numeric("trail_gap_pct"),
  exitStrategy: text("exit_strategy"),
  exitReason: text("exit_reason"),
  notes: text("notes"),
  capitalAtEntry: numeric("capital_at_entry").notNull(),
  executedAt: timestamp("executed_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});

export const insertPaperTradeSchema = createInsertSchema(paperTradesTable).omit({
  id: true,
  executedAt: true,
  closedAt: true,
});

export type InsertPaperTrade = z.infer<typeof insertPaperTradeSchema>;
export type PaperTrade = typeof paperTradesTable.$inferSelect;

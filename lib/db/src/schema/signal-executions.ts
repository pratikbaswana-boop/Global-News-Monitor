import { pgTable, text, timestamp, integer, numeric, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const signalExecutionsTable = pgTable("signal_executions", {
  id: text("id").primaryKey(),
  signalSnapshotId: text("signal_snapshot_id").notNull(),
  userId: text("user_id").notNull(),
  brokerAccountId: text("broker_account_id").notNull(),
  brokerOrderId: text("broker_order_id").notNull(),
  assetId: text("asset_id").notNull(),
  assetSymbol: text("asset_symbol").notNull(),
  direction: text("direction").notNull(), // up | down
  quantity: integer("quantity").notNull(),
  entryPrice: numeric("entry_price"),
  exitPrice: numeric("exit_price"),
  realisedPnl: numeric("realised_pnl"),
  status: text("status").notNull().default("open"), // open | closed | cancelled
  // Exit logic
  targetPrice: numeric("target_price"),
  stopLossPrice: numeric("stop_loss_price"),
  highestPriceReached: numeric("highest_price_reached"), // peak price for trailing ratchet
  trailGapPct: numeric("trail_gap_pct"), // snapshot of gap setting at entry
  exitStrategy: text("exit_strategy"), // fixed_target | trailing_ratchet
  product: text("product"), // MIS | CNC | NRML
  gttTriggerId: text("gtt_trigger_id"), // Kite GTT trigger ID for bracket
  exitReason: text("exit_reason"), // target_hit | stop_loss | manual | eod_squareoff | trailing_stop | time_stop
  notes: text("notes"), // JSON blob for far OTM config (delta, milestoneStep, timeStop, etc.)
  executedAt: timestamp("executed_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});

export const insertSignalExecutionSchema = createInsertSchema(signalExecutionsTable).omit({
  id: true,
  executedAt: true,
  closedAt: true,
});

export type InsertSignalExecution = z.infer<typeof insertSignalExecutionSchema>;
export type SignalExecution = typeof signalExecutionsTable.$inferSelect;

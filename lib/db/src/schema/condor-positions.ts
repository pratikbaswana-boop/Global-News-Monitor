import { pgTable, text, integer, numeric, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Iron Condor (option-selling) positions — completely separate from signal_executions
// (option buying) and paper_trades (single-leg option buying paper engine). A condor
// position holds 4 legs (sell PE, sell CE, buy hedge PE, buy hedge CE) stored as JSON.
export const condorPositionsTable = pgTable("condor_positions", {
  id: text("id").primaryKey(),
  mode: text("mode").notNull().default("paper"), // paper | real
  status: text("status").notNull().default("open"), // open | closed | cancelled
  userId: text("user_id"), // null for paper mode, set for real per-user condor positions

  spotAtEntry: numeric("spot_at_entry").notNull(),
  expiryDate: text("expiry_date").notNull(), // YYYY-MM-DD
  directionTilt: text("direction_tilt").notNull().default("neutral"), // bullish | bearish | neutral

  // legs: JSON array of { leg, role, strike, symbol, entryPremium, quantity, closed, exitPremium, closedAt }
  legsJson: text("legs_json").notNull(),

  netPremium: numeric("net_premium").notNull(), // per-unit net credit received
  maxLoss: numeric("max_loss").notNull(),
  maxProfit: numeric("max_profit").notNull(),
  lots: integer("lots").notNull(),
  quantity: integer("quantity").notNull(), // lots * lot size
  capitalAtEntry: numeric("capital_at_entry").notNull(),
  marginBlocked: numeric("margin_blocked"),

  realisedPnl: numeric("realised_pnl"),
  exitReason: text("exit_reason"),

  // notes: JSON { vixLevel, regime, crisisProbability, tiltAccuracyPct, sameDirectionDays, ... }
  notesJson: text("notes_json"),

  executedAt: timestamp("executed_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});

export const insertCondorPositionSchema = createInsertSchema(condorPositionsTable).omit({
  executedAt: true,
  closedAt: true,
});

export type InsertCondorPosition = z.infer<typeof insertCondorPositionSchema>;
export type CondorPosition = typeof condorPositionsTable.$inferSelect;

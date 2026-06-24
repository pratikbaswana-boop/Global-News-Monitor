import { pgTable, text, boolean, timestamp, integer, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const userTradePreferencesTable = pgTable("user_trade_preferences", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  assetId: text("asset_id").notNull(),
  assetSymbol: text("asset_symbol").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  // Per-asset overrides (null = use global settings from broker_accounts)
  maxRiskPerTradePct: integer("max_risk_per_trade_pct"),
  defaultProduct: text("default_product"), // MIS | CNC | NRML
  defaultOrderType: text("default_order_type"), // MARKET | LIMIT
  customQuantity: integer("custom_quantity"), // Fixed quantity override
  // Bracket / exit settings
  targetPct: numeric("target_pct").default("1.2"),   // +1.2% target
  stopLossPct: numeric("stop_loss_pct").default("2.0"), // -2.0% stop
  useGttBracket: boolean("use_gtt_bracket").notNull().default(true),
  // Exit strategy
  exitStrategy: text("exit_strategy").notNull().default("trailing_ratchet"), // fixed_target | trailing_ratchet
  trailGapPct: numeric("trail_gap_pct").default("15"), // % gap for proportional ratchet
  // Execution guardrails
  minConfidence: text("min_confidence").notNull().default("medium"), // low | medium | high
  onlyIntraday: boolean("only_intraday").notNull().default(true),
  // F&O auto-trade settings
  useOptions: boolean("use_options").notNull().default(false),
  maxCapitalPerTrade: numeric("max_capital_per_trade"), // max ₹ to deploy per trade (for F&O)
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertUserTradePreferenceSchema = createInsertSchema(userTradePreferencesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertUserTradePreference = z.infer<typeof insertUserTradePreferenceSchema>;
export type UserTradePreference = typeof userTradePreferencesTable.$inferSelect;

import { pgTable, text, timestamp, boolean, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const brokerAccountsTable = pgTable("broker_accounts", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  brokerName: text("broker_name").notNull().default("zerodha"),
  apiKey: text("api_key"),
  apiSecret: text("api_secret"),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  publicToken: text("public_token"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  staticIpRegistered: text("static_ip_registered"),
  isActive: boolean("is_active").notNull().default(false),
  autoTradeEnabled: boolean("auto_trade_enabled").notNull().default(false),
  // Risk settings
  maxRiskPerTradePct: integer("max_risk_per_trade_pct").notNull().default(2), // % of available margin
  defaultProduct: text("default_product").notNull().default("MIS"), // MIS | CNC | NRML
  defaultOrderType: text("default_order_type").notNull().default("MARKET"), // MARKET | LIMIT
  strategyPreference: text("strategy_preference").notNull().default("fno"), // fno | condor
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertBrokerAccountSchema = createInsertSchema(brokerAccountsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertBrokerAccount = z.infer<typeof insertBrokerAccountSchema>;
export type BrokerAccount = typeof brokerAccountsTable.$inferSelect;

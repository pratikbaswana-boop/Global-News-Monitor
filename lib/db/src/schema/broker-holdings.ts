import { pgTable, text, timestamp, integer, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const brokerHoldingsTable = pgTable("broker_holdings", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  brokerAccountId: text("broker_account_id").notNull(),
  tradingsymbol: text("tradingsymbol").notNull(),
  exchange: text("exchange").notNull(),
  instrumentToken: text("instrument_token"),
  isin: text("isin"),
  quantity: integer("quantity").notNull(),
  t1Quantity: integer("t1_quantity").default(0),
  averagePrice: numeric("average_price").notNull(),
  lastPrice: numeric("last_price"),
  closePrice: numeric("close_price"),
  pnl: numeric("pnl"),
  dayChange: numeric("day_change"),
  dayChangePercentage: numeric("day_change_percentage"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertBrokerHoldingSchema = createInsertSchema(brokerHoldingsTable).omit({
  id: true,
  updatedAt: true,
});

export type InsertBrokerHolding = z.infer<typeof insertBrokerHoldingSchema>;
export type BrokerHolding = typeof brokerHoldingsTable.$inferSelect;

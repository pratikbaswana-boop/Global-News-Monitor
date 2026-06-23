import { pgTable, text, timestamp, integer, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const brokerPositionsTable = pgTable("broker_positions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  brokerAccountId: text("broker_account_id").notNull(),
  tradingsymbol: text("tradingsymbol").notNull(),
  exchange: text("exchange").notNull(),
  instrumentToken: text("instrument_token"),
  product: text("product").notNull(), // CNC | MIS | NRML
  quantity: integer("quantity").notNull(),
  dayQuantity: integer("day_quantity").notNull().default(0),
  averagePrice: numeric("average_price").notNull(),
  lastPrice: numeric("last_price"),
  closePrice: numeric("close_price"),
  pnl: numeric("pnl"),
  m2m: numeric("m2m"),
  unrealised: numeric("unrealised"),
  realised: numeric("realised"),
  buyQuantity: integer("buy_quantity"),
  buyPrice: numeric("buy_price"),
  sellQuantity: integer("sell_quantity"),
  sellPrice: numeric("sell_price"),
  value: numeric("value"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertBrokerPositionSchema = createInsertSchema(brokerPositionsTable).omit({
  id: true,
  updatedAt: true,
});

export type InsertBrokerPosition = z.infer<typeof insertBrokerPositionSchema>;
export type BrokerPosition = typeof brokerPositionsTable.$inferSelect;

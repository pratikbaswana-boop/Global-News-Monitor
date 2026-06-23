import { pgTable, text, timestamp, integer, numeric, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const brokerOrdersTable = pgTable("broker_orders", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  brokerAccountId: text("broker_account_id").notNull(),
  kiteOrderId: text("kite_order_id").notNull(),
  variety: text("variety").notNull(), // regular | amo | co | iceberg | auction
  exchange: text("exchange").notNull(),
  tradingsymbol: text("tradingsymbol").notNull(),
  transactionType: text("transaction_type").notNull(), // BUY | SELL
  orderType: text("order_type").notNull(), // MARKET | LIMIT | SL | SL-M
  product: text("product").notNull(), // CNC | MIS | NRML
  quantity: integer("quantity").notNull(),
  price: numeric("price"),
  triggerPrice: numeric("trigger_price"),
  status: text("status").notNull(), // OPEN | COMPLETE | REJECTED | CANCELLED | TRIGGER_PENDING | AMO
  statusMessage: text("status_message"),
  filledQty: integer("filled_qty").default(0),
  pendingQty: integer("pending_qty").default(0),
  cancelledQty: integer("cancelled_qty").default(0),
  averagePrice: numeric("average_price"),
  disclosedQuantity: integer("disclosed_quantity"),
  marketProtection: numeric("market_protection"),
  tag: text("tag"), // auto-signal-{assetId}-{snapshotId}
  // Link to signal if auto-traded
  signalSnapshotId: text("signal_snapshot_id"),
  placedAt: timestamp("placed_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertBrokerOrderSchema = createInsertSchema(brokerOrdersTable).omit({
  id: true,
  placedAt: true,
  updatedAt: true,
});

export type InsertBrokerOrder = z.infer<typeof insertBrokerOrderSchema>;
export type BrokerOrder = typeof brokerOrdersTable.$inferSelect;

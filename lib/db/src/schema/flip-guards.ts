import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// FlipGuard state — persisted per asset to enforce two-cycle flip confirmation.
export const flipGuardsTable = pgTable("flip_guards", {
  id: text("id").primaryKey(),
  assetId: text("asset_id").notNull().unique(),

  pendingDirection: text("pending_direction"), // 'up' | 'down' | 'uncertain' | null
  pendingCount: integer("pending_count").notNull().default(0),
  confirmedDirection: text("confirmed_direction").notNull().default("uncertain"),

  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertFlipGuardSchema = createInsertSchema(flipGuardsTable).omit({ updatedAt: true });
export type InsertFlipGuard = z.infer<typeof insertFlipGuardSchema>;
export type FlipGuardRow = typeof flipGuardsTable.$inferSelect;

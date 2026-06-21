import { pgTable, text, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const pageViewsTable = pgTable("page_views", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  pagePath: text("page_path").notNull(),
  enteredAt: timestamp("entered_at", { withTimezone: true }).notNull(),
  exitedAt: timestamp("exited_at", { withTimezone: true }),
  durationMs: integer("duration_ms"),
  referrer: text("referrer"),
});

export const insertPageViewSchema = createInsertSchema(pageViewsTable).omit({
  exitedAt: true,
  durationMs: true,
});
export type InsertPageView = z.infer<typeof insertPageViewSchema>;
export type PageView = typeof pageViewsTable.$inferSelect;

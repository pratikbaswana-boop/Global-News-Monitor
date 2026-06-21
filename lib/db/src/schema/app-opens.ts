import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const appOpensTable = pgTable("app_opens", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  userAgent: text("user_agent"),
  viewportWidth: text("viewport_width"),
  viewportHeight: text("viewport_height"),
});

export const insertAppOpenSchema = createInsertSchema(appOpensTable).omit({
  openedAt: true,
});
export type InsertAppOpen = z.infer<typeof insertAppOpenSchema>;
export type AppOpen = typeof appOpensTable.$inferSelect;

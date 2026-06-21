import { pgTable, text, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const userSessionsTable = pgTable("user_sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  durationMs: integer("duration_ms"),
  loginMethod: text("login_method").notNull(), // "google" | "email"
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
});

export const insertUserSessionSchema = createInsertSchema(userSessionsTable).omit({
  startedAt: true,
});
export type InsertUserSession = z.infer<typeof insertUserSessionSchema>;
export type UserSession = typeof userSessionsTable.$inferSelect;

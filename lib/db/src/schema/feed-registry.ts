import { pgTable, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const feedRegistryTable = pgTable("feed_registry", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  type: text("type").notNull(), // rss | scrape | api | batch_csv
  credibilityTier: integer("credibility_tier").notNull(), // 1=wire, 2=established, 3=state, 4=think_tank
  isStateMedia: boolean("is_state_media").notNull().default(false),
  fetchIntervalSeconds: integer("fetch_interval_seconds").notNull(),
  parser: text("parser").notNull(), // rss | gdelt | acled | congress
  quarantineUntil: timestamp("quarantine_until", { withTimezone: true }),
  lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
});

export const insertFeedRegistrySchema = createInsertSchema(feedRegistryTable);
export type InsertFeedRegistry = z.infer<typeof insertFeedRegistrySchema>;
export type FeedRegistry = typeof feedRegistryTable.$inferSelect;

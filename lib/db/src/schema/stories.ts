import { pgTable, text, real, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Weekly narrative centroids per Story — used for drift detection
export const storyCentroidsTable = pgTable("story_centroids", {
  id: text("id").primaryKey(),
  storyId: text("story_id").notNull(),
  weekStart: timestamp("week_start", { withTimezone: true }).notNull(),
  // mean embedding vector stored as JSON array
  centroid: text("centroid").notNull(),
  articleCount: text("article_count").notNull(),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
});

// Contradicting event pairs awaiting Analyst agent resolution (Phase 3)
export const contradictionQueueTable = pgTable("contradiction_queue", {
  id: text("id").primaryKey(),
  eventIdA: text("event_id_a").notNull(),
  eventIdB: text("event_id_b").notNull(),
  actorPair: text("actor_pair").notNull(), // "CountryA|CountryB"
  cameoCodeA: text("cameo_code_a").notNull(),
  cameoCodeB: text("cameo_code_b").notNull(),
  storyId: text("story_id"),
  resolutionStatus: text("resolution_status").notNull().default("open"), // open | resolved
  resolvedBy: text("resolved_by"), // article_id that corroborated one side
  detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertStoryCentroidSchema = createInsertSchema(storyCentroidsTable).omit({
  computedAt: true,
});
export type InsertStoryCentroid = z.infer<typeof insertStoryCentroidSchema>;
export type StoryCentroid = typeof storyCentroidsTable.$inferSelect;

export const insertContradictionSchema = createInsertSchema(contradictionQueueTable).omit({
  detectedAt: true,
});
export type InsertContradiction = z.infer<typeof insertContradictionSchema>;
export type Contradiction = typeof contradictionQueueTable.$inferSelect;

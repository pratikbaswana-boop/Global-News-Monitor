import { pgTable, text, boolean, timestamp, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const predictionSnapshotsTable = pgTable("prediction_snapshots", {
  id: text("id").primaryKey(),
  templateId: text("template_id").notNull(),
  clusterId: text("cluster_id").notNull(),
  headline: text("headline").notNull(),
  reasoning: text("reasoning").notNull(),
  historicalPrecedent: text("historical_precedent").notNull(),
  triggerSummary: text("trigger_summary").notNull(),
  potentialOutcomes: text("potential_outcomes").notNull(),
  confidence: text("confidence").notNull(),
  riskLevel: text("risk_level").notNull(),
  timeframeText: text("timeframe_text").notNull(),
  category: text("category").notNull(),
  countries: text("countries").notNull(),
  leaders: text("leaders").notNull(),
  triggerScore: numeric("trigger_score").notNull(),
  triggerArticleIds: text("trigger_article_ids").notNull(),
  snapshotAt: timestamp("snapshot_at", { withTimezone: true }).notNull().defaultNow(),
  resolveAfter: timestamp("resolve_after", { withTimezone: true }).notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  isCorrect: boolean("is_correct"),
  resolutionNotes: text("resolution_notes"),
});

export const insertPredictionSnapshotSchema = createInsertSchema(predictionSnapshotsTable).omit({
  snapshotAt: true,
  resolvedAt: true,
  isCorrect: true,
  resolutionNotes: true,
});
export type InsertPredictionSnapshot = z.infer<typeof insertPredictionSnapshotSchema>;
export type PredictionSnapshot = typeof predictionSnapshotsTable.$inferSelect;

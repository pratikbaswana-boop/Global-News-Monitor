import { pgTable, text, real, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Phase 3 prediction schema — probabilistic scenario trees with falsification conditions.
// Replaces the keyword-triggered prediction_snapshots approach.
export const predictionV2Table = pgTable("prediction_v2", {
  id: text("id").primaryKey(),
  storyId: text("story_id").notNull(),

  // Agent outputs (stored as JSON strings)
  analystReport: text("analyst_report").notNull(),       // SituationReport JSON
  historianPrecedents: text("historian_precedents").notNull(), // historical analogues + base rates JSON
  forecasterTree: text("forecaster_tree").notNull(),     // 3 scenarios JSON
  devilCritique: text("devil_critique").notNull(),       // Devil's Advocate output JSON
  finalScenarios: text("final_scenarios").notNull(),     // merged forecaster + devil revisions

  // Pipeline metadata
  flags: text("flags").notNull().default("[]"), // JSON array: no_historical_analogue, active_contradiction, narrative_drifting
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),

  // Resolution tracking
  resolveAfter: timestamp("resolve_after", { withTimezone: true }).notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolutionStatus: text("resolution_status").notNull().default("pending"), // pending | auto_resolved | manually_resolved

  // Scoring (populated after resolution)
  brierScore: real("brier_score"),
  lessonsLearned: text("lessons_learned"), // GPT-4o post-mortem JSON
  devilWasRight: text("devil_was_right"), // boolean stored as text for nullable
  missedChannel: text("missed_channel"),
  dominantChannel: text("dominant_channel"),
});

export const insertPredictionV2Schema = createInsertSchema(predictionV2Table).omit({
  generatedAt: true,
  resolvedAt: true,
  brierScore: true,
  lessonsLearned: true,
});
export type InsertPredictionV2 = z.infer<typeof insertPredictionV2Schema>;
export type PredictionV2 = typeof predictionV2Table.$inferSelect;

import { pgTable, text, real, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Phase 3 prediction schema — probabilistic scenario trees with falsification conditions.
export const predictionV2Table = pgTable("prediction_v2", {
  id: text("id").primaryKey(),
  storyId: text("story_id").notNull(),

  // Agent outputs (stored as JSON strings)
  analystReport: text("analyst_report").notNull(),
  historianPrecedents: text("historian_precedents").notNull(),
  forecasterTree: text("forecaster_tree").notNull(),
  devilCritique: text("devil_critique").notNull(),
  finalScenarios: text("final_scenarios").notNull(),

  // Pipeline metadata
  flags: text("flags").notNull().default("[]"),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),

  // Resolution tracking
  resolveAfter: timestamp("resolve_after", { withTimezone: true }).notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolutionStatus: text("resolution_status").notNull().default("pending"),
  resolvedScenarioIndex: integer("resolved_scenario_index"), // 0-2, which scenario materialised
  outcomeDescription: text("outcome_description"),           // human-readable outcome summary

  // Scoring (populated after resolution)
  brierScore: real("brier_score"),
  lessonsLearned: text("lessons_learned"),
  devilWasRight: text("devil_was_right"),
  missedChannel: text("missed_channel"),
  dominantChannel: text("dominant_channel"),

  // 4-level Brier breakdown (JSON)
  brierByStoryType: text("brier_by_story_type"),    // { [storyType]: brierScore }
  brierByCameoAction: text("brier_by_cameo_action"), // { [cameoCode]: brierScore }
  brierByChannel: text("brier_by_channel"),          // { [channelId]: brierScore }
});

export const insertPredictionV2Schema = createInsertSchema(predictionV2Table).omit({
  generatedAt: true,
  resolvedAt: true,
  brierScore: true,
  lessonsLearned: true,
  resolvedScenarioIndex: true,
  outcomeDescription: true,
  brierByStoryType: true,
  brierByCameoAction: true,
  brierByChannel: true,
});
export type InsertPredictionV2 = z.infer<typeof insertPredictionV2Schema>;
export type PredictionV2 = typeof predictionV2Table.$inferSelect;

import { pgTable, text, real, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// CAMEO-structured event extracted by GPT-4o (or pre-extracted by GDELT)
export const extractedEventsTable = pgTable("extracted_events", {
  id: text("id").primaryKey(),
  articleId: text("article_id").notNull(),
  // actors JSON: [{name, role, country_iso, entity_type}]
  actors: text("actors").notNull(),
  actionType: text("action_type").notNull(), // CAMEO code e.g. SANCTION, MOBILIZE_MILITARY
  actionLabel: text("action_label").notNull(), // plain English
  // target JSON: {name, country_iso, entity_type}
  target: text("target").notNull(),
  // location JSON: {country_iso, region, city}
  location: text("location").notNull(),
  eventDate: text("event_date").notNull(), // ISO 8601 or UNKNOWN
  statedIntent: text("stated_intent").notNull(),
  requiresCorroboration: boolean("requires_corroboration").notNull().default(false),
  isHypothesis: boolean("is_hypothesis").notNull().default(false),
  confidence: real("confidence").notNull(),
  storyId: text("story_id"), // set in Phase 2 after Louvain
  extractedAt: timestamp("extracted_at", { withTimezone: true }).notNull().defaultNow(),
});

// Failed extractions for audit and retry
export const extractionErrorsTable = pgTable("extraction_errors", {
  id: text("id").primaryKey(),
  articleId: text("article_id").notNull(),
  errorType: text("error_type").notNull(), // malformed_json | model_refusal | timeout
  errorMessage: text("error_message").notNull(),
  rawResponse: text("raw_response"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertExtractedEventSchema = createInsertSchema(extractedEventsTable).omit({
  extractedAt: true,
});
export type InsertExtractedEvent = z.infer<typeof insertExtractedEventSchema>;
export type ExtractedEvent = typeof extractedEventsTable.$inferSelect;

export const insertExtractionErrorSchema = createInsertSchema(extractionErrorsTable).omit({
  occurredAt: true,
});
export type InsertExtractionError = z.infer<typeof insertExtractionErrorSchema>;
export type ExtractionError = typeof extractionErrorsTable.$inferSelect;

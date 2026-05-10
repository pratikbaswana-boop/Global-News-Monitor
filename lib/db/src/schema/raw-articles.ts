import { pgTable, text, integer, boolean, timestamp, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const rawArticlesTable = pgTable("raw_articles", {
  id: text("id").primaryKey(),
  feedId: text("feed_id").notNull(),
  url: text("url").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
  credibilityTier: integer("credibility_tier").notNull(),
  isStateMedia: boolean("is_state_media").notNull().default(false),
  biasFlag: boolean("bias_flag").notNull().default(false),
  // embedding stored as JSON array string: "[0.123, -0.456, ...]"
  embedding: text("embedding"),
  dedupStatus: text("dedup_status").notNull().default("pending"), // pending | independent | duplicate | corroboration
  corroborationCount: integer("corroboration_count").notNull().default(0),
  requiresCorroboration: boolean("requires_corroboration").notNull().default(false),
  ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
});

// Tracks which articles corroborate each other
export const articleCorroborationsTable = pgTable("article_corroborations", {
  id: text("id").primaryKey(),
  primaryArticleId: text("primary_article_id").notNull(),
  corroboratingArticleId: text("corroborating_article_id").notNull(),
  similarityScore: real("similarity_score").notNull(),
  linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertRawArticleSchema = createInsertSchema(rawArticlesTable).omit({
  ingestedAt: true,
});
export type InsertRawArticle = z.infer<typeof insertRawArticleSchema>;
export type RawArticle = typeof rawArticlesTable.$inferSelect;

export const insertArticleCorroborationSchema = createInsertSchema(articleCorroborationsTable).omit({
  linkedAt: true,
});
export type InsertArticleCorroboration = z.infer<typeof insertArticleCorroborationSchema>;
export type ArticleCorroboration = typeof articleCorroborationsTable.$inferSelect;

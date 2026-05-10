import { pgTable, text, numeric, boolean, timestamp, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const marketSnapshotsTable = pgTable("market_snapshots", {
  id: text("id").primaryKey(),
  assetId: text("asset_id").notNull(),
  assetName: text("asset_name").notNull(),
  assetSymbol: text("asset_symbol").notNull(),
  predictedDirection: text("predicted_direction").notNull(),
  predictedMagnitude: text("predicted_magnitude").notNull(),
  predictedConfidence: text("predicted_confidence").notNull(),
  priceImpactEstimate: text("price_impact_estimate").notNull(),
  timeframe: text("timeframe").notNull(),
  bullScore: numeric("bull_score").notNull(),
  bearScore: numeric("bear_score").notNull(),
  dominantNarrative: text("dominant_narrative").notNull(),
  verdict: text("verdict").notNull(),
  triggerArticleIds: text("trigger_article_ids").notNull().default("[]"),
  triggerNewsSummary: text("trigger_news_summary").notNull().default(""),
  assumptions: text("assumptions").notNull().default(""),
  snapshotAt: timestamp("snapshot_at", { withTimezone: true }).notNull().defaultNow(),
  resolveAfter: timestamp("resolve_after", { withTimezone: true }).notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolutionDirection: text("resolution_direction"),
  realPriceAtSnapshot: numeric("real_price_at_snapshot"),
  realPriceAtResolution: numeric("real_price_at_resolution"),
  priceChangePct: numeric("price_change_pct"),
  isCorrect: boolean("is_correct"),
  resolutionNotes: text("resolution_notes"),
  flipReason: text("flip_reason"),
  lessonsLearned: text("lessons_learned"),
  // Regime & ensemble columns
  regimeAtSnapshot: text("regime_at_snapshot"),           // RISK_ON | RISK_OFF | CRISIS
  activeChannels: text("active_channels"),                // JSON array of active Neo4j transmission channel IDs
  ensembleVotes: text("ensemble_votes"),                  // JSON: { "6h": "BULLISH", "24h": "BEARISH", "72h": "BULLISH", "final": "UNCERTAIN" }
  uncertaintyFlag: boolean("uncertainty_flag").default(false),
  dominantChannel: text("dominant_channel"),              // e.g. "crude_oil_spike"
  brierScoreContribution: real("brier_score_contribution"),
});

export const insertMarketSnapshotSchema = createInsertSchema(marketSnapshotsTable).omit({
  snapshotAt: true,
  resolvedAt: true,
  isCorrect: true,
  resolutionDirection: true,
  resolutionNotes: true,
  realPriceAtResolution: true,
  priceChangePct: true,
  flipReason: true,
  lessonsLearned: true,
  brierScoreContribution: true,
});
export type InsertMarketSnapshot = z.infer<typeof insertMarketSnapshotSchema>;
export type MarketSnapshot = typeof marketSnapshotsTable.$inferSelect;

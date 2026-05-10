import { pgTable, text, real, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Phase 4: HMM regime state per asset — updated hourly during market hours.
export const marketRegimesTable = pgTable("market_regimes", {
  id: text("id").primaryKey(),
  assetId: text("asset_id").notNull(),

  regime: text("regime").notNull(), // "bull" | "bear" | "sideways"

  // Forward-algorithm state probabilities (sum to 1.0)
  bullProbability: real("bull_probability").notNull(),
  sidewaysProbability: real("sideways_probability").notNull(),
  bearProbability: real("bear_probability").notNull(),

  // Price data used for detection
  latestClose: real("latest_close"),
  lookbackDays: real("lookback_days").notNull().default(30),
  returnsJson: text("returns_json").notNull(), // JSON number[] — daily % returns

  detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertMarketRegimeSchema = createInsertSchema(marketRegimesTable).omit({ detectedAt: true });
export type InsertMarketRegime = z.infer<typeof insertMarketRegimeSchema>;
export type MarketRegime = typeof marketRegimesTable.$inferSelect;

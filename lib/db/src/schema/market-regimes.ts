import { pgTable, text, real, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Phase 4: HMM regime state — updated hourly during market hours.
export const marketRegimesTable = pgTable("market_regimes", {
  id: text("id").primaryKey(),
  assetId: text("asset_id").notNull(),

  regime: text("regime").notNull(), // "RISK_ON" | "RISK_OFF" | "CRISIS"

  // Forward-algorithm state probabilities (sum to 1.0)
  riskOnProbability: real("risk_on_probability").notNull(),
  riskOffProbability: real("risk_off_probability").notNull(),
  crisisProbability: real("crisis_probability").notNull(),

  // Raw 5-dim feature snapshot used for detection
  vixLevel: real("vix_level"),
  vixChange5d: real("vix_change_5d"),
  fiiNetFlow5d: real("fii_net_flow_5d"),      // ₹ crore
  niftyRealVol10d: real("nifty_real_vol_10d"), // annualised %
  inrUsdChange5d: real("inr_usd_change_5d"),   // %

  featuresJson: text("features_json").notNull(), // JSON RegimeFeatures[] — rolling window
  sequenceSummary: text("sequence_summary"),     // e.g. "OOOFFC"

  detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertMarketRegimeSchema = createInsertSchema(marketRegimesTable).omit({ detectedAt: true });
export type InsertMarketRegime = z.infer<typeof insertMarketRegimeSchema>;
export type MarketRegime = typeof marketRegimesTable.$inferSelect;

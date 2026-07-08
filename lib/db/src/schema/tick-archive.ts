import { pgTable, text, numeric, timestamp, bigserial, integer, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ── Raw tick data from KiteTicker WebSocket ──────────────────────────────────
// Every tick received from Kite is stored here for backtesting and audit.
// Two categories: "spot" (NIFTY 50 index) and "option" (NFO-OPT instruments).

export const tickArchiveTable = pgTable("tick_archive", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  ts: timestamp("ts", { withTimezone: true }).notNull(),       // tick arrival time
  category: text("category").notNull(),                         // "spot" | "option" | "equity"
  token: integer("token").notNull(),                            // Kite instrument token
  tradingsymbol: text("tradingsymbol"),                         // e.g. NIFTY26JUL24500CE (null for spot)
  ltp: numeric("ltp", { precision: 12, scale: 4 }).notNull(),
  oi: numeric("oi", { precision: 20, scale: 0 }),              // open interest (options only)
  volume: numeric("volume", { precision: 20, scale: 0 }),      // cumulative day volume
  prevClose: numeric("prev_close", { precision: 12, scale: 4 }), // previous day close (spot only)
  extra: jsonb("extra"),                                        // reserved for future fields
});

export const insertTickArchiveSchema = createInsertSchema(tickArchiveTable).omit({
  id: true,
});
export type InsertTickArchive = z.infer<typeof insertTickArchiveSchema>;
export type TickArchive = typeof tickArchiveTable.$inferSelect;

// ── Computed chain metrics snapshot ───────────────────────────────────────────
// Stored every time we compute chain metrics from the tick map (throttled to ~1s).

export const chainMetricsArchiveTable = pgTable("chain_metrics_archive", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  ts: timestamp("ts", { withTimezone: true }).notNull(),
  spotPrice: numeric("spot_price", { precision: 12, scale: 4 }).notNull(),
  callOI: numeric("call_oi", { precision: 20, scale: 0 }).notNull(),
  putOI: numeric("put_oi", { precision: 20, scale: 0 }).notNull(),
  optionVolume: numeric("option_volume", { precision: 20, scale: 0 }).notNull(),
  atmIV: numeric("atm_iv", { precision: 8, scale: 4 }),
  atmGamma: numeric("atm_gamma", { precision: 12, scale: 8 }),
  pcr: numeric("pcr", { precision: 8, scale: 4 }),
  maxPainStrike: numeric("max_pain_strike", { precision: 12, scale: 4 }),
  // Tier-3 signal state at this moment
  tier3D: numeric("tier3_d", { precision: 8, scale: 4 }),       // direction EMA
  tier3P: numeric("tier3_p", { precision: 8, scale: 4 }),       // power EMA
  spotPersistence: numeric("spot_persistence", { precision: 8, scale: 4 }),
  spotNetPct: numeric("spot_net_pct", { precision: 8, scale: 4 }),
});

export const insertChainMetricsArchiveSchema = createInsertSchema(chainMetricsArchiveTable).omit({
  id: true,
});
export type InsertChainMetricsArchive = z.infer<typeof insertChainMetricsArchiveSchema>;
export type ChainMetricsArchive = typeof chainMetricsArchiveTable.$inferSelect;

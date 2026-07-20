// Per-asset raw-news selection for the market direction generator.
//
// Key principle (per product intent): an instrument is NOT moved by news that
// literally names it ("Nifty 50" rarely appears in the article that moves the Nifty).
// It is moved by its DRIVERS. So for each forecast asset we enumerate the topics that
// actually push it, expand those into keyword/alias sets, and match raw articles on the
// drivers — within a time window that reaches back to the last trading day.
//
// Pipeline: one DB query for the window → in-memory driver-match scoring per asset →
// compact summary string injected into runMarketAgent's prompt (see market-agent.ts).

import { db, rawArticlesTable } from "@workspace/db";
import { gt, desc } from "drizzle-orm";
import { logger } from "../../lib/logger.js";

// ── Drivers per asset ─────────────────────────────────────────────────────────
// Grouped by the real-world transmission channel so the list stays maintainable.
// Keep tokens lowercase; short acronyms are matched with word boundaries (below),
// so "ril"/"fii"/"nim" won't false-match inside "April"/"affiliate"/"minimum".

const BROAD_MARKET_DRIVERS = [
  // Institutional flows
  "fii", "dii", "foreign institutional", "foreign investors", "fpi", "institutional flows",
  // India monetary / macro
  "rbi", "repo rate", "monetary policy", "mpc", "inflation", "cpi", "wpi", "gdp", "iip",
  "fiscal deficit", "union budget", "gst collection", "monsoon", "industrial output",
  // Global macro cues
  "us fed", "federal reserve", "fomc", "jerome powell", "rate cut", "rate hike",
  "us inflation", "treasury yield", "dollar index", "crude oil", "brent", "wti",
  "rupee", "usd/inr", "global cues", "wall street", "nasdaq", "dow jones",
  // Risk / structural (trade tariffs kept specific so telecom "5G tariffs" can't match)
  "trade tariff", "import tariff", "tariff war", "trump tariff", "trade war",
  "geopolitical", "recession", "sovereign rating", "earnings season",
  // Index-native
  "nifty", "sensex", "dalal street", "indian equities", "indian markets", "bse", "nse",
];

const ASSET_NEWS_DRIVERS: Record<string, string[]> = {
  // Broad indices — driven almost entirely by macro + flows.
  nifty50: BROAD_MARKET_DRIVERS,
  sensex: BROAD_MARKET_DRIVERS,

  // Reliance — conglomerate: energy margins + Jio tariffs + retail + capex narrative.
  reliance: [
    "reliance", "ril", "mukesh ambani", "ambani", "reliance industries",
    "jio", "reliance jio", "jio platforms", "telecom tariff", "arpu", "5g",
    "reliance retail", "o2c", "oil-to-chemicals", "refining margin", "gross refining",
    "petrochemical", "kg-d6", "new energy", "green hydrogen", "reliance agm",
    "crude oil", "brent", "singapore grm", // refining-margin drivers
  ],

  // TCS — IT exporter: global discretionary tech spend + deal flow + rupee + visas.
  tcs: [
    "tcs", "tata consultancy", "tata consultancy services",
    "it services", "it sector", "indian it", "software exporter", "outsourcing",
    "deal wins", "tcv", "order book", "deal pipeline", "attrition",
    "discretionary spend", "client budgets", "bfsi spending", "it spending",
    "h-1b", "h1b", "visa", "accenture", "nasdaq", // peer/sector cues
    "rupee", "usd/inr", "us recession", // exporters gain on weak rupee
  ],

  // HDFC Bank — private lender: rates, margins, deposits, asset quality, bank index.
  "hdfc-bank": [
    "hdfc bank", "hdfcbank", "hdfc",
    "private banks", "banking sector", "bank nifty", "nifty bank", "psu banks",
    "net interest margin", "nim", "credit growth", "loan growth", "deposit growth",
    "casa", "asset quality", "npa", "gross npa", "slippages", "provisioning",
    "rbi", "repo rate", "monetary policy", "liquidity", "hdfc merger",
  ],

  // Gold — macro hedge: real yields, dollar, inflation, safe-haven, CB buying.
  gold: [
    "gold", "bullion", "gold price", "mcx gold", "comex gold", "spot gold",
    "fed rate", "rate cut", "real yields", "treasury yield", "us dollar", "dollar index",
    "inflation hedge", "safe haven", "safe-haven", "central bank gold", "gold reserves",
    "geopolitical", "risk-off",
  ],

  // Silver — gold drivers + industrial/solar demand.
  silver: [
    "silver", "mcx silver", "comex silver", "bullion", "silver price",
    "gold-silver ratio", "industrial metal", "solar demand", "photovoltaic",
    "fed rate", "real yields", "dollar index", "safe haven",
  ],

  // ── AMF Stock Universe ──────────────────────────────────────────────────────

  // Energy
  ongc: ["ongc", "oil and natural gas", "crude oil", "brent", "oil exploration", "upstream oil", "government disinvestment", "oil subsidy"],
  ntpc: ["ntpc", "power generation", "thermal power", "renewable energy", "coal", "power tariff", "capacity addition", "electricity"],
  powergrid: ["powergrid", "power grid", "transmission", "inter-regional", "grid", "power infrastructure", "renewable transmission"],

  // IT
  infosys: ["infosys", "infy", "it services", "indian it", "software exporter", "outsourcing", "deal wins", "digital transformation", "guidance", "attrition", "h-1b", "visa", "rupee", "usd/inr", "bfsi spending"],
  wipro: ["wipro", "it services", "indian it", "software exporter", "outsourcing", "deal wins", "attrition", "h-1b", "visa", "rupee", "usd/inr", "guidance"],
  hcltech: ["hcltech", "hcl technologies", "it services", "indian it", "software exporter", "outsourcing", "deal wins", "attrition", "h-1b", "visa", "rupee", "engineering services"],
  techm: ["tech mahindra", "techm", "it services", "indian it", "software exporter", "outsourcing", "5g", "telecom it", "deal wins", "attrition", "h-1b", "visa", "rupee"],

  // Banking
  "icici-bank": ["icici bank", "icicibank", "icici", "private banks", "banking sector", "bank nifty", "net interest margin", "nim", "credit growth", "loan growth", "deposit growth", "casa", "asset quality", "npa", "provisioning", "rbi", "repo rate"],
  sbin: ["state bank of india", "sbin", "sbi", "psu banks", "banking sector", "bank nifty", "net interest margin", "credit growth", "loan growth", "deposit growth", "asset quality", "npa", "provisioning", "rbi", "repo rate", "government stake"],
  "axis-bank": ["axis bank", "axisbank", "private banks", "banking sector", "bank nifty", "net interest margin", "credit growth", "loan growth", "deposit growth", "casa", "asset quality", "npa", "provisioning", "rbi", "repo rate"],
  "kotak-bank": ["kotak mahindra", "kotakbank", "kotak bank", "private banks", "banking sector", "bank nifty", "net interest margin", "credit growth", "deposit growth", "casa", "asset quality", "npa", "rbi", "repo rate"],

  // Auto
  maruti: ["maruti", "maruti suzuki", "auto sector", "car sales", "passenger vehicle", "pv sales", "automobile", "vehicle dispatch", "semiconductor shortage", "rural demand", "fuel price"],
  "tata-motors": ["tata motors", "tatamotors", "jlr", "jaguar land rover", "auto sector", "commercial vehicle", "cv sales", "passenger vehicle", "ev", "electric vehicle", "vehicle sales", "brexit"],
  "m-and-m": ["mahindra", "m&m", "auto sector", "tractor sales", "farm equipment", "suv", "passenger vehicle", "ev", "electric vehicle", "rural demand"],

  // FMCG
  hindunilvr: ["hindustan unilever", "hul", "hindunilvr", "fmcg", "consumer goods", "volume growth", "rural demand", "input cost", "palm oil", "crude palm oil", "premiumisation", "d2c"],
  itc: ["itc", "itc limited", "fmcg", "cigarette", "tobacco", "gst on tobacco", "hotel business", "paperboard", "agri business", "volume growth", "rural demand"],
  nestleind: ["nestle india", "nestleind", "nestle", "fmcg", "consumer goods", "volume growth", "input cost", "coffee", "milk prices", "premiumisation", "maggi", "kitkat"],

  // Pharma
  sunpharma: ["sun pharma", "sunpharma", "pharma sector", "usfda", "fda approval", "generic", "andaman", "specialty pharma", "ranbaxy", "us pharma", "drug recall"],
  drreddy: ["dr reddy", "drreddy", "dr reddy's", "pharma sector", "usfda", "fda approval", "generic", "andaman", "api", "us pharma", "drug recall", "russia"],
  cipla: ["cipla", "pharma sector", "usfda", "fda approval", "generic", "respiratory", "api", "us pharma", "drug recall", "south africa"],

  // Metals
  "tata-steel": ["tata steel", "tatasteel", "steel sector", "steel price", "hot rolled coil", "hrc", "iron ore", "coking coal", "china steel", "anti-dumping", "corus", "europe steel"],
  hindalco: ["hindalco", "novelis", "aluminium", "aluminum", "copper", "lme", "london metal exchange", "metal sector", "china demand", "auto demand"],
  "jsw-steel": ["jsw steel", "jswsteel", "steel sector", "steel price", "hot rolled coil", "hrc", "iron ore", "coking coal", "china steel", "anti-dumping", "capacity addition"],

  // Infra / Cement
  lt: ["larsen", "l&t", "lt", "infrastructure", "order book", "order inflow", "construction", "engineering", "ePC", "hydrocarbon", "power", "middle east order"],
  ultracemco: ["ultratech", "ultracemco", "cement sector", "cement demand", "real estate", "infrastructure spending", "capacity addition", "clinker", "fuel cost"],

  // Telecom
  "bharti-artl": ["bharti airtel", "bhartiartl", "airtel", "telecom sector", "arpu", "5g", "tariff hike", "subscriber addition", "fiber", "africa telecom", "vodafone idea", "jio"],
};

// ── Time window: back to the last trading day ─────────────────────────────────
// Normal weekday → 24h. Saturday/Sunday → 48h. Monday → reaches back through the
// weekend to Friday (~72h). Implemented as: 1 day, plus every consecutive
// non-trading (weekend) day immediately preceding today; weekends floor at 2 days.

function istDay(d: Date): number {
  // Day-of-week in IST (UTC+5:30).
  return new Date(d.getTime() + 330 * 60 * 1000).getUTCDay(); // 0=Sun..6=Sat
}

function isWeekendIST(d: Date): boolean {
  const day = istDay(d);
  return day === 0 || day === 6;
}

export function getNewsWindowStart(now: Date = new Date()): Date {
  let days = 1;
  const probe = new Date(now);
  probe.setUTCDate(probe.getUTCDate() - 1);
  while (isWeekendIST(probe)) {
    days++;
    probe.setUTCDate(probe.getUTCDate() - 1);
  }
  if (isWeekendIST(now)) days = Math.max(days, 2);
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

// ── Driver matching ───────────────────────────────────────────────────────────

const BODY_SCAN_LIMIT = 2000; // cap body scan length per article

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Compile one word-boundary regex per asset (alternation of its drivers).
const ASSET_MATCHERS: Record<string, RegExp> = {};
for (const [assetId, kws] of Object.entries(ASSET_NEWS_DRIVERS)) {
  const alts = kws.map(escapeRegex).join("|");
  ASSET_MATCHERS[assetId] = new RegExp(`\\b(?:${alts})\\b`, "gi");
}

interface ScoredArticle {
  title: string;
  feedId: string;
  publishedAt: Date;
  credibilityTier: number;
  score: number;
  drivers: string[];
}

/** Count distinct driver hits for one asset in an article's text. */
function scoreArticle(assetId: string, text: string): { score: number; drivers: string[] } {
  const re = ASSET_MATCHERS[assetId];
  if (!re) return { score: 0, drivers: [] };
  re.lastIndex = 0;
  const hits = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) hits.add(m[0].toLowerCase());
  return { score: hits.size, drivers: [...hits] };
}

const MAX_ARTICLES_PER_ASSET = 6;

function formatSummary(assetLabel: string, windowStart: Date, items: ScoredArticle[]): string {
  if (items.length === 0) {
    return `RELEVANT NEWS for ${assetLabel} (since ${windowStart.toISOString().slice(0, 16)}Z): none found on its drivers.`;
  }
  const lines = items.map((a) => {
    const when = a.publishedAt.toISOString().slice(0, 16).replace("T", " ");
    return `- [${when}] ${a.title.trim()} (drivers: ${a.drivers.slice(0, 3).join(", ")})`;
  });
  return [
    `RELEVANT NEWS for ${assetLabel} — last-trading-day window, filtered to its market drivers:`,
    ...lines,
  ].join("\n");
}

/**
 * One DB query for the window, then per-asset driver scoring in memory.
 * Returns a map assetId → compact summary string for prompt injection.
 */
export async function getRelevantNewsByAsset(
  assets: Array<{ id: string; name: string }>,
  now: Date = new Date(),
): Promise<Map<string, string>> {
  const windowStart = getNewsWindowStart(now);
  const out = new Map<string, string>();

  let rows: Array<typeof rawArticlesTable.$inferSelect>;
  try {
    rows = await db
      .select()
      .from(rawArticlesTable)
      .where(gt(rawArticlesTable.publishedAt, windowStart))
      .orderBy(desc(rawArticlesTable.publishedAt))
      .limit(600);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "stock-news: article fetch failed");
    for (const a of assets) out.set(a.id, "");
    return out;
  }

  // Pre-lowercase scan text once per article (title + capped body).
  const scanText = rows.map((r) => `${r.title}\n${(r.body ?? "").slice(0, BODY_SCAN_LIMIT)}`.toLowerCase());

  for (const asset of assets) {
    if (!ASSET_MATCHERS[asset.id]) {
      out.set(asset.id, "");
      continue;
    }
    const seen = new Set<string>();
    const scored: ScoredArticle[] = [];
    for (let i = 0; i < rows.length; i++) {
      const { score, drivers } = scoreArticle(asset.id, scanText[i]!);
      if (score === 0) continue;
      const r = rows[i]!;
      const key = r.title.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      scored.push({
        title: r.title,
        feedId: r.feedId,
        publishedAt: r.publishedAt,
        credibilityTier: r.credibilityTier,
        score,
        drivers,
      });
    }
    // Rank: most drivers matched, then most credible (tier 1 best), then most recent.
    scored.sort((a, b) =>
      b.score - a.score ||
      a.credibilityTier - b.credibilityTier ||
      b.publishedAt.getTime() - a.publishedAt.getTime()
    );
    const top = scored.slice(0, MAX_ARTICLES_PER_ASSET);
    out.set(asset.id, formatSummary(asset.name, windowStart, top));
    logger.debug({ assetId: asset.id, matched: scored.length, kept: top.length }, "stock-news: relevance selected");
  }

  return out;
}

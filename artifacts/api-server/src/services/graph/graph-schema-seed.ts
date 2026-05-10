import { runCypher } from "./neo4j-client.js";
import { logger } from "../../lib/logger.js";

// ─── Indexes ─────────────────────────────────────────────────────────────────

export async function createIndexes(): Promise<void> {
  const indexes = [
    "CREATE INDEX event_date IF NOT EXISTS FOR (e:Event) ON (e.event_date)",
    "CREATE INDEX event_cameo IF NOT EXISTS FOR (e:Event) ON (e.cameo_code)",
    "CREATE INDEX country_name IF NOT EXISTS FOR (c:Country) ON (c.name)",
    "CREATE INDEX leader_name IF NOT EXISTS FOR (l:Leader) ON (l.name)",
    "CREATE INDEX story_id IF NOT EXISTS FOR (s:Story) ON (s.id)",
  ];
  for (const q of indexes) {
    await runCypher(q);
  }
  logger.info("neo4j indexes created");
}

// ─── Static Country Seed ─────────────────────────────────────────────────────

const COUNTRY_SEED = [
  { name: "United States", iso_code: "US", region: "Americas", un_member: true, nuclear_status: "nuclear" },
  { name: "China", iso_code: "CN", region: "Asia", un_member: true, nuclear_status: "nuclear" },
  { name: "Russia", iso_code: "RU", region: "Europe", un_member: true, nuclear_status: "nuclear" },
  { name: "India", iso_code: "IN", region: "Asia", un_member: true, nuclear_status: "nuclear" },
  { name: "Pakistan", iso_code: "PK", region: "Asia", un_member: true, nuclear_status: "nuclear" },
  { name: "United Kingdom", iso_code: "GB", region: "Europe", un_member: true, nuclear_status: "nuclear" },
  { name: "France", iso_code: "FR", region: "Europe", un_member: true, nuclear_status: "nuclear" },
  { name: "Germany", iso_code: "DE", region: "Europe", un_member: true, nuclear_status: "non-nuclear" },
  { name: "Japan", iso_code: "JP", region: "Asia", un_member: true, nuclear_status: "non-nuclear" },
  { name: "South Korea", iso_code: "KR", region: "Asia", un_member: true, nuclear_status: "non-nuclear" },
  { name: "North Korea", iso_code: "KP", region: "Asia", un_member: true, nuclear_status: "nuclear" },
  { name: "Iran", iso_code: "IR", region: "Middle East", un_member: true, nuclear_status: "suspected" },
  { name: "Israel", iso_code: "IL", region: "Middle East", un_member: true, nuclear_status: "suspected" },
  { name: "Saudi Arabia", iso_code: "SA", region: "Middle East", un_member: true, nuclear_status: "non-nuclear" },
  { name: "Ukraine", iso_code: "UA", region: "Europe", un_member: true, nuclear_status: "non-nuclear" },
  { name: "Turkey", iso_code: "TR", region: "Europe/Asia", un_member: true, nuclear_status: "non-nuclear" },
  { name: "Brazil", iso_code: "BR", region: "Americas", un_member: true, nuclear_status: "non-nuclear" },
  { name: "Australia", iso_code: "AU", region: "Oceania", un_member: true, nuclear_status: "non-nuclear" },
  { name: "Canada", iso_code: "CA", region: "Americas", un_member: true, nuclear_status: "non-nuclear" },
  { name: "Taiwan", iso_code: "TW", region: "Asia", un_member: false, nuclear_status: "non-nuclear" },
  { name: "Palestine", iso_code: "PS", region: "Middle East", un_member: false, nuclear_status: "non-nuclear" },
  { name: "Egypt", iso_code: "EG", region: "Africa", un_member: true, nuclear_status: "non-nuclear" },
  { name: "Indonesia", iso_code: "ID", region: "Asia", un_member: true, nuclear_status: "non-nuclear" },
  { name: "Poland", iso_code: "PL", region: "Europe", un_member: true, nuclear_status: "non-nuclear" },
  { name: "UAE", iso_code: "AE", region: "Middle East", un_member: true, nuclear_status: "non-nuclear" },
];

export async function seedCountries(): Promise<void> {
  for (const c of COUNTRY_SEED) {
    await runCypher(
      `MERGE (c:Country {iso_code: $iso_code})
       SET c.name = $name, c.region = $region, c.un_member = $un_member, c.nuclear_status = $nuclear_status`,
      c
    );
  }
  logger.info({ count: COUNTRY_SEED.length }, "country nodes seeded");
}

// ─── Transmission Channel Nodes ───────────────────────────────────────────────

const TRANSMISSION_CHANNELS = [
  {
    id: "crude_oil_spike",
    type: "crude_oil_spike",
    avg_lag_days: 1.5,
    historical_correlation: 0.71,
    affected_sectors: ["OMC", "aviation", "paints", "tyre"],
    trigger_condition: "Brent +5% in 48h or Middle East conflict event",
  },
  {
    id: "crude_oil_drop",
    type: "crude_oil_drop",
    avg_lag_days: 2.0,
    historical_correlation: 0.63,
    affected_sectors: ["OMC", "aviation"],
    trigger_condition: "Brent -5% in 48h",
  },
  {
    id: "usd_inr_depreciation",
    type: "usd_inr_depreciation",
    avg_lag_days: 0.5,
    historical_correlation: 0.68,
    affected_sectors: ["IT exporters", "import-heavy"],
    trigger_condition: "INR/USD -1% in 24h",
  },
  {
    id: "fii_risk_off",
    type: "fii_risk_off",
    avg_lag_days: 1.0,
    historical_correlation: 0.74,
    affected_sectors: ["NIFTY broad", "banking"],
    trigger_condition: "US VIX spike +15% in 48h",
  },
  {
    id: "china_trade_escalation",
    type: "china_trade_escalation",
    avg_lag_days: 10.5,
    historical_correlation: 0.41,
    affected_sectors: ["IT", "pharma"],
    trigger_condition: "US-China tariff or sanction announcement",
  },
  {
    id: "middle_east_conflict",
    type: "middle_east_conflict",
    avg_lag_days: 2.0,
    historical_correlation: 0.58,
    affected_sectors: ["OMC", "defense PSUs"],
    trigger_condition: "Armed conflict event in Gulf/Levant region",
  },
  {
    id: "russia_sanctions_tighten",
    type: "russia_sanctions_tighten",
    avg_lag_days: 10.5,
    historical_correlation: 0.37,
    affected_sectors: ["fertiliser inputs"],
    trigger_condition: "OFAC new Russia designation",
  },
  {
    id: "fed_hawkish_signal",
    type: "fed_hawkish_signal",
    avg_lag_days: 3.5,
    historical_correlation: 0.52,
    affected_sectors: ["FII outflow", "banking"],
    trigger_condition: "Fed hawkish statement or rate hike",
  },
  {
    id: "global_risk_off",
    type: "global_risk_off",
    avg_lag_days: 0.5,
    historical_correlation: 0.79,
    affected_sectors: ["NIFTY broad"],
    trigger_condition: "VIX > 30",
  },
  {
    id: "rbi_surprise_action",
    type: "rbi_surprise_action",
    avg_lag_days: 1.0,
    historical_correlation: 0.44,
    affected_sectors: ["banking"],
    trigger_condition: "RBI emergency statement or unscheduled intervention",
  },
];

const INDIAN_ASSETS = [
  { symbol: "NIFTY50", name: "Nifty 50 Index", sector: "broad_market", nse_token: "999920000" },
  { symbol: "SENSEX", name: "S&P BSE SENSEX", sector: "broad_market", nse_token: "999941" },
  { symbol: "BANKNIFTY", name: "Nifty Bank Index", sector: "banking", nse_token: "999920001" },
  { symbol: "HPCL", name: "Hindustan Petroleum", sector: "OMC", nse_token: "500104" },
  { symbol: "BPCL", name: "Bharat Petroleum", sector: "OMC", nse_token: "500547" },
  { symbol: "INFY", name: "Infosys Ltd", sector: "IT", nse_token: "500209" },
  { symbol: "TCS", name: "Tata Consultancy Services", sector: "IT", nse_token: "532540" },
  { symbol: "SBIN", name: "State Bank of India", sector: "banking", nse_token: "500112" },
  { symbol: "NIFTYIT", name: "Nifty IT Index", sector: "IT", nse_token: "999920003" },
  { symbol: "NIFTYPHARMA", name: "Nifty Pharma Index", sector: "pharma", nse_token: "999920005" },
];

// Sector-level channel connections per blueprint spec
const CHANNEL_ASSET_LINKS: Array<{
  channelId: string;
  assetSymbol: string;
  direction: "BULL" | "BEAR" | "MIXED" | "VOLATILE";
  historical_correlation: number;
}> = [
  { channelId: "crude_oil_spike", assetSymbol: "HPCL", direction: "BEAR", historical_correlation: 0.71 },
  { channelId: "crude_oil_spike", assetSymbol: "BPCL", direction: "BEAR", historical_correlation: 0.70 },
  { channelId: "crude_oil_drop", assetSymbol: "HPCL", direction: "BULL", historical_correlation: 0.63 },
  { channelId: "usd_inr_depreciation", assetSymbol: "INFY", direction: "BULL", historical_correlation: 0.68 },
  { channelId: "usd_inr_depreciation", assetSymbol: "TCS", direction: "BULL", historical_correlation: 0.67 },
  { channelId: "fii_risk_off", assetSymbol: "NIFTY50", direction: "BEAR", historical_correlation: 0.74 },
  { channelId: "fii_risk_off", assetSymbol: "BANKNIFTY", direction: "BEAR", historical_correlation: 0.72 },
  { channelId: "china_trade_escalation", assetSymbol: "NIFTYIT", direction: "BULL", historical_correlation: 0.41 },
  { channelId: "china_trade_escalation", assetSymbol: "NIFTYPHARMA", direction: "BULL", historical_correlation: 0.38 },
  { channelId: "middle_east_conflict", assetSymbol: "HPCL", direction: "BEAR", historical_correlation: 0.58 },
  { channelId: "middle_east_conflict", assetSymbol: "BPCL", direction: "BEAR", historical_correlation: 0.57 },
  { channelId: "global_risk_off", assetSymbol: "NIFTY50", direction: "BEAR", historical_correlation: 0.79 },
  { channelId: "global_risk_off", assetSymbol: "SENSEX", direction: "BEAR", historical_correlation: 0.79 },
  { channelId: "fed_hawkish_signal", assetSymbol: "BANKNIFTY", direction: "BEAR", historical_correlation: 0.52 },
  { channelId: "rbi_surprise_action", assetSymbol: "BANKNIFTY", direction: "VOLATILE", historical_correlation: 0.44 },
  { channelId: "rbi_surprise_action", assetSymbol: "SBIN", direction: "VOLATILE", historical_correlation: 0.44 },
];

export async function seedTransmissionChannels(): Promise<void> {
  // Seed TransmissionChannel nodes
  for (const ch of TRANSMISSION_CHANNELS) {
    await runCypher(
      `MERGE (tc:TransmissionChannel {id: $id})
       SET tc.type = $type,
           tc.avg_lag_days = $avg_lag_days,
           tc.historical_correlation = $historical_correlation,
           tc.affected_sectors = $affected_sectors,
           tc.trigger_condition = $trigger_condition`,
      { ...ch, affected_sectors: ch.affected_sectors.join(",") }
    );
  }

  // Seed IndianAsset nodes
  for (const asset of INDIAN_ASSETS) {
    await runCypher(
      `MERGE (a:IndianAsset {symbol: $symbol})
       SET a.name = $name, a.sector = $sector, a.nse_token = $nse_token`,
      asset
    );
  }

  // Create AFFECTS edges
  for (const link of CHANNEL_ASSET_LINKS) {
    await runCypher(
      `MATCH (tc:TransmissionChannel {id: $channelId})
       MATCH (a:IndianAsset {symbol: $assetSymbol})
       MERGE (tc)-[r:AFFECTS]->(a)
       SET r.direction = $direction, r.historical_correlation = $historical_correlation`,
      link
    );
  }

  logger.info({
    channels: TRANSMISSION_CHANNELS.length,
    assets: INDIAN_ASSETS.length,
    links: CHANNEL_ASSET_LINKS.length,
  }, "transmission channels and Indian assets seeded");
}

export async function seedGraphSchema(): Promise<void> {
  await createIndexes();
  await seedCountries();
  await seedTransmissionChannels();
  logger.info("phase 2 graph schema seed complete");
}

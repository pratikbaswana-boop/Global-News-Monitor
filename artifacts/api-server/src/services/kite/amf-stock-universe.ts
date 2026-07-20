// AMF Stock Universe — the complete list of equities tracked by the AMF swing engine.
//
// This is completely additive: it doesn't modify the existing NIFTY F&O pipeline or
// the 3-stock SPOT_EQUITY_TOKENS in market-ticker.ts. The swing engine reads from
// this list to subscribe ticks, fetch historical data, and generate signals.
//
// Stocks are selected from NIFTY 50 with high liquidity, spanning diverse sectors.

export interface AmfStockDef {
  symbol: string;          // NSE trading symbol (e.g. "RELIANCE")
  assetId: string;         // internal asset ID (e.g. "reliance")
  name: string;            // display name
  sector: string;          // sector classification
  kiteToken?: number;      // Kite instrument token (resolved dynamically if absent)
  newsDrivers: string[];   // keywords for news matching
}

export const AMF_STOCKS: AmfStockDef[] = [
  // ── Energy / Oil ──
  { symbol: "RELIANCE",   assetId: "reliance",   name: "Reliance Industries", sector: "Energy",   newsDrivers: ["reliance", "ril", "ambani", "jio", "reliance retail", "o2c", "oil-to-chemicals", "refining margin", "petrochemical", "new energy", "green hydrogen", "crude oil", "brent"] },
  { symbol: "ONGC",       assetId: "ongc",        name: "Oil & Natural Gas Corp", sector: "Energy", newsDrivers: ["ongc", "oil and natural gas", "crude oil", "brent", "oil exploration", "upstream oil", "government disinvestment", "oil subsidy"] },
  { symbol: "NTPC",       assetId: "ntpc",        name: "NTPC Ltd", sector: "Power",   newsDrivers: ["ntpc", "power generation", "thermal power", "renewable energy", "coal", "power tariff", "capacity addition", "electricity"] },
  { symbol: "POWERGRID",  assetId: "powergrid",   name: "Power Grid Corp", sector: "Power", newsDrivers: ["powergrid", "power grid", "transmission", "inter-regional", "grid", "power infrastructure", "renewable transmission"] },

  // ── IT ──
  { symbol: "TCS",        assetId: "tcs",         name: "Tata Consultancy Services", sector: "IT", newsDrivers: ["tcs", "tata consultancy", "it services", "it sector", "indian it", "software exporter", "outsourcing", "deal wins", "tcv", "order book", "attrition", "discretionary spend", "h-1b", "h1b", "visa", "accenture", "rupee", "usd/inr"] },
  { symbol: "INFY",       assetId: "infosys",     name: "Infosys Ltd", sector: "IT", newsDrivers: ["infosys", "infy", "it services", "indian it", "software exporter", "outsourcing", "deal wins", "digital transformation", "guidance", "attrition", "h-1b", "visa", "rupee", "usd/inr", "bfsi spending"] },
  { symbol: "WIPRO",      assetId: "wipro",       name: "Wipro Ltd", sector: "IT", newsDrivers: ["wipro", "it services", "indian it", "software exporter", "outsourcing", "deal wins", "attrition", "h-1b", "visa", "rupee", "usd/inr", "guidance"] },
  { symbol: "HCLTECH",    assetId: "hcltech",     name: "HCL Technologies", sector: "IT", newsDrivers: ["hcltech", "hcl technologies", "it services", "indian it", "software exporter", "outsourcing", "deal wins", "attrition", "h-1b", "visa", "rupee", "engineering services"] },
  { symbol: "TECHM",      assetId: "techm",       name: "Tech Mahindra", sector: "IT", newsDrivers: ["tech mahindra", "techm", "it services", "indian it", "software exporter", "outsourcing", "5g", "telecom it", "deal wins", "attrition", "h-1b", "visa", "rupee"] },

  // ── Banking / Financial ──
  { symbol: "HDFCBANK",   assetId: "hdfc-bank",   name: "HDFC Bank", sector: "Banking", newsDrivers: ["hdfc bank", "hdfcbank", "hdfc", "private banks", "banking sector", "bank nifty", "nifty bank", "net interest margin", "nim", "credit growth", "loan growth", "deposit growth", "casa", "asset quality", "npa", "gross npa", "slippages", "provisioning", "rbi", "repo rate", "monetary policy", "liquidity", "hdfc merger"] },
  { symbol: "ICICIBANK",  assetId: "icici-bank",  name: "ICICI Bank", sector: "Banking", newsDrivers: ["icici bank", "icicibank", "icici", "private banks", "banking sector", "bank nifty", "net interest margin", "nim", "credit growth", "loan growth", "deposit growth", "casa", "asset quality", "npa", "provisioning", "rbi", "repo rate"] },
  { symbol: "SBIN",       assetId: "sbin",        name: "State Bank of India", sector: "Banking", newsDrivers: ["state bank of india", "sbin", "sbi", "psu banks", "banking sector", "bank nifty", "net interest margin", "credit growth", "loan growth", "deposit growth", "asset quality", "npa", "provisioning", "rbi", "repo rate", "government stake"] },
  { symbol: "AXISBANK",   assetId: "axis-bank",   name: "Axis Bank", sector: "Banking", newsDrivers: ["axis bank", "axisbank", "private banks", "banking sector", "bank nifty", "net interest margin", "credit growth", "loan growth", "deposit growth", "casa", "asset quality", "npa", "provisioning", "rbi", "repo rate"] },
  { symbol: "KOTAKBANK",  assetId: "kotak-bank",  name: "Kotak Mahindra Bank", sector: "Banking", newsDrivers: ["kotak mahindra", "kotakbank", "kotak bank", "private banks", "banking sector", "bank nifty", "net interest margin", "credit growth", "deposit growth", "casa", "asset quality", "npa", "rbi", "repo rate"] },

  // ── Auto ──
  { symbol: "MARUTI",     assetId: "maruti",      name: "Maruti Suzuki India", sector: "Auto", newsDrivers: ["maruti", "maruti suzuki", "auto sector", "car sales", "passenger vehicle", "pv sales", "automobile", "vehicle dispatch", "semiconductor shortage", "rural demand", "fuel price"] },
  { symbol: "TATAMOTORS", assetId: "tata-motors", name: "Tata Motors", sector: "Auto", newsDrivers: ["tata motors", "tatamotors", "jlr", "jaguar land rover", "auto sector", "commercial vehicle", "cv sales", "passenger vehicle", "ev", "electric vehicle", "vehicle sales", "brexit"] },
  { symbol: "M&M",        assetId: "m-and-m",     name: "Mahindra & Mahindra", sector: "Auto", newsDrivers: ["mahindra", "m&m", "auto sector", "tractor sales", "farm equipment", "suv", "passenger vehicle", "ev", "electric vehicle", "rural demand"] },

  // ── FMCG ──
  { symbol: "HINDUNILVR", assetId: "hindunilvr",  name: "Hindustan Unilever", sector: "FMCG", newsDrivers: ["hindustan unilever", "hul", "hindunilvr", "fmcg", "consumer goods", "volume growth", "rural demand", "input cost", "palm oil", "crude palm oil", "premiumisation", "d2c"] },
  { symbol: "ITC",        assetId: "itc",         name: "ITC Ltd", sector: "FMCG", newsDrivers: ["itc", "itc limited", "fmcg", "cigarette", "tobacco", "gst on tobacco", "hotel business", "paperboard", "agri business", "volume growth", "rural demand"] },
  { symbol: "NESTLEIND",  assetId: "nestleind",   name: "Nestle India", sector: "FMCG", newsDrivers: ["nestle india", "nestleind", "nestle", "fmcg", "consumer goods", "volume growth", "input cost", "coffee", "milk prices", "premiumisation", "maggi", "kitkat"] },

  // ── Pharma ──
  { symbol: "SUNPHARMA",  assetId: "sunpharma",   name: "Sun Pharmaceutical", sector: "Pharma", newsDrivers: ["sun pharma", "sunpharma", "pharma sector", "usfda", "fda approval", "generic", "andaman", "specialty pharma", "ranbaxy", "us pharma", "drug recall"] },
  { symbol: "DRREDDY",    assetId: "drreddy",     name: "Dr Reddy's Labs", sector: "Pharma", newsDrivers: ["dr reddy", "drreddy", "dr reddy's", "pharma sector", "usfda", "fda approval", "generic", "andaman", "api", "us pharma", "drug recall", "russia"] },
  { symbol: "CIPLA",      assetId: "cipla",       name: "Cipla Ltd", sector: "Pharma", newsDrivers: ["cipla", "pharma sector", "usfda", "fda approval", "generic", "respiratory", "api", "us pharma", "drug recall", "south africa"] },

  // ── Metals ──
  { symbol: "TATASTEEL",  assetId: "tata-steel",  name: "Tata Steel", sector: "Metals", newsDrivers: ["tata steel", "tatasteel", "steel sector", "steel price", "hot rolled coil", "hrc", "iron ore", "coking coal", "china steel", "anti-dumping", "corus", "europe steel"] },
  { symbol: "HINDALCO",   assetId: "hindalco",    name: "Hindalco Industries", sector: "Metals", newsDrivers: ["hindalco", "novelis", "aluminium", "aluminum", "copper", "lme", "london metal exchange", "metal sector", "china demand", "auto demand"] },
  { symbol: "JSWSTEEL",   assetId: "jsw-steel",   name: "JSW Steel", sector: "Metals", newsDrivers: ["jsw steel", "jswsteel", "steel sector", "steel price", "hot rolled coil", "hrc", "iron ore", "coking coal", "china steel", "anti-dumping", "capacity addition"] },

  // ── Infra / Construction ──
  { symbol: "LT",         assetId: "lt",          name: "Larsen & Toubro", sector: "Infra", newsDrivers: ["larsen", "l&t", "lt", "infrastructure", "order book", "order inflow", "construction", "engineering", "ePC", "hydrocarbon", "power", "middle east order"] },
  { symbol: "ULTRACEMCO", assetId: "ultracemco",  name: "UltraTech Cement", sector: "Cement", newsDrivers: ["ultratech", "ultracemco", "cement sector", "cement demand", "real estate", "infrastructure spending", "capacity addition", "clinker", "fuel cost"] },

  // ── Telecom ──
  { symbol: "BHARTIARTL", assetId: "bharti-artl", name: "Bharti Airtel", sector: "Telecom", newsDrivers: ["bharti airtel", "bhartiartl", "airtel", "telecom sector", "arpu", "5g", "tariff hike", "subscriber addition", "fiber", "africa telecom", "vodafone idea", "jio"] },
];

// Quick lookup maps
export const AMF_STOCK_BY_SYMBOL = new Map(AMF_STOCKS.map((s) => [s.symbol, s]));
export const AMF_STOCK_BY_ASSET_ID = new Map(AMF_STOCKS.map((s) => [s.assetId, s]));
export const AMF_STOCK_SYMBOLS = AMF_STOCKS.map((s) => s.symbol);

// Sector grouping for UI display
export const AMF_SECTORS = [...new Set(AMF_STOCKS.map((s) => s.sector))];
export const AMF_STOCKS_BY_SECTOR = AMF_SECTORS.reduce((acc, sector) => {
  acc[sector] = AMF_STOCKS.filter((s) => s.sector === sector);
  return acc;
}, {} as Record<string, AmfStockDef[]>);

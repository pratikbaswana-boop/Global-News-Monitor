// Crypto asset universe — defines which cryptocurrencies the system tracks and trades.
//
// Mirrors the AMF stock universe pattern (amf-stock-universe.ts) but for crypto.
// Each asset has: symbol (exchange pair), assetId (internal ID), category, and
// newsDrivers (keywords for the news intelligence pipeline to match on).
//
// The newsDrivers are the KEY to reusing the existing news pipeline — they're
// the topics that actually move each coin, not just the coin's name. Crypto is
// heavily news-driven (ETF flows, regulations, hacks, upgrades, whale moves).

export interface CryptoAssetDef {
  symbol: string;       // Exchange trading pair, e.g. "BTCUSDT"
  assetId: string;      // Internal ID for DB + news matching, e.g. "btc"
  name: string;         // Display name, e.g. "Bitcoin"
  category: CryptoCategory;
  exchange: "binance" | "bybit";
  marketType: "spot" | "perp";
  newsDrivers: string[];
  isActive: boolean;
}

export type CryptoCategory =
  | "majors"      // BTC, ETH — driven by macro + institutional flows
  | "defi"        // UNI, AAVE — driven by TVL, protocol upgrades, DeFi regulation
  | "l1"          // SOL, AVAX, NEAR — driven by ecosystem growth, TVS, upgrades
  | "l2"          // ARB, OP, MATIC — driven by L2 ecosystem, bridge volume
  | "meme"        // DOGE, SHIB — driven by social sentiment, celebrity, listings
  | "ai"          // FET, RNDR, TAO — driven by AI narrative, compute demand
  | "stablecoin"; // USDT, USDC — for funding arb, not directional trading

export const CRYPTO_ASSETS: CryptoAssetDef[] = [
  {
    symbol: "BTCUSDT",
    assetId: "btc",
    name: "Bitcoin",
    category: "majors",
    exchange: "binance",
    marketType: "spot",
    isActive: true,
    newsDrivers: [
      "bitcoin", "btc", "btc price", "crypto market",
      "bitcoin etf", "spot bitcoin etf", "blackrock bitcoin", "ibit", "fbtc",
      "sec bitcoin", "gary gensler", "sec crypto",
      "halving", "block reward", "mining difficulty", "hash rate",
      "microstrategy", "michael saylor", "tesla bitcoin", "el salvador bitcoin",
      "bitcoin dominance", "btc dominance", "risk-on", "risk-off",
      "fed rate", "fomc", "dollar index", "dxy", "treasury yield",
      "binance", "coinbase", "kraken", "crypto exchange",
      "crypto regulation", "crypto bill", "stablecoin regulation",
      "futures funding", "funding rate", "open interest", "liquidation",
      "whale", "whale alert", "large transfer", "cold wallet",
    ],
  },
  {
    symbol: "ETHUSDT",
    assetId: "eth",
    name: "Ethereum",
    category: "majors",
    exchange: "binance",
    marketType: "spot",
    isActive: true,
    newsDrivers: [
      "ethereum", "eth", "ether", "eth price",
      "ethereum etf", "spot ethereum etf", "blackrock ethereum",
      "vitalik buterin", "vitalik",
      "ethereum upgrade", "ethereum fork", "pectra", "dencun", "shapella",
      "ethereum staking", "staked eth", "eth staking", "withdrawal queue",
      "ethereum gas", "gas fees", "blob fees", "eip-4844",
      "l2 tvl", "layer 2", "rollup", "base", "arbitrum", "optimism",
      "defi tvl", "total value locked", "defi protocol",
      "ethereum supply", "burned eth", "deflationary eth", "ultrasound money",
      "sec ethereum", "ethereum regulation",
    ],
  },
  {
    symbol: "SOLUSDT",
    assetId: "sol",
    name: "Solana",
    category: "l1",
    exchange: "binance",
    marketType: "spot",
    isActive: true,
    newsDrivers: [
      "solana", "sol", "sol price",
      "solana outage", "solana congestion", "solana fork",
      "solana tvl", "solana ecosystem", "solana defi",
      "solana memecoin", "pump.fun", "bonk", "jito",
      "solana phone", "saga",
      "solana stake", "jito stake",
      "solana etf", "solana futures",
      "anatoly yakovenko", "raj gokal",
    ],
  },
  {
    symbol: "BNBUSDT",
    assetId: "bnb",
    name: "BNB",
    category: "majors",
    exchange: "binance",
    marketType: "spot",
    isActive: true,
    newsDrivers: [
      "bnb", "binance coin", "bnb price",
      "binance", "cz", "changpeng zhao", "binance settlement",
      "binance listing", "launchpool", "megadrop",
      "bnb chain", "bsc", "bnb smart chain",
      "binance regulation", "doj binance", "sec binance",
      "bnb burn", "quarterly burn",
    ],
  },
  {
    symbol: "XRPUSDT",
    assetId: "xrp",
    name: "XRP",
    category: "majors",
    exchange: "binance",
    marketType: "spot",
    isActive: true,
    newsDrivers: [
      "xrp", "ripple", "xrp price",
      "sec ripple", "ripple lawsuit", "ripple settlement",
      "xrp etf", "ripple etf",
      "ripple payments", "ripple remittance", "odl",
      "brad garlinghouse",
      "xrp ledger", "xrpl",
    ],
  },
  {
    symbol: "AVAXUSDT",
    assetId: "avax",
    name: "Avalanche",
    category: "l1",
    exchange: "binance",
    marketType: "spot",
    isActive: false,
    newsDrivers: [
      "avalanche", "avax", "avax price",
      "avalanche subnet", "subnet", "avalanche9000",
      "avalanche tvl", "avalanche defi",
      "avax staking",
      "emin gun sirer",
    ],
  },
  {
    symbol: "DOGEUSDT",
    assetId: "doge",
    name: "Dogecoin",
    category: "meme",
    exchange: "binance",
    marketType: "spot",
    isActive: false,
    newsDrivers: [
      "dogecoin", "doge", "doge price",
      "elon musk doge", "elon musk crypto", "x doge",
      "doge etf",
      "doge listing", "doge payment",
      "meme coin", "memecoin",
    ],
  },
  {
    symbol: "ARBUSDT",
    assetId: "arb",
    name: "Arbitrum",
    category: "l2",
    exchange: "binance",
    marketType: "spot",
    isActive: false,
    newsDrivers: [
      "arbitrum", "arb", "arb price",
      "arbitrum odyssey", "arbitrum airdrop",
      "arbitrum tvl", "arbitrum defi",
      "offchain labs",
      "arbitrum nitro", "arbitrum orbit",
    ],
  },
  {
    symbol: "OPUSDT",
    assetId: "op",
    name: "Optimism",
    category: "l2",
    exchange: "binance",
    marketType: "spot",
    isActive: false,
    newsDrivers: [
      "optimism", "op token", "op price",
      "optimism tvl", "optimism defi",
      "optimism retroactive", "retropgf",
      "optimism superchain", "op stack",
    ],
  },
];

// Active assets for trading (isActive=true)
export const ACTIVE_CRYPTO_ASSETS = CRYPTO_ASSETS.filter((a) => a.isActive);

// All symbols for subscription (active only)
export const ACTIVE_CRYPTO_SYMBOLS = ACTIVE_CRYPTO_ASSETS.map((a) => a.symbol);

// All asset IDs for news matching
export const CRYPTO_ASSET_IDS = CRYPTO_ASSETS.map((a) => a.assetId);

// Lookup by symbol
export const CRYPTO_BY_SYMBOL = new Map(CRYPTO_ASSETS.map((a) => [a.symbol, a]));

// Lookup by assetId
export const CRYPTO_BY_ASSET_ID = new Map(CRYPTO_ASSETS.map((a) => [a.assetId, a]));

// Perp symbols (append to spot for Binance perp futures)
export function toPerpSymbol(spotSymbol: string): string {
  return spotSymbol; // Binance perp uses same symbol on futures WS
}

// Broad crypto market drivers — affect all coins
export const BROAD_CRYPTO_DRIVERS = [
  "crypto market", "crypto crash", "crypto rally", "crypto selloff",
  "bitcoin dominance", "altcoin season", "altseason",
  "fear and greed", "crypto fear",
  "stablecoin", "usdt", "usdc", "tether",
  "binance", "coinbase", "kraken", "okx", "bybit",
  "sec crypto", "cftc crypto", "crypto regulation", "crypto bill",
  "fed rate", "fomc", "rate cut", "rate hike", "dollar index", "dxy",
  "risk-on", "risk-off", "risk assets",
  "liquidation", "long squeeze", "short squeeze", "funding rate",
  "open interest", "crypto etf", "bitcoin etf", "ethereum etf",
  "war", "geopolitical", "safe haven",
];

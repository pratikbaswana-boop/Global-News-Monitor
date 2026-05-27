// Tier 1 Candle Trust Filter — detects volume anomalies and intraday noise.
// Called from market-agent.ts after OHLCV fetch, before context assembly.

export interface OHLCV {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CandleTrustResult {
  trustScore: number;   // 0.0 to 1.0. 1.0 = clean. 0.2 = flagged.
  flags: CandleFlag[];  // List of flags that fired.
  tier1Score: number;   // Directional score from price: +1 up, -1 down, 0 flat.
}

export type CandleFlag =
  | "volume_anomaly"          // Volume > 3x 20-day average
  | "wash_trade_suspected"    // Large buy and sell at same price within same candle
  | "low_delivery_high_move"; // Price moved > 0.5% but delivery % < 20% (intraday noise)

export function checkCandleTrust(
  currentCandle: OHLCV,
  rollingAvgVolume20d: number,
  deliveryPct: number | null
): CandleTrustResult {
  const flags: CandleFlag[] = [];

  // Rule 1: Volume anomaly
  if (currentCandle.volume > rollingAvgVolume20d * 3) {
    flags.push("volume_anomaly");
  }

  // Rule 2: Low delivery on big move (intraday noise indicator)
  const priceMovePct = Math.abs(
    ((currentCandle.close - currentCandle.open) / currentCandle.open) * 100
  );
  if (priceMovePct > 0.5 && deliveryPct !== null && deliveryPct < 20) {
    flags.push("low_delivery_high_move");
  }

  // Trust score: each flag reduces trust
  let trustScore = 1.0;
  if (flags.includes("volume_anomaly")) trustScore -= 0.5;
  if (flags.includes("low_delivery_high_move")) trustScore -= 0.3;
  if (flags.includes("wash_trade_suspected")) trustScore -= 0.4;
  trustScore = Math.max(0.1, trustScore); // Never zero

  // Tier1 directional score from candle
  const tier1Score = priceMovePct < 0.05 ? 0
    : currentCandle.close > currentCandle.open ? 1
    : -1;

  return { trustScore, flags, tier1Score };
}

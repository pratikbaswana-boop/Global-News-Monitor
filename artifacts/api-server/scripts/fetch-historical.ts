// Fetch 60 days of 1-minute NIFTY data from Kite API for backtesting.
//
// Usage:
//   npx tsx scripts/fetch-historical.ts --token=<kite_access_token> [--days=60]
//
// Output: scripts/data/nifty-historical-<date>.json

import { KiteConnect } from "kiteconnect";
import * as fs from "fs";
import * as path from "path";

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const tokenArg = args.find((a) => a.startsWith("--token="));
const daysArg = args.find((a) => a.startsWith("--days="));

const ACCESS_TOKEN = tokenArg?.split("=")[1] ?? process.env["KITE_ACCESS_TOKEN"] ?? "";
const DAYS = parseInt(daysArg?.split("=")[1] ?? "60", 10);

if (!ACCESS_TOKEN) {
  console.error("Usage: npx tsx scripts/fetch-historical.ts --token=<kite_access_token> [--days=60]");
  console.error("Get your access token from https://kite.trade (after OAuth login)");
  process.exit(1);
}

const API_KEY = process.env["KITE_API_KEY"] ?? "m84meupl50i415w5";

// ── Constants ─────────────────────────────────────────────────────────────────

const NIFTY_INDEX_TOKEN = 256265; // NIFTY 50 index instrument token
const STRIKE_INTERVAL = 50;
const STRIKE_RANGE = 5; // ±5 strikes around ATM
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

interface Candle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  oi?: number;
}

interface DayData {
  date: string;
  niftyCandles: Candle[];
  optionData: Array<{
    strike: number;
    type: "CE" | "PE";
    tradingsymbol: string;
    candles: Candle[];
  }>;
  atmStrike: number;
}

interface NfoInstrument {
  instrument_token: number;
  tradingsymbol: string;
  strike: number;
  instrument_type: "CE" | "PE";
  expiry: string;
  name: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function formatISTDate(d: Date): string {
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  return ist.toISOString().slice(0, 10);
}

function getNearestThursday(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const daysUntilThu = (4 - day + 7) % 7;
  d.setDate(d.getDate() + daysUntilThu);
  return d;
}

function formatExpiryDate(expiry: Date): string {
  const y = expiry.getFullYear();
  const m = String(expiry.getMonth() + 1).padStart(2, "0");
  const d = String(expiry.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const kite = new KiteConnect({ api_key: API_KEY });
  kite.setAccessToken(ACCESS_TOKEN);

  console.log(`Fetching ${DAYS} days of NIFTY 1-min data from Kite...`);

  // 1. Fetch NFO instruments (for option tokens)
  console.log("Fetching NFO instruments list...");
  const allInstruments = await kite.getInstruments("NFO") as Array<Record<string, unknown>>;
  const niftyOptions: NfoInstrument[] = allInstruments
    .filter((i) => i["name"] === "NIFTY" && (i["instrument_type"] === "CE" || i["instrument_type"] === "PE"))
    .map((i) => ({
      instrument_token: Number(i["instrument_token"]),
      tradingsymbol: String(i["tradingsymbol"]),
      strike: Number(i["strike"]),
      instrument_type: i["instrument_type"] as "CE" | "PE",
      expiry: String(i["expiry"]),
      name: String(i["name"]),
    }));
  console.log(`  Found ${niftyOptions.length} NIFTY option instruments`);

  // 2. Fetch NIFTY 50 index 1-min candles (in 5-day chunks to respect 2000 candle limit)
  const now = new Date();
  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - DAYS);

  const allNiftyCandles: Candle[] = [];
  const chunkDays = 5;
  let chunkStart = new Date(startDate);

  console.log(`Fetching NIFTY 50 index data from ${formatISTDate(startDate)} to ${formatISTDate(now)}...`);

  while (chunkStart < now) {
    const chunkEnd = new Date(chunkStart);
    chunkEnd.setDate(chunkEnd.getDate() + chunkDays);
    if (chunkEnd > now) chunkEnd.setTime(now.getTime());

    const from = chunkStart.toISOString().slice(0, 10);
    const to = chunkEnd.toISOString().slice(0, 10);

    try {
      const data = await kite.getHistoricalData(NIFTY_INDEX_TOKEN, "minute", from, to, false, false) as Candle[];
      allNiftyCandles.push(...data);
      console.log(`  ${from} → ${to}: ${data.length} candles`);
    } catch (err) {
      console.error(`  ${from} → ${to}: ERROR ${(err as Error).message}`);
    }

    chunkStart = new Date(chunkEnd);
    await sleep(350); // respect rate limit (~3 req/s)
  }

  console.log(`Total NIFTY candles: ${allNiftyCandles.length}`);

  // 3. Group candles by trading day
  const dayMap = new Map<string, Candle[]>();
  for (const c of allNiftyCandles) {
    const dayKey = formatISTDate(new Date(c.date));
    if (!dayMap.has(dayKey)) dayMap.set(dayKey, []);
    dayMap.get(dayKey)!.push(c);
  }

  const tradingDays = Array.from(dayMap.keys()).sort();
  console.log(`Trading days: ${tradingDays.length}`);

  // 4. For each trading day, fetch ATM ± STRIKE_RANGE option data
  const allDays: DayData[] = [];

  for (const day of tradingDays) {
    const niftyCandles = dayMap.get(day)!;
    if (niftyCandles.length === 0) continue;

    // Determine ATM strike from day's average close
    const avgPrice = niftyCandles.reduce((s, c) => s + c.close, 0) / niftyCandles.length;
    const atmStrike = Math.round(avgPrice / STRIKE_INTERVAL) * STRIKE_INTERVAL;

    // Find expiry for this day
    const dayDate = new Date(day + "T09:15:00+05:30");
    const expiryDate = getNearestThursday(dayDate);
    const expiryStr = formatExpiryDate(expiryDate);

    // Find option instruments for ATM ± STRIKE_RANGE
    const minStrike = atmStrike - STRIKE_RANGE * STRIKE_INTERVAL;
    const maxStrike = atmStrike + STRIKE_RANGE * STRIKE_INTERVAL;

    const dayOptions = niftyOptions.filter(
      (o) => o.expiry === expiryStr && o.strike >= minStrike && o.strike <= maxStrike
    );

    console.log(`\nDay ${day}: ATM=${atmStrike}, expiry=${expiryStr}, ${dayOptions.length} options`);

    const optionData: DayData["optionData"] = [];

    for (const opt of dayOptions) {
      try {
        const data = await kite.getHistoricalData(
          opt.instrument_token, "minute", day, day, false, true
        ) as Candle[];
        optionData.push({
          strike: opt.strike,
          type: opt.instrument_type,
          tradingsymbol: opt.tradingsymbol,
          candles: data,
        });
        process.stdout.write(".");
      } catch (err) {
        process.stdout.write("x");
      }
      await sleep(350); // rate limit
    }

    console.log(`\n  Fetched ${optionData.length} option instruments for ${day}`);

    allDays.push({
      date: day,
      niftyCandles,
      optionData,
      atmStrike,
    });
  }

  // 5. Save to JSON
  const dataDir = path.join(__dirname, "data");
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const outputFile = path.join(dataDir, `nifty-historical-${formatISTDate(now)}.json`);
  const output = {
    fetchedAt: new Date().toISOString(),
    days: allDays.length,
    data: allDays,
  };

  fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
  console.log(`\nSaved ${allDays.length} days to ${outputFile}`);
  console.log(`File size: ${(fs.statSync(outputFile).size / 1024 / 1024).toFixed(1)} MB`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

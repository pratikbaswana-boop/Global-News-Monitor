import fs from "fs";

const SYMBOL = "^NSEI"; // Nifty 50 index
const INTERVAL = "1m";  // 1 minute
const RANGE = "1d";     // today

async function fetchNifty() {
  // Yahoo Finance chart API
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${SYMBOL}?interval=${INTERVAL}&range=${RANGE}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

  const data = await res.json();
  const result = data.chart?.result?.[0];
  if (!result) {
    console.error("No data returned:", JSON.stringify(data.chart?.error, null, 2));
    process.exit(1);
  }

  const timestamps: number[] = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const { open = [], high = [], low = [], close = [], volume = [] } = quote;

  const rows = timestamps.map((ts: number, i: number) => ({
    datetime: new Date(ts * 1000).toISOString(),
    open: open[i] ?? null,
    high: high[i] ?? null,
    low: low[i] ?? null,
    close: close[i] ?? null,
    volume: volume[i] ?? null,
  }));

  const outPath = `/Users/pratikbaswana/Downloads/Global-News-Monitorzip/nifty-1min-${new Date().toISOString().split("T")[0]}.json`;
  fs.writeFileSync(outPath, JSON.stringify(rows, null, 2));
  console.log(`Saved ${rows.length} 1-minute candles to ${outPath}`);
}

fetchNifty().catch((e) => {
  console.error(e);
  process.exit(1);
});

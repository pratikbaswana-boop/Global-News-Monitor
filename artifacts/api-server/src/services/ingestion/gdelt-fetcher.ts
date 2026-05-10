import { logger } from "../../lib/logger.js";

export interface GdeltEvent {
  cameoCode: string;
  actionLabel: string;
  actor1Name: string;
  actor1CountryCode: string;
  actor2Name: string;
  actor2CountryCode: string;
  locationCountryCode: string;
  locationName: string;
  eventDate: string; // YYYYMMDD
  sourceUrl: string;
  confidence: number;
  goldsteinScale: number; // -10 to +10, conflict intensity
}

const GDELT_LASTUPDATE_URL = "https://data.gdeltproject.org/gdeltv2/lastupdate.txt";

// CAMEO numeric → label mapping (partial, covering key categories)
const CAMEO_LABELS: Record<string, string> = {
  "01": "make public statement",
  "02": "appeal",
  "03": "express intent to cooperate",
  "04": "consult",
  "05": "engage in diplomatic cooperation",
  "06": "engage in material cooperation",
  "07": "provide aid",
  "08": "yield",
  "09": "investigate",
  "10": "demand",
  "11": "disapprove",
  "12": "reject",
  "13": "threaten",
  "14": "protest",
  "15": "exhibit military posture",
  "16": "reduce relations",
  "17": "coerce",
  "18": "assault",
  "19": "fight",
  "20": "use unconventional mass violence",
};

function cameoLabel(code: string): string {
  const prefix = code.slice(0, 2);
  return CAMEO_LABELS[prefix] ?? `CAMEO-${code}`;
}

function parseGdeltDate(yyyymmdd: string): string {
  if (yyyymmdd.length !== 8) return "UNKNOWN";
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

export async function fetchGdeltBatch(lastProcessedUrl?: string): Promise<{
  events: GdeltEvent[];
  batchUrl: string;
}> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);

  try {
    const res = await fetch(GDELT_LASTUPDATE_URL, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!res.ok) throw new Error(`GDELT lastupdate fetch HTTP ${res.status}`);

    const text = await res.text();
    // Format: "size hash url\nsize hash url\n..." — first line is the CSV export
    const lines = text.trim().split("\n");
    const csvLine = lines.find((l) => l.endsWith(".export.CSV.zip") || l.includes("export.CSV"));
    if (!csvLine) throw new Error("No export CSV found in GDELT lastupdate");

    const batchUrl = csvLine.trim().split(/\s+/)[2];
    if (!batchUrl) throw new Error("Could not parse GDELT batch URL");

    // Skip if we already processed this batch
    if (lastProcessedUrl === batchUrl) {
      return { events: [], batchUrl };
    }

    // Download CSV (may be gzipped)
    const controller2 = new AbortController();
    const timeoutId2 = setTimeout(() => controller2.abort(), 60_000);
    const csvRes = await fetch(batchUrl, { signal: controller2.signal });
    clearTimeout(timeoutId2);
    if (!csvRes.ok) throw new Error(`GDELT CSV fetch HTTP ${csvRes.status}`);

    const csvBuffer = await csvRes.arrayBuffer();
    let csvText: string;

    // GDELT files are either .zip or plain .csv
    if (batchUrl.endsWith(".zip")) {
      // We need to decompress — use DecompressionStream if available (Node 18+)
      try {
        const ds = new DecompressionStream("deflate-raw");
        const decompressed = csvBuffer; // fallback: assume inner CSV is accessible
        // Node 18+ supports DecompressionStream; in practice Replit runs Node 20
        const stream = new Response(decompressed).body!.pipeThrough(ds);
        csvText = await new Response(stream).text();
      } catch {
        // Fallback: try reading as plain text (may be pre-extracted)
        csvText = new TextDecoder().decode(csvBuffer);
      }
    } else {
      csvText = new TextDecoder().decode(csvBuffer);
    }

    const events: GdeltEvent[] = [];
    const rows = csvText.split("\n");

    for (const row of rows.slice(0, 500)) {
      // GDELT 2.0 export has 61 tab-separated columns
      const cols = row.split("\t");
      if (cols.length < 60) continue;

      const eventDate = cols[1] ?? "";
      const actor1CountryCode = cols[7] ?? "";
      const actor2CountryCode = cols[17] ?? "";
      const cameoCode = cols[26] ?? "";
      const goldsteinScale = parseFloat(cols[30] ?? "0") || 0;
      const sourceUrl = cols[57] ?? "";
      const actor1Name = cols[6] ?? cols[7] ?? "Unknown";
      const actor2Name = cols[16] ?? cols[17] ?? "Unknown";
      const locationName = cols[40] ?? "";
      const locationCountryCode = cols[37] ?? "";
      const confidence = Math.min(1.0, Math.max(0.1, (parseFloat(cols[33] ?? "50") || 50) / 100));

      if (!sourceUrl || !cameoCode || !eventDate) continue;

      events.push({
        cameoCode,
        actionLabel: cameoLabel(cameoCode),
        actor1Name,
        actor1CountryCode,
        actor2Name,
        actor2CountryCode,
        locationCountryCode,
        locationName,
        eventDate: parseGdeltDate(eventDate),
        sourceUrl,
        confidence,
        goldsteinScale,
      });
    }

    logger.info({ count: events.length, batchUrl }, "gdelt batch fetched");
    return { events, batchUrl };
  } catch (err) {
    clearTimeout(timeoutId);
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, "gdelt-fetch failed");
    throw err;
  }
}

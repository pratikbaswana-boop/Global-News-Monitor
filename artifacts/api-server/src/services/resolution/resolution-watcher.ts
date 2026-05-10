// Resolution watcher — runs every 6h.
// Checks for expired pending predictions and resolves them via multiple signal watchers:
//   1. OFAC XML diff — sanctions additions/removals
//   2. ACLED API — per-country conflict events
//   3. UN News RSS — UN statements matching story actors
//   4. NSE price threshold — NIFTY crossing ±2% triggers resolution
//   5. 60-day auto-mark — unresolved → outcome_unverifiable
//   6. GPT-4o fallback — for stories without a specific watcher match
//
// UNCERTAIN retrospective scoring: if uncertaintyFlag=true and |actual_pct_change| > 1% → CORRECT

import { openai } from "@workspace/integrations-openai-ai-server";
import { db, predictionV2Table, marketSnapshotsTable } from "@workspace/db";
import { eq, lt, and, isNull, lte } from "drizzle-orm";
import { logger } from "../../lib/logger.js";
import { runCypher, isGraphAvailable } from "../graph/neo4j-client.js";
import { computeBrierScore } from "./brier-score.js";
import { runForensicsAgent } from "./forensics.js";
import type { Scenario } from "../reasoning/agent-forecaster.js";
import type { DevilCritique } from "../reasoning/agent-devil.js";

const AUTO_MARK_DAYS = 60;

// ── OFAC XML watcher ──────────────────────────────────────────────────────────

const _ofacCache: { entries: Set<string>; fetchedAt: number } = { entries: new Set(), fetchedAt: 0 };

async function fetchOfacSdnEntities(): Promise<Set<string>> {
  if (Date.now() - _ofacCache.fetchedAt < 6 * 60 * 60 * 1000 && _ofacCache.entries.size > 0) {
    return _ofacCache.entries;
  }
  try {
    const res = await fetch("https://www.treasury.gov/ofac/downloads/sdn.xml", {
      headers: { "User-Agent": "HARNESS-Intelligence/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`OFAC HTTP ${res.status}`);
    const xml = await res.text();
    const names = new Set<string>();
    const matches = xml.matchAll(/<lastName>([^<]+)<\/lastName>/g);
    for (const m of matches) names.add(m[1]!.toLowerCase());
    _ofacCache.entries = names;
    _ofacCache.fetchedAt = Date.now();
    logger.debug({ count: names.size }, "OFAC SDN list refreshed");
    return names;
  } catch (err) {
    logger.warn({ err }, "OFAC fetch failed");
    return _ofacCache.entries;
  }
}

async function checkOfacSignal(storyId: string, actorNames: string[]): Promise<string | null> {
  if (actorNames.length === 0) return null;
  const sdn = await fetchOfacSdnEntities();
  const hits = actorNames.filter(n => sdn.has(n.toLowerCase()));
  return hits.length > 0 ? `OFAC sanctions detected for: ${hits.join(", ")}` : null;
}

// ── ACLED watcher (per-country conflict events) ───────────────────────────────

async function checkAcledSignal(countryIso: string, _sinceDate: Date): Promise<string | null> {
  // ACLED requires API key — check env; fall back gracefully
  const apiKey = process.env["ACLED_API_KEY"];
  const email = process.env["ACLED_EMAIL"];
  if (!apiKey || !email) return null;

  try {
    const url = new URL("https://api.acleddata.com/acled/read");
    url.searchParams.set("key", apiKey);
    url.searchParams.set("email", email);
    url.searchParams.set("iso", countryIso);
    url.searchParams.set("event_date", _sinceDate.toISOString().slice(0, 10));
    url.searchParams.set("event_date_where", ">");
    url.searchParams.set("limit", "5");
    url.searchParams.set("fields", "event_type|event_date|fatalities|notes");

    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const data = await res.json() as { data: Array<{ event_type: string; fatalities: number; notes: string }> };
    if (!data.data?.length) return null;

    const summary = data.data.map(e => `${e.event_type} (${e.fatalities} fatalities)`).join("; ");
    return `ACLED conflict events: ${summary}`;
  } catch {
    return null;
  }
}

// ── UN News RSS watcher ───────────────────────────────────────────────────────

async function checkUnNewsSignal(actorNames: string[]): Promise<string | null> {
  if (actorNames.length === 0) return null;
  try {
    const res = await fetch("https://news.un.org/feed/subscribe/en/news/all/rss.xml", {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const xml = await res.text();
    const titles: string[] = [];
    const matches = xml.matchAll(/<title><!\[CDATA\[([^\]]+)\]\]><\/title>/g);
    for (const m of matches) titles.push(m[1]!);

    const relevant = titles.filter(t =>
      actorNames.some(a => t.toLowerCase().includes(a.toLowerCase()))
    );
    return relevant.length > 0 ? `UN News: ${relevant.slice(0, 2).join("; ")}` : null;
  } catch {
    return null;
  }
}

// ── NSE price threshold watcher ───────────────────────────────────────────────

async function checkPriceThresholdSignal(storyId: string): Promise<{ signal: string | null; pctChange: number }> {
  try {
    const url = "https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=1d&range=2d";
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return { signal: null, pctChange: 0 };
    interface YahooClose {
      chart: { result: Array<{ indicators: { quote: Array<{ close: number[] }> } }> };
    }
    const raw = await res.json() as YahooClose;
    const closes = raw.chart.result[0]?.indicators.quote[0]?.close ?? [];
    if (closes.length < 2) return { signal: null, pctChange: 0 };

    const prev = closes[closes.length - 2]!;
    const curr = closes[closes.length - 1]!;
    const pctChange = ((curr - prev) / prev) * 100;

    if (Math.abs(pctChange) >= 2.0) {
      return {
        signal: `NIFTY moved ${pctChange > 0 ? "+" : ""}${pctChange.toFixed(2)}% — price threshold breach`,
        pctChange,
      };
    }
    return { signal: null, pctChange };
  } catch {
    return { signal: null, pctChange: 0 };
  }
}

// ── GPT-4o fallback outcome determination ─────────────────────────────────────

const OUTCOME_SYSTEM = `You are a geopolitical outcome assessor. Given forecast scenarios and recent events, determine which scenario (if any) materialised. Return only valid JSON.

Schema: { "materialisedIndex": number | null, "outcomeDescription": string, "confidence": "high" | "medium" | "low" }

Rules:
- materialisedIndex: 0/1/2 for matching scenario, null if ambiguous
- If situation still developing and forecast window was too short: confidence="low", materialisedIndex=null
- Match based on falsification conditions: if met → that scenario did NOT materialise`;

async function fetchRecentStoryEvents(storyId: string): Promise<string> {
  try {
    const result = await runCypher(
      `MATCH (s:Story {id: $storyId})-[:CONTAINS]->(e:Event)
       WHERE e.eventDate > datetime() - duration({days: 30})
       RETURN e.cameoLabel AS label, e.actors AS actors, toString(e.eventDate) AS date
       ORDER BY e.eventDate DESC LIMIT 20`,
      { storyId }
    );
    if (!result.records.length) return "No recent events found in knowledge graph.";
    return result.records
      .map(r => `${r.get("date")}: ${r.get("label")} — actors: ${JSON.stringify(r.get("actors"))}`)
      .join("\n");
  } catch {
    return "Knowledge graph unavailable.";
  }
}

interface OutcomeDetermination {
  materialisedIndex: number | null;
  outcomeDescription: string;
  confidence: "high" | "medium" | "low";
}

async function determineOutcomeGpt(
  storyId: string,
  scenarios: Scenario[],
  recentEvents: string,
  watcherSignals: string[]
): Promise<OutcomeDetermination> {
  const scenarioText = scenarios.map((s, i) =>
    `[${i}] "${s.label}" (${(s.probability * 100).toFixed(0)}%)\nFalsification: ${s.falsificationConditions.join("; ")}`
  ).join("\n\n");

  const signalSection = watcherSignals.length > 0
    ? `\nEXTERNAL SIGNALS (OFAC/ACLED/UN/Price):\n${watcherSignals.join("\n")}`
    : "";

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.1,
    max_tokens: 600,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: OUTCOME_SYSTEM },
      { role: "user", content: `Story: ${storyId}\n\nSCENARIOS:\n${scenarioText}\n\nRECENT EVENTS:\n${recentEvents}${signalSection}` },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? "{}";
  return JSON.parse(raw) as OutcomeDetermination;
}

// ── UNCERTAIN retrospective scoring ──────────────────────────────────────────

async function scoreUncertainSnapshots(now: Date): Promise<void> {
  try {
    const snapshots = await db
      .select()
      .from(marketSnapshotsTable)
      .where(
        and(
          eq(marketSnapshotsTable.uncertaintyFlag, true),
          isNull(marketSnapshotsTable.isCorrect),
          lte(marketSnapshotsTable.resolveAfter, now)
        )
      );

    for (const snap of snapshots) {
      const pctChange = snap.priceChangePct ? parseFloat(String(snap.priceChangePct)) : null;
      if (pctChange === null) continue;

      // UNCERTAIN + significant move = scored CORRECT (uncertainty acknowledged a volatile regime)
      const isCorrect = Math.abs(pctChange) > 1.0;

      await db.update(marketSnapshotsTable)
        .set({
          isCorrect,
          resolutionNotes: `UNCERTAIN retrospective: |pct_change|=${Math.abs(pctChange).toFixed(2)}% — ${isCorrect ? "CORRECT" : "INCORRECT"}`,
          resolvedAt: now,
        })
        .where(eq(marketSnapshotsTable.id, snap.id));
    }

    if (snapshots.length > 0) {
      logger.info({ count: snapshots.length }, "resolution-watcher: UNCERTAIN retrospective scoring complete");
    }
  } catch (err) {
    logger.warn({ err }, "resolution-watcher: UNCERTAIN retrospective scoring failed");
  }
}

// ── Main resolution cycle ─────────────────────────────────────────────────────

export async function runResolutionCycle(): Promise<void> {
  const graphOk = await isGraphAvailable().catch(() => false);
  const now = new Date();

  // 1. Score UNCERTAIN market snapshots first
  await scoreUncertainSnapshots(now);

  // 2. Auto-mark predictions older than 60 days with no resolution
  try {
    const cutoff = new Date(now.getTime() - AUTO_MARK_DAYS * 24 * 60 * 60 * 1000);
    await db.update(predictionV2Table)
      .set({
        resolutionStatus: "outcome_unverifiable",
        resolvedAt: now,
        lessonsLearned: JSON.stringify("• Prediction expired after 60 days without verifiable outcome."),
      })
      .where(
        and(
          eq(predictionV2Table.resolutionStatus, "pending"),
          lt(predictionV2Table.resolveAfter, cutoff),
          isNull(predictionV2Table.resolvedAt)
        )
      );
  } catch (err) {
    logger.warn({ err }, "resolution-watcher: 60-day auto-mark failed");
  }

  // 3. Resolve expired (but not yet 60d old) predictions
  let expired: typeof predictionV2Table.$inferSelect[];
  try {
    expired = await db
      .select()
      .from(predictionV2Table)
      .where(
        and(
          eq(predictionV2Table.resolutionStatus, "pending"),
          lt(predictionV2Table.resolveAfter, now),
          isNull(predictionV2Table.resolvedAt)
        )
      );
  } catch (err) {
    logger.error({ err }, "resolution-watcher: DB query failed");
    return;
  }

  if (!expired.length) {
    logger.info("resolution-watcher: no expired predictions");
    return;
  }

  logger.info({ count: expired.length }, "resolution-watcher: resolving expired predictions");

  for (const row of expired) {
    try {
      let scenarios: Scenario[] = [];
      let devilCritique: DevilCritique | null = null;

      try {
        scenarios = JSON.parse(row.finalScenarios) as Scenario[];
        devilCritique = JSON.parse(row.devilCritique) as DevilCritique;
      } catch {
        await db.update(predictionV2Table)
          .set({ resolutionStatus: "auto_resolved", resolvedAt: now, lessonsLearned: JSON.stringify({ error: "JSON parse failed" }) })
          .where(eq(predictionV2Table.id, row.id));
        continue;
      }

      // Collect actor names from analyst report for OFAC/UN watchers
      let actorNames: string[] = [];
      let countryIso = "";
      try {
        const analyst = JSON.parse(row.analystReport) as { primaryActors?: Array<{ actorLabel: string }> };
        actorNames = analyst.primaryActors?.map(a => a.actorLabel) ?? [];
        const historianRaw = JSON.parse(row.historianPrecedents) as { analogues?: Array<{ metadata?: { iso_code?: string } }> };
        countryIso = historianRaw.analogues?.[0]?.metadata?.iso_code ?? "";
      } catch { /* proceed without */ }

      // Run all external watchers in parallel
      const [ofacSignal, acledSignal, unSignal, priceResult] = await Promise.all([
        checkOfacSignal(row.storyId, actorNames),
        checkAcledSignal(countryIso, row.resolveAfter),
        checkUnNewsSignal(actorNames),
        checkPriceThresholdSignal(row.storyId),
      ]);

      const watcherSignals = [ofacSignal, acledSignal, unSignal, priceResult.signal].filter(Boolean) as string[];

      // Fetch Neo4j events
      const recentEvents = graphOk ? await fetchRecentStoryEvents(row.storyId) : "Knowledge graph not connected.";

      // GPT-4o outcome determination (enriched with watcher signals)
      const outcome = await determineOutcomeGpt(row.storyId, scenarios, recentEvents, watcherSignals);

      // Brier score
      const scored = scenarios.map((s, i) => ({
        label: s.label,
        probability: s.probability,
        materialised: i === outcome.materialisedIndex,
      }));
      const brierScore = computeBrierScore(scored);

      // Forensics post-mortem
      let forensics = null;
      if (devilCritique && outcome.confidence !== "low") {
        forensics = await runForensicsAgent(
          row.storyId,
          scenarios,
          devilCritique,
          outcome.materialisedIndex,
          outcome.outcomeDescription
        );
      }

      // Write back to DB
      await db.update(predictionV2Table)
        .set({
          resolutionStatus: "auto_resolved",
          resolvedAt: now,
          brierScore,
          resolvedScenarioIndex: outcome.materialisedIndex,
          outcomeDescription: outcome.outcomeDescription,
          lessonsLearned: forensics ? JSON.stringify(forensics.lessonsLearned) : null,
          devilWasRight: forensics ? String(forensics.devilWasRight) : null,
          missedChannel: forensics?.missedChannel ?? null,
          dominantChannel: forensics?.dominantChannel ?? row.dominantChannel,
        })
        .where(eq(predictionV2Table.id, row.id));

      logger.info({
        predictionId: row.id,
        storyId: row.storyId,
        materialisedIndex: outcome.materialisedIndex,
        brierScore,
        watcherSignals: watcherSignals.length,
        devilWasRight: forensics?.devilWasRight,
      }, "resolution-watcher: prediction resolved");

    } catch (err) {
      logger.warn({ predictionId: row.id, err }, "resolution-watcher: resolution failed");
    }
  }

  logger.info({ count: expired.length }, "resolution-watcher: cycle complete");
}

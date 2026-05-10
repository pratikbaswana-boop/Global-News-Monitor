import { db, extractedEventsTable, contradictionQueueTable } from "@workspace/db";
import { runCypher } from "./neo4j-client.js";
import { logger } from "../../lib/logger.js";
import { randomUUID } from "crypto";
import { eq, and, gte } from "drizzle-orm";

// CAMEO codes that logically conflict with each other
const CONFLICTING_PAIRS: Array<[string, string]> = [
  ["NEGOTIATE", "THREATEN"],
  ["NEGOTIATE", "MOBILIZE_MILITARY"],
  ["CEASEFIRE", "FIGHT"],
  ["CEASEFIRE", "ASSAULT"],
  ["SIGN_TREATY", "IMPOSE_EMBARGO"],
  ["PROVIDE_AID", "IMPOSE_EMBARGO"],
  ["EXPEL_DIPLOMAT", "CONSULT"],
];

function actionTypesConflict(codeA: string, codeB: string): boolean {
  for (const [x, y] of CONFLICTING_PAIRS) {
    if ((codeA === x && codeB === y) || (codeA === y && codeB === x)) return true;
  }
  return false;
}

function parseActorIsos(actorsJson: string): string[] {
  try {
    const actors = JSON.parse(actorsJson) as Array<{ country_iso?: string }>;
    return actors.map((a) => a.country_iso ?? "").filter(Boolean);
  } catch {
    return [];
  }
}

export async function runContradictionDetection(): Promise<number> {
  const windowStart = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000); // ±2 days

  // Fetch recent FACT-level events (not hypotheses)
  const events = await db
    .select()
    .from(extractedEventsTable)
    .where(
      and(
        gte(extractedEventsTable.extractedAt, windowStart),
        eq(extractedEventsTable.isHypothesis, false)
      )
    );

  let contradictionsFound = 0;

  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      const a = events[i];
      const b = events[j];

      if (!actionTypesConflict(a.actionType, b.actionType)) continue;

      const isosA = parseActorIsos(a.actors);
      const isosB = parseActorIsos(b.actors);

      // Must share same actor pair (order-insensitive)
      const sharedIsos = isosA.filter((iso) => isosB.includes(iso));
      if (sharedIsos.length < 2) continue;

      const actorPair = [...new Set([...isosA, ...isosB])].sort().slice(0, 2).join("|");

      // Check event dates are within ±2 days
      const dateA = new Date(a.eventDate !== "UNKNOWN" ? a.eventDate : a.extractedAt);
      const dateB = new Date(b.eventDate !== "UNKNOWN" ? b.eventDate : b.extractedAt);
      const diffDays = Math.abs(dateA.getTime() - dateB.getTime()) / (1000 * 60 * 60 * 24);
      if (diffDays > 2) continue;

      // Write CONTRADICTS edge in Neo4j
      await runCypher(
        `MATCH (ea:Event {id: $idA}), (eb:Event {id: $idB})
         MERGE (ea)-[r:CONTRADICTS]->(eb)
         SET r.conflict_type = $conflictType, r.resolution_status = 'open'`,
        {
          idA: a.id,
          idB: b.id,
          conflictType: `${a.actionType}_vs_${b.actionType}`,
        }
      );

      // Write to contradiction_queue in PostgreSQL for Analyst agent (Phase 3)
      await db.insert(contradictionQueueTable).values({
        id: randomUUID(),
        eventIdA: a.id,
        eventIdB: b.id,
        actorPair,
        cameoCodeA: a.actionType,
        cameoCodeB: b.actionType,
        storyId: a.storyId ?? b.storyId ?? null,
        resolutionStatus: "open",
      }).onConflictDoNothing();

      contradictionsFound++;
    }
  }

  if (contradictionsFound > 0) {
    logger.info({ contradictionsFound }, "contradiction detection complete");
  }
  return contradictionsFound;
}

import { db, extractedEventsTable, rawArticlesTable } from "@workspace/db";
import { eq, isNull, gt } from "drizzle-orm";
import { runCypher } from "./neo4j-client.js";
import { logger } from "../../lib/logger.js";

// Credibility → effective weight for graph edges
const CREDIBILITY_WEIGHT: Record<number, number> = {
  1: 1.0,
  2: 0.8,
  3: 0.5,
  4: 0.9,
};

// Pull new extracted events (not yet in graph — storyId null means unprocessed)
// and write them as Event nodes + ACTED_ON edges into Neo4j.
export async function syncEventsToGraph(): Promise<number> {
  // Fetch events not yet assigned to a story (Phase 2 graph population)
  const events = await db
    .select({
      id: extractedEventsTable.id,
      articleId: extractedEventsTable.articleId,
      actors: extractedEventsTable.actors,
      actionType: extractedEventsTable.actionType,
      actionLabel: extractedEventsTable.actionLabel,
      target: extractedEventsTable.target,
      location: extractedEventsTable.location,
      eventDate: extractedEventsTable.eventDate,
      confidence: extractedEventsTable.confidence,
      isHypothesis: extractedEventsTable.isHypothesis,
    })
    .from(extractedEventsTable)
    .where(isNull(extractedEventsTable.storyId))
    .limit(500);

  if (events.length === 0) return 0;

  for (const evt of events) {
    let actors: Array<{ name: string; country_iso: string; entity_type: string }> = [];
    let target: { name: string; country_iso: string; entity_type: string } = { name: "", country_iso: "", entity_type: "" };
    let location: { country_iso: string; region: string; city: string } = { country_iso: "", region: "", city: "" };

    try { actors = JSON.parse(evt.actors); } catch { /* ignore */ }
    try { target = JSON.parse(evt.target); } catch { /* ignore */ }
    try { location = JSON.parse(evt.location); } catch { /* ignore */ }

    // Lookup article credibility tier
    const [article] = await db
      .select({ credibilityTier: rawArticlesTable.credibilityTier })
      .from(rawArticlesTable)
      .where(eq(rawArticlesTable.id, evt.articleId))
      .limit(1);
    const credWeight = CREDIBILITY_WEIGHT[article?.credibilityTier ?? 2] ?? 0.8;

    // Merge Event node
    await runCypher(
      `MERGE (e:Event {id: $id})
       SET e.cameo_code = $cameo_code,
           e.action_label = $action_label,
           e.event_date = $event_date,
           e.source_article_ids = $source_article_ids,
           e.confidence = $confidence,
           e.is_hypothesis = $is_hypothesis,
           e.effective_weight = $effective_weight`,
      {
        id: evt.id,
        cameo_code: evt.actionType,
        action_label: evt.actionLabel,
        event_date: evt.eventDate,
        source_article_ids: evt.articleId,
        confidence: evt.confidence,
        is_hypothesis: evt.isHypothesis,
        effective_weight: credWeight * evt.confidence,
      }
    );

    // Merge actor Country/Leader/Organization nodes and ACTED_ON edges
    for (const actor of actors) {
      if (!actor.name) continue;

      if (actor.entity_type === "state" || actor.entity_type === "org") {
        const label = actor.entity_type === "state" ? "Country" : "Organization";
        await runCypher(
          `MERGE (a:${label} {name: $name})
           ON CREATE SET a.iso_code = $iso_code
           WITH a
           MATCH (e:Event {id: $eventId})
           MERGE (e)-[r:ACTED_ON]->(a)
           SET r.cameo_code = $cameoCode, r.event_date = $eventDate, r.weight = $weight`,
          {
            name: actor.name,
            iso_code: actor.country_iso,
            eventId: evt.id,
            cameoCode: evt.actionType,
            eventDate: evt.eventDate,
            weight: credWeight * evt.confidence,
          }
        );
      } else {
        // Person / Leader
        await runCypher(
          `MERGE (l:Leader {name: $name})
           ON CREATE SET l.country_iso = $country_iso, l.role = $role, l.credibility_weight = $cw
           WITH l
           MATCH (e:Event {id: $eventId})
           MERGE (e)-[r:ACTED_ON]->(l)
           SET r.cameo_code = $cameoCode, r.event_date = $eventDate, r.weight = $weight`,
          {
            name: actor.name,
            country_iso: actor.country_iso,
            role: actor.role ?? "",
            cw: credWeight,
            eventId: evt.id,
            cameoCode: evt.actionType,
            eventDate: evt.eventDate,
            weight: credWeight * evt.confidence,
          }
        );
      }
    }

    // Merge target node and ACTED_ON edge
    if (target.name) {
      await runCypher(
        `MERGE (t:Country {name: $name})
         ON CREATE SET t.iso_code = $iso_code
         WITH t
         MATCH (e:Event {id: $eventId})
         MERGE (e)-[r:ACTED_ON]->(t)
         SET r.cameo_code = $cameoCode, r.event_date = $eventDate, r.weight = $weight, r.role = 'target'`,
        {
          name: target.name,
          iso_code: target.country_iso ?? "",
          eventId: evt.id,
          cameoCode: evt.actionType,
          eventDate: evt.eventDate,
          weight: credWeight * evt.confidence * 0.8,
        }
      );
    }

    // Mark event as graph-synced (storyId = "pending" until Louvain assigns)
    await db
      .update(extractedEventsTable)
      .set({ storyId: "pending" })
      .where(eq(extractedEventsTable.id, evt.id));
  }

  logger.info({ count: events.length }, "events synced to neo4j graph");
  return events.length;
}

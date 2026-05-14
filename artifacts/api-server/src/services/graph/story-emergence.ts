import { chatComplete } from "@workspace/integrations-openai-ai-server";
import { runCypher } from "./neo4j-client.js";
import { detectCommunities, groupCommunities } from "./louvain.js";
import { logger } from "../../lib/logger.js";
import { randomUUID } from "crypto";

const MIN_COMMUNITY_EVENTS = 4;
const MIN_COMMUNITY_COUNTRIES = 1;
const STORY_CONTINUITY_OVERLAP_THRESHOLD = 0.60;
const LOOKBACK_DAYS = 21;
const MAX_ACTIVE_STORIES = 25; // hard cap per blueprint

interface EventNode {
  id: string;
  cameoCode: string;
  eventDate: string;
  countryIsos: string[]; // from ACTED_ON edges
  effectiveWeight: number;
  confidence: number;
}

interface StoryNode {
  id: string;
  label: string;
  countryIsos: string[];
  status: string;
}

// Jaccard similarity between two sets
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// GPT-4o: label a community in 8 words or fewer
async function labelCommunity(events: EventNode[]): Promise<string> {
  const topEvents = events
    .sort((a, b) => b.effectiveWeight - a.effectiveWeight)
    .slice(0, 5)
    .map((e) => `[${e.cameoCode}] countries: ${e.countryIsos.join(",")} on ${e.eventDate}`)
    .join("\n");

  try {
    const response = await chatComplete({
      model: "gpt-4o",
      temperature: 0.2,
      max_tokens: 30,
      messages: [
        {
          role: "system",
          content: "You label geopolitical stories. Return ONLY the label string. 8 words or fewer. No punctuation.",
        },
        {
          role: "user",
          content: `In 8 words or fewer, what geopolitical story do these events describe?\n${topEvents}`,
        },
      ],
    });
    return (response.choices[0]?.message?.content ?? "Unknown story").trim().slice(0, 80);
  } catch {
    // Fallback label from top countries
    const countries = [...new Set(events.flatMap((e) => e.countryIsos))].slice(0, 3).join("-");
    return `${countries} situation`;
  }
}

export async function runStoryEmergence(): Promise<number> {
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  // 1. Fetch all Event nodes from last 21 days with their ACTED_ON targets
  const result = await runCypher(
    `MATCH (e:Event)
     WHERE e.event_date >= $cutoff AND e.is_hypothesis = false
     OPTIONAL MATCH (e)-[r:ACTED_ON]->(a)
     WHERE a:Country OR a:Leader
     RETURN e.id AS id,
            e.cameo_code AS cameoCode,
            e.event_date AS eventDate,
            e.effective_weight AS effectiveWeight,
            e.confidence AS confidence,
            collect(DISTINCT coalesce(a.iso_code, a.country_iso, '')) AS countryIsos`,
    { cutoff: cutoffStr }
  );

  const events: EventNode[] = result.records.map((r) => ({
    id: r.get("id") as string,
    cameoCode: r.get("cameoCode") as string,
    eventDate: r.get("eventDate") as string,
    effectiveWeight: (r.get("effectiveWeight") as number) ?? 0.5,
    confidence: (r.get("confidence") as number) ?? 0.5,
    countryIsos: ((r.get("countryIsos") as string[]) ?? []).filter(Boolean),
  }));

  if (events.length < MIN_COMMUNITY_EVENTS) {
    logger.info({ eventCount: events.length }, "not enough events for story emergence");
    return 0;
  }

  // 2. Build weighted graph: Events connected by shared country/actor
  const nodeList = events.map((e) => ({ id: e.id }));
  const edges: Array<{ source: string; target: string; weight: number }> = [];

  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      const a = events[i];
      const b = events[j];
      const shared = a.countryIsos.filter((c) => b.countryIsos.includes(c)).length;
      if (shared === 0) continue;
      const weight = (a.effectiveWeight + b.effectiveWeight) / 2 * shared;
      edges.push({ source: a.id, target: b.id, weight });
    }
  }

  // 3. Run Louvain
  const assignment = detectCommunities(nodeList, edges);
  const communities = groupCommunities(assignment);

  // 4. Filter communities by blueprint minimum requirements
  const eventMap = new Map(events.map((e) => [e.id, e]));
  const qualifying = communities
    .map((c) => {
      const commEvents = c.nodes.map((id) => eventMap.get(id)).filter(Boolean) as EventNode[];
      const countryIsos = new Set(commEvents.flatMap((e) => e.countryIsos));
      return { commEvents, countryIsos };
    })
    .filter((c) => c.commEvents.length >= MIN_COMMUNITY_EVENTS && c.countryIsos.size >= MIN_COMMUNITY_COUNTRIES);

  // 5. Fetch existing Story nodes
  const existingStoriesResult = await runCypher(
    `MATCH (s:Story) RETURN s.id AS id, s.label AS label, s.country_isos AS countryIsos, s.status AS status`
  );
  const existingStories: StoryNode[] = existingStoriesResult.records.map((r) => ({
    id: r.get("id") as string,
    label: r.get("label") as string,
    countryIsos: (r.get("countryIsos") as string ?? "").split(",").filter(Boolean),
    status: r.get("status") as string,
  }));

  let storiesCreated = 0;
  let storiesUpdated = 0;

  // 6. For each qualifying community, match or create Story node
  for (const { commEvents, countryIsos } of qualifying.slice(0, MAX_ACTIVE_STORIES)) {
    const communityCountrySet = new Set([...countryIsos]);

    // Find existing story by Jaccard overlap of country sets
    let matchedStory: StoryNode | null = null;
    let bestOverlap = 0;
    for (const story of existingStories) {
      const storySet = new Set(story.countryIsos);
      const overlap = jaccard(communityCountrySet, storySet);
      if (overlap > STORY_CONTINUITY_OVERLAP_THRESHOLD && overlap > bestOverlap) {
        bestOverlap = overlap;
        matchedStory = story;
      }
    }

    if (matchedStory) {
      // Update existing story
      await runCypher(
        `MATCH (s:Story {id: $id})
         SET s.status = 'active', s.country_isos = $countryIsos, s.last_seen = $now`,
        {
          id: matchedStory.id,
          countryIsos: [...communityCountrySet].join(","),
          now: new Date().toISOString(),
        }
      );
      // Assign events to story
      for (const e of commEvents) {
        await runCypher(
          `MATCH (e:Event {id: $eventId}), (s:Story {id: $storyId})
           MERGE (e)-[:PART_OF]->(s)`,
          { eventId: e.id, storyId: matchedStory.id }
        );
      }
      storiesUpdated++;
    } else {
      // Create new story — label with GPT-4o
      const label = await labelCommunity(commEvents);
      const storyId = randomUUID();
      await runCypher(
        `CREATE (s:Story {
           id: $id,
           label: $label,
           status: 'emerging',
           country_isos: $countryIsos,
           narrative_drift_score: 0.0,
           emerged_at: $now,
           last_seen: $now
         })`,
        {
          id: storyId,
          label,
          countryIsos: [...communityCountrySet].join(","),
          now: new Date().toISOString(),
        }
      );
      // Assign events
      for (const e of commEvents) {
        await runCypher(
          `MATCH (e:Event {id: $eventId}), (s:Story {id: $storyId})
           MERGE (e)-[:PART_OF]->(s)`,
          { eventId: e.id, storyId }
        );
      }
      storiesCreated++;
    }
  }

  // 7. Mark dormant: stories not seen in this cycle
  const seenStoryIds = new Set<string>();
  for (const { commEvents } of qualifying) {
    for (const e of commEvents) {
      const partOfResult = await runCypher(
        `MATCH (e:Event {id: $id})-[:PART_OF]->(s:Story) RETURN s.id AS sid`,
        { id: e.id }
      );
      partOfResult.records.forEach((r) => seenStoryIds.add(r.get("sid") as string));
    }
  }
  await runCypher(
    `MATCH (s:Story) WHERE s.status = 'active' AND NOT s.id IN $seenIds
     SET s.status = 'dormant'`,
    { seenIds: [...seenStoryIds] }
  );

  logger.info({ storiesCreated, storiesUpdated, qualifyingCommunities: qualifying.length }, "story emergence complete");
  return storiesCreated + storiesUpdated;
}

// Read active stories for API responses (replaces CLUSTER_TEMPLATES)
export interface GraphStory {
  id: string;
  label: string;
  status: string;
  countryIsos: string[];
  narrativeDriftScore: number;
  driftDescription: string | null;
  eventCount: number;
  latestEventDate: string;
}

export async function getActiveStories(): Promise<GraphStory[]> {
  const result = await runCypher(
    `MATCH (s:Story)
     WHERE s.status IN ['active', 'emerging']
     OPTIONAL MATCH (e:Event)-[:PART_OF]->(s)
     RETURN s.id AS id,
            s.label AS label,
            s.status AS status,
            s.country_isos AS countryIsos,
            s.narrative_drift_score AS driftScore,
            s.drift_description AS driftDescription,
            count(e) AS eventCount,
            max(e.event_date) AS latestEventDate
     ORDER BY eventCount DESC
     LIMIT 30`
  );

  return result.records.map((r) => ({
    id: r.get("id") as string,
    label: r.get("label") as string,
    status: r.get("status") as string,
    countryIsos: (r.get("countryIsos") as string ?? "").split(",").filter(Boolean),
    narrativeDriftScore: (r.get("driftScore") as number) ?? 0,
    driftDescription: r.get("driftDescription") as string | null,
    eventCount: (r.get("eventCount") as number) ?? 0,
    latestEventDate: r.get("latestEventDate") as string ?? "",
  }));
}

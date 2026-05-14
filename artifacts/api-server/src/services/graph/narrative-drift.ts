import { chatComplete } from "@workspace/integrations-openai-ai-server";
import { db, rawArticlesTable, storyCentroidsTable } from "@workspace/db";
import { runCypher } from "./neo4j-client.js";
import { embedText } from "../ingestion/semantic-dedup.js";
import { logger } from "../../lib/logger.js";
import { randomUUID } from "crypto";
import { eq, and, gte, lt } from "drizzle-orm";

const DRIFT_THRESHOLD = 0.25;
const LOOKBACK_WEEKS = 4;

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function meanVector(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dim = vectors[0].length;
  const mean = new Array<number>(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) mean[i] += v[i];
  }
  return mean.map((x) => x / vectors.length);
}

// Run weekly drift detection for all active stories
export async function runNarrativeDrift(): Promise<void> {
  const storiesResult = await runCypher(
    `MATCH (s:Story) WHERE s.status IN ['active', 'emerging']
     RETURN s.id AS id, s.label AS label`
  );

  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // start of this week
  weekStart.setHours(0, 0, 0, 0);

  for (const record of storiesResult.records) {
    const storyId = record.get("id") as string;
    const storyLabel = record.get("label") as string;

    try {
      await processStoryDrift(storyId, storyLabel, weekStart);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ storyId, err: msg }, "narrative drift failed for story");
    }
  }
}

async function processStoryDrift(storyId: string, storyLabel: string, weekStart: Date): Promise<void> {
  // Fetch article IDs for this story from Neo4j
  const eventsResult = await runCypher(
    `MATCH (e:Event)-[:PART_OF]->(s:Story {id: $storyId})
     RETURN e.source_article_ids AS articleId`,
    { storyId }
  );
  const articleIds = eventsResult.records
    .map((r) => r.get("articleId") as string)
    .filter(Boolean);

  if (articleIds.length < 3) return;

  // Fetch article bodies for embedding
  const recentArticles: string[] = [];
  for (const articleId of articleIds.slice(0, 30)) {
    const [article] = await db
      .select({ title: rawArticlesTable.title, body: rawArticlesTable.body })
      .from(rawArticlesTable)
      .where(eq(rawArticlesTable.id, articleId))
      .limit(1);
    if (article) recentArticles.push(`${article.title} ${article.body.slice(0, 200)}`);
  }
  if (recentArticles.length === 0) return;

  // Embed all articles and compute centroid
  const embeddings: number[][] = [];
  for (const text of recentArticles) {
    try {
      const emb = await embedText(text);
      if (emb.length > 0) embeddings.push(emb);
    } catch {
      // skip failed embeddings
    }
  }
  if (embeddings.length === 0) return;

  const currentCentroid = meanVector(embeddings);

  // Store centroid
  const existingCentroid = await db
    .select()
    .from(storyCentroidsTable)
    .where(
      and(
        eq(storyCentroidsTable.storyId, storyId),
        gte(storyCentroidsTable.weekStart, weekStart)
      )
    )
    .limit(1);

  if (existingCentroid.length === 0) {
    await db.insert(storyCentroidsTable).values({
      id: randomUUID(),
      storyId,
      weekStart,
      centroid: JSON.stringify(currentCentroid),
      articleCount: String(embeddings.length),
    });
  }

  // Compare with centroid from 4 weeks ago
  const fourWeeksAgo = new Date(weekStart.getTime() - LOOKBACK_WEEKS * 7 * 24 * 60 * 60 * 1000);
  const fiveWeeksAgo = new Date(fourWeeksAgo.getTime() - 7 * 24 * 60 * 60 * 1000);

  const oldCentroidRow = await db
    .select()
    .from(storyCentroidsTable)
    .where(
      and(
        eq(storyCentroidsTable.storyId, storyId),
        gte(storyCentroidsTable.weekStart, fiveWeeksAgo),
        lt(storyCentroidsTable.weekStart, fourWeeksAgo)
      )
    )
    .limit(1);

  if (oldCentroidRow.length === 0) return;

  let oldCentroid: number[];
  try {
    oldCentroid = JSON.parse(oldCentroidRow[0].centroid) as number[];
  } catch {
    return;
  }

  const similarity = cosineSimilarity(currentCentroid, oldCentroid);
  const cosineDistance = 1 - similarity;

  if (cosineDistance > DRIFT_THRESHOLD) {
    // Story character has changed — call GPT-4o for drift description
    const driftDescription = await describeDrift(storyLabel, oldCentroidRow[0], embeddings);

    await runCypher(
      `MATCH (s:Story {id: $id})
       SET s.narrative_drift_score = $score, s.drift_description = $desc`,
      {
        id: storyId,
        score: cosineDistance,
        desc: driftDescription,
      }
    );
    logger.info({ storyId, storyLabel, driftScore: cosineDistance }, "narrative drift detected");
  } else {
    // Reset drift if story is stable again
    await runCypher(
      `MATCH (s:Story {id: $id}) SET s.narrative_drift_score = $score`,
      { id: storyId, score: cosineDistance }
    );
  }
}

async function describeDrift(
  storyLabel: string,
  oldCentroidRow: { articleCount: string },
  _currentEmbeddings: number[][]
): Promise<string> {
  try {
    const response = await chatComplete({
      model: "gpt-4o",
      temperature: 0.3,
      max_tokens: 60,
      messages: [
        {
          role: "user",
          content: `The geopolitical story "${storyLabel}" has significantly changed character over 4 weeks (cosine drift detected). In one sentence, describe how this type of story typically evolves — e.g. from diplomatic dispute to military standoff. Be concise.`,
        },
      ],
    });
    return (response.choices[0]?.message?.content ?? "").trim().slice(0, 300);
  } catch {
    return `Story character shifted significantly from ${oldCentroidRow.articleCount} articles ago`;
  }
}

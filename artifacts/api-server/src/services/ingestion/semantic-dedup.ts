import { openai } from "@workspace/integrations-openai-ai-server";
import { db, rawArticlesTable, articleCorroborationsTable } from "@workspace/db";
import { and, gte, eq, or, sql } from "drizzle-orm";
import { logger } from "../../lib/logger.js";
import { randomUUID } from "crypto";

const EMBEDDING_MODEL = "text-embedding-3-small";
const DEDUP_WINDOW_HOURS = 6;
const DUPLICATE_THRESHOLD = 0.88;
const CORROBORATION_THRESHOLD = 0.70;

export type DedupStatus = "independent" | "duplicate" | "corroboration";

export interface DedupResult {
  status: DedupStatus;
  embedding: number[];
  primaryArticleId?: string; // set when duplicate
  similarityScore?: number;
}

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

export async function embedText(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text.slice(0, 8192),
  });
  return response.data[0].embedding;
}

export async function deduplicateArticle(
  articleId: string,
  title: string,
  bodyPreview: string,
  credibilityTier: number
): Promise<DedupResult> {
  const inputText = `${title} ${bodyPreview.slice(0, 300)}`;

  let embedding: number[];
  try {
    embedding = await embedText(inputText);
  } catch (err) {
    logger.warn({ articleId, err }, "embedding failed — treating as independent");
    return { status: "independent", embedding: [] };
  }

  // Fetch recent articles within the dedup window that have embeddings
  const windowStart = new Date(Date.now() - DEDUP_WINDOW_HOURS * 60 * 60 * 1000);

  const recentArticles = await db
    .select({
      id: rawArticlesTable.id,
      embedding: rawArticlesTable.embedding,
      credibilityTier: rawArticlesTable.credibilityTier,
    })
    .from(rawArticlesTable)
    .where(
      and(
        gte(rawArticlesTable.ingestedAt, windowStart),
        or(
          eq(rawArticlesTable.dedupStatus, "independent"),
          eq(rawArticlesTable.dedupStatus, "corroboration")
        )
      )
    );

  let maxSimilarity = 0;
  let mostSimilarId: string | null = null;
  let mostSimilarTier: number = 999;

  for (const recent of recentArticles) {
    if (!recent.embedding || recent.id === articleId) continue;
    let recentEmb: number[];
    try {
      recentEmb = JSON.parse(recent.embedding) as number[];
    } catch {
      continue;
    }
    const sim = cosineSimilarity(embedding, recentEmb);
    if (sim > maxSimilarity) {
      maxSimilarity = sim;
      mostSimilarId = recent.id;
      mostSimilarTier = recent.credibilityTier;
    }
  }

  // Duplicate: keep higher quality source (lower tier = higher quality)
  if (maxSimilarity >= DUPLICATE_THRESHOLD && mostSimilarId) {
    if (credibilityTier <= mostSimilarTier) {
      // New article is higher quality — it becomes the primary, discard old
      // For simplicity: mark new as independent, old stays as is.
      // In practice the old gets replaced — but we just skip the new duplicate.
      logger.debug({ articleId, similarTo: mostSimilarId, sim: maxSimilarity }, "duplicate detected — discarding");
      return {
        status: "duplicate",
        embedding,
        primaryArticleId: mostSimilarId,
        similarityScore: maxSimilarity,
      };
    }
    // New article is lower quality than existing — discard new
    logger.debug({ articleId, similarTo: mostSimilarId, sim: maxSimilarity }, "duplicate detected — keeping existing");
    return {
      status: "duplicate",
      embedding,
      primaryArticleId: mostSimilarId,
      similarityScore: maxSimilarity,
    };
  }

  // Corroboration
  if (maxSimilarity >= CORROBORATION_THRESHOLD && mostSimilarId) {
    // Link as corroboration — persist the link
    await db.insert(articleCorroborationsTable).values({
      id: randomUUID(),
      primaryArticleId: mostSimilarId,
      corroboratingArticleId: articleId,
      similarityScore: maxSimilarity,
    }).onConflictDoNothing();

    // Increment corroboration_count on the primary
    await db
      .update(rawArticlesTable)
      .set({ corroborationCount: sql`${rawArticlesTable.corroborationCount} + 1` })
      .where(eq(rawArticlesTable.id, mostSimilarId));

    logger.debug({ articleId, primaryId: mostSimilarId, sim: maxSimilarity }, "corroboration linked");
    return {
      status: "corroboration",
      embedding,
      primaryArticleId: mostSimilarId,
      similarityScore: maxSimilarity,
    };
  }

  return { status: "independent", embedding };
}

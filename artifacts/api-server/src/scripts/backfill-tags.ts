// Backfill narrative_sequence_id + article_asset_tags for existing articles.
//
// Usage (on EC2):
//   node --enable-source-maps ./dist/scripts/backfill-tags.mjs
//
// What it does:
//   1. Fetches all raw_articles from the last 2 weeks where narrative_sequence_id IS NULL
//   2. Assigns a new UUID as narrative_sequence_id (can't reconstruct semantic dedup retroactively)
//   3. Runs driver matching (scoreArticle) for each article against all assets
//   4. Inserts tags into article_asset_tags
//
// This is a one-time migration script. Run after `drizzle-kit push` applies the schema changes.

import { db, rawArticlesTable, articleAssetTagsTable } from "@workspace/db";
import { eq, isNull, gte, and } from "drizzle-orm";
import { randomUUID } from "crypto";
import { ASSET_MATCHERS, scoreArticle } from "../services/market/stock-news.js";

const WINDOW_DAYS = 14;
const BATCH_SIZE = 100;

async function main() {
  const windowStart = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  console.log(`[backfill] Starting backfill for articles since ${windowStart.toISOString()}`);

  // Step 1: Backfill narrative_sequence_id for articles that don't have one
  const articlesWithoutNsid = await db
    .select({ id: rawArticlesTable.id, title: rawArticlesTable.title })
    .from(rawArticlesTable)
    .where(and(
      gte(rawArticlesTable.publishedAt, windowStart),
      isNull(rawArticlesTable.narrativeSequenceId),
    ));

  console.log(`[backfill] ${articlesWithoutNsid.length} articles need narrative_sequence_id`);

  let nsidCount = 0;
  for (const article of articlesWithoutNsid) {
    await db
      .update(rawArticlesTable)
      .set({ narrativeSequenceId: randomUUID() })
      .where(eq(rawArticlesTable.id, article.id));
    nsidCount++;
    if (nsidCount % 100 === 0) {
      console.log(`[backfill] narrative_sequence_id: ${nsidCount}/${articlesWithoutNsid.length}`);
    }
  }
  console.log(`[backfill] Assigned ${nsidCount} narrative_sequence_ids`);

  // Step 2: Backfill article_asset_tags for all articles in the window
  const allArticles = await db
    .select({
      id: rawArticlesTable.id,
      title: rawArticlesTable.title,
      body: rawArticlesTable.body,
    })
    .from(rawArticlesTable)
    .where(gte(rawArticlesTable.publishedAt, windowStart));

  console.log(`[backfill] ${allArticles.length} articles to tag for assets`);

  let taggedCount = 0;
  let totalTags = 0;

  for (let i = 0; i < allArticles.length; i += BATCH_SIZE) {
    const batch = allArticles.slice(i, i + BATCH_SIZE);
    const tagInserts: Array<{
      articleId: string;
      assetId: string;
      matchedDrivers: string[];
      driverScore: number;
    }> = [];

    for (const article of batch) {
      const scanText = `${article.title}\n${(article.body ?? "").slice(0, 2000)}`.toLowerCase();
      for (const assetId of Object.keys(ASSET_MATCHERS)) {
        const { score, drivers } = scoreArticle(assetId, scanText);
        if (score > 0) {
          tagInserts.push({
            articleId: article.id,
            assetId,
            matchedDrivers: drivers,
            driverScore: score,
          });
        }
      }
    }

    if (tagInserts.length > 0) {
      try {
        await db.insert(articleAssetTagsTable).values(tagInserts).onConflictDoNothing();
        totalTags += tagInserts.length;
      } catch (err) {
        console.warn(`[backfill] Batch tag insert failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    taggedCount += batch.length;
    console.log(`[backfill] Tagged ${taggedCount}/${allArticles.length} articles (${totalTags} tags so far)`);
  }

  console.log(`[backfill] Done. Assigned ${nsidCount} nsids, inserted ${totalTags} asset tags.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill] Fatal error:", err);
  process.exit(1);
});

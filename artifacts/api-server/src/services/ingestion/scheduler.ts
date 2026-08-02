import { db, feedRegistryTable, rawArticlesTable, articleAssetTagsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { logger } from "../../lib/logger.js";
import { FEED_REGISTRY_SEED } from "./feed-registry-seed.js";
import { fetchRssFeed, computeBackoffMs } from "./rss-fetcher.js";
import { fetchGuardianApi } from "./guardian-fetcher.js";
import { fetchGdeltBatch } from "./gdelt-fetcher.js";
import { deduplicateArticle } from "./semantic-dedup.js";
import { extractEventFromArticle, insertGdeltEvent } from "./event-extractor.js";
import { onNewArticle } from "./breaking-news-detector.js";
import { ASSET_MATCHERS, scoreArticle } from "../market/stock-news.js";
import type { FeedRegistry } from "@workspace/db";

// Track consecutive failures per feed for backoff
const failureCount = new Map<string, number>();
// Track last processed GDELT batch URL
let lastGdeltBatchUrl: string | undefined;

// ─── Breaking News Keyword Detection ──────────────────────────────────────────

const BREAKING_DRIVERS = [
  "rbi", "repo rate", "rate cut", "rate hike", "monetary policy",
  "crude oil", "brent", "wti", "oil price",
  "war", "invasion", "missile", "nuclear", "ceasefire",
  "sanctions", "embargo", "ofac",
  "earnings", "q1", "q2", "q3", "q4", "results",
  "fii", "foreign institutional", "dii",
  "sensex", "nifty", "market crash", "circuit breaker",
];

function isBreakingNews(title: string, body: string): boolean {
  const text = `${title} ${body}`.toLowerCase();
  return BREAKING_DRIVERS.some((d) => text.includes(d));
}

// ─── Feed Registry Bootstrap ──────────────────────────────────────────────────

async function ensureFeedRegistry(): Promise<void> {
  for (const feed of FEED_REGISTRY_SEED) {
    await db.insert(feedRegistryTable).values(feed).onConflictDoNothing();
  }
  logger.info({ count: FEED_REGISTRY_SEED.length }, "feed registry seeded");
}

// ─── Single Article Processing Pipeline ───────────────────────────────────────

async function processArticle(
  feedId: string,
  url: string,
  title: string,
  body: string,
  publishedAt: Date,
  credibilityTier: number,
  isStateMedia: boolean
): Promise<void> {
  // Fast path: skip if URL already exists (catches RSS re-fetches, cross-feed duplicates)
  const existing = await db
    .select({ id: rawArticlesTable.id })
    .from(rawArticlesTable)
    .where(eq(rawArticlesTable.url, url))
    .limit(1);
  if (existing.length > 0) {
    return;
  }

  const articleId = randomUUID();

  // Step 1: Semantic deduplication (catches near-duplicate rewrites)
  const dedupResult = await deduplicateArticle(articleId, title, body, credibilityTier);

  if (dedupResult.status === "duplicate") {
    // Discard — do not persist
    return;
  }

  // Step 2: Determine narrative_sequence_id
  let narrativeSequenceId: string;
  if (dedupResult.status === "corroboration" && dedupResult.primaryArticleId) {
    const primary = await db
      .select({ nsid: rawArticlesTable.narrativeSequenceId })
      .from(rawArticlesTable)
      .where(eq(rawArticlesTable.id, dedupResult.primaryArticleId))
      .limit(1);
    narrativeSequenceId = primary[0]?.nsid ?? randomUUID();
  } else {
    narrativeSequenceId = randomUUID();
  }

  // Step 3: Persist raw article
  const isBreaking = isBreakingNews(title, body);
  await db.insert(rawArticlesTable).values({
    id: articleId,
    feedId,
    url,
    title: title.slice(0, 500),
    body: body.slice(0, 5000),
    publishedAt,
    credibilityTier,
    isStateMedia,
    biasFlag: isStateMedia,
    embedding: dedupResult.embedding.length > 0 ? JSON.stringify(dedupResult.embedding) : null,
    dedupStatus: dedupResult.status,
    corroborationCount: 0,
    requiresCorroboration: isStateMedia && credibilityTier >= 3,
    isBreaking,
    narrativeSequenceId,
  }).onConflictDoNothing();

  if (isBreaking) {
    logger.info({ articleId, title: title.slice(0, 100) }, "breaking news flagged at ingestion");
  }

  // Step 4: GPT-4o CAMEO extraction (skip for state-media-only hypotheses until corroborated)
  const skipExtraction = isStateMedia && credibilityTier >= 3;
  if (!skipExtraction) {
    await extractEventFromArticle(articleId, title, body, credibilityTier, isStateMedia, publishedAt);
  }

  // Step 5: Pre-tag assets for this article (eliminates query-time regex scanning)
  const scanText = `${title}\n${body.slice(0, 2000)}`.toLowerCase();
  const tagInserts: Array<{ articleId: string; assetId: string; matchedDrivers: string[]; driverScore: number }> = [];
  for (const assetId of Object.keys(ASSET_MATCHERS)) {
    const { score, drivers } = scoreArticle(assetId, scanText);
    if (score > 0) {
      tagInserts.push({ articleId, assetId, matchedDrivers: drivers, driverScore: score });
    }
  }
  if (tagInserts.length > 0) {
    try {
      await db.insert(articleAssetTagsTable).values(tagInserts).onConflictDoNothing();
    } catch (err) {
      logger.warn({ articleId, err: err instanceof Error ? err.message : err }, "asset pre-tagging failed");
    }
  }

  // Step 6: Trigger breaking news detector (may emit event for immediate ensemble re-run)
  onNewArticle({ id: articleId, title, url, isBreaking, publishedAt });
}

// ─── RSS Feed Processor ────────────────────────────────────────────────────────

async function processFeed(feed: FeedRegistry): Promise<void> {
  // Check quarantine
  if (feed.quarantineUntil && new Date() < feed.quarantineUntil) {
    return;
  }

  // Skip non-RSS feeds (handled separately)
  if (feed.parser === "gdelt" || feed.parser === "acled" || feed.parser === "congress" || feed.parser === "worldbank" || feed.parser === "ofac") {
    return;
  }

  try {
    const articles = await fetchRssFeed(feed);

    // Clear failure count on success
    failureCount.set(feed.id, 0);

    // Update lastFetchedAt
    await db
      .update(feedRegistryTable)
      .set({ lastFetchedAt: new Date() })
      .where(eq(feedRegistryTable.id, feed.id));

    // Process each article
    for (const article of articles) {
      try {
        await processArticle(
          article.feedId,
          article.url,
          article.title,
          article.body,
          article.publishedAt,
          article.credibilityTier,
          article.isStateMedia
        );
      } catch (err) {
        // Per-article errors don't fail the whole feed
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ feedId: feed.id, url: article.url, err: msg }, "article processing error");
      }
    }

    logger.info({ feedId: feed.id, count: articles.length }, "feed processed");
  } catch (err) {
    const count = (failureCount.get(feed.id) ?? 0) + 1;
    failureCount.set(feed.id, count);

    if (count >= 3) {
      const backoffMs = computeBackoffMs(count);
      const quarantineUntil = new Date(Date.now() + backoffMs);
      await db
        .update(feedRegistryTable)
        .set({ quarantineUntil })
        .where(eq(feedRegistryTable.id, feed.id));
      logger.warn({ feedId: feed.id, quarantineUntil, failures: count }, "feed quarantined");
    }
  }
}

// ─── GDELT Batch Processor ────────────────────────────────────────────────────

async function processGdeltBatch(): Promise<void> {
  try {
    const { events, batchUrl } = await fetchGdeltBatch(lastGdeltBatchUrl);
    lastGdeltBatchUrl = batchUrl;

    const gdeltFeedId = "gdelt-batch";

    for (const evt of events) {
      if (!evt.sourceUrl) continue;

      // Check if source URL already ingested
      const existing = await db
        .select({ id: rawArticlesTable.id })
        .from(rawArticlesTable)
        .where(eq(rawArticlesTable.url, evt.sourceUrl))
        .limit(1);

      if (existing.length > 0) continue;

      const articleId = randomUUID();
      const syntheticTitle = `[${evt.cameoCode}] ${evt.actor1Name} → ${evt.actor2Name}: ${evt.actionLabel}`;
      const syntheticBody = `Location: ${evt.locationName || evt.locationCountryCode}. Date: ${evt.eventDate}. Source: ${evt.sourceUrl}`;

      await db.insert(rawArticlesTable).values({
        id: articleId,
        feedId: gdeltFeedId,
        url: evt.sourceUrl,
        title: syntheticTitle.slice(0, 500),
        body: syntheticBody,
        publishedAt: new Date(evt.eventDate !== "UNKNOWN" ? evt.eventDate : Date.now()),
        credibilityTier: 2,
        isStateMedia: false,
        biasFlag: false,
        embedding: null,
        dedupStatus: "independent",
        corroborationCount: 0,
        requiresCorroboration: false,
      }).onConflictDoNothing();

      // Insert pre-extracted event — bypass GPT-4o
      await insertGdeltEvent(
        articleId,
        evt.cameoCode,
        evt.actionLabel,
        evt.actor1Name,
        evt.actor1CountryCode,
        evt.actor2Name,
        evt.actor2CountryCode,
        evt.locationCountryCode,
        evt.locationName,
        evt.eventDate,
        evt.confidence
      );
    }

    if (events.length > 0) {
      logger.info({ count: events.length }, "gdelt batch processed");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, "gdelt batch processing failed");
  }
}

// ─── Main Scheduler ──────────────────────────────────────────────────────────

let schedulerRunning = false;

export async function startIngestionScheduler(): Promise<void> {
  if (schedulerRunning) return;
  schedulerRunning = true;

  logger.info("ingestion scheduler starting");

  // Bootstrap feed registry
  await ensureFeedRegistry();

  // Build per-feed timers based on fetch_interval_seconds
  const feeds = await db.select().from(feedRegistryTable);

  for (const feed of feeds) {
    if (feed.parser === "gdelt") continue; // handled separately

    const intervalMs = (feed.fetchIntervalSeconds ?? 900) * 1000;

    // Stagger startup: offset each feed by a fraction of its interval
    const staggerMs = Math.random() * Math.min(intervalMs, 60_000);

    setTimeout(() => {
      // Initial run
      processFeed(feed).catch(() => null);
      // Recurring
      setInterval(() => processFeed(feed).catch(() => null), intervalMs);
    }, staggerMs);
  }

  // Guardian API: every 2 minutes (fast-poll, 2,880 req/day, within 5,000/day free tier)
  const processGuardianApi = async () => {
    try {
      const articles = await fetchGuardianApi();
      for (const article of articles) {
        try {
          await processArticle(
            article.feedId,
            article.url,
            article.title,
            article.body,
            article.publishedAt,
            article.credibilityTier,
            article.isStateMedia,
          );
        } catch (err) {
          logger.warn({ url: article.url, err: err instanceof Error ? err.message : err },
            "guardian-api: article processing error");
        }
      }
      if (articles.length > 0) {
        logger.info({ count: articles.length }, "guardian-api: processed");
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, "guardian-api: fetch failed");
    }
  };

  setTimeout(() => {
    processGuardianApi().catch(() => null);
    setInterval(() => processGuardianApi().catch(() => null), 120 * 1000);
  }, 5_000); // 5 sec stagger after startup

  // GDELT: every 5 minutes
  processGdeltBatch().catch(() => null);
  setInterval(() => processGdeltBatch().catch(() => null), 5 * 60 * 1000);

  logger.info({ feeds: feeds.length }, "ingestion scheduler started — all feeds scheduled");
}

// News bias bridge — connects the existing news intelligence pipeline to the
// crypto signal engine's setNewsBias() function.
//
// The existing pipeline already tags articles with asset IDs (including crypto
// assets we added to ASSET_NEWS_DRIVERS in stock-news.ts). This bridge:
//   1. Queries recent crypto-tagged articles (same as getRelevantNewsByAsset)
//   2. Uses GPT-4o to classify sentiment as bullish/bearish/neutral per asset
//   3. Feeds the bias score (-1..1) into the crypto signal engine
//
// Runs every 15 minutes (crypto news cycle is faster than NSE's 4h cycle).

import { db, rawArticlesTable, articleAssetTagsTable } from "@workspace/db";
import { gt, desc, eq, and } from "drizzle-orm";
import { logger } from "../../../lib/logger.js";
import { chatComplete } from "@workspace/integrations-openai-ai-server";
import { setNewsBias } from "../signals/crypto-signal-engine.js";
import { ACTIVE_CRYPTO_ASSETS, BROAD_CRYPTO_DRIVERS } from "../universe.js";

const BIAS_INTERVAL_MS = 15 * 60 * 1000; // 15 min
const LOOKBACK_HOURS = 4; // look back 4 hours of news
const MAX_ARTICLES_PER_ASSET = 20;

let schedulerTimer: NodeJS.Timeout | null = null;
let started = false;

interface ArticleForBias {
  title: string;
  publishedAt: Date;
  drivers: string[];
}

async function fetchCryptoNews(assetId: string): Promise<ArticleForBias[]> {
  const windowStart = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000);

  try {
    const rows = await db
      .select({
        article: rawArticlesTable,
        tag: articleAssetTagsTable,
      })
      .from(rawArticlesTable)
      .innerJoin(
        articleAssetTagsTable,
        eq(rawArticlesTable.id, articleAssetTagsTable.articleId),
      )
      .where(and(
        gt(rawArticlesTable.publishedAt, windowStart),
        eq(articleAssetTagsTable.assetId, assetId),
      ))
      .orderBy(desc(rawArticlesTable.publishedAt))
      .limit(MAX_ARTICLES_PER_ASSET);

    return rows.map((r) => ({
      title: r.article.title,
      publishedAt: r.article.publishedAt,
      drivers: r.tag.matchedDrivers,
    }));
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err, assetId }, "news-bias: article fetch failed");
    return [];
  }
}

async function classifySentiment(
  assetId: string,
  assetName: string,
  articles: ArticleForBias[],
): Promise<number> {
  if (articles.length === 0) return 0;

  const headlines = articles.slice(0, 10).map((a, i) => `${i + 1}. ${a.title}`).join("\n");

  const prompt = `You are a crypto trading sentiment analyst. Analyze the following recent news headlines about ${assetName} (${assetId}) and classify the overall sentiment.

Headlines (last ${LOOKBACK_HOURS}h):
${headlines}

Respond with ONLY a JSON object:
{"bias": <number between -1 and 1>, "confidence": <number between 0 and 1>, "reason": "<one sentence>"}

- bias = -1 (very bearish) to +1 (very bullish)
- bias = 0 means neutral/mixed
- Consider: regulatory news, ETF flows, hacks, upgrades, institutional adoption, macro conditions`;

  try {
    const response = await chatComplete({
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 150,
    });

    const text = response?.choices?.[0]?.message?.content ?? "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return 0;

    const parsed = JSON.parse(jsonMatch[0]);
    const bias = typeof parsed.bias === "number" ? Math.max(-1, Math.min(1, parsed.bias)) : 0;
    const confidence = typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5;

    logger.info({
      assetId,
      bias: bias.toFixed(2),
      confidence: confidence.toFixed(2),
      articles: articles.length,
      reason: parsed.reason ?? "",
    }, "news-bias: classified");

    return bias * confidence; // weight by confidence
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err, assetId }, "news-bias: classification failed");
    return 0;
  }
}

async function updateAllCryptoNewsBias(): Promise<void> {
  for (const asset of ACTIVE_CRYPTO_ASSETS) {
    try {
      const articles = await fetchCryptoNews(asset.assetId);
      if (articles.length === 0) {
        setNewsBias(asset.symbol, 0);
        continue;
      }
      const bias = await classifySentiment(asset.assetId, asset.name, articles);
      setNewsBias(asset.symbol, bias);
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : err, assetId: asset.assetId }, "news-bias: update failed");
    }
  }
  logger.info("news-bias: all crypto assets updated");
}

export function startNewsBiasBridge(): boolean {
  if (started) return true;
  started = true;

  // Run immediately
  updateAllCryptoNewsBias().catch((err) => {
    logger.error({ err: err instanceof Error ? err.message : err }, "news-bias: initial run failed");
  });

  schedulerTimer = setInterval(() => {
    updateAllCryptoNewsBias().catch((err) => {
      logger.error({ err: err instanceof Error ? err.message : err }, "news-bias: scheduled run failed");
    });
  }, BIAS_INTERVAL_MS);

  logger.info({ intervalMs: BIAS_INTERVAL_MS }, "news-bias: bridge started");
  return true;
}

export function stopNewsBiasBridge(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
  started = false;
  logger.info("news-bias: bridge stopped");
}

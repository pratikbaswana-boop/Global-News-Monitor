import { logger } from "../../lib/logger.js";
import { FeedRegistry } from "@workspace/db";

export interface FetchedArticle {
  feedId: string;
  url: string;
  title: string;
  body: string;
  publishedAt: Date;
  credibilityTier: number;
  isStateMedia: boolean;
}

// Minimal RSS/Atom parser that works without external dependencies
function parseRssDate(dateStr: string | undefined): Date {
  if (!dateStr) return new Date();
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? new Date() : d;
}

function extractText(xml: string, tag: string): string {
  const cdataMatch = xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, "i"));
  if (cdataMatch) return cdataMatch[1].trim();
  const tagMatch = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!tagMatch) return "";
  return tagMatch[1].replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

function extractItems(xml: string): string[] {
  const items: string[] = [];
  const itemRegex = /<(?:item|entry)[\s>]([\s\S]*?)<\/(?:item|entry)>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    items.push(match[1]);
  }
  return items;
}

export async function fetchRssFeed(feed: FeedRegistry): Promise<FetchedArticle[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);

  try {
    const res = await fetch(feed.url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; HarnessBot/1.0; +https://harness.ai)",
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
    });
    clearTimeout(timeoutId);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const xml = await res.text();
    const items = extractItems(xml);

    const articles: FetchedArticle[] = [];
    for (const item of items.slice(0, 30)) {
      const title = extractText(item, "title");
      if (!title) continue;

      const link =
        extractText(item, "link") ||
        item.match(/<link[^>]+href="([^"]+)"/i)?.[1] ||
        "";
      if (!link || !link.startsWith("http")) continue;

      const description =
        extractText(item, "description") ||
        extractText(item, "content:encoded") ||
        extractText(item, "summary") ||
        "";

      const pubDate =
        extractText(item, "pubDate") ||
        extractText(item, "published") ||
        extractText(item, "updated") ||
        extractText(item, "dc:date") ||
        "";

      articles.push({
        feedId: feed.id,
        url: link,
        title: title.slice(0, 500),
        body: description.slice(0, 2000),
        publishedAt: parseRssDate(pubDate),
        credibilityTier: feed.credibilityTier,
        isStateMedia: feed.isStateMedia,
      });
    }

    return articles;
  } catch (err) {
    clearTimeout(timeoutId);
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ feedId: feed.id, err: msg }, "rss-fetch failed");
    throw err;
  }
}

// Exponential backoff handler: returns quarantine duration in ms
export function computeBackoffMs(consecutiveFailures: number): number {
  // 1h * 2^(n-1), capped at 24h
  const hours = Math.min(24, Math.pow(2, consecutiveFailures - 1));
  return hours * 60 * 60 * 1000;
}

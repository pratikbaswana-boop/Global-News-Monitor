import { logger } from "../../lib/logger.js";
import type { FetchedArticle } from "./rss-fetcher.js";

const GUARDIAN_API_BASE = "https://content.guardianapis.com/search";
const SECTIONS = ["world", "politics", "business", "us-news"];
const PAGE_SIZE = 20;

export async function fetchGuardianApi(): Promise<FetchedArticle[]> {
  const apiKey = process.env["GUARDIAN_KEY"];
  if (!apiKey) return [];

  const articles: FetchedArticle[] = [];

  for (const section of SECTIONS) {
    try {
      const url = new URL(GUARDIAN_API_BASE);
      url.searchParams.set("section", section);
      url.searchParams.set("order-by", "newest");
      url.searchParams.set("page-size", String(PAGE_SIZE));
      url.searchParams.set("show-fields", "trailText,bodyText");
      url.searchParams.set("api-key", apiKey);

      const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        logger.warn({ section, status: res.status }, "guardian-api: HTTP error");
        continue;
      }

      const data = (await res.json()) as {
        response?: {
          results?: Array<{
            webTitle?: string;
            webUrl?: string;
            webPublicationDate?: string;
            fields?: { bodyText?: string; trailText?: string };
          }>;
        };
      };

      for (const r of data.response?.results ?? []) {
        if (!r.webTitle || !r.webUrl) continue;
        articles.push({
          feedId: "guardian-api",
          url: r.webUrl,
          title: r.webTitle.slice(0, 500),
          body: (r.fields?.bodyText ?? r.fields?.trailText ?? "").slice(0, 5000),
          publishedAt: r.webPublicationDate ? new Date(r.webPublicationDate) : new Date(),
          credibilityTier: 1,
          isStateMedia: false,
        });
      }
    } catch (err) {
      logger.warn({ section, err: err instanceof Error ? err.message : err }, "guardian-api: section fetch failed");
    }
  }

  return articles;
}

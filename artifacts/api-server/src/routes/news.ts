import { Router } from "express";
import {
  GetNewsQueryParams,
  GetNewsResponse,
  GetNewsSummaryResponse,
  GetTrendingTopicsResponse,
} from "@workspace/api-zod";
import { db, rawArticlesTable } from "@workspace/db";
import { count, desc, like, or } from "drizzle-orm";

const router = Router();

// ─── Types ────────────────────────────────────────────────────────────────────

interface RawArticle {
  id: string;
  title: string;
  description: string;
  url: string;
  imageUrl: string | null;
  source: string;
  sourceName: string;
  publishedAt: string;
  category: "politics" | "deals" | "sanctions" | "tensions" | "general";
  countries: string[];
  leaders: string[];
}

// ─── Keywords for classification ─────────────────────────────────────────────

const SANCTIONS_KEYWORDS = [
  "sanction",
  "sanctions",
  "embargo",
  "ban",
  "restriction",
  "blacklist",
  "freeze",
  "penalty",
  "penalties",
];
const TENSIONS_KEYWORDS = [
  "tension",
  "tensions",
  "conflict",
  "clash",
  "dispute",
  "threat",
  "war",
  "military",
  "crisis",
  "standoff",
  "confrontation",
  "escalation",
  "missile",
  "nuclear",
];
const DEALS_KEYWORDS = [
  "deal",
  "agreement",
  "treaty",
  "accord",
  "partnership",
  "trade",
  "signed",
  "contract",
  "pact",
  "alliance",
  "summit",
  "cooperation",
  "bilateral",
];
const POLITICS_KEYWORDS = [
  "president",
  "prime minister",
  "government",
  "election",
  "parliament",
  "minister",
  "diplomat",
  "diplomacy",
  "foreign policy",
  "political",
  "leader",
  "nato",
  "un ",
  "united nations",
  "g7",
  "g20",
];

const WORLD_LEADERS = [
  "Biden",
  "Trump",
  "Putin",
  "Xi Jinping",
  "Macron",
  "Scholz",
  "Sunak",
  "Modi",
  "Erdogan",
  "Zelensky",
  "Kishida",
  "Yoon",
  "Lula",
  "Milei",
  "Meloni",
  "Trudeau",
  "Albanese",
  "Ramaphosa",
  "Sisi",
  "MBS",
  "bin Salman",
  "Netanyahu",
  "Kim Jong",
  "Khamenei",
  "Raisi",
  "Johnson",
  "Starmer",
  "von der Leyen",
  "Guterres",
  "Blinken",
  "Austin",
  "Lavrov",
  "Wang Yi",
  "Jaishankar",
  "Baerbock",
];

const WORLD_COUNTRIES = [
  "United States",
  "USA",
  "China",
  "Russia",
  "Ukraine",
  "Germany",
  "France",
  "UK",
  "Britain",
  "India",
  "Japan",
  "South Korea",
  "North Korea",
  "Iran",
  "Israel",
  "Saudi Arabia",
  "Turkey",
  "Brazil",
  "Australia",
  "Canada",
  "EU",
  "European Union",
  "NATO",
  "Pakistan",
  "Bangladesh",
  "Taiwan",
  "Poland",
  "Hungary",
  "Italy",
  "Spain",
  "Egypt",
  "South Africa",
  "Nigeria",
  "Ethiopia",
  "Mexico",
  "Argentina",
  "Venezuela",
  "Cuba",
  "Afghanistan",
  "Syria",
  "Iraq",
  "Yemen",
  "Libya",
  "Sudan",
  "Myanmar",
  "Vietnam",
  "Philippines",
  "Indonesia",
  "Malaysia",
  "Thailand",
  "Singapore",
  "UAE",
  "Qatar",
  "Kuwait",
  "Jordan",
  "Lebanon",
  "Palestine",
  "Belarus",
  "Georgia",
  "Armenia",
  "Azerbaijan",
  "Kazakhstan",
  "Serbia",
  "Kosovo",
];

function classifyArticle(
  title: string,
  description: string
): "politics" | "deals" | "sanctions" | "tensions" | "general" {
  const text = `${title} ${description}`.toLowerCase();
  if (SANCTIONS_KEYWORDS.some((k) => text.includes(k))) return "sanctions";
  if (TENSIONS_KEYWORDS.some((k) => text.includes(k))) return "tensions";
  if (DEALS_KEYWORDS.some((k) => text.includes(k))) return "deals";
  if (POLITICS_KEYWORDS.some((k) => text.includes(k))) return "politics";
  return "general";
}

function extractCountries(title: string, description: string): string[] {
  const text = `${title} ${description}`;
  return WORLD_COUNTRIES.filter((c) => text.includes(c));
}

function extractLeaders(title: string, description: string): string[] {
  const text = `${title} ${description}`;
  return WORLD_LEADERS.filter((l) => text.includes(l));
}

function generateId(url: string): string {
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    const char = url.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

// ─── API Fetchers ─────────────────────────────────────────────────────────────

const ONE_MONTH_AGO = new Date(
  Date.now() - 30 * 24 * 60 * 60 * 1000
).toISOString();

async function fetchFromNewsAPI(): Promise<RawArticle[]> {
  const apiKey = process.env["NEWSAPI_KEY"];
  if (!apiKey) return [];

  const queries = [
    "world politics leaders sanctions",
    "international deals trade agreements",
    "geopolitical tensions conflict",
    "diplomatic relations foreign policy",
  ];

  const articles: RawArticle[] = [];

  for (const q of queries) {
    try {
      const url = new URL("https://newsapi.org/v2/everything");
      url.searchParams.set("q", q);
      url.searchParams.set("from", ONE_MONTH_AGO.slice(0, 10));
      url.searchParams.set("language", "en");
      url.searchParams.set("sortBy", "publishedAt");
      url.searchParams.set("pageSize", "25");
      url.searchParams.set("apiKey", apiKey);

      const res = await fetch(url.toString());
      if (!res.ok) continue;
      const data = (await res.json()) as {
        articles?: Array<{
          title?: string;
          description?: string;
          url?: string;
          urlToImage?: string;
          source?: { name?: string };
          publishedAt?: string;
        }>;
      };

      for (const a of data.articles ?? []) {
        if (!a.title || !a.url || a.title === "[Removed]") continue;
        const title = a.title ?? "";
        const description = a.description ?? "";
        articles.push({
          id: generateId(a.url),
          title,
          description,
          url: a.url,
          imageUrl: a.urlToImage ?? null,
          source: a.source?.name ?? "NewsAPI",
          sourceName: "NewsAPI",
          publishedAt: a.publishedAt ?? new Date().toISOString(),
          category: classifyArticle(title, description),
          countries: extractCountries(title, description),
          leaders: extractLeaders(title, description),
        });
      }
    } catch {
      // continue on error
    }
  }

  return articles;
}

async function fetchFromGNews(): Promise<RawArticle[]> {
  const apiKey = process.env["GNEWS_KEY"];
  if (!apiKey) return [];

  const queries = [
    "world leaders politics",
    "international sanctions embargo",
    "global trade deals agreements",
    "military tensions conflict crisis",
  ];

  const articles: RawArticle[] = [];

  for (const q of queries) {
    try {
      const url = new URL("https://gnews.io/api/v4/search");
      url.searchParams.set("q", q);
      url.searchParams.set("lang", "en");
      url.searchParams.set("from", ONE_MONTH_AGO);
      url.searchParams.set("max", "10");
      url.searchParams.set("apikey", apiKey);

      const res = await fetch(url.toString());
      if (!res.ok) continue;
      const data = (await res.json()) as {
        articles?: Array<{
          title?: string;
          description?: string;
          url?: string;
          image?: string;
          source?: { name?: string };
          publishedAt?: string;
        }>;
      };

      for (const a of data.articles ?? []) {
        if (!a.title || !a.url) continue;
        const title = a.title ?? "";
        const description = a.description ?? "";
        articles.push({
          id: generateId(a.url),
          title,
          description,
          url: a.url,
          imageUrl: a.image ?? null,
          source: a.source?.name ?? "GNews",
          sourceName: "GNews",
          publishedAt: a.publishedAt ?? new Date().toISOString(),
          category: classifyArticle(title, description),
          countries: extractCountries(title, description),
          leaders: extractLeaders(title, description),
        });
      }
    } catch {
      // continue on error
    }
  }

  return articles;
}

async function fetchFromGuardian(): Promise<RawArticle[]> {
  const apiKey = process.env["GUARDIAN_KEY"];
  if (!apiKey) return [];

  const sections = ["world", "politics", "us-news", "business"];
  const articles: RawArticle[] = [];

  for (const section of sections) {
    try {
      const url = new URL("https://content.guardianapis.com/search");
      url.searchParams.set("section", section);
      url.searchParams.set("from-date", ONE_MONTH_AGO.slice(0, 10));
      url.searchParams.set("order-by", "newest");
      url.searchParams.set("page-size", "20");
      url.searchParams.set("show-fields", "thumbnail,trailText,headline");
      url.searchParams.set("api-key", apiKey);

      const res = await fetch(url.toString());
      if (!res.ok) continue;
      const data = (await res.json()) as {
        response?: {
          results?: Array<{
            webTitle?: string;
            webUrl?: string;
            webPublicationDate?: string;
            fields?: {
              headline?: string;
              trailText?: string;
              thumbnail?: string;
            };
          }>;
        };
      };

      for (const a of data.response?.results ?? []) {
        if (!a.webTitle || !a.webUrl) continue;
        const title = a.fields?.headline ?? a.webTitle ?? "";
        const description = a.fields?.trailText ?? "";
        articles.push({
          id: generateId(a.webUrl),
          title,
          description,
          url: a.webUrl,
          imageUrl: a.fields?.thumbnail ?? null,
          source: "The Guardian",
          sourceName: "Guardian",
          publishedAt: a.webPublicationDate ?? new Date().toISOString(),
          category: classifyArticle(title, description),
          countries: extractCountries(title, description),
          leaders: extractLeaders(title, description),
        });
      }
    } catch {
      // continue on error
    }
  }

  return articles;
}

// ─── Cache ────────────────────────────────────────────────────────────────────

let cachedArticles: RawArticle[] = [];
let lastFetched: Date | null = null;
const FETCH_INTERVAL_HOURS = parseFloat(process.env["NEWS_FETCH_INTERVAL_HOURS"] ?? "6");
const CACHE_TTL_MS = FETCH_INTERVAL_HOURS * 60 * 60 * 1000;

async function fetchArticlesFromDatabase(): Promise<RawArticle[]> {
  try {
    const rows = await db
      .select()
      .from(rawArticlesTable)
      .orderBy(desc(rawArticlesTable.publishedAt))
      .limit(500);

    return rows.map((row) => {
      const title = row.title ?? "";
      const body = row.body ?? "";
      return {
        id: row.id,
        title,
        description: body,
        url: row.url,
        imageUrl: null,
        source: row.feedId,
        sourceName: row.feedId,
        publishedAt: row.publishedAt.toISOString(),
        category: classifyArticle(title, body),
        countries: extractCountries(title, body),
        leaders: extractLeaders(title, body),
      };
    });
  } catch (err) {
    console.error("Failed to fetch articles from database:", err);
    return [];
  }
}

async function getTotalDbArticleCount(): Promise<number> {
  try {
    const result = await db.select({ value: count() }).from(rawArticlesTable);
    return result[0]?.value ?? 0;
  } catch {
    return 0;
  }
}

async function searchArticlesFromDatabase(query: string): Promise<RawArticle[]> {
  try {
    const term = `%${query}%`;
    const rows = await db
      .select()
      .from(rawArticlesTable)
      .where(
        or(
          like(rawArticlesTable.title, term),
          like(rawArticlesTable.body, term)
        )
      )
      .orderBy(desc(rawArticlesTable.publishedAt))
      .limit(200);

    return rows.map((row) => {
      const title = row.title ?? "";
      const body = row.body ?? "";
      return {
        id: row.id,
        title,
        description: body,
        url: row.url,
        imageUrl: null,
        source: row.feedId,
        sourceName: row.feedId,
        publishedAt: row.publishedAt.toISOString(),
        category: classifyArticle(title, body),
        countries: extractCountries(title, body),
        leaders: extractLeaders(title, body),
      };
    });
  } catch (err) {
    console.error("Failed to search articles from database:", err);
    return [];
  }
}

async function getAllArticles(): Promise<{
  articles: RawArticle[];
  counts: Record<string, number>;
}> {
  const now = new Date();
  if (lastFetched && now.getTime() - lastFetched.getTime() < CACHE_TTL_MS) {
    const counts: Record<string, number> = {};
    for (const a of cachedArticles) {
      counts[a.sourceName] = (counts[a.sourceName] ?? 0) + 1;
    }
    return { articles: cachedArticles, counts };
  }

  // Primary: fetch from database (RSS ingestion pipeline)
  const dbArticles = await fetchArticlesFromDatabase();
  if (dbArticles.length > 0) {
    cachedArticles = dbArticles;
    lastFetched = now;
    const counts: Record<string, number> = {};
    for (const a of dbArticles) {
      counts[a.sourceName] = (counts[a.sourceName] ?? 0) + 1;
    }
    return { articles: dbArticles, counts };
  }

  // Fallback: external news APIs
  const [newsapiArticles, gnewsArticles, guardianArticles] = await Promise.all([
    fetchFromNewsAPI(),
    fetchFromGNews(),
    fetchFromGuardian(),
  ]);

  const seenIds = new Set<string>();
  const all: RawArticle[] = [];
  for (const a of [...newsapiArticles, ...gnewsArticles, ...guardianArticles]) {
    if (!seenIds.has(a.id)) {
      seenIds.add(a.id);
      all.push(a);
    }
  }

  all.sort(
    (a, b) =>
      new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
  );

  cachedArticles = all;
  lastFetched = now;

  const counts: Record<string, number> = {};
  for (const a of all) {
    counts[a.sourceName] = (counts[a.sourceName] ?? 0) + 1;
  }
  return { articles: all, counts };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

router.get("/news", async (req, res) => {
  const parseResult = GetNewsQueryParams.safeParse(req.query);
  const params = parseResult.success
    ? parseResult.data
    : { category: "all", page: 1, pageSize: 30, country: undefined, search: undefined, sort: "newest" as const };

  const searchQuery = params.search?.trim();
  const sort = params.sort ?? "newest";

  let articles: RawArticle[];
  let counts: Record<string, number>;

  if (searchQuery) {
    // Search: try cached articles first, fall back to DB search
    const { articles: cached, counts: cachedCounts } = await getAllArticles();
    const lq = searchQuery.toLowerCase();
    const cacheHits = cached.filter(
      (a) =>
        a.title.toLowerCase().includes(lq) ||
        a.description.toLowerCase().includes(lq)
    );

    if (cacheHits.length > 0) {
      articles = cacheHits;
      counts = cachedCounts;
    } else {
      // Fall back to direct DB search
      articles = await searchArticlesFromDatabase(searchQuery);
      counts = {};
      for (const a of articles) {
        counts[a.sourceName] = (counts[a.sourceName] ?? 0) + 1;
      }
    }
  } else {
    const result = await getAllArticles();
    articles = result.articles;
    counts = result.counts;
  }

  let filtered = articles;

  // Filter by category
  if (params.category && params.category !== "all") {
    filtered = filtered.filter((a) => a.category === params.category);
  }

  // Filter by country
  if (params.country) {
    const c = params.country.toLowerCase();
    filtered = filtered.filter((a) =>
      a.countries.some((country) => country.toLowerCase().includes(c))
    );
  }

  // Sort
  if (sort === "oldest") {
    filtered = [...filtered].sort(
      (a, b) => new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime()
    );
  } else {
    filtered = [...filtered].sort(
      (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
    );
  }

  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? 30;
  const start = (page - 1) * pageSize;
  const paginated = filtered.slice(start, start + pageSize);

  const response = GetNewsResponse.parse({
    articles: paginated,
    totalResults: filtered.length,
    page,
    pageSize,
    sources: counts,
  });

  res.json(response);
});

router.get("/news/summary", async (_req, res) => {
  const [{ articles, counts }, totalDbArticles] = await Promise.all([
    getAllArticles(),
    getTotalDbArticleCount(),
  ]);

  const byCategory = {
    politics: articles.filter((a) => a.category === "politics").length,
    deals: articles.filter((a) => a.category === "deals").length,
    sanctions: articles.filter((a) => a.category === "sanctions").length,
    tensions: articles.filter((a) => a.category === "tensions").length,
    general: articles.filter((a) => a.category === "general").length,
  };

  const response = GetNewsSummaryResponse.parse({
    totalArticles: articles.length,
    totalDbArticles,
    byCategory,
    bySource: counts,
    lastUpdated: lastFetched?.toISOString() ?? new Date().toISOString(),
  });

  res.json(response);
});

router.get("/news/trending", async (_req, res) => {
  const { articles } = await getAllArticles();

  // Count countries
  const countryCounts = new Map<string, number>();
  const leaderCounts = new Map<string, number>();

  for (const a of articles) {
    for (const c of a.countries) {
      countryCounts.set(c, (countryCounts.get(c) ?? 0) + 1);
    }
    for (const l of a.leaders) {
      leaderCounts.set(l, (leaderCounts.get(l) ?? 0) + 1);
    }
  }

  const topCountries = [...countryCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count, type: "country" as const }));

  const topLeaders = [...leaderCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count, type: "leader" as const }));

  // Extract topics from category keywords
  const topicCounts = new Map<string, number>();
  const topicKeywords = [
    "sanctions",
    "trade war",
    "nuclear",
    "summit",
    "treaty",
    "tariffs",
    "invasion",
    "ceasefire",
    "embargo",
    "alliance",
  ];
  for (const a of articles) {
    const text = `${a.title} ${a.description}`.toLowerCase();
    for (const topic of topicKeywords) {
      if (text.includes(topic)) {
        topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
      }
    }
  }

  const topTopics = [...topicCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => ({ name, count, type: "topic" as const }));

  const response = GetTrendingTopicsResponse.parse({
    countries: topCountries,
    leaders: topLeaders,
    topics: topTopics,
  });

  res.json(response);
});

export default router;

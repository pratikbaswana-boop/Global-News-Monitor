import type { ChatRequest, ChatResponse, ChatTab, TabContext } from "./types";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function api(path: string): string {
  return `${basePath}/api${path}`;
}

// Keep just the fields the LLM actually needs. Large nested arrays
// (article lists inside clusters, signal article-source dumps inside
// predictions) blow the request body well past 100KB on Intelligence.
function trimItem(item: unknown, allow: string[]): Record<string, unknown> {
  if (!item || typeof item !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const k of allow) {
    const v = (item as Record<string, unknown>)[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

const ARTICLE_KEYS = ["id", "title", "source", "sourceName", "publishedAt", "category", "countries", "leaders", "description"];
const CLUSTER_KEYS = ["id", "title", "countries", "leaders", "keywords", "category", "articleCount", "summary"];
const PREDICTION_KEYS = ["id", "title", "confidence", "direction", "timeframe", "verdict", "status", "createdAt"];
const SIGNAL_KEYS = ["assetId", "asset", "direction", "verdict", "confidence", "impact", "timeframe", "votes", "reason"];

function compactContext(tab: ChatTab, ctx: TabContext): TabContext {
  const out: TabContext = {};
  if (tab === "dashboard" && Array.isArray(ctx.articles)) {
    out.articles = ctx.articles.slice(0, 25).map((a) => trimItem(a, ARTICLE_KEYS));
  }
  if (tab === "trending") out.trending = ctx.trending;
  if (tab === "sources") out.sources = ctx.sources;
  if (tab === "intelligence") {
    if (Array.isArray(ctx.clusters)) out.clusters = ctx.clusters.slice(0, 10).map((c) => trimItem(c, CLUSTER_KEYS));
    if (Array.isArray(ctx.predictions)) out.predictions = ctx.predictions.slice(0, 15).map((p) => trimItem(p, PREDICTION_KEYS));
    if (Array.isArray(ctx.marketSignals)) out.marketSignals = ctx.marketSignals.slice(0, 15).map((s) => trimItem(s, SIGNAL_KEYS));
    if (ctx.trackRecord && typeof ctx.trackRecord === "object") {
      const tr = ctx.trackRecord as Record<string, unknown>;
      out.trackRecord = trimItem(tr, ["stats", "totalPredictions", "correctPredictions", "accuracy", "calibration"]);
    }
  }
  return out;
}

export async function postChat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
  const trimmed: ChatRequest = { ...req, context: compactContext(req.tab, req.context) };
  const res = await fetch(api("/chat"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(trimmed),
    signal,
  });
  if (!res.ok) {
    return { reply: "Chat service is unavailable right now. Please try again in a moment." };
  }
  return (await res.json()) as ChatResponse;
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T | null> {
  try {
    const res = await fetch(api(path), { signal });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function fetchTabContext(tab: ChatTab, signal?: AbortSignal): Promise<TabContext> {
  if (tab === "dashboard") {
    const articles = await getJson<{ articles?: unknown[] } | unknown[]>("/news?limit=30", signal);
    const list = Array.isArray(articles) ? articles : (articles?.articles ?? []);
    return { articles: list };
  }
  if (tab === "trending") {
    const trending = await getJson<unknown>("/news/trending", signal);
    return { trending: trending ?? undefined };
  }
  if (tab === "sources") {
    const sources = await getJson<unknown>("/news/summary", signal);
    return { sources: sources ?? undefined };
  }
  // intelligence
  const [clusters, predictions, marketSignals, trackRecord] = await Promise.all([
    getJson<unknown[] | { clusters?: unknown[] }>("/intelligence/clusters", signal),
    getJson<unknown[] | { predictions?: unknown[] }>("/intelligence/predictions", signal),
    getJson<unknown[] | { signals?: unknown[] }>("/intelligence/market-signals", signal),
    getJson<unknown>("/intelligence/track-record", signal),
  ]);
  const arr = <T,>(v: unknown, key: string): T[] => {
    if (Array.isArray(v)) return v as T[];
    if (v && typeof v === "object" && Array.isArray((v as Record<string, unknown>)[key])) {
      return (v as Record<string, unknown>)[key] as T[];
    }
    return [];
  };
  return {
    clusters: arr(clusters, "clusters"),
    predictions: arr(predictions, "predictions"),
    marketSignals: arr(marketSignals, "signals"),
    trackRecord: trackRecord ?? undefined,
  };
}

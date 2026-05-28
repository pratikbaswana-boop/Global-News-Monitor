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

// Field names match the api-zod schemas in lib/api-zod/src/generated/api.ts.
// Keeping the wrong key name (e.g. "title" on predictions, where the field is
// actually "headline") silently drops the most important data.
const ARTICLE_KEYS = ["id", "title", "source", "sourceName", "publishedAt", "category", "countries", "leaders", "description"];
const CLUSTER_KEYS = ["id", "title", "summary", "category", "countries", "leaders", "articleCount"];
const PREDICTION_KEYS = [
  "id", "clusterId", "clusterTitle",
  "headline", "reasoning", "triggerSummary", "historicalPrecedent",
  "confidence", "riskLevel", "timeframe", "category",
  "countries", "leaders", "potentialOutcomes",
  "resolveAfter", "generatedAt",
];
const SIGNAL_KEYS = [
  "assetId", "assetName", "assetSymbol",
  "predictedDirection", "predictedMagnitude", "predictedConfidence",
  "priceImpactEstimate", "timeframe",
  "bullScore", "bearScore",
  "dominantNarrative", "verdict",
];

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

async function getJson<T>(path: string, signal?: AbortSignal, timeoutMs = 25000): Promise<T | null> {
  // Combine the caller's signal with an internal timeout
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort);
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(api(path), { signal: ctrl.signal });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

const arr = <T,>(v: unknown, key: string): T[] => {
  if (Array.isArray(v)) return v as T[];
  if (v && typeof v === "object" && Array.isArray((v as Record<string, unknown>)[key])) {
    return (v as Record<string, unknown>)[key] as T[];
  }
  return [];
};

// Per-tab cache of the last successful fetch. Some intelligence endpoints
// (predictions, clusters) can be slow under Bedrock throttling and time out
// for the chat module while the page itself already has cached data via
// React Query. If a fresh fetch returns empty, we fall back to the most
// recent non-empty snapshot so the LLM still has the context the user sees.
const lastGoodContext: Partial<Record<ChatTab, TabContext>> = {};

function mergeWithCached(tab: ChatTab, fresh: TabContext): TabContext {
  const cached = lastGoodContext[tab];
  if (!cached) return fresh;
  // For each field, prefer fresh if it has content; else fall back to cached.
  const out: TabContext = { ...fresh };
  for (const key of Object.keys(cached) as (keyof TabContext)[]) {
    const f = fresh[key];
    const c = cached[key];
    const freshEmpty =
      f === undefined ||
      (Array.isArray(f) && f.length === 0);
    if (freshEmpty && c !== undefined) {
      (out as Record<string, unknown>)[key] = c;
    }
  }
  return out;
}

function isContextRich(tab: ChatTab, ctx: TabContext): boolean {
  if (tab === "dashboard") return Array.isArray(ctx.articles) && ctx.articles.length > 0;
  if (tab === "trending") return ctx.trending !== undefined;
  if (tab === "sources") return ctx.sources !== undefined;
  // intelligence: at least one of these should have items
  return (
    (Array.isArray(ctx.clusters) && ctx.clusters.length > 0) ||
    (Array.isArray(ctx.predictions) && ctx.predictions.length > 0) ||
    (Array.isArray(ctx.marketSignals) && ctx.marketSignals.length > 0)
  );
}

export async function fetchTabContext(tab: ChatTab, signal?: AbortSignal): Promise<TabContext> {
  let fresh: TabContext;
  if (tab === "dashboard") {
    const articles = await getJson<{ articles?: unknown[] } | unknown[]>("/news?limit=30", signal);
    const list = Array.isArray(articles) ? articles : (articles?.articles ?? []);
    fresh = { articles: list };
  } else if (tab === "trending") {
    const trending = await getJson<unknown>("/news/trending", signal);
    fresh = { trending: trending ?? undefined };
  } else if (tab === "sources") {
    const sources = await getJson<unknown>("/news/summary", signal);
    fresh = { sources: sources ?? undefined };
  } else {
    const [clusters, predictions, marketSignals, trackRecord] = await Promise.all([
      getJson<unknown[] | { clusters?: unknown[] }>("/intelligence/clusters", signal),
      getJson<unknown[] | { predictions?: unknown[] }>("/intelligence/predictions", signal, 40000),
      getJson<unknown[] | { signals?: unknown[] }>("/intelligence/market-signals", signal),
      getJson<unknown>("/intelligence/track-record", signal),
    ]);
    fresh = {
      clusters: arr(clusters, "clusters"),
      predictions: arr(predictions, "predictions"),
      marketSignals: arr(marketSignals, "signals"),
      trackRecord: trackRecord ?? undefined,
    };
  }

  const merged = mergeWithCached(tab, fresh);
  if (isContextRich(tab, merged)) {
    lastGoodContext[tab] = merged;
  }
  return merged;
}

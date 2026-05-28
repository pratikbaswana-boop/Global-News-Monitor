import type { ChatRequest, ChatResponse, ChatTab, TabContext } from "./types";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function api(path: string): string {
  return `${basePath}/api${path}`;
}

export async function postChat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
  const res = await fetch(api("/chat"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
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

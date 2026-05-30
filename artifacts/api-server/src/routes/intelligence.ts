import { Router } from "express";
import { GetIntelligenceClustersResponse, GetIntelligencePredictionsResponse, GetIntelligenceMarketSignalsResponse, GetIntelligenceTrackRecordResponse } from "@workspace/api-zod";
import { db, marketSnapshotsTable, predictionSnapshotsTable, predictionV2Table, rawArticlesTable } from "@workspace/db";
import { eq, lt, gt, isNull, and, desc } from "drizzle-orm";
import { sendPushToAll } from "./push.js";
import { chatComplete } from "@workspace/integrations-openai-ai-server";
import { logger } from "../lib/logger.js";
import { getActiveStories, isGraphAvailable } from "../services/graph/index.js";
import { isChromaAvailable } from "../services/reasoning/index.js";
import type { SituationReport } from "../services/reasoning/agent-analyst.js";
import type { HistorianReport } from "../services/reasoning/agent-historian.js";
import type { ForecasterTree } from "../services/reasoning/agent-forecaster.js";
import type { Scenario } from "../services/reasoning/agent-forecaster.js";
import { detectRegime, fetchNSEPriceData, runMarketAgent, type MarketSignal } from "../services/market/index.js";
import { getMarketStatus } from "../services/market/scheduler.js";
import { marketRegimesTable } from "@workspace/db";

const router = Router();

// ─── Types (local mirror of schema) ──────────────────────────────────────────

interface RawArticle {
  id: string;
  title: string;
  description: string;
  url: string;
  imageUrl: string | null;
  source: string;
  sourceName: "NewsAPI" | "GNews" | "Guardian";
  publishedAt: string;
  category: "politics" | "deals" | "sanctions" | "tensions" | "general";
  countries: string[];
  leaders: string[];
}

// ─── Cluster templates ────────────────────────────────────────────────────────

interface ClusterTemplate {
  id: string;
  title: string;
  countries: string[];
  leaders: string[];
  keywords: string[];
  category: "politics" | "deals" | "sanctions" | "tensions" | "general";
  causalPatterns: Array<{
    trigger: string[];
    effect: string[];
    relationship: string;
  }>;
}

const CLUSTER_TEMPLATES: ClusterTemplate[] = [
  {
    id: "iran-sanctions",
    title: "Iran Sanctions & Nuclear Tensions",
    countries: ["Iran", "USA", "United States", "Israel", "EU", "European Union"],
    leaders: ["Khamenei", "Raisi", "Netanyahu", "Biden", "Trump"],
    keywords: ["iran", "nuclear", "sanction", "uranium", "iaea", "tehran"],
    category: "sanctions",
    causalPatterns: [
      { trigger: ["nuclear", "uranium"], effect: ["sanction", "embargo"], relationship: "Iran's nuclear programme triggered international sanctions" },
      { trigger: ["sanction", "embargo"], effect: ["oil", "fuel", "price"], relationship: "Sanctions on Iran restricted oil exports causing price rises" },
      { trigger: ["tension", "military"], effect: ["alliance", "nato"], relationship: "Iran tensions prompted Western nations to strengthen alliances" },
    ],
  },
  {
    id: "russia-ukraine",
    title: "Russia-Ukraine War & Western Response",
    countries: ["Russia", "Ukraine", "NATO", "EU", "European Union", "USA", "United States", "Germany", "France", "UK", "Poland"],
    leaders: ["Putin", "Zelensky", "Biden", "Trump", "Macron", "Scholz"],
    keywords: ["russia", "ukraine", "war", "invasion", "kyiv", "moscow", "nato", "zelensky", "putin"],
    category: "tensions",
    causalPatterns: [
      { trigger: ["invasion", "attack", "missile"], effect: ["sanction", "embargo"], relationship: "Russia's military actions prompted sweeping Western sanctions" },
      { trigger: ["sanction", "embargo"], effect: ["energy", "gas", "oil", "price"], relationship: "Sanctions on Russia triggered an energy crisis in Europe" },
      { trigger: ["energy", "gas"], effect: ["inflation", "economic"], relationship: "Energy shortages drove inflation across European economies" },
      { trigger: ["military", "weapons"], effect: ["aid", "support"], relationship: "Ukraine's military needs led Western nations to provide arms support" },
    ],
  },
  {
    id: "us-china-trade",
    title: "US-China Trade War & Tech Rivalry",
    countries: ["China", "USA", "United States", "Taiwan"],
    leaders: ["Xi Jinping", "Biden", "Trump", "Wang Yi"],
    keywords: ["china", "tariff", "trade", "semiconductor", "chip", "taiwan", "huawei", "tiktok"],
    category: "deals",
    causalPatterns: [
      { trigger: ["tariff", "trade war"], effect: ["supply chain", "price", "inflation"], relationship: "US-China tariffs disrupted global supply chains and raised consumer prices" },
      { trigger: ["semiconductor", "chip"], effect: ["ban", "restriction", "sanction"], relationship: "Tech rivalry led to semiconductor export restrictions on China" },
      { trigger: ["taiwan", "military"], effect: ["tension", "conflict"], relationship: "Taiwan tensions escalated US-China military posturing" },
    ],
  },
  {
    id: "israel-gaza",
    title: "Israel-Gaza Conflict & Regional Fallout",
    countries: ["Israel", "Palestine", "USA", "United States", "Iran", "Egypt", "Jordan", "Lebanon"],
    leaders: ["Netanyahu", "Biden", "Khamenei"],
    keywords: ["israel", "gaza", "hamas", "ceasefire", "palestine", "west bank", "idf", "hezbollah"],
    category: "tensions",
    causalPatterns: [
      { trigger: ["attack", "conflict", "hamas"], effect: ["military", "airstrike"], relationship: "Hamas attack triggered Israeli military campaign in Gaza" },
      { trigger: ["military", "civilian"], effect: ["sanction", "criticism", "protest"], relationship: "Civilian casualties drew international criticism and calls for sanctions" },
      { trigger: ["conflict", "war"], effect: ["refugee", "aid", "humanitarian"], relationship: "Conflict created a humanitarian crisis requiring international aid" },
      { trigger: ["hezbollah", "iran"], effect: ["tension", "escalation", "regional"], relationship: "Proxy group involvement risked wider regional escalation" },
    ],
  },
  {
    id: "saudi-deals",
    title: "Saudi Arabia & Gulf Diplomatic Deals",
    countries: ["Saudi Arabia", "UAE", "USA", "United States", "China", "Israel", "Iran"],
    leaders: ["MBS", "bin Salman", "Biden", "Trump", "Xi Jinping"],
    keywords: ["saudi", "opec", "oil", "gulf", "aramco", "riyadh", "mbs", "normalization"],
    category: "deals",
    causalPatterns: [
      { trigger: ["oil", "opec", "cut"], effect: ["price", "energy", "inflation"], relationship: "OPEC oil cuts by Saudi Arabia drove global energy price increases" },
      { trigger: ["normalization", "deal"], effect: ["alliance", "diplomatic"], relationship: "Saudi normalisation efforts reshaped Middle East diplomatic alliances" },
    ],
  },
  {
    id: "india-pakistan",
    title: "India-Pakistan-China Regional Tensions",
    countries: ["India", "Pakistan", "China", "Bangladesh"],
    leaders: ["Modi", "Jaishankar"],
    keywords: ["india", "pakistan", "kashmir", "border", "himalaya", "modi", "brics"],
    category: "tensions",
    causalPatterns: [
      { trigger: ["border", "military", "clash"], effect: ["diplomatic", "tension"], relationship: "Border incidents escalated diplomatic tensions between neighbours" },
      { trigger: ["china", "india", "trade"], effect: ["restriction", "ban"], relationship: "Geopolitical rivalry led to trade and investment restrictions" },
    ],
  },
  {
    id: "nato-expansion",
    title: "NATO Expansion & European Security",
    countries: ["NATO", "USA", "United States", "Germany", "France", "UK", "Poland", "Finland", "Sweden"],
    leaders: ["Biden", "Trump", "Macron", "Scholz", "Sunak", "Starmer"],
    keywords: ["nato", "defense", "military", "alliance", "europe", "security", "troops"],
    category: "politics",
    causalPatterns: [
      { trigger: ["russia", "threat", "invasion"], effect: ["nato", "expansion", "membership"], relationship: "Russian aggression accelerated NATO expansion into Nordic countries" },
      { trigger: ["defense", "spending"], effect: ["economic", "budget"], relationship: "Increased defense commitments strained national budgets" },
    ],
  },
  {
    id: "global-trade-deals",
    title: "Global Trade Agreements & Economic Pacts",
    countries: ["USA", "United States", "EU", "European Union", "UK", "China", "Japan", "India", "Brazil"],
    leaders: ["Biden", "Trump", "von der Leyen", "Starmer", "Modi", "Lula"],
    keywords: ["trade", "agreement", "deal", "bilateral", "wto", "tariff", "export", "import", "free trade"],
    category: "deals",
    causalPatterns: [
      { trigger: ["trade deal", "agreement"], effect: ["economic", "growth", "gdp"], relationship: "New trade agreements opened markets and boosted economic output" },
      { trigger: ["tariff", "protectionism"], effect: ["retaliation", "trade war"], relationship: "Protectionist tariffs prompted retaliatory trade measures" },
    ],
  },
];

// ─── Scoring ──────────────────────────────────────────────────────────────────

function scoreArticleForCluster(article: RawArticle, template: ClusterTemplate): number {
  const text = `${article.title} ${article.description}`.toLowerCase();
  let score = 0;

  for (const kw of template.keywords) {
    if (text.includes(kw)) score += 2;
  }
  for (const country of template.countries) {
    if (article.countries.includes(country)) score += 3;
  }
  for (const leader of template.leaders) {
    if (article.leaders.includes(leader)) score += 3;
  }
  if (article.category === template.category) score += 1;

  return score;
}

// ─── Causal chain builder ─────────────────────────────────────────────────────

interface CausalLink {
  fromArticleId: string;
  toArticleId: string;
  relationship: string;
  strength: number;
}

function buildCausalChain(articles: RawArticle[], template: ClusterTemplate): CausalLink[] {
  const links: CausalLink[] = [];

  // Sort articles by date ascending (oldest first = cause, newest = effect)
  const sorted = [...articles].sort(
    (a, b) => new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime()
  );

  for (let i = 0; i < sorted.length - 1; i++) {
    const older = sorted[i];
    const newer = sorted[i + 1];
    const olderText = `${older.title} ${older.description}`.toLowerCase();
    const newerText = `${newer.title} ${newer.description}`.toLowerCase();

    // Find matching causal pattern
    for (const pattern of template.causalPatterns) {
      const triggerMatch = pattern.trigger.some((t) => olderText.includes(t));
      const effectMatch = pattern.effect.some((e) => newerText.includes(e));

      if (triggerMatch && effectMatch) {
        // Don't duplicate the same pair
        const exists = links.some(
          (l) => l.fromArticleId === older.id && l.toArticleId === newer.id
        );
        if (!exists) {
          links.push({
            fromArticleId: older.id,
            toArticleId: newer.id,
            relationship: pattern.relationship,
            strength: 0.7 + Math.random() * 0.3,
          });
        }
        break;
      }
    }

    // Even without a pattern match, link adjacent articles in the same cluster as weakly connected
    if (links.length === i) {
      // No link found for this pair yet — add weak causal link based on time proximity
      const sharedCountries = older.countries.filter((c) => newer.countries.includes(c));
      if (sharedCountries.length > 0) {
        links.push({
          fromArticleId: older.id,
          toArticleId: newer.id,
          relationship: `Developing story: continued coverage of ${sharedCountries[0]} situation`,
          strength: 0.3 + Math.random() * 0.2,
        });
      }
    }
  }

  return links;
}

// ─── Cluster summary ──────────────────────────────────────────────────────────

function buildClusterSummary(template: ClusterTemplate, articles: RawArticle[]): string {
  const topArticles = [...articles]
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
    .slice(0, 3);
  const recentDevelopments = topArticles.map(a => a.title).join("; ");
  const topCountries = [...new Set(articles.flatMap((a) => a.countries))].slice(0, 3).join(", ");

  return `${articles.length} articles. Recent developments: ${recentDevelopments.slice(0, 220)}${recentDevelopments.length > 220 ? "..." : ""} This cluster tracks how events involving ${topCountries || "global actors"} are escalating or triggering follow-on developments.`;
}

// ─── Relationship graph ───────────────────────────────────────────────────────

function buildRelationshipGraph(articles: RawArticle[]) {
  const nodeMap = new Map<string, { label: string; type: "country" | "leader" | "topic"; articleCount: number }>();
  const edgeMap = new Map<string, { weight: number; categories: Set<string> }>();

  for (const article of articles) {
    for (const country of article.countries) {
      const existing = nodeMap.get(`country:${country}`);
      if (existing) {
        existing.articleCount++;
      } else {
        nodeMap.set(`country:${country}`, { label: country, type: "country", articleCount: 1 });
      }
    }
    for (const leader of article.leaders) {
      const existing = nodeMap.get(`leader:${leader}`);
      if (existing) {
        existing.articleCount++;
      } else {
        nodeMap.set(`leader:${leader}`, { label: leader, type: "leader", articleCount: 1 });
      }
    }

    // Build edges between countries in the same article
    const allEntities = [
      ...article.countries.map((c) => `country:${c}`),
      ...article.leaders.map((l) => `leader:${l}`),
    ];
    for (let i = 0; i < allEntities.length; i++) {
      for (let j = i + 1; j < allEntities.length; j++) {
        const [a, b] = [allEntities[i], allEntities[j]].sort();
        const key = `${a}||${b}`;
        const existing = edgeMap.get(key);
        if (existing) {
          existing.weight++;
          existing.categories.add(article.category);
        } else {
          edgeMap.set(key, { weight: 1, categories: new Set([article.category]) });
        }
      }
    }
  }

  // Filter to top nodes by article count
  const topNodes = [...nodeMap.entries()]
    .sort((a, b) => b[1].articleCount - a[1].articleCount)
    .slice(0, 40)
    .map(([id, data]) => ({ id, ...data }));

  const topNodeIds = new Set(topNodes.map((n) => n.id));

  const edges = [...edgeMap.entries()]
    .filter(([key]) => {
      const [a, b] = key.split("||");
      return topNodeIds.has(a) && topNodeIds.has(b);
    })
    .sort((a, b) => b[1].weight - a[1].weight)
    .slice(0, 80)
    .map(([key, data]) => {
      const [source, target] = key.split("||");
      return {
        source,
        target,
        weight: data.weight,
        categories: [...data.categories],
      };
    });

  return { nodes: topNodes, edges };
}

// ─── Route ────────────────────────────────────────────────────────────────────

// Lazy import to share cached articles from news.ts — we'll use the same endpoint approach
// but import articles from the cached fetch. Since they're in separate modules, we'll
// re-use the same global cache via a shared in-memory store.

// Access cached articles from news route (shared module cache)
let _articlesCache: RawArticle[] = [];

// Throttle push notifications: track last sent direction + timestamp per asset
const _lastNotifiedAsset = new Map<string, { direction: string; sentAt: number }>();

async function fetchArticlesFromDatabase(): Promise<RawArticle[]> {
  try {
    const rows = await db
      .select()
      .from(rawArticlesTable)
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
        sourceName: row.feedId as RawArticle["sourceName"],
        publishedAt: row.publishedAt.toISOString(),
        category: "general" as const,
        countries: [] as string[],
        leaders: [] as string[],
      };
    });
  } catch {
    return [];
  }
}

export function updateIntelligenceCache(articles: RawArticle[]) {
  _articlesCache = articles;
}

router.get("/intelligence/clusters", async (req, res) => {
  // ── Phase 2: Read from Neo4j knowledge graph when available ───────────────
  const graphAvailable = await isGraphAvailable().catch(() => false);

  if (graphAvailable) {
    try {
      const stories = await getActiveStories();
      const recentArticles = await fetchArticlesFromDatabase();
      // Build story-specific summaries by finding the most relevant articles per story
      const clusters = stories.map((story) => {
        // Find articles most relevant to this story's countries
        const storyArticles = recentArticles
          .filter(a => a.countries.some(c => story.countryIsos.includes(c)))
          .slice(0, 10);
        const topTitles = storyArticles.slice(0, 3).map(a => a.title).join("; ");
        const specificSummary = storyArticles.length > 0
          ? `Latest developments: ${topTitles.slice(0, 200)}${topTitles.length > 200 ? "..." : ""}`
          : `${story.eventCount} geopolitical events tracked involving ${story.countryIsos.join(", ") || "global actors"}.`;

        return {
          id: story.id,
          title: story.label,
          summary: `${specificSummary}${
            story.narrativeDriftScore > 0.25
              ? ` Narrative drift: ${story.driftDescription ?? "story dynamics are shifting."}`
              : ""
          }`,
          category: "general" as const,
          countries: story.countryIsos,
          leaders: [] as string[],
          articles: recentArticles.slice(0, 20) as RawArticle[],
          causalChain: [] as { fromArticleId: string; toArticleId: string; relationship: string; strength: number }[],
          articleCount: story.eventCount,
          latestAt: story.latestEventDate
            ? new Date(story.latestEventDate).toISOString()
            : new Date().toISOString(),
          earliestAt: new Date().toISOString(),
        };
      });

      const response = GetIntelligenceClustersResponse.parse({
        clusters,
        nodes: [],
        edges: [],
        generatedAt: new Date().toISOString(),
      });
      return res.json(response);
    } catch {
      // fall through to legacy path on graph error
    }
  }

  // ── Legacy fallback: CLUSTER_TEMPLATES (active until Neo4j is connected) ──
  if (_articlesCache.length === 0) {
    try {
      const baseUrl = `http://localhost:${process.env["PORT"] ?? 8080}`;
      const newsRes = await fetch(`${baseUrl}/api/news?pageSize=200`);
      if (newsRes.ok) {
        const data = (await newsRes.json()) as { articles?: RawArticle[] };
        _articlesCache = data.articles ?? [];
      }
    } catch {
      // proceed with empty cache
    }
  }

  const articles = _articlesCache;

  const clusterArticlesMap = new Map<string, RawArticle[]>();
  const articleClusterScore = new Map<string, Map<string, number>>();

  for (const article of articles) {
    const scores = new Map<string, number>();
    for (const template of CLUSTER_TEMPLATES) {
      const score = scoreArticleForCluster(article, template);
      if (score > 0) scores.set(template.id, score);
    }
    articleClusterScore.set(article.id, scores);
  }

  const THRESHOLD = 4;
  for (const article of articles) {
    const scores = articleClusterScore.get(article.id) ?? new Map();
    let bestCluster: string | null = null;
    let bestScore = THRESHOLD - 1;
    for (const [clusterId, score] of scores.entries()) {
      if (score > bestScore) {
        bestScore = score;
        bestCluster = clusterId;
      }
    }
    if (bestCluster) {
      const existing = clusterArticlesMap.get(bestCluster) ?? [];
      existing.push(article);
      clusterArticlesMap.set(bestCluster, existing);
    }
  }

  const clusters = CLUSTER_TEMPLATES.map((template) => {
    const clusterArticles = clusterArticlesMap.get(template.id) ?? [];
    if (clusterArticles.length === 0) return null;

    const sorted = [...clusterArticles].sort(
      (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
    );
    const dates = clusterArticles.map((a) => new Date(a.publishedAt).getTime());
    const latestAt = new Date(Math.max(...dates)).toISOString();
    const earliestAt = new Date(Math.min(...dates)).toISOString();
    const allCountries = [...new Set(clusterArticles.flatMap((a) => a.countries))];
    const allLeaders = [...new Set(clusterArticles.flatMap((a) => a.leaders))];
    const causalChain = buildCausalChain(sorted, template);

    return {
      id: template.id,
      title: template.title,
      summary: buildClusterSummary(template, clusterArticles),
      category: template.category,
      countries: allCountries,
      leaders: allLeaders,
      articles: sorted.slice(0, 20),
      causalChain,
      articleCount: clusterArticles.length,
      latestAt,
      earliestAt,
    };
  }).filter(Boolean);

  const { nodes, edges } = buildRelationshipGraph(articles);

  const response = GetIntelligenceClustersResponse.parse({
    clusters,
    nodes,
    edges,
    generatedAt: new Date().toISOString(),
  });

  return res.json(response);
});

// ─── Prediction Engine ────────────────────────────────────────────────────────

interface PredictionTemplate {
  id: string;
  clusterId: string;
  clusterTitle: string;
  triggerKeywords: string[];
  antiTrigger?: string[]; // if these are present, prediction already occurred — skip
  headline: string;
  reasoning: string;
  triggerSummary: string;
  historicalPrecedent: string;
  potentialOutcomes: string[];
  confidence: "high" | "medium" | "low";
  riskLevel: "critical" | "high" | "medium" | "low";
  timeframe: "1-2 weeks" | "1 month" | "3 months" | "6+ months";
  category: "politics" | "deals" | "sanctions" | "tensions" | "general";
  countries: string[];
  leaders: string[];
}

const PREDICTION_TEMPLATES: PredictionTemplate[] = [
  // ── Iran ──
  {
    id: "iran-nuclear-escalation",
    clusterId: "iran-sanctions",
    clusterTitle: "Iran Sanctions & Nuclear Tensions",
    triggerKeywords: ["nuclear", "uranium", "enrichment", "iaea"],
    antiTrigger: ["ceasefire", "agreement", "deal", "jcpoa"],
    headline: "Iran likely to accelerate uranium enrichment beyond IAEA limits",
    reasoning: "When Iran faces tightening international sanctions without diplomatic off-ramps, it historically responds by escalating its nuclear programme as leverage. Current signals show continued enrichment activity and IAEA access limitations — a pattern that preceded the 2019-2022 enrichment spikes.",
    triggerSummary: "Multiple recent articles report ongoing IAEA inspections, enrichment above 60%, and Iranian officials rejecting diplomatic overtures. This mirrors the pre-2019 escalation pattern.",
    historicalPrecedent: "In 2019, following US withdrawal from the JCPOA, Iran progressively breached enrichment caps — first to 4.5%, then 20%, then 60% — within 18 months, using escalation as negotiating pressure.",
    potentialOutcomes: [
      "Iran raises enrichment to 90% weapons-grade, triggering emergency UN Security Council session",
      "Western nations impose secondary sanctions on Iranian oil customers (China, India)",
      "Covert sabotage operations against Iranian nuclear facilities escalate (Natanz pattern repeats)"
    ],
    confidence: "high",
    riskLevel: "critical",
    timeframe: "1 month",
    category: "tensions",
    countries: ["Iran", "USA", "Israel", "EU", "European Union"],
    leaders: ["Khamenei", "Netanyahu", "Biden", "Trump"],
  },
  {
    id: "iran-oil-price",
    clusterId: "iran-sanctions",
    clusterTitle: "Iran Sanctions & Nuclear Tensions",
    triggerKeywords: ["sanction", "embargo", "oil", "export"],
    headline: "Expanded Iran sanctions to drive oil price increase of 8-15%",
    reasoning: "Each round of Iran sanctions enforcement coincides with a contraction in global oil supply. Iran currently exports ~1.5 million bpd; tighter enforcement would remove a meaningful portion of global supply during a period of already-strained OPEC+ production.",
    triggerSummary: "Recent sanctions reporting shows new designations targeting Iranian shipping and financial networks, which historically precede enforcement crackdowns on oil customers.",
    historicalPrecedent: "When the Trump administration reimposed maximum pressure sanctions in November 2018, Brent crude rose from $72 to $86 per barrel within 6 weeks before waiver announcements tempered the spike.",
    potentialOutcomes: [
      "Global oil prices rise 10-15% over 4-6 weeks, feeding into inflation in import-dependent economies",
      "China and India continue purchasing Iranian oil via shadow fleet, partially offsetting supply impact",
      "Saudi Arabia and UAE increase production to fill the gap and maintain influence with Western buyers"
    ],
    confidence: "medium",
    riskLevel: "high",
    timeframe: "1 month",
    category: "sanctions",
    countries: ["Iran", "USA", "Saudi Arabia", "China", "India"],
    leaders: ["Khamenei", "MBS", "Biden", "Trump"],
  },

  // ── Russia-Ukraine ──
  {
    id: "ukraine-winter-offensive",
    clusterId: "russia-ukraine",
    clusterTitle: "Russia-Ukraine War & Western Response",
    triggerKeywords: ["ukraine", "military", "aid", "weapons", "offensive"],
    antiTrigger: ["ceasefire", "peace talks", "negotiations"],
    headline: "Ukrainian forces likely to launch new counter-offensive push as Western arms deliveries accelerate",
    reasoning: "The pattern of Western arms delivery announcements (ATACMS, F-16s, long-range artillery) is consistently followed 4-8 weeks later by Ukrainian offensive operations. Multiple recent signals indicate new delivery cycles are underway.",
    triggerSummary: "Recent articles report US, UK and European governments approving new weapons packages. Ukrainian military briefings reference operational preparations. This is the same signal cluster that preceded the Kharkiv and Kherson offensives.",
    historicalPrecedent: "In August 2022, the US announced HIMARS deliveries. Six weeks later, Ukraine launched the Kharkiv counter-offensive, recapturing 8,000 km² in two weeks — the fastest territorial gain of the war.",
    potentialOutcomes: [
      "Ukraine launches focused offensive in Zaporizhzhia or Kursk region using newly delivered long-range systems",
      "Russia responds with intensified aerial bombardment of Ukrainian energy infrastructure",
      "NATO member nations place troops on higher readiness alert along eastern flank"
    ],
    confidence: "medium",
    riskLevel: "high",
    timeframe: "1-2 weeks",
    category: "tensions",
    countries: ["Ukraine", "Russia", "USA", "United States", "NATO", "Germany", "UK"],
    leaders: ["Zelensky", "Putin", "Biden", "Trump", "Macron", "Scholz"],
  },
  {
    id: "russia-energy-retaliation",
    clusterId: "russia-ukraine",
    clusterTitle: "Russia-Ukraine War & Western Response",
    triggerKeywords: ["sanction", "energy", "gas", "pipeline", "russia"],
    headline: "Russia to weaponise remaining energy leverage against European winter preparedness",
    reasoning: "Russia has consistently used energy as a geopolitical tool when facing tightened Western sanctions. With European gas storage filling ahead of winter, Russia's window to maximise disruption leverage is narrowing — creating urgency to act.",
    triggerSummary: "Sanctions escalation signals and LNG pricing reports suggest Russia is preparing another energy leverage move. European gas storage articles show 80%+ capacity, but analysts note Russia may target specific pipeline corridors.",
    historicalPrecedent: "In June 2022, Russia reduced Nord Stream 1 flows to 40% capacity citing 'turbine maintenance', then to 20%, contributing to European gas prices reaching 10x pre-war levels by August.",
    potentialOutcomes: [
      "Russia suspends remaining gas transit through Ukraine after treaty expiry, affecting Balkan and Slovak supplies",
      "European energy prices spike 20-40% heading into winter, straining household and industrial budgets",
      "EU fast-tracks LNG import infrastructure investment and accelerates renewable energy targets"
    ],
    confidence: "medium",
    riskLevel: "high",
    timeframe: "1 month",
    category: "sanctions",
    countries: ["Russia", "EU", "European Union", "Germany", "Ukraine"],
    leaders: ["Putin", "von der Leyen", "Scholz"],
  },

  // ── US-China ──
  {
    id: "us-china-chip-escalation",
    clusterId: "us-china-trade",
    clusterTitle: "US-China Trade War & Tech Rivalry",
    triggerKeywords: ["semiconductor", "chip", "export", "restriction", "ban", "nvidia", "huawei"],
    headline: "US to expand semiconductor export controls to close enforcement gaps, China to retaliate with rare earth restrictions",
    reasoning: "The US-China chip war follows a clear escalation-retaliation cycle. After each US export control expansion, China has responded with targeted restrictions on critical materials it controls — rare earths, gallium, germanium. Both sides are currently in an active escalation phase.",
    triggerSummary: "Recent articles document new US chip export control regulations under discussion, Chinese Huawei's advanced chip production breakthrough, and rising trade tension rhetoric from both capitals.",
    historicalPrecedent: "In October 2022, the US imposed sweeping chip export controls. China responded in July 2023 with gallium and germanium export restrictions. In October 2023, the US tightened controls again — confirming a 9-12 month escalation cycle.",
    potentialOutcomes: [
      "China restricts rare earth exports (gallium, germanium, graphite) used in Western defense and EV industries",
      "US allies (Netherlands, Japan, South Korea) face pressure to align export controls more tightly with Washington",
      "Taiwan Strait military activity increases as tensions over semiconductor supply chains intensify"
    ],
    confidence: "high",
    riskLevel: "high",
    timeframe: "1 month",
    category: "sanctions",
    countries: ["USA", "United States", "China", "Taiwan", "Japan", "South Korea"],
    leaders: ["Xi Jinping", "Biden", "Trump", "Wang Yi"],
  },
  {
    id: "us-china-tariff-response",
    clusterId: "us-china-trade",
    clusterTitle: "US-China Trade War & Tech Rivalry",
    triggerKeywords: ["tariff", "trade", "import", "duty", "ev", "electric"],
    headline: "China to announce retaliatory tariffs on US agricultural and automotive exports",
    reasoning: "US tariff increases on Chinese goods — particularly EVs and solar panels — follow the established pattern that triggers Beijing's counter-tariff playbook targeting US farmers and manufacturers in politically sensitive states.",
    triggerSummary: "Recent signals show US tariff announcements on Chinese EVs and solar equipment, with Chinese foreign ministry statements warning of 'countermeasures'. Agricultural export volumes to China have also dropped in recent trade data reports.",
    historicalPrecedent: "In 2018-2019, US tariffs on $250B of Chinese goods triggered retaliatory tariffs on US soybeans, pork, and aircraft — directly targeting Trump's political base in Iowa, Ohio, and Michigan.",
    potentialOutcomes: [
      "China imposes 25-50% tariffs on US soybeans, pork, and LNG, hurting American farm states",
      "US tech companies with large China operations face increased regulatory scrutiny and app store restrictions",
      "WTO dispute filings surge as both sides attempt to frame unilateral actions within multilateral rules"
    ],
    confidence: "high",
    riskLevel: "medium",
    timeframe: "1-2 weeks",
    category: "deals",
    countries: ["China", "USA", "United States", "EU", "European Union"],
    leaders: ["Xi Jinping", "Biden", "Trump", "Wang Yi"],
  },

  // ── Israel-Gaza ──
  {
    id: "israel-regional-escalation",
    clusterId: "israel-gaza",
    clusterTitle: "Israel-Gaza Conflict & Regional Fallout",
    triggerKeywords: ["hezbollah", "iran", "missile", "attack", "escalation", "northern"],
    headline: "Israel-Hezbollah exchange of fire risks triggering full Lebanon front opening",
    reasoning: "The current rate of cross-border exchanges between Israel and Hezbollah exceeds the threshold seen before the 2006 Lebanon War. Iran's direct involvement creates a tripwire scenario where any miscalculation could produce uncontrolled escalation.",
    triggerSummary: "Multiple recent articles report Israeli airstrikes in southern Lebanon, Hezbollah anti-tank missile strikes in northern Israel, and US carrier groups repositioning to the Eastern Mediterranean as a deterrence signal.",
    historicalPrecedent: "The 2006 Lebanon War began after Hezbollah cross-border raids and hostage-taking triggered Israeli ground operations. The 33-day conflict killed 1,200 Lebanese civilians and displaced 1 million people before UN Resolution 1701 imposed a ceasefire.",
    potentialOutcomes: [
      "Israel launches large-scale ground operation in southern Lebanon targeting Hezbollah infrastructure",
      "Iran activates additional proxy fronts (Yemen Houthis, Iraq PMF) to stretch Israeli and US military attention",
      "US deploys additional air defense systems to Israel and increases diplomatic pressure for de-escalation"
    ],
    confidence: "medium",
    riskLevel: "critical",
    timeframe: "1-2 weeks",
    category: "tensions",
    countries: ["Israel", "Lebanon", "Iran", "USA", "United States"],
    leaders: ["Netanyahu", "Khamenei", "Biden", "Trump"],
  },

  // ── Saudi / Gulf ──
  {
    id: "opec-production-cut",
    clusterId: "saudi-deals",
    clusterTitle: "Saudi Arabia & Gulf Diplomatic Deals",
    triggerKeywords: ["opec", "oil", "production", "saudi", "cut", "barrel"],
    headline: "OPEC+ likely to extend or deepen production cuts to defend $80/bbl price floor",
    reasoning: "Saudi Arabia's fiscal break-even oil price is approximately $80/bbl. When Brent dips toward this level, Riyadh has consistently pushed for OPEC+ supply cuts. Current market signals show softening demand from China and rising US shale output — creating the same conditions that triggered the October 2023 voluntary cuts.",
    triggerSummary: "Recent articles show Brent crude trading near Saudi Arabia's fiscal break-even, Chinese industrial demand data disappointing, and Saudi Aramco revising its capital expenditure plans — classic precursors to an OPEC+ intervention.",
    historicalPrecedent: "In October 2023, despite US pressure, Saudi Arabia and Russia announced 1 million bpd cuts that pushed oil prices from $84 to $96 before global recession fears reversed the gain.",
    potentialOutcomes: [
      "OPEC+ extends 2.2 million bpd voluntary cuts through Q2, supporting prices at $80-90/bbl",
      "US responds with increased pressure on Gulf states and considers releasing Strategic Petroleum Reserve",
      "Higher energy prices feed into core inflation, complicating central bank rate-cut timelines in Europe and the US"
    ],
    confidence: "high",
    riskLevel: "medium",
    timeframe: "1 month",
    category: "deals",
    countries: ["Saudi Arabia", "UAE", "Russia", "USA", "United States", "China"],
    leaders: ["MBS", "bin Salman", "Putin", "Biden", "Trump"],
  },

  // ── NATO / Europe ──
  {
    id: "nato-defense-spending",
    clusterId: "nato-expansion",
    clusterTitle: "NATO Expansion & European Security",
    triggerKeywords: ["nato", "defense", "spending", "gdp", "military", "europe"],
    headline: "NATO members to announce accelerated defense spending commitments above 2% GDP threshold",
    reasoning: "The combination of ongoing Russia-Ukraine conflict and US political pressure (particularly under Trump-era 'burden sharing' demands) has created strong incentives for European NATO members to announce credible defense spending increases before the next NATO summit.",
    triggerSummary: "Recent articles show NATO Secretary-General statements on burden sharing, multiple European nations announcing defense budget increases, and US political figures questioning alliance commitments. This pattern reliably precedes formal spending pledges.",
    historicalPrecedent: "Following Russia's 2022 invasion, NATO members collectively announced $350B in additional defense spending pledges at the Madrid Summit. Germany's 'Zeitenwende' moment saw it commit to a €100B special defense fund within days.",
    potentialOutcomes: [
      "6-8 NATO members announce plans to reach 2.5% GDP defense spending, with Poland targeting 4%",
      "European defense industry stocks (Rheinmetall, BAE, Thales) see significant valuation increases",
      "US reduces push for NATO burden-sharing reform given allied commitments, refocusing on Indo-Pacific"
    ],
    confidence: "medium",
    riskLevel: "medium",
    timeframe: "3 months",
    category: "politics",
    countries: ["NATO", "Germany", "France", "UK", "Poland", "USA", "United States"],
    leaders: ["Biden", "Trump", "Macron", "Scholz", "Starmer"],
  },
];

function scorePrediction(
  template: PredictionTemplate,
  clusterArticles: RawArticle[]
): { score: number; triggerArticles: RawArticle[] } {
  // Only look at articles from last 21 days as "current signals"
  const cutoff = Date.now() - 21 * 24 * 60 * 60 * 1000;
  const recent = clusterArticles.filter(
    (a) => new Date(a.publishedAt).getTime() > cutoff
  );

  if (recent.length === 0) return { score: 0, triggerArticles: [] };

  const triggerArticles: RawArticle[] = [];

  // Check anti-trigger (prediction already materialised — less interesting)
  const allText = recent.map((a) => `${a.title} ${a.description}`.toLowerCase()).join(" ");
  if (template.antiTrigger?.some((kw) => allText.includes(kw))) {
    return { score: 0, triggerArticles: [] };
  }

  let score = 0;
  for (const article of recent) {
    const text = `${article.title} ${article.description}`.toLowerCase();
    const matches = template.triggerKeywords.filter((kw) => text.includes(kw));
    if (matches.length >= 1) {
      score += matches.length;
      triggerArticles.push(article);
    }
  }

  return { score, triggerArticles };
}

// ── Phase 3 helpers ─────────────────────────────────────────────────────────

function daysToTimeframe(days: number): "1-2 weeks" | "1 month" | "3 months" | "6+ months" {
  if (days <= 14) return "1-2 weeks";
  if (days <= 30) return "1 month";
  if (days <= 90) return "3 months";
  return "6+ months";
}

function confidenceFromScore(score: number): "high" | "medium" | "low" {
  if (score >= 0.7) return "high";
  if (score >= 0.45) return "medium";
  return "low";
}

function riskFromTensions(report: SituationReport): "critical" | "high" | "medium" | "low" {
  const intensityOrder = ["critical", "high", "medium", "low"] as const;
  for (const level of intensityOrder) {
    if (report.tensionIndicators.some(t => t.intensity === level)) return level;
  }
  return "low";
}

function channelToCategory(channel: string): "politics" | "deals" | "sanctions" | "tensions" | "general" {
  if (channel.startsWith("crude_oil") || channel === "middle_east_conflict") return "tensions";
  if (channel === "china_trade_escalation" || channel === "russia_sanctions_tighten") return "sanctions";
  if (channel === "fii_risk_off" || channel.startsWith("usd_inr") || channel === "fed_hawkish_signal" || channel === "rbi_surprise_action" || channel === "global_risk_off") return "politics";
  return "general";
}

function adaptPredictionV2(row: typeof predictionV2Table.$inferSelect) {
  try {
    const analyst = JSON.parse(row.analystReport) as SituationReport;
    const historian = JSON.parse(row.historianPrecedents) as HistorianReport;
    const forecaster = JSON.parse(row.forecasterTree) as ForecasterTree;
    const finalScenarios = JSON.parse(row.finalScenarios) as Scenario[];

    const dominant = finalScenarios[forecaster.dominantScenario] ?? finalScenarios[0];
    if (!dominant) return null;

    // Build explicit headline: prepend key actors so it always shows WHO is involved
    const keyActors = analyst.primaryActors.slice(0, 3).map(a => a.actorLabel).join("-");
    const probPct = Math.round(dominant.probability * 100);
    const actorPrefix = keyActors ? `${keyActors}: ` : "";
    const headline = `${actorPrefix}${dominant.label} (${probPct}% probability, ${dominant.timeframeDays}d horizon)`;

    // Build rich, story-specific reasoning by weaving together all agent outputs
    const actorDetails = analyst.primaryActors
      .map(a => `${a.actorLabel}: ${a.perceivedGoal} (leverage: ${a.leverage.slice(0, 2).join(", ")}; constraints: ${a.constraints.slice(0, 2).join(", ")})`)
      .join("; ");

    const tensionDetails = analyst.tensionIndicators
      .map(t => `${t.type.replace(/_/g, " ")} — ${t.intensity}: ${t.evidence.slice(0, 2).join("; ")}`)
      .join("; ");

    const keyUncertainties = analyst.keyUncertainties.join("; ");

    const reasoningParts = [
      `SITUATION: ${analyst.powerConfiguration.replace(/_/g, " ")}.`,
      `KEY ACTORS: ${actorDetails}.`,
      `ACTIVE TENSIONS: ${tensionDetails}.`,
      `CRITICAL UNCERTAINTIES: ${keyUncertainties}.`,
      ``,
      `PREDICTION REASONING: ${dominant.narrative}`,
      ``,
      `CONFIRMATION INDICATORS: ${dominant.keyIndicators.join("; ")}.`,
      ``,
      `FALSIFICATION CONDITIONS: ${dominant.falsificationConditions.join("; ")}.`,
      ``,
      `HISTORICAL PATTERN: ${historian.historicalPattern}`,
      `KEY DIFFERENTIATORS FROM PAST CASES: ${historian.keyDifferentiators.join("; ")}.`,
    ];

    const reasoning = reasoningParts.join("\n").slice(0, 3000);

    const precedent = historian.analogues[0]
      ? `${historian.historicalPattern} Most relevant analogue: ${historian.analogues[0].document.slice(0, 300)}`
      : historian.historicalPattern;

    const clusterTitle = (analyst as { storyLabel?: string }).storyLabel ?? `Story: ${row.storyId.slice(0, 8)}`;

    return {
      id: row.id,
      clusterId: row.storyId,
      clusterTitle,
      headline,
      reasoning,
      confidence: confidenceFromScore(forecaster.modelConfidence),
      riskLevel: riskFromTensions(analyst),
      timeframe: daysToTimeframe(dominant.timeframeDays),
      category: channelToCategory(row.dominantChannel ?? ""),
      countries: analyst.primaryActors.map(a => a.actorLabel),
      leaders: [] as string[],
      triggerArticleIds: [] as string[],
      triggerSummary: `Power configuration: ${analyst.powerConfiguration.replace(/_/g, " ")}. Market exposure: ${analyst.indianMarketExposure.severity} via ${analyst.indianMarketExposure.channels.join(", ")}.`,
      historicalPrecedent: precedent.slice(0, 800),
      potentialOutcomes: finalScenarios.map(s => `${s.label} (${Math.round(s.probability * 100)}%)`),
      generatedAt: new Date(row.generatedAt).toISOString(),
      resolveAfter: new Date(row.resolveAfter).toISOString(),
      snapshotId: row.id,
      templateAccuracy: null as number | null,
    };
  } catch {
    return null;
  }
}

router.get("/intelligence/predictions", async (req, res) => {
  // ── Phase 3: Serve from prediction_v2 when reasoning pipeline is active ────
  const [graphOk, chromaOk] = await Promise.all([
    isGraphAvailable().catch(() => false),
    isChromaAvailable().catch(() => false),
  ]);

  if (graphOk && chromaOk) {
    try {
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // last 7d
      const rows = await db
        .select()
        .from(predictionV2Table)
        .where(and(
          eq(predictionV2Table.resolutionStatus, "pending"),
          gt(predictionV2Table.generatedAt, cutoff),
        ))
        .orderBy(desc(predictionV2Table.generatedAt))
        .limit(25);

      if (rows.length > 0) {
        const predictions = rows.map(adaptPredictionV2).filter(Boolean);
        if (predictions.length > 0) {
          const response = GetIntelligencePredictionsResponse.parse({
            predictions,
            totalSignals: predictions.length,
            generatedAt: new Date().toISOString(),
          });
          return res.json(response);
        }
      }
    } catch {
      // fall through to legacy path on error
    }
  }

  // ── Legacy fallback: PREDICTION_TEMPLATES (active until reasoning pipeline has data) ──

  // Fetch articles via internal call if cache empty
  if (_articlesCache.length === 0) {
    try {
      const baseUrl = `http://localhost:${process.env["PORT"] ?? 8080}`;
      const newsRes = await fetch(`${baseUrl}/api/news?pageSize=200`);
      if (newsRes.ok) {
        const data = (await newsRes.json()) as { articles?: RawArticle[] };
        _articlesCache = data.articles ?? [];
      }
    } catch {
      // proceed with empty
    }
  }

  const articles = _articlesCache;

  // Build cluster article map (same logic as clusters route)
  const clusterArticlesMap = new Map<string, RawArticle[]>();
  for (const article of articles) {
    let bestCluster: string | null = null;
    let bestScore = 3; // threshold
    for (const template of CLUSTER_TEMPLATES) {
      const score = scoreArticleForCluster(article, template);
      if (score > bestScore) { bestScore = score; bestCluster = template.id; }
    }
    if (bestCluster) {
      const existing = clusterArticlesMap.get(bestCluster) ?? [];
      existing.push(article);
      clusterArticlesMap.set(bestCluster, existing);
    }
  }

  // Fire-and-forget: expire old pending predictions past their deadline
  void resolvePendingPredictionSnapshots();

  // Score each prediction template
  const scored = PREDICTION_TEMPLATES
    .map((template) => {
      const clusterArticles = clusterArticlesMap.get(template.clusterId) ?? [];
      const { score, triggerArticles } = scorePrediction(template, clusterArticles);
      if (score === 0) return null;
      return { template, score, triggerArticles };
    })
    .filter(Boolean) as Array<{ template: PredictionTemplate; score: number; triggerArticles: RawArticle[] }>;

  // Fetch historical accuracy for all active templates in one DB query
  const accuracyMap = await getTemplateAccuracyAll(scored.map((s) => s.template.id));

  // Persist each active prediction (throttled per-template per 24 h) and collect snapshot IDs
  const snapshotIds = new Map<string, string | null>();
  await Promise.all(scored.map(async ({ template, score, triggerArticles }) => {
    const id = await savePredictionSnapshot(
      template.id,
      template.clusterId,
      template.headline,
      template.reasoning,
      template.historicalPrecedent,
      template.triggerSummary,
      template.potentialOutcomes,
      template.confidence,
      template.riskLevel,
      template.timeframe,
      template.category,
      template.countries,
      template.leaders,
      score,
      triggerArticles.slice(0, 5).map((a) => a.id)
    );
    snapshotIds.set(template.id, id);
  }));

  const now = new Date();
  const predictions = scored.map(({ template, triggerArticles }) => ({
    id: template.id,
    clusterId: template.clusterId,
    clusterTitle: template.clusterTitle,
    headline: template.headline,
    reasoning: template.reasoning,
    confidence: template.confidence,
    riskLevel: template.riskLevel,
    timeframe: template.timeframe,
    category: template.category,
    countries: template.countries,
    leaders: template.leaders,
    triggerArticleIds: triggerArticles.slice(0, 5).map((a) => a.id),
    triggerSummary: template.triggerSummary,
    historicalPrecedent: template.historicalPrecedent,
    potentialOutcomes: template.potentialOutcomes,
    generatedAt: now.toISOString(),
    resolveAfter: new Date(now.getTime() + predictionTimeframeToMs(template.timeframe)).toISOString(),
    snapshotId: snapshotIds.get(template.id) ?? null,
    templateAccuracy: accuracyMap.get(template.id) ?? null,
  }));

  const response = GetIntelligencePredictionsResponse.parse({
    predictions,
    totalSignals: articles.length,
    generatedAt: now.toISOString(),
  });

  return res.json(response);
});

// ─── Market Signal Engine ─────────────────────────────────────────────────────

type SignalWeight = "strong" | "moderate" | "weak";
type AssetDirection = "up" | "down" | "neutral";
type AssetMagnitude = "strong" | "moderate" | "mild";

interface MarketSignalTemplate {
  id: string;
  title: string;
  reasoning: string;
  weight: SignalWeight;
  keywords: string[]; // ANY of these in article title/desc triggers this signal
  geopoliticalEvent: string;
}

interface AssetTemplate {
  id: string;
  name: string;
  symbol: string;
  bullSignals: MarketSignalTemplate[];
  bearSignals: MarketSignalTemplate[];
}

const ASSET_TEMPLATES: AssetTemplate[] = [
  // ── NIFTY 50 ─────────────────────────────────────────────────────────────────
  {
    id: "nifty50",
    name: "NIFTY 50 (NSE India)",
    symbol: "NIFTY",
    bullSignals: [
      {
        id: "nifty-bull-fii-inflow",
        title: "Global risk-on drives FII inflows into Indian equities",
        reasoning: "Foreign Institutional Investors (FIIs) are the primary price-setter in Indian equity markets. Global risk-on events — diplomatic breakthroughs, Fed rate cuts, or trade deals — drive FII capital into India as a high-growth emerging market. Every ₹1,000 crore in FII net buying historically adds 0.3-0.6% to NIFTY 50 intraday.",
        weight: "strong",
        keywords: ["trade deal", "ceasefire", "peace", "agreement", "rate cut", "fed pivot", "dovish", "global growth", "economic recovery", "de-escalation"],
        geopoliticalEvent: "Global risk-on environment driving FII inflows to India",
      },
      {
        id: "nifty-bull-india-macro",
        title: "India's structural growth story attracts global capital",
        reasoning: "India's GDP growth (~7% projected) with demographic tailwinds makes it the fastest-growing major economy. International investors increasingly overweight India as a China alternative, with sovereign wealth funds expanding India allocations. PLI schemes and manufacturing FDI reinforce this narrative.",
        weight: "strong",
        keywords: ["india gdp", "india growth", "india economy", "modi", "india investment", "make in india", "pli", "india manufacturing", "india reform", "india infrastructure"],
        geopoliticalEvent: "India GDP and investment narrative attracting global capital",
      },
      {
        id: "nifty-bull-crude-fall",
        title: "Crude oil price decline improves India's current account deficit",
        reasoning: "India imports ~85% of its crude oil. A 10% decline in crude reduces India's annual import bill by ~$15B, improving CAD, reducing inflation, and giving the RBI room to cut rates — all simultaneously bullish for NIFTY 50.",
        weight: "strong",
        keywords: ["oil crash", "crude fall", "oil slump", "opec deal", "oil decline", "oil selloff", "ceasefire", "peace deal", "oil supply"],
        geopoliticalEvent: "Crude oil price decline reducing India's external deficit",
      },
      {
        id: "nifty-bull-rbi-cut",
        title: "RBI rate cuts boost equity valuations and credit growth",
        reasoning: "When the Reserve Bank of India cuts the repo rate, borrowing costs fall, corporate earnings expectations rise, and equity valuations expand. The banking, real estate, and auto sectors — heavy NIFTY 50 weights — are most directly benefited by monetary easing.",
        weight: "moderate",
        keywords: ["rbi", "reserve bank of india", "repo rate", "rate cut", "monetary easing", "rbi policy", "interest rate cut", "india inflation", "cpi india"],
        geopoliticalEvent: "RBI monetary easing cycle expanding NIFTY 50 valuations",
      },
    ],
    bearSignals: [
      {
        id: "nifty-bear-crude-spike",
        title: "Crude oil spike worsens India's trade deficit and inflation",
        reasoning: "India's current account deficit is highly sensitive to crude prices. Every $10 rise in Brent adds ~$15B to India's annual import bill, weakening the rupee, raising inflation, and forcing RBI tightening — all simultaneously bearish for NIFTY 50.",
        weight: "strong",
        keywords: ["opec", "oil price", "crude", "brent", "wti", "oil spike", "oil rally", "production cut", "opec cut", "iran sanctions", "hormuz"],
        geopoliticalEvent: "Crude oil price surge damaging India's trade balance",
      },
      {
        id: "nifty-bear-fii-outflow",
        title: "Global risk-off triggers FII selling in Indian equities",
        reasoning: "During global crises — military conflicts, nuclear escalation, or Fed rate hikes — FIIs rapidly sell emerging market equities to move into US Treasuries. India's 20%+ FII ownership of NSE market cap makes NIFTY 50 highly vulnerable to these sudden outflows.",
        weight: "strong",
        keywords: ["war", "conflict", "nuclear", "military", "attack", "crisis", "rate hike", "hawkish", "dollar strengthen", "risk off", "recession", "market crash"],
        geopoliticalEvent: "Global risk-off triggering FII selling in Indian equities",
      },
      {
        id: "nifty-bear-india-pak",
        title: "India-Pakistan tensions trigger domestic market risk premium",
        reasoning: "India-Pakistan escalation raises direct war risk, domestic terrorism concerns, and border security spending. FIIs reduce India allocations and domestic retail investors move to safety. Kashmir/LOC incidents are the primary trigger for this risk premium.",
        weight: "strong",
        keywords: ["india pakistan", "pakistan", "kashmir", "lashkar", "isi", "cross-border", "loc", "terror attack", "surgical strike", "india border"],
        geopoliticalEvent: "India-Pakistan geopolitical escalation increasing market risk",
      },
      {
        id: "nifty-bear-rupee",
        title: "Rupee depreciation accelerates FII outflows and inflation",
        reasoning: "A weakening rupee reduces the dollar-return on Indian equities, causing FIIs to rebalance out. Simultaneously, rupee depreciation raises import costs — particularly crude oil — pushing inflation higher and reducing RBI's room to support growth.",
        weight: "moderate",
        keywords: ["rupee", "inr", "currency depreciation", "dollar strengthen", "dollar index", "dxy", "em currency", "emerging market currency"],
        geopoliticalEvent: "Rupee depreciation reducing attractiveness of Indian equities",
      },
    ],
  },

  // ── SENSEX ────────────────────────────────────────────────────────────────────
  {
    id: "sensex",
    name: "SENSEX (BSE India)",
    symbol: "SENSEX",
    bullSignals: [
      {
        id: "sensex-bull-banking",
        title: "Banking sector rally lifts SENSEX via heavyweight financials",
        reasoning: "Banking stocks (HDFC Bank, ICICI Bank, SBI, Kotak) constitute ~35% of SENSEX by weight. Any positive catalyst for Indian banking — RBI rate cuts, strong credit growth, or NPA resolution progress — disproportionately lifts SENSEX versus broader market.",
        weight: "strong",
        keywords: ["rbi", "rate cut", "repo rate", "india credit growth", "loan growth", "banking sector", "npa resolution", "india bank", "hdfc", "icici", "sbi", "kotak"],
        geopoliticalEvent: "Indian banking sector positive catalyst driving SENSEX outperformance",
      },
      {
        id: "sensex-bull-global-cues",
        title: "Positive global cues and overnight US market gains support SENSEX open",
        reasoning: "SENSEX correlates 0.7-0.8 with US indices on an intraday basis. Strong US market performance overnight, positive European PMI data, or commodity price stability feed directly into positive SENSEX opening momentum — the highest-impact intraday driver.",
        weight: "strong",
        keywords: ["us market", "dow jones", "s&p 500", "nasdaq", "global markets", "european markets", "asia markets", "fii buying", "foreign buying", "trade deal", "agreement"],
        geopoliticalEvent: "Global equity market rally creating positive SENSEX intraday momentum",
      },
      {
        id: "sensex-bull-china-plus-one",
        title: "India benefits as global manufacturers diversify away from China",
        reasoning: "US-China trade tensions drive MNC investment into India as a manufacturing alternative ('China+1' strategy). Apple, Samsung, and semiconductor assembly relocation creates direct FDI inflows and export revenue — long-run SENSEX bullish with intraday implications on each new announcement.",
        weight: "moderate",
        keywords: ["china tariff", "trade war", "china alternative", "india manufacturing", "supply chain", "apple india", "samsung india", "china+1", "pli scheme"],
        geopoliticalEvent: "China manufacturing diversification driving India FDI inflows",
      },
    ],
    bearSignals: [
      {
        id: "sensex-bear-us-recession",
        title: "US recession fears reduce global risk appetite and India FII flows",
        reasoning: "SENSEX has a high correlation with global equity sentiment. US recession signals — weak employment data, earnings misses, or Fed over-tightening — trigger broad EM equity selloffs. India's export-dependent IT sector (Infosys, Wipro, TCS in SENSEX) directly loses order momentum.",
        weight: "strong",
        keywords: ["recession", "us recession", "slowdown", "yield curve", "employment", "layoff", "tech layoff", "it slowdown", "earnings miss", "gdp contraction"],
        geopoliticalEvent: "US recession risk compressing global equity valuations",
      },
      {
        id: "sensex-bear-sanctions",
        title: "Western sanctions tightening threatens India's discounted energy imports",
        reasoning: "India purchases Iranian and Russian oil at deep discounts. If the US tightens secondary sanctions enforcement targeting Indian buyers, India's discounted crude supply is threatened — raising import costs. Periodic US pressure on India's balancing act creates market anxiety.",
        weight: "moderate",
        keywords: ["sanctions india", "secondary sanctions", "iran oil india", "russia india", "us sanctions", "india russia", "dollar sanctions"],
        geopoliticalEvent: "Western sanctions threatening India's discounted energy supply chain",
      },
    ],
  },

  // ── RELIANCE INDUSTRIES ───────────────────────────────────────────────────────
  {
    id: "reliance",
    name: "Reliance Industries (NSE)",
    symbol: "RELIANCE",
    bullSignals: [
      {
        id: "reliance-bull-oil",
        title: "Higher crude prices expand Reliance's refining and petchem margins",
        reasoning: "Reliance operates the world's largest integrated refinery at Jamnagar. Higher crude with strong product cracks (petrol, diesel, naphtha) expands Gross Refining Margins (GRM). Each $1/bbl GRM improvement adds ~₹500 crore quarterly EBITDA — directly reflected in intraday stock movement on crude news.",
        weight: "strong",
        keywords: ["oil price", "crude", "brent", "opec", "wti", "oil rally", "petroleum", "refining", "petrochemicals", "iran sanctions", "hormuz"],
        geopoliticalEvent: "Crude oil price rise improving Reliance's refining economics",
      },
      {
        id: "reliance-bull-jio",
        title: "Jio 5G rollout and digital services growth drives valuation re-rating",
        reasoning: "Reliance Jio is India's largest telecom with 470M+ subscribers. ARPU improvement through 5G premium plans, JioAirFiber home broadband, and JioCinema streaming rights directly drive valuation. Telecom sector policy support from the government amplifies the growth narrative.",
        weight: "strong",
        keywords: ["jio", "5g", "telecom", "broadband", "streaming", "digital", "jiocinema", "reliance retail", "jio airfiber", "arpu", "mukesh ambani"],
        geopoliticalEvent: "Jio digital services expansion driving Reliance revenue diversification",
      },
      {
        id: "reliance-bull-green",
        title: "New Energy investments position Reliance for clean energy transition",
        reasoning: "Reliance has committed $10B to New Energy (green hydrogen, solar panels, battery storage). Global clean energy momentum — EU Green Deal, India solar targets — validates this strategy. Each major clean energy policy announcement provides a sentiment lift.",
        weight: "moderate",
        keywords: ["solar", "renewable", "clean energy", "green hydrogen", "net zero", "climate", "india solar", "green deal"],
        geopoliticalEvent: "Global clean energy transition validating Reliance's New Energy strategy",
      },
    ],
    bearSignals: [
      {
        id: "reliance-bear-oil-crash",
        title: "Crude oil crash creates inventory losses and GRM compression",
        reasoning: "Sharp crude price declines reduce Reliance's refinery economics and create inventory valuation losses. At $65/bbl or below, GRMs compress significantly as product spreads narrow. Reliance stock historically correlates 0.65+ with crude price direction on intraday basis.",
        weight: "strong",
        keywords: ["oil crash", "crude fall", "oil slump", "oil selloff", "opec deal", "oil decline", "peace deal", "ceasefire"],
        geopoliticalEvent: "Crude oil price crash compressing Reliance's refining margins",
      },
      {
        id: "reliance-bear-sanctions-risk",
        title: "Secondary sanctions risk threatens Reliance's discounted crude sourcing",
        reasoning: "Reliance historically sources significant volumes from Iran and Russia at discounts. US secondary sanctions enforcement targeting Indian refiners could disrupt these supply chains and threaten access to US financial markets — creating significant operational and reputational risk.",
        weight: "moderate",
        keywords: ["iran", "sanction", "secondary sanctions", "iran oil", "us sanctions", "enforcement", "russia oil india"],
        geopoliticalEvent: "US secondary sanctions enforcement threatening Reliance's crude sourcing",
      },
    ],
  },

  // ── TCS ───────────────────────────────────────────────────────────────────────
  {
    id: "tcs",
    name: "TCS (Tata Consultancy Services)",
    symbol: "TCS",
    bullSignals: [
      {
        id: "tcs-bull-rupee",
        title: "Rupee depreciation directly boosts TCS's INR-reported revenue",
        reasoning: "TCS earns ~90% of revenue in USD, GBP, and EUR. Every 1% decline in the rupee vs dollar improves TCS's INR-reported revenue by ~1%. In periods of dollar strength (geopolitical risk-off, Fed hawkishness), TCS becomes a natural hedge within the Indian equity market — often rising when NIFTY falls.",
        weight: "strong",
        keywords: ["rupee fall", "inr depreciation", "dollar strengthen", "rupee weak", "dollar rally", "usd rally", "dollar index", "dxy rise", "hawkish", "rate hike"],
        geopoliticalEvent: "Rupee depreciation boosting TCS dollar-earned revenue in INR terms",
      },
      {
        id: "tcs-bull-ai-demand",
        title: "Global AI and cloud transformation drives IT services demand surge",
        reasoning: "The global AI transformation is generating massive IT services opportunities — AI integration, cloud migration, data modernisation, cybersecurity. TCS's GenAI platforms and partnerships with Microsoft, Google, AWS position it well to capture this multi-year spend cycle. Each major AI policy or investment announcement drives TCS re-rating.",
        weight: "strong",
        keywords: ["ai", "artificial intelligence", "cloud", "digital transformation", "automation", "generative ai", "microsoft", "google", "aws", "tech spending", "it spending", "digital deal"],
        geopoliticalEvent: "AI/cloud adoption wave expanding TCS's addressable market",
      },
      {
        id: "tcs-bull-us-economy",
        title: "Strong US and European economic growth sustains IT budgets",
        reasoning: "~50% of TCS revenue comes from BFSI clients in North America. Strong US economic data — employment, consumer spending, corporate earnings — correlates directly with IT budget growth and TCS deal wins. Trade agreements and geopolitical stability that boost global growth are TCS-positive.",
        weight: "moderate",
        keywords: ["us economy", "us growth", "consumer spending", "corporate earnings", "gdp", "employment", "us jobs", "economic growth", "recovery"],
        geopoliticalEvent: "US/European economic strength sustaining enterprise IT spending",
      },
    ],
    bearSignals: [
      {
        id: "tcs-bear-visa",
        title: "US H-1B visa restrictions raise TCS's delivery costs",
        reasoning: "TCS relies on H-1B visas to staff client-side projects in the US. Restrictive visa policy — caps, rejections, or fee increases — forces more expensive local hiring or offshore shift, compressing margins by 150-250 bps. This is a recurring US political risk that markets react to intraday.",
        weight: "strong",
        keywords: ["h-1b", "visa", "immigration", "work visa", "it worker", "tech visa", "us immigration", "visa restriction"],
        geopoliticalEvent: "US H-1B visa restrictions increasing TCS's US delivery costs",
      },
      {
        id: "tcs-bear-us-recession",
        title: "US recession fears trigger IT budget freezes and deal deferrals",
        reasoning: "Enterprise IT spending is pro-cyclical. When US recession risks rise, corporate boards impose discretionary spending freezes — IT modernisation, cloud migration, and digital projects are deferred first. TCS's BFSI and retail clients cut discretionary IT budgets, directly reducing deal wins.",
        weight: "strong",
        keywords: ["recession", "us recession", "slowdown", "tech layoff", "it budget", "spending cut", "deal deferral", "cost cut", "gdp contraction"],
        geopoliticalEvent: "US recession compressing enterprise IT budgets affecting TCS",
      },
      {
        id: "tcs-bear-rupee-appreciate",
        title: "Rupee appreciation compresses TCS's INR-reported margins",
        reasoning: "A strengthening rupee reduces the INR value of TCS's dollar revenues. While TCS has natural hedging, sustained rupee appreciation above ₹82/USD compresses EBITDA margins by 40-60 bps. FII inflows into India that strengthen the rupee paradoxically hurt TCS.",
        weight: "moderate",
        keywords: ["rupee strengthen", "inr appreciation", "rupee rally", "dollar weaken", "dollar fall", "dollar decline", "usd fall"],
        geopoliticalEvent: "Rupee appreciation compressing TCS's dollar-earned margins",
      },
    ],
  },

  // ── HDFC BANK ──────────────────────────────────────────────────────────────────
  {
    id: "hdfcbank",
    name: "HDFC Bank (NSE India)",
    symbol: "HDFCBANK",
    bullSignals: [
      {
        id: "hdfc-bull-rate-cut",
        title: "RBI rate cut cycle expands HDFC Bank's NIM and loan demand",
        reasoning: "An RBI repo rate cut reduces HDFC Bank's cost of funds while asset yields reprice with a lag, temporarily expanding Net Interest Margins. Combined with accelerating credit demand in a low-rate environment, this is the single most powerful intraday catalyst for HDFC Bank — reacting within minutes of RBI announcements.",
        weight: "strong",
        keywords: ["rbi rate cut", "repo rate cut", "rate cut", "monetary easing", "rbi policy", "interest rate", "india inflation", "cpi india", "rbi dovish"],
        geopoliticalEvent: "RBI rate cut cycle expanding HDFC Bank NIM and loan demand",
      },
      {
        id: "hdfc-bull-india-credit",
        title: "India's retail lending boom drives HDFC Bank loan book growth",
        reasoning: "India's mortgage-to-GDP ratio (~12%) vs 70%+ in developed markets signals massive structural growth runway. HDFC Bank leads in home loans, auto loans, credit cards, and personal loans. Government affordable housing schemes and rising middle class income directly accelerate this growth — supporting a premium valuation.",
        weight: "strong",
        keywords: ["india credit", "loan growth", "home loan", "mortgage", "retail lending", "credit card", "india housing", "affordable housing", "india consumption"],
        geopoliticalEvent: "India's structural credit demand underpinning HDFC Bank's loan book",
      },
      {
        id: "hdfc-bull-fii",
        title: "FII buying concentrated in HDFC Bank as India's proxy large-cap",
        reasoning: "HDFC Bank is used by global ETFs and active managers as a liquid proxy for India's consumer growth story. When FIIs increase India weightings (driven by global risk-on, MSCI rebalancing, or India upgrade), HDFC Bank disproportionately receives inflows due to its size and $160B+ market cap liquidity.",
        weight: "moderate",
        keywords: ["fii buying", "foreign buying", "india overweight", "msci india", "emerging market", "india etf", "trade deal", "rate cut", "global rally"],
        geopoliticalEvent: "FII India allocation increase concentrating flows in HDFC Bank",
      },
    ],
    bearSignals: [
      {
        id: "hdfc-bear-rate-hike",
        title: "RBI rate hikes pressure HDFC Bank's funding cost and valuation",
        reasoning: "Rate hike cycles compress bank NIMs as deposit repricing is faster than asset repricing for retail-heavy lenders. Rising rates also slow credit demand — particularly mortgages and auto loans — and expand the discount rate applied to HDFC Bank's premium P/B valuation.",
        weight: "strong",
        keywords: ["rbi rate hike", "repo rate hike", "rate hike", "monetary tightening", "rbi hawkish", "inflation", "india inflation", "cpi"],
        geopoliticalEvent: "RBI rate tightening cycle compressing HDFC Bank's margins",
      },
      {
        id: "hdfc-bear-geopolitical",
        title: "Geopolitical escalation triggers broad India selloff via HDFC Bank",
        reasoning: "India-Pakistan military escalation or major global crises trigger immediate FII selling across Indian equities. HDFC Bank, as the largest weight in NIFTY 50 and SENSEX, becomes the primary vehicle for index-level FII de-risking — experiencing outsized intraday selling pressure in risk events.",
        weight: "strong",
        keywords: ["india pakistan", "war", "conflict", "military", "attack", "crisis", "nuclear", "kashmir", "china india", "border tension"],
        geopoliticalEvent: "Major geopolitical escalation triggering FII selling via HDFC Bank",
      },
      {
        id: "hdfc-bear-npa",
        title: "Rising NPAs or credit quality concerns trigger valuation de-rating",
        reasoning: "Any sign of deteriorating asset quality — rising Gross NPA ratios, microfinance stress, or large corporate defaults — immediately triggers de-rating for HDFC Bank. The bank trades at a premium P/B that is highly sensitive to credit quality perception and any adverse RBI action.",
        weight: "moderate",
        keywords: ["npa", "bad loan", "credit quality", "stress", "default", "npa rise", "banking stress", "credit risk", "unsecured loan", "rbi action"],
        geopoliticalEvent: "Asset quality deterioration triggering HDFC Bank valuation de-rating",
      },
    ],
  },
];

// ─── Historical price fetching (Yahoo Finance, 7-day OHLCV) ──────────────────

interface OHLCVCandle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  changePct: number;
}

interface HistoricalData {
  candles: OHLCVCandle[];
  avgDailyRangePct: number; // average daily high-low spread as % of close
  sevenDayChangePct: number;
  trend: "up" | "down" | "flat";
  volatility: "high" | "medium" | "low";
}

const _historicalCache = new Map<string, { data: HistoricalData; fetchedAt: number }>();
const HISTORICAL_CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function fetchHistoricalPrices(assetId: string): Promise<HistoricalData | null> {
  const ticker = YAHOO_TICKERS[assetId];
  if (!ticker) return null;

  const cached = _historicalCache.get(assetId);
  if (cached && Date.now() - cached.fetchedAt < HISTORICAL_CACHE_TTL) {
    return cached.data;
  }

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=10d`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return null;

    const json = await resp.json() as {
      chart?: {
        result?: Array<{
          timestamp?: number[];
          indicators?: {
            quote?: Array<{
              open?: (number | null)[];
              high?: (number | null)[];
              low?: (number | null)[];
              close?: (number | null)[];
              volume?: (number | null)[];
            }>;
          };
        }>;
      };
    };

    const result = json.chart?.result?.[0];
    if (!result) return null;

    const timestamps = result.timestamp ?? [];
    const quote = result.indicators?.quote?.[0];
    if (!quote || timestamps.length === 0) return null;

    const candles: OHLCVCandle[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const o = quote.open?.[i];
      const h = quote.high?.[i];
      const l = quote.low?.[i];
      const c = quote.close?.[i];
      const v = quote.volume?.[i];
      if (o == null || h == null || l == null || c == null) continue;

      const prevClose = i > 0 ? (quote.close?.[i - 1] ?? c) : c;
      candles.push({
        date: new Date((timestamps[i]!) * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short" }),
        open: Math.round(o * 100) / 100,
        high: Math.round(h * 100) / 100,
        low: Math.round(l * 100) / 100,
        close: Math.round(c * 100) / 100,
        volume: Math.round(v ?? 0),
        changePct: Math.round(((c - prevClose) / prevClose) * 10000) / 100,
      });
    }

    if (candles.length < 2) return null;

    const last7 = candles.slice(-7);
    const avgDailyRangePct = last7.reduce((sum, c) => sum + ((c.high - c.low) / c.close) * 100, 0) / last7.length;
    const firstClose = last7[0]!.close;
    const lastClose = last7[last7.length - 1]!.close;
    const sevenDayChangePct = Math.round(((lastClose - firstClose) / firstClose) * 10000) / 100;

    const upDays = last7.filter((c) => c.changePct > 0).length;
    const trend: "up" | "down" | "flat" = upDays >= 5 ? "up" : upDays <= 2 ? "down" : "flat";
    const volatility: "high" | "medium" | "low" = avgDailyRangePct > 2 ? "high" : avgDailyRangePct > 1 ? "medium" : "low";

    const data: HistoricalData = { candles: last7, avgDailyRangePct: Math.round(avgDailyRangePct * 100) / 100, sevenDayChangePct, trend, volatility };
    _historicalCache.set(assetId, { data, fetchedAt: Date.now() });
    return data;
  } catch {
    return null;
  }
}

// ─── AI Prediction Engine ─────────────────────────────────────────────────────

interface AIPrediction {
  direction: AssetDirection;
  magnitude: AssetMagnitude;
  confidence: "high" | "medium" | "low";
  timeframe: "intraday" | "next-session";
  priceImpactEstimate: string;
  verdict: string;
  dominantNarrative: string;
  assumptions: string;
  triggerNewsSummary: string;
  bullScore: number;
  bearScore: number;
  activeBullSignals: { template: MarketSignalTemplate; articleIds: string[] }[];
  activeBearSignals: { template: MarketSignalTemplate; articleIds: string[] }[];
  // ── New Phase-5 fields (internal, not returned to API clients directly) ──
  _priceScore?: number;
  _flipConfirmed?: boolean;
  _tier3Evidence?: Record<string, unknown>;
  _candleTrustScore?: number;
  _candleFlags?: string[];
  _regimeAge?: number;
  _channelDecaySummary?: Record<string, unknown>[];
  _regime?: string;
  _regimeProbabilities?: Record<string, number>;
  _activeChannels?: string[];
  _ensembleVotes?: Record<string, unknown>[];
  _uncertaintyFlag?: boolean;
}

const _aiPredictionCache = new Map<string, { prediction: AIPrediction; fetchedAt: number }>();
const AI_CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function aiPredictAsset(
  asset: AssetTemplate,
  articles: RawArticle[],
  historical: HistoricalData | null,
  lessons: string | null
): Promise<AIPrediction> {
  const cached = _aiPredictionCache.get(asset.id);
  if (cached && Date.now() - cached.fetchedAt < AI_CACHE_TTL) {
    return cached.prediction;
  }

  // Prepare 7-day OHLCV summary
  const candleSummary = historical
    ? historical.candles.map((c) =>
        `${c.date}: O=${c.open} H=${c.high} L=${c.low} C=${c.close} Chg=${c.changePct > 0 ? "+" : ""}${c.changePct}%`
      ).join("\n")
    : "Historical price data unavailable.";

  const marketStats = historical
    ? `7-day change: ${historical.sevenDayChangePct > 0 ? "+" : ""}${historical.sevenDayChangePct}% | Avg daily range: ${historical.avgDailyRangePct}% | Trend: ${historical.trend} | Volatility: ${historical.volatility}`
    : "";

  // Prepare recent news (last 7 days, relevant headlines)
  const cutoff7d = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recentArticles = articles
    .filter((a) => new Date(a.publishedAt).getTime() > cutoff7d)
    .slice(0, 40);

  const newsLines = recentArticles.length > 0
    ? recentArticles.map((a, i) => `[${i + 1}] ${a.title}${a.description ? " — " + a.description.slice(0, 80) : ""}`).join("\n")
    : "No recent news available.";

  // Build signal catalog for the asset
  const bullCatalog = asset.bullSignals.map((s) =>
    `BULL[${s.id}] "${s.title}" (${s.weight}) — ${s.reasoning.slice(0, 120)}`
  ).join("\n");
  const bearCatalog = asset.bearSignals.map((s) =>
    `BEAR[${s.id}] "${s.title}" (${s.weight}) — ${s.reasoning.slice(0, 120)}`
  ).join("\n");

  const lessonsSection = lessons
    ? `\n\nPAST FAILURES TO LEARN FROM:\n${lessons}`
    : "";

  const prompt = `You are a quantitative market analyst specializing in Indian equity markets. Analyze ${asset.name} (${asset.symbol}) and produce a short-term directional prediction.

## 7-DAY HISTORICAL PRICE DATA (OHLCV)
${candleSummary}
${marketStats}

## RECENT NEWS (last 7 days, ${recentArticles.length} articles)
${newsLines}

## KNOWN SIGNAL CATALOG FOR ${asset.symbol}
${bullCatalog}
${bearCatalog}${lessonsSection}

## YOUR TASK
1. Study the 7-day price action: identify trend, momentum, support/resistance levels from the OHLCV data.
2. Identify which news headlines from the list above are ACTUALLY relevant to ${asset.symbol} price movement.
3. Cross-reference news against the signal catalog — which bull/bear signals are triggered?
4. Factor in the past failures (if any) — avoid repeating the same analytical mistake.
5. Produce a structured JSON prediction.

## OUTPUT FORMAT (respond ONLY with valid JSON, no markdown fences)
{
  "direction": "up" | "down" | "neutral",
  "magnitude": "strong" | "moderate" | "mild",
  "confidence": "high" | "medium" | "low",
  "timeframe": "intraday" | "next-session",
  "priceImpactEstimate": "<calculate from actual avg daily range — e.g. if avg range is 1.2%, a moderate move is +0.8-1.2%>",
  "verdict": "<2-3 sentence analyst summary explaining the prediction with specific reference to price levels and news>",
  "dominantNarrative": "<single most important driver in ≤12 words>",
  "assumptions": "<bullet list of 3-4 key assumptions being made>",
  "triggerNewsSummary": "<which specific headlines are driving this, article numbers in brackets>",
  "bullScore": <0-100 score representing bullish signal strength>,
  "bearScore": <0-100 score representing bearish signal strength>,
  "activeBullSignalIds": [<list of BULL signal IDs from catalog that are currently active, e.g. "nifty-bull-fii-inflow">],
  "activeBearSignalIds": [<list of BEAR signal IDs from catalog that are currently active>],
  "activeNewsArticleIndices": [<1-based article indices that are relevant to this asset>]
}`;

  try {
    const response = await chatComplete({
      model: "gpt-5.1",
      max_tokens: 1200,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = response.choices[0]?.message?.content ?? "";
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed = JSON.parse(cleaned) as {
      direction: AssetDirection;
      magnitude: AssetMagnitude;
      confidence: "high" | "medium" | "low";
      timeframe: "intraday" | "next-session";
      priceImpactEstimate: string;
      verdict: string;
      dominantNarrative: string;
      assumptions: string;
      triggerNewsSummary: string;
      bullScore: number;
      bearScore: number;
      activeBullSignalIds: string[];
      activeBearSignalIds: string[];
      activeNewsArticleIndices: number[];
    };

    // Map signal IDs back to templates with article IDs
    const articleIndexToId = new Map(recentArticles.map((a, i) => [i + 1, a.id]));
    const relevantArticleIds = (parsed.activeNewsArticleIndices ?? [])
      .map((i) => articleIndexToId.get(i))
      .filter((id): id is string => !!id);

    const activeBullSignals = (parsed.activeBullSignalIds ?? [])
      .map((id) => {
        const template = asset.bullSignals.find((s) => s.id === id);
        return template ? { template, articleIds: relevantArticleIds.slice(0, 5) } : null;
      })
      .filter((s): s is { template: MarketSignalTemplate; articleIds: string[] } => s !== null);

    const activeBearSignals = (parsed.activeBearSignalIds ?? [])
      .map((id) => {
        const template = asset.bearSignals.find((s) => s.id === id);
        return template ? { template, articleIds: relevantArticleIds.slice(0, 5) } : null;
      })
      .filter((s): s is { template: MarketSignalTemplate; articleIds: string[] } => s !== null);

    const direction: AssetDirection = ["up", "down", "neutral"].includes(parsed.direction) ? parsed.direction : "neutral";
    const magnitude: AssetMagnitude = ["strong", "moderate", "mild"].includes(parsed.magnitude) ? parsed.magnitude : "mild";
    const confidence = ["high", "medium", "low"].includes(parsed.confidence) ? parsed.confidence : "low";
    const timeframe = ["intraday", "next-session"].includes(parsed.timeframe) ? parsed.timeframe : "intraday";

    const prediction: AIPrediction = {
      direction,
      magnitude,
      confidence,
      timeframe,
      priceImpactEstimate: parsed.priceImpactEstimate ?? "±varies",
      verdict: parsed.verdict ?? "",
      dominantNarrative: parsed.dominantNarrative ?? "",
      assumptions: parsed.assumptions ?? "",
      triggerNewsSummary: parsed.triggerNewsSummary ?? "",
      bullScore: typeof parsed.bullScore === "number" ? parsed.bullScore : 0,
      bearScore: typeof parsed.bearScore === "number" ? parsed.bearScore : 0,
      activeBullSignals,
      activeBearSignals,
    };

    _aiPredictionCache.set(asset.id, { prediction, fetchedAt: Date.now() });
    return prediction;
  } catch {
    // Fallback: neutral prediction when AI fails
    return {
      direction: "neutral",
      magnitude: "mild",
      confidence: "low",
      timeframe: "intraday",
      priceImpactEstimate: "±varies",
      verdict: `Unable to generate AI prediction for ${asset.name} at this time. Please try again shortly.`,
      dominantNarrative: "AI prediction unavailable",
      assumptions: "",
      triggerNewsSummary: "",
      bullScore: 0,
      bearScore: 0,
      activeBullSignals: [],
      activeBearSignals: [],
    };
  }
}

// ─── Prediction snapshot helpers ─────────────────────────────────────────────

function predictionTimeframeToMs(timeframe: string): number {
  switch (timeframe) {
    case "1-2 weeks": return 10.5 * 24 * 60 * 60 * 1000;
    case "1 month":   return 30   * 24 * 60 * 60 * 1000;
    case "3 months":  return 90   * 24 * 60 * 60 * 1000;
    case "6+ months": return 180  * 24 * 60 * 60 * 1000;
    default:          return 30   * 24 * 60 * 60 * 1000;
  }
}

async function getTemplateAccuracyAll(templateIds: string[]): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  try {
    // Fetch all resolved rows (isCorrect is set only when resolvedAt is also set)
    const allRows = await db
      .select({
        templateId: predictionSnapshotsTable.templateId,
        isCorrect: predictionSnapshotsTable.isCorrect,
        resolvedAt: predictionSnapshotsTable.resolvedAt,
      })
      .from(predictionSnapshotsTable);
    for (const tid of templateIds) {
      const resolved = allRows.filter((r) => r.templateId === tid && r.resolvedAt !== null);
      if (resolved.length === 0) { result.set(tid, null); continue; }
      const correct = resolved.filter((r) => r.isCorrect === true).length;
      result.set(tid, Math.round((correct / resolved.length) * 100));
    }
  } catch {
    for (const tid of templateIds) result.set(tid, null);
  }
  return result;
}

async function resolvePendingPredictionSnapshots(): Promise<void> {
  // Predictions are self-resolved: when their timeframe expires we mark isCorrect
  // based on whether the prediction template is STILL scoring > 0 (event not yet resolved)
  // For now we mark expired unresolved snapshots as resolved with a note asking for manual review
  try {
    const now = new Date();
    const expired = await db
      .select()
      .from(predictionSnapshotsTable)
      .where(
        and(
          isNull(predictionSnapshotsTable.resolvedAt),
          lt(predictionSnapshotsTable.resolveAfter, now)
        )
      );
    for (const snap of expired) {
      await db
        .update(predictionSnapshotsTable)
        .set({
          resolvedAt: now,
          resolutionNotes: `Timeframe expired (${snap.timeframeText}). Auto-resolved after deadline passed — outcome pending manual confirmation.`,
        })
        .where(eq(predictionSnapshotsTable.id, snap.id));
    }
  } catch {
    // Non-fatal
  }
}

async function savePredictionSnapshot(
  templateId: string,
  clusterId: string,
  headline: string,
  reasoning: string,
  historicalPrecedent: string,
  triggerSummary: string,
  potentialOutcomes: string[],
  confidence: string,
  riskLevel: string,
  timeframeText: string,
  category: string,
  countries: string[],
  leaders: string[],
  triggerScore: number,
  triggerArticleIds: string[]
): Promise<string | null> {
  try {
    // Throttle: one snapshot per template per 24 hours
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recent = await db
      .select({ id: predictionSnapshotsTable.id })
      .from(predictionSnapshotsTable)
      .where(
        and(
          eq(predictionSnapshotsTable.templateId, templateId),
          gt(predictionSnapshotsTable.snapshotAt, oneDayAgo)
        )
      )
      .limit(1);

    if (recent.length > 0) return recent[0]!.id;

    const id = `pred-${templateId}-${Date.now()}`;
    const resolveAfter = new Date(Date.now() + predictionTimeframeToMs(timeframeText));

    await db.insert(predictionSnapshotsTable).values({
      id,
      templateId,
      clusterId,
      headline,
      reasoning,
      historicalPrecedent,
      triggerSummary,
      potentialOutcomes: JSON.stringify(potentialOutcomes),
      confidence,
      riskLevel,
      timeframeText,
      category,
      countries: JSON.stringify(countries),
      leaders: JSON.stringify(leaders),
      triggerScore: triggerScore.toString(),
      triggerArticleIds: JSON.stringify(triggerArticleIds),
      resolveAfter,
    });
    return id;
  } catch {
    return null;
  }
}

// ─── Snapshot helpers ─────────────────────────────────────────────────────────

function timeframeToMs(timeframe: string): number {
  switch (timeframe) {
    case "today":        return 6.5 * 60 * 60 * 1000; // 9:00 AM → 3:30 PM IST
    case "intraday":     return 4    * 60 * 60 * 1000;
    case "next-session": return 18   * 60 * 60 * 1000;
    case "1-2 weeks":   return 10.5 * 24 * 60 * 60 * 1000;
    case "1 month":     return 30   * 24 * 60 * 60 * 1000;
    case "3 months":    return 90   * 24 * 60 * 60 * 1000;
    default:             return 6.5 * 60 * 60 * 1000; // default to "today"
  }
}

// ─── Real price fetching (Yahoo Finance, no API key) ─────────────────────────

// Yahoo Finance ticker map for NSE assets
const YAHOO_TICKERS: Record<string, string> = {
  nifty50:  "^NSEI",
  sensex:   "^BSESN",
  reliance: "RELIANCE.NS",
  tcs:      "TCS.NS",
  hdfcbank: "HDFCBANK.NS",
};

// In-memory cache: { price, fetchedAt }
const _priceCache = new Map<string, { price: number; fetchedAt: number }>();
const PRICE_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

async function fetchRealPrice(assetId: string): Promise<number | null> {
  const ticker = YAHOO_TICKERS[assetId];
  if (!ticker) return null;

  const cached = _priceCache.get(assetId);
  if (cached && Date.now() - cached.fetchedAt < PRICE_CACHE_TTL) {
    return cached.price;
  }

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return null;
    const json = await resp.json() as {
      chart?: { result?: Array<{ meta?: { regularMarketPrice?: number } }> }
    };
    const price = json.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (typeof price !== "number") return null;
    _priceCache.set(assetId, { price, fetchedAt: Date.now() });
    return price;
  } catch {
    return null;
  }
}

// ─── Lessons from past failures ───────────────────────────────────────────────

async function getLessonsFromFailures(assetId: string): Promise<string | null> {
  try {
    const failed = await db
      .select({
        verdict: marketSnapshotsTable.verdict,
        assumptions: marketSnapshotsTable.assumptions,
        triggerNewsSummary: marketSnapshotsTable.triggerNewsSummary,
        resolutionNotes: marketSnapshotsTable.resolutionNotes,
        flipReason: marketSnapshotsTable.flipReason,
        lessonsLearned: marketSnapshotsTable.lessonsLearned,
        predictedDirection: marketSnapshotsTable.predictedDirection,
        resolutionDirection: marketSnapshotsTable.resolutionDirection,
        snapshotAt: marketSnapshotsTable.snapshotAt,
      })
      .from(marketSnapshotsTable)
      .where(
        and(
          eq(marketSnapshotsTable.assetId, assetId),
          eq(marketSnapshotsTable.isCorrect, false)
        )
      )
      .orderBy(desc(marketSnapshotsTable.snapshotAt))
      .limit(3);

    if (failed.length === 0) return null;

    const parts = failed.map((f, i) => {
      const date = new Date(f.snapshotAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
      const flip = f.flipReason ? ` Flip reason: ${f.flipReason}.` : "";
      const lesson = f.lessonsLearned ?? `Previously predicted ${f.predictedDirection?.toUpperCase()} but resolved as ${f.resolutionDirection?.toUpperCase()}.${flip}`;
      return `[Failure ${i + 1} — ${date}] ${lesson}`;
    });

    return parts.join("\n");
  } catch {
    return null;
  }
}

// ─── Generate per-prediction assumptions text ─────────────────────────────────

function buildAssumptions(
  direction: AssetDirection,
  activeBullSignals: { template: MarketSignalTemplate; articleIds: string[] }[],
  activeBearSignals: { template: MarketSignalTemplate; articleIds: string[] }[],
  assetName: string
): string {
  const side = direction === "up" ? activeBullSignals : direction === "down" ? activeBearSignals : [];
  if (side.length === 0) return `No strong directional signals detected for ${assetName}. Assuming sideways trading.`;
  const points = side.slice(0, 3).map((s) => `• ${s.template.title}: ${s.template.reasoning.slice(0, 120)}…`);
  return points.join("\n");
}

// ─── Build trigger news summary ───────────────────────────────────────────────

function buildTriggerNewsSummary(
  activeBullSignals: { template: MarketSignalTemplate; articleIds: string[] }[],
  activeBearSignals: { template: MarketSignalTemplate; articleIds: string[] }[],
  articles: RawArticle[]
): string {
  const articleMap = new Map(articles.map((a) => [a.id, a]));
  const allSignals = [...activeBullSignals, ...activeBearSignals];
  const usedArticleIds = new Set<string>();
  const headlines: string[] = [];

  for (const sig of allSignals) {
    for (const aid of sig.articleIds.slice(0, 2)) {
      if (!usedArticleIds.has(aid)) {
        const art = articleMap.get(aid);
        if (art) {
          headlines.push(`[${sig.template.title.slice(0, 40)}] "${art.title.slice(0, 80)}"`);
          usedArticleIds.add(aid);
        }
      }
    }
    if (headlines.length >= 5) break;
  }

  return headlines.length > 0 ? headlines.join("\n") : "No specific news articles matched this prediction's signals.";
}

// ─── V2 agent signal synthesis ────────────────────────────────────────────────
// The v2 market agent (market-agent.ts) emits a verdict + a bullScore/bearScore
// derived from ensemble window votes and Tier-3 evidence, but does NOT emit
// per-template signal items the way the legacy LLM path does. Without this
// conversion the UI shows "BULL SIGNALS (0) — 4 PTS" — a score with no
// underlying breakdown. This translates the agent's internal reasoning
// (ensemble votes, Tier-3 microstructure, active geopolitical channels) into
// the signal-item shape the UI expects, so the score and the breakdown stay
// honest.
function synthesizeV2Signals(
  signal: MarketSignal,
  assetSymbol: string,
): {
  activeBullSignals: { template: MarketSignalTemplate; articleIds: string[] }[];
  activeBearSignals: { template: MarketSignalTemplate; articleIds: string[] }[];
} {
  const bull: { template: MarketSignalTemplate; articleIds: string[] }[] = [];
  const bear: { template: MarketSignalTemplate; articleIds: string[] }[] = [];

  // ── Catalog-matched signals: per-asset business reasons for the call ──
  // Each asset's ASSET_TEMPLATES entry has 4 bull + 4 bear signal templates
  // with professionally written titles/reasoning (e.g. "nifty-bull-fii-inflow",
  // "reliance-bull-oil", "tcs-bull-ai-demand"). We match these to live Tier-3
  // flags and active channels so each asset shows WHY this specific stock
  // would move — not just "6h window: bullish". When no flag matches but the
  // ensemble has a directional consensus, we surface the asset's top-weight
  // template so every call has at least one asset-specific narrative.
  const assetCatalog = ASSET_TEMPLATES.find((a) => a.symbol === assetSymbol);
  if (assetCatalog) {
    const t3 = signal.tier3Evidence;
    const channelIds = (signal.channelDecaySummary ?? [])
      .filter((c) => c.decayedWeight >= 0.3)
      .map((c) => c.channelId.toLowerCase());

    const flags = new Set<string>();
    if (t3) {
      if (!t3.fiiIsStale && t3.fiiNetCrore > 1000) flags.add("fii");
      if (!t3.fiiIsStale && t3.fiiNetCrore < -1000) flags.add("fii-outflow");
      if (t3.indiaVix5dChange != null && t3.indiaVix5dChange < -1) flags.add("global-cues");
      if (t3.indiaVix5dChange != null && t3.indiaVix5dChange > 1) flags.add("us-recession");
      if (t3.advanceDeclineRatio != null && t3.advanceDeclineRatio > 1.5) flags.add("banking");
      if (t3.advanceDeclineRatio != null && t3.advanceDeclineRatio < 0.7) flags.add("npa");
    }
    for (const ch of channelIds) {
      if (ch.includes("crude") && ch.includes("spike")) flags.add("crude-spike");
      if (ch.includes("crude") && (ch.includes("fall") || ch.includes("decline"))) flags.add("crude-fall");
      if (ch.includes("rupee") || ch.includes("inr_weak")) flags.add("rupee");
      if (ch.includes("india") && ch.includes("pak")) flags.add("india-pak");
      if (ch.includes("sanctions")) flags.add("sanctions");
      if (ch.includes("ai")) flags.add("ai-demand");
      if (ch.includes("rate") && ch.includes("cut")) flags.add("rate-cut");
      if (ch.includes("rate") && ch.includes("hike")) flags.add("rate-hike");
      if (ch.includes("oil") || ch.includes("crude")) flags.add("oil");
    }

    const matchByFlags = (templates: MarketSignalTemplate[]): MarketSignalTemplate[] => {
      if (flags.size === 0) return [];
      return templates.filter((t) => {
        const tail = t.id.replace(/^[a-z]+-(bull|bear)-/, "");
        for (const flag of flags) {
          if (tail === flag || tail.includes(flag) || flag.includes(tail)) return true;
        }
        return false;
      });
    };

    const surfaceCatalogFor = (
      direction: "up" | "down",
      templates: MarketSignalTemplate[],
      target: typeof bull,
    ): void => {
      if (signal.direction !== direction) return;
      const matched = matchByFlags(templates);
      if (matched.length > 0) {
        for (const tmpl of matched.slice(0, 2)) target.push({ template: tmpl, articleIds: [] });
      } else {
        const top = templates.find((s) => s.weight === "strong") ?? templates[0];
        if (top) target.push({ template: top, articleIds: [] });
      }
    };

    surfaceCatalogFor("up", assetCatalog.bullSignals, bull);
    surfaceCatalogFor("down", assetCatalog.bearSignals, bear);
  }

  // EnsembleVote.confidence is a 0-1 number; bucket into the UI's weight tiers.
  const weightFromConf = (c: number): SignalWeight =>
    c >= 0.7 ? "strong" : c >= 0.4 ? "moderate" : "weak";

  // Ensemble window votes → one signal per directional window
  for (const v of signal.ensembleVotes ?? []) {
    if (v.call === "BULLISH") {
      bull.push({
        template: {
          id: `v2-vote-${v.window}`,
          title: `${v.window} window: bullish read on ${assetSymbol}`,
          reasoning: v.rationale && v.rationale.length > 0
            ? v.rationale
            : `${v.window} ensemble window voted BULLISH (confidence ${v.confidence.toFixed(2)}).`,
          weight: weightFromConf(v.confidence),
          keywords: [],
          geopoliticalEvent: `Regime: ${signal.regime}`,
        },
        articleIds: [],
      });
    } else if (v.call === "BEARISH") {
      bear.push({
        template: {
          id: `v2-vote-${v.window}`,
          title: `${v.window} window: bearish read on ${assetSymbol}`,
          reasoning: v.rationale && v.rationale.length > 0
            ? v.rationale
            : `${v.window} ensemble window voted BEARISH (confidence ${v.confidence.toFixed(2)}).`,
          weight: weightFromConf(v.confidence),
          keywords: [],
          geopoliticalEvent: `Regime: ${signal.regime}`,
        },
        articleIds: [],
      });
    }
  }

  // Tier-3 microstructure evidence
  const t3 = signal.tier3Evidence;
  if (t3) {
    if (t3.advanceDeclineRatio != null) {
      if (t3.advanceDeclineRatio >= 1.5) {
        bull.push({
          template: {
            id: "v2-tier3-breadth-bull",
            title: `Market breadth strongly positive (A/D = ${t3.advanceDeclineRatio.toFixed(2)})`,
            reasoning: `Advancing issues outnumber decliners ${t3.advanceDeclineRatio.toFixed(2)}-to-1 on NSE — a textbook risk-on tape.`,
            weight: t3.advanceDeclineRatio >= 2 ? "strong" : "moderate",
            keywords: [],
            geopoliticalEvent: "Market microstructure",
          },
          articleIds: [],
        });
      } else if (t3.advanceDeclineRatio <= 0.67) {
        bear.push({
          template: {
            id: "v2-tier3-breadth-bear",
            title: `Market breadth negative (A/D = ${t3.advanceDeclineRatio.toFixed(2)})`,
            reasoning: `Decliners dominate advances ${(1 / t3.advanceDeclineRatio).toFixed(2)}-to-1 on NSE — weak internal tape despite index level.`,
            weight: t3.advanceDeclineRatio <= 0.5 ? "strong" : "moderate",
            keywords: [],
            geopoliticalEvent: "Market microstructure",
          },
          articleIds: [],
        });
      }
    }

    if (!t3.fiiIsStale && Math.abs(t3.fiiNetCrore) >= 500) {
      const isBull = t3.fiiNetCrore > 0;
      const target = isBull ? bull : bear;
      target.push({
        template: {
          id: `v2-tier3-fii-${isBull ? "bull" : "bear"}`,
          title: `FII flow ${isBull ? "positive" : "negative"} (₹${Math.abs(t3.fiiNetCrore).toFixed(0)} cr ${isBull ? "buy" : "sell"})`,
          reasoning: `FIIs net-${isBull ? "bought" : "sold"} ₹${Math.abs(t3.fiiNetCrore).toFixed(0)} cr of Indian equities. FII flow is the dominant intraday price-setter for NIFTY-correlated names.`,
          weight: Math.abs(t3.fiiNetCrore) >= 2000 ? "strong" : "moderate",
          keywords: [],
          geopoliticalEvent: "Foreign institutional flow",
        },
        articleIds: [],
      });
    }

    if (t3.putCallRatio != null) {
      if (t3.putCallRatio <= 0.7) {
        bull.push({
          template: {
            id: "v2-tier3-pcr-bull",
            title: `Options skewed bullish (PCR = ${t3.putCallRatio.toFixed(2)})`,
            reasoning: `Put-Call ratio of ${t3.putCallRatio.toFixed(2)} shows traders buying far more calls than puts — bullish positioning.`,
            weight: "moderate",
            keywords: [],
            geopoliticalEvent: "Options positioning",
          },
          articleIds: [],
        });
      } else if (t3.putCallRatio >= 1.3) {
        bear.push({
          template: {
            id: "v2-tier3-pcr-bear",
            title: `Options skewed bearish (PCR = ${t3.putCallRatio.toFixed(2)})`,
            reasoning: `Put-Call ratio of ${t3.putCallRatio.toFixed(2)} shows heavy put protection — hedged/bearish positioning.`,
            weight: "moderate",
            keywords: [],
            geopoliticalEvent: "Options positioning",
          },
          articleIds: [],
        });
      }
    }

    if (t3.indiaVix5dChange != null) {
      if (t3.indiaVix5dChange <= -10) {
        bull.push({
          template: {
            id: "v2-tier3-vix-bull",
            title: `India VIX collapsing (${t3.indiaVix5dChange.toFixed(1)}% over 5d)`,
            reasoning: `Volatility has fallen ${Math.abs(t3.indiaVix5dChange).toFixed(1)}% over 5 sessions — fear draining out of the market.`,
            weight: "moderate",
            keywords: [],
            geopoliticalEvent: "Volatility regime",
          },
          articleIds: [],
        });
      } else if (t3.indiaVix5dChange >= 20) {
        bear.push({
          template: {
            id: "v2-tier3-vix-bear",
            title: `India VIX spiking (+${t3.indiaVix5dChange.toFixed(1)}% over 5d)`,
            reasoning: `Volatility surged +${t3.indiaVix5dChange.toFixed(1)}% over 5 sessions — risk-off positioning building.`,
            weight: t3.indiaVix5dChange >= 40 ? "strong" : "moderate",
            keywords: [],
            geopoliticalEvent: "Volatility regime",
          },
          articleIds: [],
        });
      }
    }
  }

  // Active geopolitical channels — direction inferred from regime
  const regimeIsBull = signal.regime === "RISK_ON";
  for (const ch of (signal.channelDecaySummary ?? []).slice(0, 3)) {
    if (ch.decayedWeight < 0.3) continue;
    const target = regimeIsBull ? bull : bear;
    target.push({
      template: {
        id: `v2-channel-${ch.channelId}`,
        title: `Geopolitical channel active: ${ch.channelId}`,
        reasoning: `Channel "${ch.channelId}" carries decayed weight ${ch.decayedWeight.toFixed(2)} (triggered ${ch.daysSinceTrigger}d ago) under ${signal.regime} regime.`,
        weight: ch.decayedWeight >= 0.7 ? "strong" : "moderate",
        keywords: [],
        geopoliticalEvent: ch.channelId,
      },
      articleIds: [],
    });
  }

  return { activeBullSignals: bull, activeBearSignals: bear };
}

// ─── Per-asset price impact ───────────────────────────────────────────────────
// Replaces the hardcoded "+0.5% to +1.2%" string from market-agent.ts so each
// asset's impact estimate reflects its own typical daily range and the call's
// magnitude. Falls back to the original constants when history isn't available.
function computePerAssetPriceImpact(
  direction: "up" | "down" | "neutral" | "uncertain",
  magnitude: "strong" | "moderate" | "mild",
  avgDailyRangePct: number | null,
): string {
  if (!avgDailyRangePct || avgDailyRangePct <= 0) {
    return direction === "up" ? "+0.5% to +1.2%"
         : direction === "down" ? "-0.5% to -1.2%"
         : "±0.3%";
  }
  const loMul = magnitude === "strong" ? 0.4 : magnitude === "moderate" ? 0.2 : 0.05;
  const hiMul = magnitude === "strong" ? 1.0 : magnitude === "moderate" ? 0.6 : 0.3;
  const lo = avgDailyRangePct * loMul;
  const hi = avgDailyRangePct * hiMul;
  const fmt = (n: number) => n.toFixed(1);
  if (direction === "up") return `+${fmt(lo)}% to +${fmt(hi)}%`;
  if (direction === "down") return `-${fmt(lo)}% to -${fmt(hi)}%`;
  return `±${fmt(hi)}%`;
}

// ─── Early flip detection ─────────────────────────────────────────────────────

async function detectEarlyFlipAndNotify(
  assetId: string,
  assetSymbol: string,
  currentDirection: AssetDirection,
  currentVerdict: string,
  activeBullSignals: { template: MarketSignalTemplate }[],
  activeBearSignals: { template: MarketSignalTemplate }[]
): Promise<void> {
  try {
    const now = new Date();
    // Find pending snapshots where direction has FLIPPED before the deadline
    const pending = await db
      .select()
      .from(marketSnapshotsTable)
      .where(
        and(
          eq(marketSnapshotsTable.assetId, assetId),
          isNull(marketSnapshotsTable.resolvedAt),
          gt(marketSnapshotsTable.resolveAfter, now) // still within window (not yet due)
        )
      )
      .orderBy(desc(marketSnapshotsTable.snapshotAt))
      .limit(5);

    for (const snap of pending) {
      if (snap.predictedDirection === currentDirection) continue; // direction unchanged, no flip

      // Direction flipped before deadline — mark incorrect immediately
      const flipReason = `Direction flipped from ${snap.predictedDirection.toUpperCase()} to ${currentDirection.toUpperCase()} before the ${snap.timeframe} deadline. ` +
        `Original signals: ${snap.dominantNarrative}. New dominant force: ${
          currentDirection === "up"
            ? activeBullSignals[0]?.template.title ?? "bullish signals"
            : currentDirection === "down"
            ? activeBearSignals[0]?.template.title ?? "bearish signals"
            : "neutral balance"
        }.`;

      // Generate lessons from this failure
      const lessons = `This prediction assumed ${snap.predictedDirection.toUpperCase()} based on: "${snap.assumptions?.slice(0, 200) ?? snap.dominantNarrative}". ` +
        `It failed because the market narrative shifted before the ${snap.timeframe} timeframe expired. ` +
        `Next time: weight ${currentDirection === "up" ? "bullish" : "bearish"} signals more heavily and set a shorter timeframe when signals are mixed.`;

      await db
        .update(marketSnapshotsTable)
        .set({
          resolvedAt: now,
          resolutionDirection: currentDirection,
          isCorrect: false,
          resolutionNotes: `Early flip detected. ${flipReason}`,
          flipReason,
          lessonsLearned: lessons,
        })
        .where(eq(marketSnapshotsTable.id, snap.id));

      // Fire push notification about the flip
      const arrow = currentDirection === "up" ? "↑" : currentDirection === "down" ? "↓" : "→";
      const oldLabel = snap.predictedDirection === "up" ? "BULLISH" : snap.predictedDirection === "down" ? "BEARISH" : "NEUTRAL";
      const newLabel = currentDirection === "up" ? "BULLISH" : currentDirection === "down" ? "BEARISH" : "NEUTRAL";
      void sendPushToAll({
        title: `⚠️ ${assetSymbol} Prediction Flipped Early`,
        body: `Was ${oldLabel} → now ${arrow} ${newLabel} before deadline. Old prediction marked incorrect. ${currentVerdict.slice(0, 80)}…`,
        tag: `flip-${assetId}-${snap.id}`,
        url: "/intelligence",
        assetId,
      });
    }
  } catch {
    // Non-fatal
  }
}

// ─── Resolve expired snapshots against real price ─────────────────────────────

// ─── IST helpers ──────────────────────────────────────────────────────────────

function getISTMinutes(): number {
  const now = new Date();
  return (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % (24 * 60);
}

function isWeekend(): boolean {
  const now = new Date();
  // IST day: UTC + 5:30, so Sunday IST starts Saturday 18:30 UTC
  const istDay = new Date(now.getTime() + 330 * 60 * 1000).getUTCDay();
  return istDay === 0 || istDay === 6; // Sunday or Saturday in IST
}

function isMarketOpen(): boolean {
  return !isWeekend();
}

// ─── Resolve expired snapshots against real price movement ────────────────────

async function resolvePendingSnapshots(
  assetId: string,
  _currentDirection: string, // kept for API compat, not used for scoring
  realPrice: number | null
): Promise<void> {
  try {
    const now = new Date();
    const pending = await db
      .select()
      .from(marketSnapshotsTable)
      .where(
        and(
          eq(marketSnapshotsTable.assetId, assetId),
          isNull(marketSnapshotsTable.resolvedAt),
          lt(marketSnapshotsTable.resolveAfter, now)
        )
      );

    for (const snapshot of pending) {
      // Determine ACTUAL direction from real price movement, not AI prediction
      let actualDirection = "neutral";
      let priceChangePct: string | undefined;

      if (realPrice !== null && snapshot.realPriceAtSnapshot !== null) {
        const snapPrice = parseFloat(snapshot.realPriceAtSnapshot ?? "0");
        const pctChange = ((realPrice - snapPrice) / Math.max(snapPrice, 0.01)) * 100;
        priceChangePct = pctChange.toFixed(2);

        // Significant threshold: 0.1% to avoid noise
        if (pctChange > 0.1) actualDirection = "up";
        else if (pctChange < -0.1) actualDirection = "down";
        else actualDirection = "neutral";
      } else {
        // Fallback: if no price data, mark as unresolvable
        actualDirection = "unknown";
      }

      const isCorrect =
        actualDirection === "unknown"
          ? null
          : snapshot.predictedDirection === actualDirection;

      let notes: string;
      let lessons: string | undefined;

      if (actualDirection === "unknown") {
        notes = `Could not resolve — no price data available at resolution time.`;
      } else if (isCorrect) {
        notes = `Prediction CORRECT. Predicted ${snapshot.predictedDirection.toUpperCase()} and market moved ${actualDirection.toUpperCase()} (${priceChangePct}%).`;
        if (realPrice !== null && priceChangePct !== undefined) {
          notes += ` Price: ${snapshot.realPriceAtSnapshot} → ${realPrice.toFixed(2)}.`;
        }
      } else {
        notes = `Prediction INCORRECT. Predicted ${snapshot.predictedDirection.toUpperCase()} but market moved ${actualDirection.toUpperCase()} (${priceChangePct}%).`;
        if (realPrice !== null && priceChangePct !== undefined) {
          notes += ` Price: ${snapshot.realPriceAtSnapshot} → ${realPrice.toFixed(2)}.`;
        }
        lessons = `Predicted ${snapshot.predictedDirection.toUpperCase()} based on: "${snapshot.dominantNarrative}". ` +
          `Actual outcome: ${actualDirection.toUpperCase()}. ` +
          `Next time weigh counter-signals more heavily when ${snapshot.dominantNarrative.slice(0, 100)} is mixed.`;
      }

      await db
        .update(marketSnapshotsTable)
        .set({
          resolvedAt: now,
          resolutionDirection: actualDirection,
          isCorrect,
          resolutionNotes: notes,
          ...(realPrice !== null ? { realPriceAtResolution: realPrice.toString() } : {}),
          ...(priceChangePct !== undefined ? { priceChangePct } : {}),
          ...(lessons !== undefined ? { lessonsLearned: lessons } : {}),
        })
        .where(eq(marketSnapshotsTable.id, snapshot.id));
    }
  } catch {
    // Non-fatal — proceed even if DB fails
  }
}

async function saveSnapshot(
  assetId: string,
  assetName: string,
  assetSymbol: string,
  direction: AssetDirection,
  magnitude: AssetMagnitude,
  confidence: "high" | "medium" | "low",
  priceImpactEstimate: string,
  timeframe: string,
  bullScore: number,
  bearScore: number,
  dominantNarrative: string,
  verdict: string,
  triggerNewsSummary: string,
  assumptions: string,
  triggerArticleIds: string[],
  realPrice: number | null,
  // ── New Phase-5 fields ──
  extra?: {
    priceScore?: number;
    flipConfirmed?: boolean;
    tier3Evidence?: Record<string, unknown>;
    candleTrustScore?: number;
    candleFlags?: string[];
    regimeAge?: number;
    channelDecaySummary?: Record<string, unknown>[];
    regime?: string;
    regimeProbabilities?: Record<string, number>;
    activeChannels?: string[];
    ensembleVotes?: Record<string, unknown>[];
    uncertaintyFlag?: boolean;
  }
): Promise<void> {
  try {
    // Only persist snapshots when the NSE market is actively open or in pre-market.
    // Skips overnight + weekend writes so the UI never inherits stale "live" data.
    // Override: ALLOW_CLOSED_WRITES env var (for diagnostic dry-runs like
    // simulating "what would Friday's prediction have looked like with the
    // channels pipeline working"). Set to "true" temporarily, restart, fire
    // trigger?force=true, verify, then unset.
    const status = getMarketStatus().status;
    const allowClosedWrites = process.env["ALLOW_CLOSED_WRITES"] === "true";
    if (status === "closed" && !allowClosedWrites) return;

    // Throttle: only save one snapshot per asset per 6 hours (4 per day max)
    // This allows fresh signals during pre-market, open, and post-close windows.
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const recent = await db
      .select({ id: marketSnapshotsTable.id })
      .from(marketSnapshotsTable)
      .where(
        and(
          eq(marketSnapshotsTable.assetId, assetId),
          gt(marketSnapshotsTable.snapshotAt, sixHoursAgo)
        )
      );

    if (recent.length > 0) return; // already snapshotted in last 6h

    const id = `${assetId}-${Date.now()}`;
    // If timeframe is "today", set resolveAfter to 3:30 PM IST today (= 10:00 UTC).
    // Old code did a +330min / setUTCHours(10) / -330min dance which ended up at
    // 04:30 UTC = 10:00 IST (mid-session), making all resolutions capture the
    // wrong intraday price. Just set 10:00 UTC directly on `now`.
    let resolveAfter: Date;
    if (timeframe === "today") {
      const now = new Date();
      resolveAfter = new Date(now);
      resolveAfter.setUTCHours(10, 0, 0, 0); // 15:30 IST market close
      // If it's already past 3:30 PM IST, push to next market day
      if (resolveAfter <= now) {
        resolveAfter = new Date(resolveAfter.getTime() + 24 * 60 * 60 * 1000);
        // Skip to Monday if next day is weekend
        while (isWeekendForDate(resolveAfter)) {
          resolveAfter = new Date(resolveAfter.getTime() + 24 * 60 * 60 * 1000);
        }
      }
    } else {
      resolveAfter = new Date(Date.now() + timeframeToMs(timeframe));
    }

    await db.insert(marketSnapshotsTable).values({
      id,
      assetId,
      assetName,
      assetSymbol,
      predictedDirection: direction,
      predictedMagnitude: magnitude,
      predictedConfidence: confidence,
      priceImpactEstimate,
      timeframe,
      bullScore: bullScore.toString(),
      bearScore: bearScore.toString(),
      dominantNarrative,
      verdict,
      triggerNewsSummary,
      assumptions,
      triggerArticleIds: JSON.stringify(triggerArticleIds),
      resolveAfter,
      ...(realPrice !== null ? { realPriceAtSnapshot: realPrice.toString() } : {}),
      // ── New Phase-5 fields ──
      ...(extra?.priceScore !== undefined ? { priceScore: extra.priceScore } : {}),
      ...(extra?.flipConfirmed !== undefined ? { flipConfirmed: extra.flipConfirmed } : {}),
      ...(extra?.tier3Evidence ? { tier3Evidence: JSON.stringify(extra.tier3Evidence) } : {}),
      ...(extra?.candleTrustScore !== undefined ? { candleTrustScore: extra.candleTrustScore } : {}),
      ...(extra?.candleFlags ? { candleFlags: JSON.stringify(extra.candleFlags) } : {}),
      ...(extra?.regimeAge !== undefined ? { regimeAge: extra.regimeAge } : {}),
      ...(extra?.channelDecaySummary ? { channelDecaySummary: JSON.stringify(extra.channelDecaySummary) } : {}),
      // Persist ensemble votes + regime context so the read-from-DB path can
      // re-synthesize bull/bear signal items without re-running the agent.
      ...(extra?.ensembleVotes ? { ensembleVotes: JSON.stringify(extra.ensembleVotes) } : {}),
      ...(extra?.regime ? { regimeAtSnapshot: extra.regime } : {}),
      ...(extra?.activeChannels ? { activeChannels: JSON.stringify(extra.activeChannels) } : {}),
      ...(extra?.uncertaintyFlag !== undefined ? { uncertaintyFlag: extra.uncertaintyFlag } : {}),
    });
  } catch {
    // Non-fatal
  }
}

function isWeekendForDate(date: Date): boolean {
  const istMs = date.getTime() + 330 * 60 * 1000;
  const istDay = new Date(istMs).getUTCDay();
  return istDay === 0 || istDay === 6;
}

// Adapt a DB market_snapshots row into the response asset shape so the UI
// renders exactly what's persisted. Used by the read-from-DB fast path below.
async function adaptSnapshotToAsset(
  asset: typeof ASSET_TEMPLATES[number],
  snapshot: typeof marketSnapshotsTable.$inferSelect,
  realPrice: number | null,
  recentHistory: Array<typeof marketSnapshotsTable.$inferSelect>,
  lessons: string | null,
): Promise<{
  id: string; name: string; symbol: string;
  direction: "up" | "down" | "neutral";
  magnitude: "strong" | "moderate" | "mild";
  confidence: "high" | "medium" | "low";
  timeframe: string;
  priceImpactEstimate: string;
  bullScore: number; bearScore: number;
  bullSignals: Array<unknown>; bearSignals: Array<unknown>;
  verdict: string; dominantNarrative: string;
  resolveAfter: string;
  currentRealPrice: number | null;
  lessonsFromPastFailures: string | null;
  recentHistory: Array<unknown>;
}> {
  const history = recentHistory.map((r) => {
    const status: "pending" | "correct" | "incorrect" = r.resolvedAt !== null
      ? (r.isCorrect ? "correct" : "incorrect")
      : "pending";
    return {
      id: r.id,
      assetId: r.assetId,
      assetName: r.assetName,
      assetSymbol: r.assetSymbol,
      predictedDirection: r.predictedDirection as "up" | "down" | "neutral",
      predictedMagnitude: r.predictedMagnitude as "strong" | "moderate" | "mild",
      predictedConfidence: r.predictedConfidence as "high" | "medium" | "low",
      priceImpactEstimate: r.priceImpactEstimate,
      timeframe: r.timeframe,
      bullScore: parseFloat(r.bullScore ?? "0"),
      bearScore: parseFloat(r.bearScore ?? "0"),
      dominantNarrative: r.dominantNarrative,
      verdict: r.verdict,
      triggerNewsSummary: r.triggerNewsSummary,
      assumptions: r.assumptions,
      snapshotAt: r.snapshotAt.toISOString(),
      resolveAfter: r.resolveAfter.toISOString(),
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
      resolutionDirection: r.resolutionDirection ?? null,
      realPriceAtSnapshot: r.realPriceAtSnapshot !== null ? parseFloat(r.realPriceAtSnapshot) : null,
      realPriceAtResolution: r.realPriceAtResolution !== null ? parseFloat(r.realPriceAtResolution) : null,
      priceChangePct: r.priceChangePct !== null ? parseFloat(r.priceChangePct) : null,
      isCorrect: r.isCorrect ?? null,
      resolutionNotes: r.resolutionNotes ?? null,
      flipReason: r.flipReason ?? null,
      lessonsLearned: r.lessonsLearned ?? null,
      status,
    };
  });

  // Re-synthesize bull/bear signal items from the persisted ensemble votes so
  // the UI's "BULL SIGNALS (n) — m pts" row shows the agent's actual reasoning,
  // not always "(0)". Falls back to empty if ensemble_votes wasn't stored
  // (older rows before this column was wired into saveSnapshot).
  let cachedBull: { template: MarketSignalTemplate; articleIds: string[] }[] = [];
  let cachedBear: { template: MarketSignalTemplate; articleIds: string[] }[] = [];
  if (snapshot.ensembleVotes) {
    try {
      const votes = JSON.parse(snapshot.ensembleVotes) as Array<{
        window: "6h" | "24h" | "72h"; call: string; confidence: number; rationale?: string;
      }>;
      const fakeSignal: MarketSignal = {
        direction: snapshot.predictedDirection as "up" | "down" | "neutral",
        magnitude: snapshot.predictedMagnitude as "strong" | "moderate" | "mild",
        confidence: snapshot.predictedConfidence as "high" | "medium" | "low",
        timeframe: "intraday",
        priceImpactEstimate: snapshot.priceImpactEstimate,
        verdict: snapshot.verdict,
        dominantNarrative: snapshot.dominantNarrative,
        assumptions: snapshot.assumptions,
        triggerNewsSummary: snapshot.triggerNewsSummary,
        bullScore: parseFloat(snapshot.bullScore ?? "0"),
        bearScore: parseFloat(snapshot.bearScore ?? "0"),
        regime: snapshot.regimeAtSnapshot ?? "",
        regimeProbabilities: {},
        activeGeopoliticalScenarios: [],
        activeChannels: snapshot.activeChannels ? JSON.parse(snapshot.activeChannels) : [],
        ensembleVotes: votes as MarketSignal["ensembleVotes"],
        uncertaintyFlag: snapshot.uncertaintyFlag ?? false,
        priceScore: snapshot.priceScore ?? 0,
        flipConfirmed: snapshot.flipConfirmed ?? false,
        tier3Evidence: { fiiNetCrore: 0, fiiIsStale: true, putCallRatio: null, advanceDeclineRatio: null, deliveryPct: null, indiaVix5dChange: null, tier3Score: 0 },
        candleTrustScore: snapshot.candleTrustScore ?? 0,
        candleFlags: snapshot.candleFlags ? JSON.parse(snapshot.candleFlags) : [],
        regimeAge: snapshot.regimeAge ?? 0,
        channelDecaySummary: [],
      };
      const synth = synthesizeV2Signals(fakeSignal, asset.symbol);
      cachedBull = synth.activeBullSignals;
      cachedBear = synth.activeBearSignals;
    } catch {
      // malformed JSON — fall back to empty
    }
  }

  return {
    id: asset.id,
    name: asset.name,
    symbol: asset.symbol,
    direction: snapshot.predictedDirection as "up" | "down" | "neutral",
    magnitude: snapshot.predictedMagnitude as "strong" | "moderate" | "mild",
    confidence: snapshot.predictedConfidence as "high" | "medium" | "low",
    timeframe: snapshot.timeframe,
    priceImpactEstimate: snapshot.priceImpactEstimate,
    bullScore: parseFloat(snapshot.bullScore ?? "0"),
    bearScore: parseFloat(snapshot.bearScore ?? "0"),
    bullSignals: cachedBull.map(s => ({
      id: s.template.id, title: s.template.title, reasoning: s.template.reasoning,
      weight: s.template.weight, sourceArticleIds: s.articleIds,
      geopoliticalEvent: s.template.geopoliticalEvent,
    })),
    bearSignals: cachedBear.map(s => ({
      id: s.template.id, title: s.template.title, reasoning: s.template.reasoning,
      weight: s.template.weight, sourceArticleIds: s.articleIds,
      geopoliticalEvent: s.template.geopoliticalEvent,
    })),
    verdict: snapshot.verdict,
    dominantNarrative: snapshot.dominantNarrative,
    resolveAfter: snapshot.resolveAfter.toISOString(),
    currentRealPrice: realPrice,
    lessonsFromPastFailures: lessons,
    recentHistory: history,
  };
}

router.get("/intelligence/market-signals", async (req, res) => {
  // ── Fast path: serve latest DB snapshots when available ─────────────────────
  // UI must always reflect what's actually persisted in market_snapshots — no
  // inline agent calls returning values that drift from the saved row. Inline
  // agent only runs when DB has nothing for an asset (cold start). The
  // POST /intelligence/market-signals/trigger endpoint + schedulers are the
  // sole writers in the steady state.
  try {
    const latestPerAsset = await Promise.all(
      ASSET_TEMPLATES.map((a) =>
        db.select().from(marketSnapshotsTable)
          .where(eq(marketSnapshotsTable.assetId, a.id))
          .orderBy(desc(marketSnapshotsTable.snapshotAt))
          .limit(1)
          .then((r) => r[0] ?? null)
          .catch(() => null),
      ),
    );
    const allHaveData = latestPerAsset.every((s) => s !== null);
    if (allHaveData) {
      const [realPrices, histories, lessons] = await Promise.all([
        Promise.all(ASSET_TEMPLATES.map((a) => fetchRealPrice(a.id))),
        Promise.all(ASSET_TEMPLATES.map((a) =>
          db.select().from(marketSnapshotsTable)
            .where(eq(marketSnapshotsTable.assetId, a.id))
            .orderBy(desc(marketSnapshotsTable.snapshotAt))
            .limit(5)
            .catch(() => []),
        )),
        Promise.all(ASSET_TEMPLATES.map((a) => getLessonsFromFailures(a.id))),
      ]);
      const assetsFromDb = await Promise.all(
        ASSET_TEMPLATES.map((asset, idx) =>
          adaptSnapshotToAsset(
            asset,
            latestPerAsset[idx]!,
            realPrices[idx] ?? null,
            histories[idx] ?? [],
            lessons[idx] ?? null,
          ),
        ),
      );
      const marketStatusInfo = getMarketStatus();
      const reasonByStatus: Record<typeof marketStatusInfo.status, string | undefined> = {
        "open": undefined,
        "pre-market": "Market is in pre-open session (08:45–09:15 IST)",
        "closed": isWeekend()
          ? "Indian markets are closed for the weekend"
          : "Indian markets are closed — next session opens at 9:15 AM IST",
      };
      const response = GetIntelligenceMarketSignalsResponse.parse({
        assets: assetsFromDb,
        totalArticlesAnalyzed: _articlesCache.length,
        generatedAt: new Date().toISOString(),
        marketClosed: marketStatusInfo.status === "closed",
        marketClosedReason: reasonByStatus[marketStatusInfo.status],
        marketStatus: marketStatusInfo.status,
        nextSessionOpenAt: marketStatusInfo.nextOpen,
        currentSessionClosesAt: marketStatusInfo.currentClose,
      });
      return res.json(response);
    }
  } catch (err) {
    logger.warn({ err }, "market-signals: DB read fast-path failed, falling back to agent path");
  }

  // ── Cold-start path: no DB snapshot for at least one asset — run agents ─────

  // Pull articles from cache or fetch
  if (_articlesCache.length === 0) {
    try {
      const baseUrl = `http://localhost:${process.env["PORT"] ?? 8080}`;
      const newsRes = await fetch(`${baseUrl}/api/news?pageSize=200`);
      if (newsRes.ok) {
        const data = (await newsRes.json()) as { articles?: RawArticle[] };
        _articlesCache = data.articles ?? [];
      }
    } catch {
      // proceed with empty
    }
  }
  const articles = _articlesCache;

  // ── Phase 4: Check if HMM regime data is available ───────────────────────────
  // When market_regimes has recent data, use regime-aware runMarketAgent instead of
  // keyword-based aiPredictAsset. Falls back to legacy path if no regime data.
  const recentRegimeCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000); // last 24h
  // Scheduler writes a single market-wide row under assetId="nse_market".
  // All Indian assets share that regime. Per-asset rows are also accepted (override).
  const sharedRegime = await db
    .select()
    .from(marketRegimesTable)
    .where(and(eq(marketRegimesTable.assetId, "nse_market"), gt(marketRegimesTable.detectedAt, recentRegimeCutoff)))
    .orderBy(desc(marketRegimesTable.detectedAt))
    .limit(1)
    .then((r) => r[0] ?? null)
    .catch(() => null);

  const recentRegimes = await Promise.all(
    ASSET_TEMPLATES.map(async (a) => {
      try {
        const rows = await db
          .select()
          .from(marketRegimesTable)
          .where(and(eq(marketRegimesTable.assetId, a.id), gt(marketRegimesTable.detectedAt, recentRegimeCutoff)))
          .orderBy(desc(marketRegimesTable.detectedAt))
          .limit(1);
        return rows[0] ?? sharedRegime;
      } catch { return sharedRegime; }
    })
  );
  const useRegimeAgent = recentRegimes.some(r => r !== null);

  // Fetch real prices + 7-day OHLCV history + DB snapshot history + lessons — all in parallel
  const [realPrices, historicalData, assetHistories, assetLessons] = await Promise.all([
    Promise.all(ASSET_TEMPLATES.map((a) => fetchRealPrice(a.id))),
    Promise.all(ASSET_TEMPLATES.map((a) => fetchHistoricalPrices(a.id))),
    Promise.all(ASSET_TEMPLATES.map(async (a) => {
      try {
        const rows = await db
          .select()
          .from(marketSnapshotsTable)
          .where(eq(marketSnapshotsTable.assetId, a.id))
          .orderBy(desc(marketSnapshotsTable.snapshotAt))
          .limit(5);
        return rows;
      } catch { return []; }
    })),
    Promise.all(ASSET_TEMPLATES.map((a) => getLessonsFromFailures(a.id))),
  ]);

  // Run AI predictions for all assets in parallel (each is cached 1hr individually)
  const aiPredictions = await Promise.all(
    ASSET_TEMPLATES.map(async (asset, idx) => {
      const storedRegime = recentRegimes[idx];
      const historical = historicalData[idx] ?? null;
      const lessons = assetLessons[idx] ?? null;

      // ── Phase 4 path: regime-aware market agent ──────────────────────────────
      if (useRegimeAgent && storedRegime) {
        try {
          const candleSummary = historical
            ? historical.candles.map((c) =>
                `${c.date}: O=${c.open} H=${c.high} L=${c.low} C=${c.close} Chg=${c.changePct > 0 ? "+" : ""}${c.changePct}%`
              ).join("\n")
            : "Historical price data unavailable.";
          const marketStats = historical
            ? `7-day change: ${historical.sevenDayChangePct > 0 ? "+" : ""}${historical.sevenDayChangePct}% | Avg daily range: ${historical.avgDailyRangePct}% | Trend: ${historical.trend} | Volatility: ${historical.volatility}`
            : "";

          const regimeState = {
            regime: storedRegime.regime as "RISK_ON" | "RISK_OFF" | "CRISIS",
            probabilities: {
              RISK_ON: storedRegime.riskOnProbability,
              RISK_OFF: storedRegime.riskOffProbability,
              CRISIS: storedRegime.crisisProbability,
            },
            confidence: Math.max(
              storedRegime.riskOnProbability,
              storedRegime.riskOffProbability,
              storedRegime.crisisProbability,
            ),
            sequenceSummary: storedRegime.sequenceSummary ?? "stored",
            avgLogLikelihood: 0,
            driftAlert: false,
          };

          const signal = await runMarketAgent(asset.id, asset.name, asset.symbol, regimeState, candleSummary, marketStats, lessons, {
            ohlcvCandles: historical?.candles.map(c => ({
              date: new Date().toISOString().slice(0, 10), // approximate
              open: c.open,
              high: c.high,
              low: c.low,
              close: c.close,
              volume: c.volume,
              changePct: c.changePct,
            })),
          });
          // Adapt MarketSignal → AIPrediction shape.
          // Synthesize signal items from the agent's internal reasoning so the
          // UI's "BULL SIGNALS (n) — m pts" row reflects real evidence rather
          // than always showing "(0)". And override the agent's hardcoded
          // priceImpactEstimate constant with a per-asset estimate derived
          // from the asset's own avg daily range.
          const { activeBullSignals: synthBull, activeBearSignals: synthBear } =
            synthesizeV2Signals(signal, asset.symbol);
          const perAssetImpact = computePerAssetPriceImpact(
            signal.direction,
            signal.magnitude,
            historical?.avgDailyRangePct ?? null,
          );
          return {
            direction: signal.direction,
            magnitude: signal.magnitude,
            confidence: signal.confidence,
            timeframe: signal.timeframe,
            priceImpactEstimate: perAssetImpact,
            verdict: signal.verdict,
            dominantNarrative: signal.dominantNarrative,
            assumptions: signal.assumptions,
            triggerNewsSummary: signal.triggerNewsSummary,
            bullScore: signal.bullScore,
            bearScore: signal.bearScore,
            activeBullSignals: synthBull,
            activeBearSignals: synthBear,
            _priceScore: signal.priceScore,
            _flipConfirmed: signal.flipConfirmed,
            _tier3Evidence: signal.tier3Evidence as Record<string, unknown>,
            _candleTrustScore: signal.candleTrustScore,
            _candleFlags: signal.candleFlags,
            _regimeAge: signal.regimeAge,
            _channelDecaySummary: signal.channelDecaySummary as Record<string, unknown>[],
            _regime: signal.regime,
            _regimeProbabilities: signal.regimeProbabilities,
            _activeChannels: signal.activeChannels,
            _ensembleVotes: signal.ensembleVotes as unknown as Record<string, unknown>[],
            _uncertaintyFlag: signal.uncertaintyFlag,
          };
        } catch {
          // fall through to legacy path
        }
      }

      // ── Legacy path: keyword bull/bear scoring ────────────────────────────────
      return aiPredictAsset(asset, articles, historical, lessons);
    })
  );

  const assets = ASSET_TEMPLATES.map((asset, idx) => {
    const ai = aiPredictions[idx]!;
    const { direction, magnitude, confidence, timeframe: _aiTimeframe, priceImpactEstimate,
            verdict, dominantNarrative, assumptions, triggerNewsSummary,
            bullScore, bearScore, activeBullSignals, activeBearSignals } = ai;

    // Force all market signals to be "today" (9:00 AM → 3:30 PM IST)
    const timeframe = "today";

    const realPrice = realPrices[idx] ?? null;
    const history = assetHistories[idx] ?? [];

    const triggerArticleIds = [...new Set([
      ...(activeBullSignals ?? []).flatMap((s) => s.articleIds),
      ...(activeBearSignals ?? []).flatMap((s) => s.articleIds),
    ])].slice(0, 10);

    // Fire-and-forget: early flip detection, resolve expired snapshots, save new snapshot
    const safeDirection: AssetDirection = direction === "uncertain" ? "neutral" : direction;
    void detectEarlyFlipAndNotify(asset.id, asset.symbol, safeDirection, verdict, activeBullSignals ?? [], activeBearSignals ?? []);
    void resolvePendingSnapshots(asset.id, safeDirection, realPrice);
    void saveSnapshot(
      asset.id, asset.name, asset.symbol,
      safeDirection, magnitude, confidence,
      priceImpactEstimate, timeframe,
      bullScore, bearScore, dominantNarrative, verdict,
      triggerNewsSummary, assumptions, triggerArticleIds, realPrice,
      {
        priceScore: ai._priceScore,
        flipConfirmed: ai._flipConfirmed,
        tier3Evidence: ai._tier3Evidence,
        candleTrustScore: ai._candleTrustScore,
        candleFlags: ai._candleFlags,
        regimeAge: ai._regimeAge,
        channelDecaySummary: ai._channelDecaySummary,
        regime: ai._regime,
        regimeProbabilities: ai._regimeProbabilities,
        activeChannels: ai._activeChannels,
        ensembleVotes: ai._ensembleVotes,
        uncertaintyFlag: ai._uncertaintyFlag,
      }
    );

    // Resolve at 3:30 PM IST today (or next market day if already past)
    let resolveAfter: string;
    if (timeframe === "today") {
      const now = new Date();
      const istMs = now.getTime() + 330 * 60 * 1000;
      const istDate = new Date(istMs);
      istDate.setUTCHours(10, 0, 0, 0); // 15:30 IST = 10:00 UTC
      let targetMs = istDate.getTime() - 330 * 60 * 1000;
      if (targetMs <= now.getTime()) {
        targetMs += 24 * 60 * 60 * 1000;
        while (isWeekendForDate(new Date(targetMs))) {
          targetMs += 24 * 60 * 60 * 1000;
        }
      }
      resolveAfter = new Date(targetMs).toISOString();
    } else {
      resolveAfter = new Date(Date.now() + timeframeToMs(timeframe)).toISOString();
    }

    // Build recentHistory entries for the UI
    const recentHistory = history.map((r) => {
      const status: "pending" | "correct" | "incorrect" = r.resolvedAt !== null
        ? (r.isCorrect ? "correct" : "incorrect")
        : "pending";
      return {
        id: r.id,
        assetId: r.assetId,
        assetName: r.assetName,
        assetSymbol: r.assetSymbol,
        predictedDirection: r.predictedDirection as "up" | "down" | "neutral",
        predictedMagnitude: r.predictedMagnitude as "strong" | "moderate" | "mild",
        predictedConfidence: r.predictedConfidence as "high" | "medium" | "low",
        priceImpactEstimate: r.priceImpactEstimate,
        timeframe: r.timeframe,
        bullScore: parseFloat(r.bullScore ?? "0"),
        bearScore: parseFloat(r.bearScore ?? "0"),
        dominantNarrative: r.dominantNarrative,
        verdict: r.verdict,
        triggerNewsSummary: r.triggerNewsSummary,
        assumptions: r.assumptions,
        snapshotAt: r.snapshotAt.toISOString(),
        resolveAfter: r.resolveAfter.toISOString(),
        resolvedAt: r.resolvedAt?.toISOString() ?? null,
        resolutionDirection: r.resolutionDirection ?? null,
        realPriceAtSnapshot: r.realPriceAtSnapshot !== null ? parseFloat(r.realPriceAtSnapshot) : null,
        realPriceAtResolution: r.realPriceAtResolution !== null ? parseFloat(r.realPriceAtResolution) : null,
        priceChangePct: r.priceChangePct !== null ? parseFloat(r.priceChangePct) : null,
        isCorrect: r.isCorrect ?? null,
        resolutionNotes: r.resolutionNotes ?? null,
        flipReason: r.flipReason ?? null,
        lessonsLearned: r.lessonsLearned ?? null,
        status,
      };
    });

    // Normalize direction for API contract (schema rejects "uncertain")
    const apiDirection: "up" | "down" | "neutral" = direction === "uncertain" ? "neutral" : direction;

    return {
      id: asset.id,
      name: asset.name,
      symbol: asset.symbol,
      direction: apiDirection,
      magnitude,
      confidence,
      timeframe,
      priceImpactEstimate,
      bullScore,
      bearScore,
      bullSignals: (activeBullSignals ?? []).map((s) => ({
        id: s.template.id,
        title: s.template.title,
        reasoning: s.template.reasoning,
        weight: s.template.weight,
        sourceArticleIds: s.articleIds,
        geopoliticalEvent: s.template.geopoliticalEvent,
      })),
      bearSignals: (activeBearSignals ?? []).map((s) => ({
        id: s.template.id,
        title: s.template.title,
        reasoning: s.template.reasoning,
        weight: s.template.weight,
        sourceArticleIds: s.articleIds,
        geopoliticalEvent: s.template.geopoliticalEvent,
      })),
      verdict,
      dominantNarrative,
      resolveAfter,
      currentRealPrice: realPrice,
      lessonsFromPastFailures: assetLessons[idx] ?? null,
      recentHistory,
    };
  });

  const marketStatusInfo = getMarketStatus();
  const reasonByStatus: Record<typeof marketStatusInfo.status, string | undefined> = {
    "open": undefined,
    "pre-market": "Market is in pre-open session (08:45–09:15 IST)",
    "closed": isWeekend()
      ? "Indian markets are closed for the weekend"
      : "Indian markets are closed — next session opens at 9:15 AM IST",
  };

  const response = GetIntelligenceMarketSignalsResponse.parse({
    assets,
    totalArticlesAnalyzed: articles.length,
    generatedAt: new Date().toISOString(),
    marketClosed: marketStatusInfo.status === "closed",
    marketClosedReason: reasonByStatus[marketStatusInfo.status],
    marketStatus: marketStatusInfo.status,
    nextSessionOpenAt: marketStatusInfo.nextOpen,
    currentSessionClosesAt: marketStatusInfo.currentClose,
  });

  // Fire-and-forget: push notification — throttled per asset
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  const topAsset = assets
    .filter((a) => a.direction !== "neutral")
    .sort((a, b) => Math.max(b.bullScore, b.bearScore) - Math.max(a.bullScore, a.bearScore))[0];
  if (topAsset) {
    const last = _lastNotifiedAsset.get(topAsset.id);
    const directionChanged = !last || last.direction !== topAsset.direction;
    const cooldownExpired = !last || (Date.now() - last.sentAt) > SIX_HOURS;
    if (directionChanged || cooldownExpired) {
      _lastNotifiedAsset.set(topAsset.id, { direction: topAsset.direction, sentAt: Date.now() });
      const arrow = topAsset.direction === "up" ? "↑" : "↓";
      const label = topAsset.direction === "up" ? "BULLISH" : "BEARISH";
      const dominant = topAsset.direction === "up"
        ? topAsset.bullSignals[0]?.title
        : topAsset.bearSignals[0]?.title;
      const resolveDate = new Date(topAsset.resolveAfter).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
      void sendPushToAll({
        title: `🇮🇳 ${topAsset.symbol} Signal: ${arrow} ${label}`,
        body: dominant
          ? `${dominant.slice(0, 70)}${dominant.length > 70 ? "…" : ""} — ${topAsset.priceImpactEstimate} · due ${resolveDate}`
          : `${topAsset.priceImpactEstimate} potential move · due ${resolveDate}`,
        tag: `market-signal-${topAsset.id}`,
        url: "/intelligence",
        assetId: topAsset.id,
      });
    }
  }

  res.json(response);
});

// ─── Manual trigger for market signals ──────────────────────────────────────

router.post("/intelligence/market-signals/trigger", async (req, res) => {
  // Debug flag for diagnostic runs (e.g. simulating "what would Friday's
  // prediction have looked like with channels working"). When force=true is
  // passed, weekend / market-closed gating is bypassed. The result is still
  // not persisted via saveSnapshot (the inner status="closed" check there
  // still blocks writes during closed hours), so this is a non-destructive
  // dry-run that exercises the full read path.
  const force = req.query["force"] === "true";
  if (!force && isWeekend()) {
    res.status(400).json({ error: "Market is closed on weekends" });
    return;
  }

  try {
    // Re-run the same logic as GET but force a new snapshot by clearing the 24h throttle
    // We do this by calling the market signal generation directly
    const baseUrl = `http://localhost:${process.env["PORT"] ?? 8080}`;
    const newsRes = await fetch(`${baseUrl}/api/news?pageSize=200`);
    let articles: RawArticle[] = [];
    if (newsRes.ok) {
      const data = (await newsRes.json()) as { articles?: RawArticle[] };
      articles = data.articles ?? [];
    }

    // Fetch prices
    const realPrices = await Promise.all(ASSET_TEMPLATES.map((a) => fetchRealPrice(a.id)));

    // For each asset, force a new snapshot by bypassing the daily throttle
    for (let idx = 0; idx < ASSET_TEMPLATES.length; idx++) {
      const asset = ASSET_TEMPLATES[idx]!;
      const realPrice = realPrices[idx] ?? null;

      // Use regime agent if available, otherwise legacy
      let ai;
      try {
        const recentRegimeCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const sharedRegime = await db
          .select()
          .from(marketRegimesTable)
          .where(and(eq(marketRegimesTable.assetId, "nse_market"), gt(marketRegimesTable.detectedAt, recentRegimeCutoff)))
          .orderBy(desc(marketRegimesTable.detectedAt))
          .limit(1)
          .then((r) => r[0] ?? null)
          .catch(() => null);

        const assetRegime = await db
          .select()
          .from(marketRegimesTable)
          .where(and(eq(marketRegimesTable.assetId, asset.id), gt(marketRegimesTable.detectedAt, recentRegimeCutoff)))
          .orderBy(desc(marketRegimesTable.detectedAt))
          .limit(1)
          .then((r) => r[0] ?? sharedRegime)
          .catch(() => sharedRegime);

        if (assetRegime) {
          const regimeState = {
            regime: assetRegime.regime as "RISK_ON" | "RISK_OFF" | "CRISIS",
            probabilities: {
              RISK_ON: assetRegime.riskOnProbability,
              RISK_OFF: assetRegime.riskOffProbability,
              CRISIS: assetRegime.crisisProbability,
            },
            confidence: Math.max(assetRegime.riskOnProbability, assetRegime.riskOffProbability, assetRegime.crisisProbability),
            sequenceSummary: assetRegime.sequenceSummary ?? "stored",
            avgLogLikelihood: 0,
            driftAlert: false,
          };
          const signal = await runMarketAgent(asset.id, asset.name, asset.symbol, regimeState, "OHLCV unavailable", "", null, { force: true });
          const safeDir = signal.direction === "uncertain" ? "neutral" : signal.direction;
          // Manual trigger path: pull asset's historical range so price impact
          // is per-asset, and synthesize signal items from agent reasoning.
          const triggerHistorical = await fetchHistoricalPrices(asset.id).catch(() => null);
          const { activeBullSignals: synthBull, activeBearSignals: synthBear } =
            synthesizeV2Signals(signal, asset.symbol);
          const perAssetImpact = computePerAssetPriceImpact(
            signal.direction,
            signal.magnitude,
            triggerHistorical?.avgDailyRangePct ?? null,
          );
          ai = {
            direction: safeDir,
            magnitude: signal.magnitude,
            confidence: signal.confidence,
            timeframe: "today",
            priceImpactEstimate: perAssetImpact,
            verdict: signal.verdict,
            dominantNarrative: signal.dominantNarrative,
            assumptions: signal.assumptions,
            triggerNewsSummary: signal.triggerNewsSummary,
            bullScore: signal.bullScore,
            bearScore: signal.bearScore,
            activeBullSignals: synthBull,
            activeBearSignals: synthBear,
            _priceScore: signal.priceScore,
            _flipConfirmed: signal.flipConfirmed,
            _tier3Evidence: signal.tier3Evidence as Record<string, unknown>,
            _candleTrustScore: signal.candleTrustScore,
            _candleFlags: signal.candleFlags,
            _regimeAge: signal.regimeAge,
            _channelDecaySummary: signal.channelDecaySummary as Record<string, unknown>[],
            _regime: signal.regime,
            _regimeProbabilities: signal.regimeProbabilities,
            _activeChannels: signal.activeChannels,
            _ensembleVotes: signal.ensembleVotes as unknown as Record<string, unknown>[],
            _uncertaintyFlag: signal.uncertaintyFlag,
          };
        } else {
          throw new Error("no regime");
        }
      } catch {
        ai = await aiPredictAsset(asset, articles, null, null);
      }

      const triggerArticleIds: string[] = [];
      void saveSnapshot(
        asset.id, asset.name, asset.symbol,
        ai.direction, ai.magnitude, ai.confidence,
        ai.priceImpactEstimate, "today",
        ai.bullScore, ai.bearScore, ai.dominantNarrative, ai.verdict,
        ai.triggerNewsSummary, ai.assumptions, triggerArticleIds, realPrice,
        {
          priceScore: ai._priceScore,
          flipConfirmed: ai._flipConfirmed,
          tier3Evidence: ai._tier3Evidence,
          candleTrustScore: ai._candleTrustScore,
          candleFlags: ai._candleFlags,
          regimeAge: ai._regimeAge,
          channelDecaySummary: ai._channelDecaySummary,
          regime: ai._regime,
          regimeProbabilities: ai._regimeProbabilities,
          activeChannels: ai._activeChannels,
          ensembleVotes: ai._ensembleVotes,
          uncertaintyFlag: ai._uncertaintyFlag,
        }
      );
    }

    res.json({ success: true, message: "Market signals triggered manually", assets: ASSET_TEMPLATES.length });
  } catch (err) {
    logger.error({ err }, "market-signals/trigger failed");
    res.status(500).json({ error: "Failed to trigger market signals" });
  }
});

// ─── Track Record ─────────────────────────────────────────────────────────────

router.get("/intelligence/track-record", async (req, res) => {
  let rows: (typeof marketSnapshotsTable.$inferSelect)[] = [];
  try {
    rows = await db
      .select()
      .from(marketSnapshotsTable)
      .orderBy(desc(marketSnapshotsTable.snapshotAt));
  } catch {
    // Return empty on DB failure
  }

  const entries = rows.map((r) => {
    let status: "pending" | "correct" | "incorrect" = "pending";
    if (r.resolvedAt !== null) {
      status = r.isCorrect ? "correct" : "incorrect";
    }
    return {
      id: r.id,
      assetId: r.assetId,
      assetName: r.assetName,
      assetSymbol: r.assetSymbol,
      predictedDirection: r.predictedDirection as "up" | "down" | "neutral",
      predictedMagnitude: r.predictedMagnitude as "strong" | "moderate" | "mild",
      predictedConfidence: r.predictedConfidence as "high" | "medium" | "low",
      priceImpactEstimate: r.priceImpactEstimate,
      timeframe: r.timeframe,
      bullScore: parseFloat(r.bullScore ?? "0"),
      bearScore: parseFloat(r.bearScore ?? "0"),
      dominantNarrative: r.dominantNarrative,
      verdict: r.verdict,
      triggerNewsSummary: r.triggerNewsSummary,
      assumptions: r.assumptions,
      snapshotAt: r.snapshotAt.toISOString(),
      resolveAfter: r.resolveAfter.toISOString(),
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
      resolutionDirection: r.resolutionDirection ?? null,
      realPriceAtSnapshot: r.realPriceAtSnapshot !== null ? parseFloat(r.realPriceAtSnapshot ?? "0") : null,
      realPriceAtResolution: r.realPriceAtResolution !== null ? parseFloat(r.realPriceAtResolution ?? "0") : null,
      priceChangePct: r.priceChangePct !== null ? parseFloat(r.priceChangePct ?? "0") : null,
      isCorrect: r.isCorrect ?? null,
      resolutionNotes: r.resolutionNotes ?? null,
      flipReason: r.flipReason ?? null,
      lessonsLearned: r.lessonsLearned ?? null,
      status,
    };
  });

  // Compute stats
  const resolved = entries.filter((e) => e.status !== "pending");
  const correct  = entries.filter((e) => e.status === "correct");

  function assetAccuracy(assetId: string) {
    const a = entries.filter((e) => e.assetId === assetId);
    const r = a.filter((e) => e.status !== "pending");
    const c = a.filter((e) => e.status === "correct");
    return {
      total:       a.length,
      resolved:    r.length,
      correct:     c.length,
      accuracyPct: r.length > 0 ? Math.round((c.length / r.length) * 100) : 0,
    };
  }

  function confAccuracy(conf: string) {
    const a = entries.filter((e) => e.predictedConfidence === conf);
    const r = a.filter((e) => e.status !== "pending");
    const c = a.filter((e) => e.status === "correct");
    return {
      total:       a.length,
      resolved:    r.length,
      correct:     c.length,
      accuracyPct: r.length > 0 ? Math.round((c.length / r.length) * 100) : 0,
    };
  }

  const byAsset: Record<string, { total: number; resolved: number; correct: number; accuracyPct: number }> = {};
  for (const asset of ASSET_TEMPLATES) {
    byAsset[asset.id] = assetAccuracy(asset.id);
  }

  const stats = {
    totalPredictions: entries.length,
    resolved:         resolved.length,
    correct:          correct.length,
    accuracyPct:      resolved.length > 0 ? Math.round((correct.length / resolved.length) * 100) : 0,
    byAsset,
    byConfidence: {
      high:   confAccuracy("high"),
      medium: confAccuracy("medium"),
      low:    confAccuracy("low"),
    },
  };

  const response = GetIntelligenceTrackRecordResponse.parse({
    entries,
    stats,
    generatedAt: new Date().toISOString(),
  });

  res.json(response);
});

// ─── Phase 5: Brier score calibration summary ────────────────────────────────
// GET /api/intelligence/calibration — returns Brier scores and Devil's Advocate accuracy
// across all resolved prediction_v2 entries.

router.get("/intelligence/calibration", async (_req, res) => {
  try {
    const resolved = await db
      .select({
        id: predictionV2Table.id,
        storyId: predictionV2Table.storyId,
        brierScore: predictionV2Table.brierScore,
        devilWasRight: predictionV2Table.devilWasRight,
        missedChannel: predictionV2Table.missedChannel,
        dominantChannel: predictionV2Table.dominantChannel,
        flags: predictionV2Table.flags,
        generatedAt: predictionV2Table.generatedAt,
        resolvedAt: predictionV2Table.resolvedAt,
      })
      .from(predictionV2Table)
      .where(eq(predictionV2Table.resolutionStatus, "auto_resolved"))
      .orderBy(desc(predictionV2Table.resolvedAt))
      .limit(200);

    const withScore = resolved.filter(r => r.brierScore !== null);
    const avgBrier = withScore.length > 0
      ? Math.round((withScore.reduce((s, r) => s + (r.brierScore ?? 0), 0) / withScore.length) * 10000) / 10000
      : null;

    const devilRight = resolved.filter(r => r.devilWasRight === "true").length;
    const devilTotal = resolved.filter(r => r.devilWasRight !== null).length;

    // Channel frequency from resolved predictions
    const channelCounts: Record<string, number> = {};
    for (const r of resolved) {
      const ch = r.missedChannel ?? r.dominantChannel;
      if (ch) channelCounts[ch] = (channelCounts[ch] ?? 0) + 1;
    }

    // Flag frequency
    const flagCounts: Record<string, number> = {};
    for (const r of resolved) {
      try {
        const flags = JSON.parse(r.flags ?? "[]") as string[];
        for (const f of flags) flagCounts[f] = (flagCounts[f] ?? 0) + 1;
      } catch { /* skip */ }
    }

    return res.json({
      totalResolved: resolved.length,
      averageBrierScore: avgBrier,
      brierLabel: avgBrier !== null ? (avgBrier <= 0.10 ? "Excellent" : avgBrier <= 0.20 ? "Good" : avgBrier <= 0.33 ? "Acceptable" : "Poor") : null,
      devilAdvocateAccuracy: devilTotal > 0 ? Math.round((devilRight / devilTotal) * 100) : null,
      devilRight,
      devilTotal,
      topMissedChannels: Object.entries(channelCounts).sort((a, b) => b[1] - a[1]).slice(0, 5),
      flagFrequency: flagCounts,
      entries: resolved.slice(0, 50).map(r => ({
        id: r.id,
        storyId: r.storyId,
        brierScore: r.brierScore,
        devilWasRight: r.devilWasRight === "true",
        missedChannel: r.missedChannel,
        dominantChannel: r.dominantChannel,
        generatedAt: r.generatedAt,
        resolvedAt: r.resolvedAt,
      })),
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ error: "Calibration data unavailable", detail: String(err) });
  }
});

// POST /api/intelligence/predictions/:id/resolve — manual resolution by admin
// Body: { materialisedScenarioIndex: number | null, outcomeDescription: string }

router.post("/intelligence/predictions/:id/resolve", async (req, res) => {
  const adminToken = req.headers["x-admin-token"];
  if (!adminToken || adminToken !== process.env["ADMIN_SECRET"]) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { id } = req.params;
  const { materialisedScenarioIndex, outcomeDescription } = req.body as {
    materialisedScenarioIndex: number | null;
    outcomeDescription: string;
  };

  const rows = await db.select().from(predictionV2Table).where(eq(predictionV2Table.id, id)).limit(1);
  if (!rows.length) return res.status(404).json({ error: "Prediction not found" });

  const row = rows[0]!;
  const { computeBrierScore } = await import("../services/resolution/index.js");
  const { runForensicsAgent } = await import("../services/resolution/forensics.js");

  try {
    const finalScenarios = JSON.parse(row.finalScenarios) as Array<{ label: string; probability: number; narrative?: string; keyIndicators?: string[]; falsificationConditions?: string[]; transmissionChannelIds?: string[]; historicalBaseRate?: number; timeframeDays?: number }>;
    const devilCritique = JSON.parse(row.devilCritique);

    const scored = finalScenarios.map((s, i) => ({
      label: s.label,
      probability: s.probability,
      materialised: i === materialisedScenarioIndex,
    }));
    const brierScore = computeBrierScore(scored);

    const forensics = await runForensicsAgent(
      row.storyId,
      finalScenarios as Parameters<typeof runForensicsAgent>[1],
      devilCritique as Parameters<typeof runForensicsAgent>[2],
      materialisedScenarioIndex,
      outcomeDescription
    );

    await db.update(predictionV2Table)
      .set({
        resolutionStatus: "manually_resolved",
        resolvedAt: new Date(),
        brierScore,
        lessonsLearned: JSON.stringify(forensics.lessonsLearned),
        devilWasRight: String(forensics.devilWasRight),
        missedChannel: forensics.missedChannel,
        dominantChannel: forensics.dominantChannel ?? row.dominantChannel,
      })
      .where(eq(predictionV2Table.id, id));

    return res.json({ ok: true, brierScore, devilWasRight: forensics.devilWasRight });
  } catch (err) {
    return res.status(500).json({ error: "Resolution failed", detail: String(err) });
  }
});

// ─── Phase 3: Corpus ingest (admin) ──────────────────────────────────────────
// POST /api/intelligence/corpus/ingest  — idempotent, one-time data load
// Body: { icb: IcbCrisis[], acled: AcledWindow[] }
// Requires ADMIN_TOKEN header matching ADMIN_SECRET env var.

router.post("/intelligence/corpus/ingest", async (req, res) => {
  const adminToken = req.headers["x-admin-token"];
  const adminSecret = process.env["ADMIN_SECRET"];
  if (!adminSecret || adminToken !== adminSecret) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { ingestIcbCorpus, ingestAcledCorpus } = await import("../services/reasoning/index.js");
  const body = req.body as { icb?: unknown[]; acled?: unknown[] };

  const results: Record<string, string> = {};

  if (Array.isArray(body.icb) && body.icb.length > 0) {
    await ingestIcbCorpus(body.icb as Parameters<typeof ingestIcbCorpus>[0]);
    results["icb"] = `${body.icb.length} crises submitted`;
  }

  if (Array.isArray(body.acled) && body.acled.length > 0) {
    await ingestAcledCorpus(body.acled as Parameters<typeof ingestAcledCorpus>[0]);
    results["acled"] = `${body.acled.length} windows submitted`;
  }

  return res.json({ ok: true, results });
});

export default router;

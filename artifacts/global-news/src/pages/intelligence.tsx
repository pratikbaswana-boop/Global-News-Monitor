import React, { useState, useRef, useEffect } from "react";
import {
  useGetIntelligenceClusters,
  useGetIntelligencePredictions,
  useGetIntelligenceMarketSignals,
  useGetIntelligenceTrackRecord,
  getGetIntelligenceClustersQueryKey,
  getGetIntelligencePredictionsQueryKey,
  getGetIntelligenceMarketSignalsQueryKey,
  getGetIntelligenceTrackRecordQueryKey,
} from "@workspace/api-client-react";
import { AppLayout } from "@/components/layout";
import { ArticleModal } from "@/components/article-modal";
import type { NewsArticle, StoryCluster, Prediction, MarketAsset, MarketSignal, TrackRecordEntry, TrackRecordStats } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelativeTime } from "@/lib/format";
import { SidebarTrigger } from "@/components/ui/sidebar";
import {
  Brain,
  Lock,
  Globe2,
  User2,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Network,
  Telescope,
  AlertTriangle,
  Clock,
  TrendingUp,
  TrendingDown,
  ShieldAlert,
  Info,
  Minus,
  BarChart3,
  Swords,
  Shield,
  Scale,
  Trophy,
  CheckCircle2,
  XCircle,
  Timer,
  Bell,
  BellOff,
} from "lucide-react";

const debug = (event: string, detail?: unknown) => {
  try {
    console.info("[intel-page]", event, detail ?? "");
  } catch {
  }
};

class IntelligenceErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean; message: string }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: "" };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, message: error?.message ?? "Unknown error" };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    debug("crash", { message: error.message, stack: error.stack, componentStack: info.componentStack });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center p-6 bg-background text-foreground">
          <div className="max-w-md w-full rounded-lg border border-destructive/30 bg-destructive/5 p-4 space-y-2">
            <div className="font-semibold text-destructive">Intelligence page crashed</div>
            <div className="text-sm text-muted-foreground break-words">{this.state.message}</div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

// ─── Password Gate ────────────────────────────────────────────────────────────

const CORRECT_PASSWORD = "e6cdcecb-f7f7-4e93-ad93-d10e1f45d4fc";
const STORAGE_KEY = "intel_access_granted";

function getStoredAccess() {
  try {
    debug("session-check", {
      standalone: window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true,
    });
    return sessionStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    debug("session-check-failed");
    return false;
  }
}

function IntelligenceShell({ children }: { children: React.ReactNode }) {
  return (
    <AppLayout>
      <div className="flex-1 overflow-y-auto">
        <div className="p-6 max-w-screen-xl mx-auto space-y-6">
          {children}
        </div>
      </div>
    </AppLayout>
  );
}

function PasswordGate({ onAccess }: { onAccess: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState(false);
  const [shake, setShake] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    debug("auth-submit", { length: value.length });
    if (value.trim() === CORRECT_PASSWORD) {
      try {
        sessionStorage.setItem(STORAGE_KEY, "1");
        debug("auth-success-storage");
      } catch {
        debug("auth-success-storage-failed");
      }
      onAccess();
    } else {
      debug("auth-failed");
      setError(true);
      setShake(true);
      setTimeout(() => setShake(false), 500);
      setValue("");
    }
  };

  return (
    <AppLayout>
      <div className="fixed top-3 left-3 z-50 md:hidden">
        <SidebarTrigger className="h-10 w-10 rounded-full border border-border bg-card shadow-sm" />
      </div>
      <div className="flex-1 flex items-center justify-center p-6">
        <div className={`w-full max-w-sm space-y-6 ${shake ? "animate-shake" : ""}`}>
          <div className="text-center space-y-3">
            <div className="flex items-center justify-center">
              <div className="h-14 w-14 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center">
                <Lock className="h-6 w-6 text-primary" />
              </div>
            </div>
            <h1 className="text-2xl font-bold tracking-tight">Intelligence Access</h1>
            <p className="text-sm text-muted-foreground">
              This section contains classified analysis. Enter your access key to continue.
            </p>
          </div>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <input
                ref={inputRef}
                type="password"
                value={value}
                onChange={(e) => { setValue(e.target.value); setError(false); }}
                placeholder="Enter access key"
                className={`w-full bg-background border rounded-lg px-4 py-3 text-sm font-mono tracking-widest outline-none transition-colors ${
                  error ? "border-destructive focus:border-destructive" : "border-border focus:border-primary"
                }`}
                autoComplete="off"
                spellCheck={false}
              />
              {error && <p className="text-xs text-destructive font-medium">Invalid access key. Try again.</p>}
            </div>
            <button type="submit" className="w-full bg-primary text-primary-foreground rounded-lg px-4 py-3 text-sm font-semibold hover:bg-primary/90 transition-colors">
              Authenticate
            </button>
          </form>
        </div>
      </div>
    </AppLayout>
  );
}

// ─── Market Asset Card ────────────────────────────────────────────────────────

function SignalRow({ signal, side, allArticles, onArticleClick }: {
  signal: MarketSignal;
  side: "bull" | "bear";
  allArticles: NewsArticle[];
  onArticleClick: (a: NewsArticle) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isBull = side === "bull";
  const weightConfig = {
    strong: { label: "STRONG", color: isBull ? "text-emerald-400 bg-emerald-400/10 border-emerald-400/30" : "text-red-400 bg-red-400/10 border-red-400/30" },
    moderate: { label: "MODERATE", color: isBull ? "text-teal-400 bg-teal-400/10 border-teal-400/30" : "text-orange-400 bg-orange-400/10 border-orange-400/30" },
    weak: { label: "WEAK", color: "text-slate-400 bg-slate-400/10 border-slate-400/30" },
  }[signal.weight];

  const sources = allArticles.filter((a) => signal.sourceArticleIds.includes(a.id));

  return (
    <div className={`rounded-lg border ${isBull ? "border-emerald-500/20 bg-emerald-500/5" : "border-red-500/20 bg-red-500/5"}`}>
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-start gap-3 p-3 text-left"
      >
        <div className="shrink-0 mt-0.5">
          {isBull
            ? <TrendingUp className="h-3.5 w-3.5 text-emerald-400" />
            : <TrendingDown className="h-3.5 w-3.5 text-red-400" />}
        </div>
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-[9px] font-bold tracking-wider px-1.5 py-0.5 rounded border ${weightConfig.color}`}>
              {weightConfig.label}
            </span>
            <p className="text-xs font-semibold text-foreground/90 leading-snug">{signal.title}</p>
          </div>
          <p className="text-[10px] text-muted-foreground font-mono">{signal.geopoliticalEvent}</p>
        </div>
        <div className="shrink-0 text-muted-foreground">
          {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border/30 divide-y divide-border/20">
          <div className="px-3 py-2.5 space-y-1">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Why this matters</p>
            <p className="text-xs text-muted-foreground leading-relaxed">{signal.reasoning}</p>
          </div>
          {sources.length > 0 && (
            <div className="px-3 py-2 space-y-1">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Evidence articles ({sources.length})</p>
              {sources.slice(0, 3).map((article) => (
                <button
                  key={article.id}
                  onClick={(e) => { e.stopPropagation(); onArticleClick(article); }}
                  className="w-full text-left py-1.5 px-2 rounded hover:bg-muted/30 transition-colors group"
                >
                  <p className="text-xs font-medium text-foreground/80 group-hover:text-primary transition-colors line-clamp-1">{article.title}</p>
                  <p className="text-[10px] text-muted-foreground font-mono">{formatRelativeTime(article.publishedAt)} · {article.source}</p>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AssetHistoryTimeline({ history }: { history: NonNullable<MarketAsset["recentHistory"]> }) {
  if (history.length === 0) return null;
  return (
    <div className="border-t border-border/30 px-4 py-3 space-y-2">
      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
        <Clock className="h-3 w-3" /> Prediction history ({history.length} snapshots)
      </p>
      <div className="space-y-2">
        {history.map((snap) => {
          const dirArrow = { up: "↑", down: "↓", neutral: "→" }[snap.predictedDirection];
          const dirColor = { up: "text-emerald-400", down: "text-red-400", neutral: "text-slate-400" }[snap.predictedDirection];
          const statusCfg = {
            correct:   { dot: "bg-emerald-400", label: "✓ Correct",       cls: "text-emerald-400" },
            incorrect: { dot: "bg-red-400",     label: "✗ Wrong",         cls: "text-red-400"     },
            pending:   { dot: "bg-amber-400",   label: "⏳ Pending",       cls: "text-amber-400"   },
          }[snap.status];
          return (
            <div key={snap.id} className="flex items-start gap-2.5 bg-muted/20 rounded-lg p-2.5">
              <div className={`h-2 w-2 rounded-full shrink-0 mt-1 ${statusCfg.dot}`} />
              <div className="flex-1 min-w-0 space-y-0.5">
                {/* Row 1: direction + narrative + date */}
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-sm font-bold font-mono ${dirColor}`}>{dirArrow}</span>
                  <span className="text-[10px] font-medium text-foreground/80 line-clamp-1 flex-1">{snap.dominantNarrative}</span>
                  <span className="text-[10px] font-mono text-muted-foreground shrink-0">{formatRelativeTime(snap.snapshotAt)}</span>
                </div>
                {/* Row 2: status + real price if available */}
                <div className="flex items-center gap-3 text-[10px] font-mono">
                  <span className={`font-semibold ${statusCfg.cls}`}>{statusCfg.label}</span>
                  {snap.realPriceAtSnapshot != null && (
                    <span className="text-muted-foreground">price {snap.realPriceAtSnapshot.toLocaleString()}</span>
                  )}
                  {snap.priceChangePct != null && (
                    <span className={snap.priceChangePct >= 0 ? "text-emerald-400" : "text-red-400"}>
                      {snap.priceChangePct >= 0 ? "+" : ""}{snap.priceChangePct.toFixed(2)}%
                    </span>
                  )}
                  {snap.flipReason && (
                    <span className="text-orange-400 font-semibold">⚠ Flipped early</span>
                  )}
                </div>
                {/* Part 1: News that triggered it */}
                {snap.triggerNewsSummary && snap.triggerNewsSummary !== "No specific news articles matched this prediction's signals." && (
                  <div className="mt-1.5 space-y-0.5">
                    <p className="text-[9px] font-bold uppercase tracking-wider text-primary/70">News signal</p>
                    <p className="text-[10px] text-muted-foreground leading-relaxed line-clamp-2 font-mono">{snap.triggerNewsSummary.split("\n")[0]}</p>
                  </div>
                )}
                {/* Part 2: Assumptions */}
                {snap.assumptions && (
                  <div className="mt-1 space-y-0.5">
                    <p className="text-[9px] font-bold uppercase tracking-wider text-amber-400/70">Assumption</p>
                    <p className="text-[10px] text-muted-foreground leading-relaxed line-clamp-2">{snap.assumptions.split("\n")[0]}</p>
                  </div>
                )}
                {/* Part 3: What changed */}
                {snap.resolutionNotes && (
                  <div className="mt-1 space-y-0.5">
                    <p className={`text-[9px] font-bold uppercase tracking-wider ${snap.status === "correct" ? "text-emerald-400/70" : "text-red-400/70"}`}>Outcome</p>
                    <p className="text-[10px] text-muted-foreground leading-relaxed line-clamp-2">{snap.resolutionNotes}</p>
                  </div>
                )}
                {/* Lessons learned */}
                {snap.lessonsLearned && snap.status === "incorrect" && (
                  <div className="mt-1 p-1.5 bg-orange-950/30 rounded space-y-0.5">
                    <p className="text-[9px] font-bold uppercase tracking-wider text-orange-400/70">Lesson fed into next prediction</p>
                    <p className="text-[10px] text-orange-200/60 leading-relaxed italic line-clamp-2">{snap.lessonsLearned}</p>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MarketAssetCard({ asset, allArticles, onArticleClick }: {
  asset: MarketAsset;
  allArticles: NewsArticle[];
  onArticleClick: (a: NewsArticle) => void;
}) {
  const [showDebate, setShowDebate] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const dirConfig = {
    up: {
      arrow: "↑",
      label: "BULLISH",
      color: "text-emerald-400",
      bg: "bg-emerald-400/10 border-emerald-400/30",
      stripe: "bg-emerald-400",
      icon: <TrendingUp className="h-5 w-5 text-emerald-400" />,
    },
    down: {
      arrow: "↓",
      label: "BEARISH",
      color: "text-red-400",
      bg: "bg-red-400/10 border-red-400/30",
      stripe: "bg-red-400",
      icon: <TrendingDown className="h-5 w-5 text-red-400" />,
    },
    neutral: {
      arrow: "→",
      label: "NEUTRAL",
      color: "text-slate-400",
      bg: "bg-slate-400/10 border-slate-400/30",
      stripe: "bg-slate-400",
      icon: <Minus className="h-5 w-5 text-slate-400" />,
    },
  }[asset.direction];

  const magnitudeLabel = { strong: "Strong", moderate: "Moderate", mild: "Mild" }[asset.magnitude];
  const confColor = { high: "text-emerald-400", medium: "text-amber-400", low: "text-slate-400" }[asset.confidence];

  // Compute the bull/bear ratio bar
  const total = asset.bullScore + asset.bearScore;
  const bullPct = total > 0 ? Math.round((asset.bullScore / total) * 100) : 50;
  const bearPct = 100 - bullPct;

  return (
    <Card className="border-border/60 overflow-hidden">
      {/* Direction stripe */}
      <div className={`h-1 w-full ${dirConfig.stripe}`} />

      <CardHeader className="pb-3 border-b border-border/40">
        <div className="flex items-start gap-4">
          {/* Asset name + symbol */}
          <div className="flex-1 space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold font-mono text-muted-foreground bg-muted px-2 py-0.5 rounded">{asset.symbol}</span>
              <h3 className="text-base font-bold">{asset.name}</h3>
            </div>
            <p className="text-xs text-muted-foreground leading-snug line-clamp-2">{asset.dominantNarrative}</p>
          </div>

          {/* Direction badge */}
          <div className={`shrink-0 flex flex-col items-center gap-1 px-3 py-2 rounded-lg border ${dirConfig.bg}`}>
            {dirConfig.icon}
            <span className={`text-[10px] font-bold tracking-wider ${dirConfig.color}`}>{dirConfig.label}</span>
          </div>
        </div>

        {/* Key metrics row */}
        <div className="grid grid-cols-3 gap-2 pt-2">
          <div className="bg-muted/30 rounded-lg p-2 text-center space-y-0.5">
            <p className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">Impact</p>
            <p className={`text-sm font-bold font-mono ${dirConfig.color}`}>{asset.priceImpactEstimate}</p>
          </div>
          <div className="bg-muted/30 rounded-lg p-2 text-center space-y-0.5">
            <p className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">Timeframe</p>
            <p className="text-sm font-bold font-mono text-foreground">{asset.timeframe}</p>
            {asset.resolveAfter && (
              <p className="text-[9px] font-mono text-amber-400">
                due {new Date(asset.resolveAfter).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              </p>
            )}
          </div>
          <div className="bg-muted/30 rounded-lg p-2 text-center space-y-0.5">
            <p className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">Strength</p>
            <p className={`text-sm font-bold font-mono ${confColor}`}>{asset.confidence.toUpperCase()}</p>
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-0">
        {/* Bull vs Bear score bar */}
        <div className="px-4 py-3 space-y-2 border-b border-border/30">
          <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider">
            <span className="flex items-center gap-1 text-emerald-400">
              <Swords className="h-3 w-3" />Bull signals ({asset.bullSignals.length}) — {asset.bullScore} pts
            </span>
            <span className="flex items-center gap-1 text-red-400">
              Bear signals ({asset.bearSignals.length}) — {asset.bearScore} pts
              <Shield className="h-3 w-3" />
            </span>
          </div>
          <div className="flex h-2.5 rounded-full overflow-hidden gap-0.5">
            <div
              className="bg-emerald-400 rounded-l-full transition-all"
              style={{ width: `${bullPct}%` }}
            />
            <div
              className="bg-red-400 rounded-r-full transition-all"
              style={{ width: `${bearPct}%` }}
            />
          </div>
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>{bullPct}% bullish weight</span>
            <span>{bearPct}% bearish weight</span>
          </div>
        </div>

        {/* Verdict */}
        <div className="px-4 py-3 border-b border-border/30 bg-muted/10 space-y-1">
          <div className="flex items-center gap-1.5">
            <Scale className="h-3.5 w-3.5 text-muted-foreground" />
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Validation Verdict</p>
          </div>
          <p className="text-xs text-foreground/80 leading-relaxed">{asset.verdict}</p>
        </div>

        {/* Lessons from past failures */}
        {asset.lessonsFromPastFailures && (
          <div className="px-4 py-3 border-t border-border/30 bg-orange-950/15 space-y-1.5">
            <div className="flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 text-orange-400 shrink-0" />
              <p className="text-[10px] font-bold uppercase tracking-wider text-orange-400">Lessons from past failures (applied to this prediction)</p>
            </div>
            <div className="space-y-1">
              {asset.lessonsFromPastFailures.split("\n").map((line, i) => (
                <p key={i} className="text-xs text-orange-200/60 leading-relaxed italic">{line}</p>
              ))}
            </div>
          </div>
        )}

        {/* Real price row */}
        {asset.currentRealPrice != null && (
          <div className="px-4 py-2 border-t border-border/30 bg-muted/5 flex items-center gap-2">
            <ShieldAlert className="h-3 w-3 text-muted-foreground shrink-0" />
            <p className="text-[10px] text-muted-foreground font-mono">
              Live price: <span className="text-foreground font-semibold">{asset.currentRealPrice.toLocaleString()}</span>
              <span className="ml-1.5 text-muted-foreground/60">(Yahoo Finance · refreshed every 30 min)</span>
            </p>
          </div>
        )}

        {/* Toggle debate */}
        <button
          onClick={() => setShowDebate((d) => !d)}
          className="w-full flex items-center justify-between px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:bg-muted/20 transition-colors border-t border-border/30"
        >
          <span className="flex items-center gap-2">
            <BarChart3 className="h-3.5 w-3.5" />
            Full signal debate — {asset.bullSignals.length + asset.bearSignals.length} forces analysed
          </span>
          {showDebate ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>

        {showDebate && (
          <div className="border-t border-border/30 divide-y divide-border/30">
            {/* Bull side */}
            {asset.bullSignals.length > 0 && (
              <div className="p-4 space-y-2">
                <div className="flex items-center gap-2 mb-3">
                  <TrendingUp className="h-3.5 w-3.5 text-emerald-400" />
                  <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-400">Forces pushing {asset.symbol} UP</p>
                  <span className="ml-auto text-[10px] font-mono text-muted-foreground">{asset.bullScore} pts</span>
                </div>
                {asset.bullSignals.map((signal) => (
                  <SignalRow
                    key={signal.id}
                    signal={signal}
                    side="bull"
                    allArticles={allArticles}
                    onArticleClick={onArticleClick}
                  />
                ))}
              </div>
            )}

            {/* Bear side */}
            {asset.bearSignals.length > 0 && (
              <div className="p-4 space-y-2">
                <div className="flex items-center gap-2 mb-3">
                  <TrendingDown className="h-3.5 w-3.5 text-red-400" />
                  <p className="text-[10px] font-bold uppercase tracking-wider text-red-400">Forces pushing {asset.symbol} DOWN</p>
                  <span className="ml-auto text-[10px] font-mono text-muted-foreground">{asset.bearScore} pts</span>
                </div>
                {asset.bearSignals.map((signal) => (
                  <SignalRow
                    key={signal.id}
                    signal={signal}
                    side="bear"
                    allArticles={allArticles}
                    onArticleClick={onArticleClick}
                  />
                ))}
              </div>
            )}

            {asset.bullSignals.length === 0 && asset.bearSignals.length === 0 && (
              <div className="p-6 text-center text-muted-foreground text-xs">
                No active signals detected in the current news cycle for this asset.
              </div>
            )}
          </div>
        )}

        {/* Toggle prediction history */}
        {asset.recentHistory && asset.recentHistory.length > 0 && (
          <>
            <button
              onClick={() => setShowHistory((h) => !h)}
              className="w-full flex items-center justify-between px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:bg-muted/20 transition-colors border-t border-border/30"
            >
              <span className="flex items-center gap-2">
                <Clock className="h-3.5 w-3.5" />
                Prediction history — {asset.recentHistory.length} past snapshot{asset.recentHistory.length !== 1 ? "s" : ""}
                {asset.recentHistory.filter((h) => h.status === "incorrect").length > 0 && (
                  <span className="text-red-400 font-mono">· {asset.recentHistory.filter((h) => h.status === "incorrect").length} failed</span>
                )}
              </span>
              {showHistory ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
            {showHistory && <AssetHistoryTimeline history={asset.recentHistory} />}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Market Impact Derivation ─────────────────────────────────────────────────

const INDIA_IMPACT_ASSETS = [
  { symbol: "NIFTY", name: "NIFTY 50", desc: "Broad Indian large-cap equities" },
  { symbol: "SENSEX", name: "SENSEX", desc: "Top-30 Bombay Stock Exchange index" },
  { symbol: "RELIANCE", name: "Reliance", desc: "Refining, petrochemicals & energy" },
  { symbol: "TCS", name: "TCS", desc: "India's largest IT exporter" },
  { symbol: "HDFCBANK", name: "HDFC Bank", desc: "India's largest private bank" },
] as const;

const COMMODITY_IMPACT_ASSETS = [
  { symbol: "GOLD", name: "Gold", desc: "Safe-haven metal and inflation hedge" },
  { symbol: "SILVER", name: "Silver", desc: "Precious metal tied to risk sentiment and industrial demand" },
] as const;

type ImpactDirection = "up" | "down" | "neutral";

interface AssetImpact {
  symbol: string;
  name: string;
  desc: string;
  direction: ImpactDirection;
  reason: string;
  magnitude: "strong" | "moderate" | "mild";
}

function derivePredictionMarketImpact(prediction: Prediction): AssetImpact[] {
  const text = `${prediction.headline} ${prediction.reasoning} ${prediction.triggerSummary}`.toLowerCase();
  const countries = prediction.countries.map((c) => c.toLowerCase());
  const cat = prediction.category;
  const risk = prediction.riskLevel;

  const isHighRisk = risk === "critical" || risk === "high";
  const isTensions = cat === "tensions";
  const isSanctions = cat === "sanctions";
  const isDeals = cat === "deals";
  const hasIndia = countries.some((c) => c.includes("india"));
  const hasPakistan = countries.some((c) => c.includes("pakistan"));
  const hasUS = countries.some((c) => c.includes("united states") || c.includes("us") || c.includes("america"));
  const hasChina = countries.some((c) => c.includes("china"));
  const hasOil = text.includes("oil") || text.includes("crude") || text.includes("opec") || text.includes("iran") || text.includes("energy") || text.includes("petroleum");
  const hasMetals = text.includes("gold") || text.includes("silver") || text.includes("bullion") || text.includes("precious metal") || text.includes("safe haven") || text.includes("inflation");
  const hasBank = text.includes("bank") || text.includes("rbi") || text.includes("rate") || text.includes("inflation") || text.includes("credit") || text.includes("monetary");
  const hasTech = text.includes("tech") || text.includes("visa") || text.includes("software") || text.includes("it ") || text.includes("digital");
  const hasRecession = text.includes("recession") || text.includes("slowdown") || text.includes("gdp") || text.includes("unemployment");
  const hasCeasefire = text.includes("ceasefire") || text.includes("peace") || text.includes("diplomacy") || text.includes("negotiat");

  const impacts: AssetImpact[] = [];

  // ── NIFTY & SENSEX: broad India market ──
  {
    let dir: ImpactDirection = "neutral";
    let reason = "Limited direct India equity impact expected";
    let mag: "strong" | "moderate" | "mild" = "mild";

    if ((hasIndia || hasPakistan) && (isTensions || isSanctions)) {
      dir = "down"; reason = "India-region tensions trigger FII outflows and risk-off selling"; mag = isHighRisk ? "strong" : "moderate";
    } else if (isHighRisk && !hasIndia && !isDeals) {
      dir = "down"; reason = "Global risk-off sentiment drives FII selling in emerging markets"; mag = "moderate";
    } else if (isDeals || hasCeasefire) {
      dir = "up"; reason = "Diplomatic progress boosts risk appetite and foreign inflows"; mag = hasIndia ? "strong" : "moderate";
    } else if (hasChina && isTensions) {
      dir = "down"; reason = "India–China tensions weigh on border-sensitive sectors"; mag = "moderate";
    }

    if (dir !== "neutral" || mag === "mild") {
      impacts.push({ ...INDIA_IMPACT_ASSETS[0], direction: dir, reason, magnitude: mag });
      impacts.push({ ...INDIA_IMPACT_ASSETS[1], direction: dir, reason: reason.replace("FII outflows", "broad index selling").replace("foreign inflows", "broad index rally"), magnitude: mag });
    }
  }

  // ── RELIANCE: oil & energy proxy ──
  if (hasOil) {
    let dir: ImpactDirection = "neutral";
    let reason = "Oil price movement affects refining margins";
    let mag: "strong" | "moderate" | "mild" = "moderate";

    if (isTensions || isSanctions || text.includes("supply cut") || text.includes("sanctions on iran") || text.includes("conflict")) {
      dir = "up"; reason = "Crude supply disruption widens Reliance's refining & petchem margins"; mag = isHighRisk ? "strong" : "moderate";
    } else if (isDeals || hasCeasefire || text.includes("supply increase") || text.includes("opec+ increase")) {
      dir = "down"; reason = "Crude price fall compresses refinery margins and energy revenues"; mag = "moderate";
    } else {
      dir = "neutral"; reason = "Oil price uncertainty keeps Reliance in consolidation mode"; mag = "mild";
    }
    impacts.push({ ...INDIA_IMPACT_ASSETS[2], direction: dir, reason, magnitude: mag });
  } else if (hasIndia && (isTensions || isDeals)) {
    impacts.push({ ...INDIA_IMPACT_ASSETS[2], direction: isTensions ? "down" : "up", reason: isTensions ? "Domestic risk-off pressures conglomerate valuations" : "India trade deals expand Reliance's consumer market", magnitude: "mild" });
  }

  // ── TCS: US IT demand & visa sensitivity ──
  if (hasUS || hasTech || hasRecession) {
    let dir: ImpactDirection = "neutral";
    let reason = "US economic conditions affect IT outsourcing demand";
    let mag: "strong" | "moderate" | "mild" = "moderate";

    if (hasRecession || (isHighRisk && hasUS)) {
      dir = "down"; reason = "US recession risk cuts enterprise IT budgets and outsourcing contracts"; mag = "strong";
    } else if (isSanctions && hasUS) {
      dir = "down"; reason = "Trade/visa restrictions on Indian IT reduce H-1B onsite delivery capacity"; mag = "moderate";
    } else if (isDeals && hasUS) {
      dir = "up"; reason = "US–India trade deal boosts IT spending and eases visa restrictions"; mag = "moderate";
    } else if (hasTech && isTensions) {
      dir = "down"; reason = "Tech-sector tension increases client uncertainty, delaying IT contracts"; mag = "mild";
    } else {
      dir = "neutral"; reason = "US conditions stable — no material change to TCS deal pipeline"; mag = "mild";
    }
    if (dir !== "neutral" || mag !== "mild") {
      impacts.push({ ...INDIA_IMPACT_ASSETS[3], direction: dir, reason, magnitude: mag });
    }
  } else if (hasIndia && isTensions) {
    impacts.push({ ...INDIA_IMPACT_ASSETS[3], direction: "down", reason: "India instability raises client risk perception for long-term IT contracts", magnitude: "mild" });
  }

  // ── GOLD / SILVER: always shown — react to risk sentiment ──
  {
    const goldDir: ImpactDirection = isDeals || hasCeasefire ? "down" : (isHighRisk || isTensions || isSanctions || hasMetals) ? "up" : "neutral";
    const silverDir: ImpactDirection = isDeals || hasCeasefire ? "down" : (isHighRisk || isTensions || isSanctions || hasMetals) ? "up" : "neutral";
    const goldMag: "strong" | "moderate" | "mild" = isHighRisk ? "strong" : (isTensions || isSanctions) ? "moderate" : "mild";
    const silverMag: "strong" | "moderate" | "mild" = goldMag;

    const goldReason =
      goldDir === "up"   ? "Geopolitical uncertainty drives safe-haven flows into gold" :
      goldDir === "down" ? "Improved risk appetite and deal momentum reduce safe-haven demand for gold" :
                           "Neutral risk environment — gold likely range-bound";
    const silverReason =
      silverDir === "up"   ? "Precious-metal demand rises alongside gold in risk-off sentiment" :
      silverDir === "down" ? "Lower tension reduces safe-haven buying; industrial silver also softens" :
                             "Mixed signals — silver tracking gold without strong catalyst";

    impacts.push({ symbol: "GOLD",   name: "Gold",   desc: "Safe-haven metal and inflation hedge",                        direction: goldDir,   reason: goldReason,   magnitude: goldMag });
    impacts.push({ symbol: "SILVER", name: "Silver", desc: "Precious metal — tracks gold and industrial commodity demand", direction: silverDir, reason: silverReason, magnitude: silverMag });
  }

  // ── HDFC Bank: India credit & rates ──
  if (hasBank || (hasIndia && (isHighRisk || isDeals))) {
    let dir: ImpactDirection = "neutral";
    let reason = "Indian banking conditions remain unchanged";
    let mag: "strong" | "moderate" | "mild" = "mild";

    if (text.includes("rate hike") || text.includes("tightening") || (isTensions && hasIndia)) {
      dir = "down"; reason = "Rate tightening or flight-to-safety compresses bank NIM and loan growth"; mag = "moderate";
    } else if (text.includes("rate cut") || text.includes("rate easing") || text.includes("rbi cut")) {
      dir = "up"; reason = "RBI easing boosts loan demand and net interest margins for HDFC Bank"; mag = "strong";
    } else if (isDeals && (hasIndia || hasUS)) {
      dir = "up"; reason = "Economic stability from deal supports credit growth and asset quality"; mag = "moderate";
    } else if (isHighRisk && hasIndia) {
      dir = "down"; reason = "Risk-off environment raises NPA concerns and reduces credit appetite"; mag = "moderate";
    }
    if (dir !== "neutral") {
      impacts.push({ ...INDIA_IMPACT_ASSETS[4], direction: dir, reason, magnitude: mag });
    }
  }

  return impacts;
}

// ─── Prediction Card ──────────────────────────────────────────────────────────

function PredictionCard({ prediction, onArticleClick, allArticles }: {
  prediction: Prediction;
  onArticleClick: (article: NewsArticle) => void;
  allArticles: NewsArticle[];
}) {
  const [expanded, setExpanded] = useState(false);

  const getRiskConfig = (risk: string) => {
    switch (risk) {
      case "critical": return { color: "text-red-400 border-red-400/30 bg-red-400/10", icon: <ShieldAlert className="h-3.5 w-3.5" />, label: "CRITICAL" };
      case "high":     return { color: "text-orange-400 border-orange-400/30 bg-orange-400/10", icon: <AlertTriangle className="h-3.5 w-3.5" />, label: "HIGH RISK" };
      case "medium":   return { color: "text-amber-400 border-amber-400/30 bg-amber-400/10", icon: <TrendingUp className="h-3.5 w-3.5" />, label: "MEDIUM RISK" };
      default:         return { color: "text-slate-400 border-slate-400/30 bg-slate-400/10", icon: <Info className="h-3.5 w-3.5" />, label: "LOW RISK" };
    }
  };

  const getConfidenceBar = (confidence: string) => {
    switch (confidence) {
      case "high":   return { width: "w-full",  color: "bg-emerald-400", label: "High Confidence" };
      case "medium": return { width: "w-2/3",   color: "bg-amber-400",   label: "Medium Confidence" };
      default:       return { width: "w-1/3",   color: "bg-slate-400",   label: "Low Confidence" };
    }
  };

  const getCategoryColor = (category: string) => {
    switch (category) {
      case "tensions":  return "bg-destructive/10 text-destructive border-destructive/20";
      case "sanctions": return "bg-amber-500/10 text-amber-400 border-amber-400/20";
      case "deals":     return "bg-blue-500/10 text-blue-400 border-blue-400/20";
      case "politics":  return "bg-slate-500/10 text-slate-400 border-slate-400/20";
      default:          return "bg-secondary text-secondary-foreground border-border";
    }
  };

  const risk = getRiskConfig(prediction.riskLevel);
  const conf = getConfidenceBar(prediction.confidence);
  const triggerArticles = allArticles.filter((a) => prediction.triggerArticleIds.includes(a.id));

  return (
    <Card className="border-border/60 bg-card overflow-hidden">
      <div className={`h-1 w-full ${
        prediction.riskLevel === "critical" ? "bg-red-400" :
        prediction.riskLevel === "high"     ? "bg-orange-400" :
        prediction.riskLevel === "medium"   ? "bg-amber-400" : "bg-slate-400"
      }`} />

      <CardHeader className="pb-3 border-b border-border/40">
        <div className="flex items-start gap-3">
          <div className="flex-1 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="outline" className={`rounded-sm text-[10px] font-bold tracking-wider px-2 py-0.5 flex items-center gap-1 ${risk.color}`}>
                {risk.icon}{risk.label}
              </Badge>
              <Badge className={`rounded-sm uppercase text-[10px] tracking-wider font-bold px-2 py-0.5 border ${getCategoryColor(prediction.category)}`}>
                {prediction.category}
              </Badge>
              <div className="ml-auto flex items-center gap-2 flex-wrap justify-end">
                {prediction.templateAccuracy !== null && prediction.templateAccuracy !== undefined && (
                  <span className={`text-[9px] font-bold tracking-wider px-1.5 py-0.5 rounded border font-mono ${
                    prediction.templateAccuracy >= 70
                      ? "bg-emerald-400/10 text-emerald-400 border-emerald-400/20"
                      : prediction.templateAccuracy >= 50
                      ? "bg-amber-400/10 text-amber-400 border-amber-400/20"
                      : "bg-red-400/10 text-red-400 border-red-400/20"
                  }`}>
                    {prediction.templateAccuracy}% hist. accuracy
                  </span>
                )}
                <span className="flex items-center gap-1 text-xs text-muted-foreground font-mono">
                  <Clock className="h-3 w-3" />
                  {prediction.timeframe}
                </span>
              </div>
            </div>
            <CardTitle className="text-base font-bold leading-snug">{prediction.headline}</CardTitle>
            <div className="flex items-center gap-3 flex-wrap">
              <p className="text-[11px] text-muted-foreground font-medium uppercase tracking-wider">
                Based on: {prediction.clusterTitle}
              </p>
              {prediction.resolveAfter && (
                <span className="text-[10px] font-mono text-amber-400 flex items-center gap-1 ml-auto">
                  <Timer className="h-3 w-3" />
                  Due: {new Date(prediction.resolveAfter).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-1.5 pt-1">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{conf.label}</span>
            <span className="font-mono capitalize">{prediction.confidence}</span>
          </div>
          <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-all ${conf.width} ${conf.color}`} />
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-0">
        <div className="p-4 space-y-3 border-b border-border/30">
          <div className="space-y-1.5">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Signal Analysis</p>
            <p className="text-sm text-muted-foreground leading-relaxed">{prediction.triggerSummary}</p>
          </div>
          <div className="border-l-2 border-primary/30 pl-3 space-y-1">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Reasoning</p>
            <p className="text-sm text-foreground/80 leading-relaxed">{prediction.reasoning}</p>
          </div>
        </div>

        {/* ── Market Impact — always visible ── */}
        {(() => {
          const impacts = derivePredictionMarketImpact(prediction);
          if (impacts.length === 0) return null;
          return (
            <div className="border-t border-border/30 px-4 py-3 space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <BarChart3 className="h-3.5 w-3.5" />
                If this materialises — Market Impact
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {impacts.map((impact) => {
                  const dirConfig = {
                    up:      { arrow: "↑", label: "BULLISH",  color: "text-emerald-400", bg: "bg-emerald-400/10 border-emerald-400/30" },
                    down:    { arrow: "↓", label: "BEARISH",  color: "text-red-400",     bg: "bg-red-400/10 border-red-400/30" },
                    neutral: { arrow: "→", label: "NEUTRAL",  color: "text-slate-400",   bg: "bg-slate-400/10 border-slate-400/30" },
                  }[impact.direction];
                  const magColor = { strong: "text-emerald-400", moderate: "text-amber-400", mild: "text-slate-400" }[impact.magnitude];
                  return (
                    <div key={impact.symbol} className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 ${dirConfig.bg}`}>
                      <div className="shrink-0 text-center min-w-[46px]">
                        <div className={`text-lg font-bold font-mono leading-none ${dirConfig.color}`}>{dirConfig.arrow}</div>
                        <div className="text-[9px] font-bold tracking-wider font-mono text-foreground/70 mt-0.5">{impact.symbol}</div>
                      </div>
                      <div className="flex-1 min-w-0 space-y-0.5">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-xs font-bold text-foreground">{impact.name}</span>
                          <span className={`text-[9px] font-bold tracking-wider uppercase ${dirConfig.color}`}>{dirConfig.label}</span>
                          <span className={`text-[9px] font-mono uppercase ml-auto ${magColor}`}>{impact.magnitude}</span>
                        </div>
                        <p className="text-[10px] text-muted-foreground/80 leading-relaxed">{impact.reason}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}

        <button
          onClick={() => setExpanded((e) => !e)}
          className="w-full flex items-center justify-between px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:bg-muted/30 transition-colors border-t border-border/30"
        >
          <span>Historical precedent & potential outcomes</span>
          {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>

        {expanded && (
          <div className="divide-y divide-border/30">
            <div className="px-4 py-3 bg-muted/10 space-y-1.5">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Historical Precedent</p>
              <p className="text-sm text-muted-foreground leading-relaxed italic">"{prediction.historicalPrecedent}"</p>
            </div>
            <div className="px-4 py-3 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Potential Outcomes</p>
              <ul className="space-y-1.5">
                {prediction.potentialOutcomes.map((outcome, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-foreground/80">
                    <span className="shrink-0 h-4 w-4 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center text-[9px] font-bold text-primary mt-0.5">{i + 1}</span>
                    {outcome}
                  </li>
                ))}
              </ul>
            </div>
            {(prediction.countries.length > 0 || prediction.leaders.length > 0) && (
              <div className="px-4 py-3 space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Actors Involved</p>
                <div className="flex flex-wrap gap-1.5">
                  {prediction.countries.slice(0, 5).map((c) => (
                    <span key={c} className="inline-flex items-center gap-1 text-xs bg-muted px-2 py-0.5 rounded-full text-muted-foreground border border-border/50">
                      <Globe2 className="h-2.5 w-2.5" />{c}
                    </span>
                  ))}
                  {prediction.leaders.slice(0, 3).map((l) => (
                    <span key={l} className="inline-flex items-center gap-1 text-xs bg-primary/5 px-2 py-0.5 rounded-full text-primary/70 border border-primary/10">
                      <User2 className="h-2.5 w-2.5" />{l}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {triggerArticles.length > 0 && (
              <div className="divide-y divide-border/20">
                <p className="px-4 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Evidence Signals</p>
                {triggerArticles.slice(0, 3).map((article) => (
                  <button key={article.id} onClick={() => onArticleClick(article)} className="w-full text-left px-4 py-3 hover:bg-muted/20 transition-colors group">
                    <p className="text-sm font-medium text-foreground/80 group-hover:text-primary transition-colors line-clamp-2">{article.title}</p>
                    <p className="text-xs text-muted-foreground font-mono mt-0.5">{formatRelativeTime(article.publishedAt)} · {article.source}</p>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CommoditiesTicker() {
  const items = [
    { symbol: "GOLD", name: "Gold", tone: "text-emerald-400", bg: "bg-emerald-400/10 border-emerald-400/20", note: "safe-haven" },
    { symbol: "SILVER", name: "Silver", tone: "text-amber-400", bg: "bg-amber-400/10 border-amber-400/20", note: "risk + industry" },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      {items.map((item) => (
        <div key={item.symbol} className={`rounded-lg border px-3 py-2 ${item.bg}`}>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-bold font-mono text-foreground/80">{item.symbol}</span>
            <span className={`text-[10px] font-semibold uppercase tracking-wider ${item.tone}`}>{item.note}</span>
          </div>
          <p className="text-sm font-medium text-foreground">{item.name}</p>
        </div>
      ))}
    </div>
  );
}

// ─── Cluster Card ─────────────────────────────────────────────────────────────

function ClusterCard({ cluster, onArticleClick }: {
  cluster: StoryCluster;
  onArticleClick: (article: NewsArticle) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const getCategoryColor = (category: string) => {
    switch (category) {
      case "tensions":  return "bg-destructive/10 text-destructive border-destructive/20";
      case "sanctions": return "bg-amber-500/10 text-amber-400 border-amber-400/20";
      case "deals":     return "bg-blue-500/10 text-blue-400 border-blue-400/20";
      case "politics":  return "bg-slate-500/10 text-slate-400 border-slate-400/20";
      default:          return "bg-secondary text-secondary-foreground border-border";
    }
  };

  const articleMap = new Map(cluster.articles.map((a) => [a.id, a]));
  const sortedArticles = [...cluster.articles].sort(
    (a, b) => new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime()
  );

  return (
    <Card className="border-border/60 bg-card overflow-hidden">
      <CardHeader className="pb-3 border-b border-border/40">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge className={`rounded-sm uppercase text-[10px] tracking-wider font-bold px-2 py-0.5 border ${getCategoryColor(cluster.category)}`}>
              {cluster.category}
            </Badge>
            <span className="text-xs text-muted-foreground font-mono">{cluster.articleCount} signals</span>
            <span className="text-xs text-muted-foreground font-mono ml-auto">{formatRelativeTime(cluster.latestAt)}</span>
          </div>
          <CardTitle className="text-base font-bold leading-snug">{cluster.title}</CardTitle>
          <p className="text-xs text-muted-foreground leading-relaxed">{cluster.summary}</p>
        </div>
        <div className="flex flex-wrap gap-1.5 pt-2">
          {cluster.countries.slice(0, 6).map((c) => (
            <span key={c} className="inline-flex items-center gap-1 text-xs bg-muted px-2 py-0.5 rounded-full text-muted-foreground border border-border/50">
              <Globe2 className="h-2.5 w-2.5" />{c}
            </span>
          ))}
          {cluster.leaders.slice(0, 4).map((l) => (
            <span key={l} className="inline-flex items-center gap-1 text-xs bg-primary/5 px-2 py-0.5 rounded-full text-primary/70 border border-primary/10">
              <User2 className="h-2.5 w-2.5" />{l}
            </span>
          ))}
        </div>
      </CardHeader>

      <CardContent className="p-0">
        {cluster.causalChain.length > 0 && (
          <div className="p-4 space-y-2 border-b border-border/30 bg-muted/20">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
              <Network className="h-3.5 w-3.5" />Causal Chain
            </p>
            {cluster.causalChain.slice(0, 4).map((link, i) => {
              const from = articleMap.get(link.fromArticleId);
              const to   = articleMap.get(link.toArticleId);
              if (!from || !to) return null;
              return (
                <div key={i} className="space-y-1">
                  <div className="flex items-start gap-2 text-xs">
                    <button onClick={() => onArticleClick(from)} className="flex-1 text-left font-medium text-foreground/80 hover:text-primary transition-colors line-clamp-1">{from.title}</button>
                    <span className="text-muted-foreground font-mono text-[10px] shrink-0">{formatRelativeTime(from.publishedAt)}</span>
                  </div>
                  <div className="flex items-center gap-2 pl-2">
                    <div className="h-4 w-px bg-primary/30 ml-1" />
                    <ArrowRight className="h-3 w-3 text-primary/60 shrink-0" />
                    <span className="text-[11px] text-primary/70 italic">{link.relationship}</span>
                  </div>
                  <div className="flex items-start gap-2 text-xs pl-4">
                    <button onClick={() => onArticleClick(to)} className="flex-1 text-left font-medium text-foreground hover:text-primary transition-colors line-clamp-1">{to.title}</button>
                    <span className="text-muted-foreground font-mono text-[10px] shrink-0">{formatRelativeTime(to.publishedAt)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <button
          onClick={() => setExpanded((e) => !e)}
          className="w-full flex items-center justify-between px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:bg-muted/30 transition-colors"
        >
          <span>All articles in this cluster</span>
          {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>
        {expanded && (
          <div className="divide-y divide-border/30">
            {sortedArticles.map((article) => (
              <button key={article.id} onClick={() => onArticleClick(article)} className="w-full text-left px-4 py-3 hover:bg-muted/20 transition-colors group">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground group-hover:text-primary transition-colors line-clamp-2">{article.title}</p>
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-1">{article.description}</p>
                  </div>
                  <div className="shrink-0 flex flex-col items-end gap-1">
                    <span className="text-[10px] font-mono text-muted-foreground">{formatRelativeTime(article.publishedAt)}</span>
                    <Badge variant="outline" className={`text-[9px] px-1.5 py-0 rounded-sm font-mono ${
                      article.sourceName === "NewsAPI" ? "text-emerald-400 border-emerald-400/30" :
                      article.sourceName === "GNews"   ? "text-violet-400 border-violet-400/30" :
                                                         "text-rose-400 border-rose-400/30"
                    }`}>{article.sourceName}</Badge>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Relationship Graph ───────────────────────────────────────────────────────

type GraphNode = { id: string; label: string; type: string; articleCount: number };
type GraphEdge = { source: string; target: string; weight: number; categories: string[] };

const NODE_STYLE: Record<string, { fill: string; stroke: string; textColor: string; badgeCls: string; typeName: string; typeDesc: string }> = {
  country: {
    fill: "#0ea5e9", stroke: "#38bdf8", textColor: "#e0f2fe",
    badgeCls: "bg-sky-400/20 text-sky-300 border-sky-400/30",
    typeName: "Country / Region",
    typeDesc: "A nation or region frequently mentioned in current news. Node size reflects how many stories involve it.",
  },
  leader: {
    fill: "#8b5cf6", stroke: "#a78bfa", textColor: "#ede9fe",
    badgeCls: "bg-violet-400/20 text-violet-300 border-violet-400/30",
    typeName: "Political Leader",
    typeDesc: "A political figure driving events. Their connections reveal which countries and topics they appear alongside in the news.",
  },
  topic: {
    fill: "#f59e0b", stroke: "#fbbf24", textColor: "#fefce8",
    badgeCls: "bg-amber-400/20 text-amber-300 border-amber-400/30",
    typeName: "News Topic",
    typeDesc: "A recurring subject or theme in the news cycle. Node size shows how frequently editors are covering it.",
  },
};
const getStyle = (type: string) => NODE_STYLE[type] ?? NODE_STYLE.topic;

function RelationshipGraph({ data }: {
  data: { nodes: GraphNode[]; edges: GraphEdge[] };
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(new Map());
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);

  const W = 820; const H = 540; const PAD = 95;
  const topNodes = data.nodes.slice(0, 25);
  const topIds = new Set(topNodes.map((n) => n.id));
  const edges = data.edges.filter((e) => topIds.has(e.source) && topIds.has(e.target)).slice(0, 55);

  useEffect(() => {
    if (topNodes.length === 0) return;
    const pos = new Map<string, { x: number; y: number }>();
    topNodes.forEach((node, i) => {
      const angle = (2 * Math.PI * i) / topNodes.length;
      const r = Math.min(W - PAD * 2, H - PAD * 2) * 0.38;
      pos.set(node.id, { x: W / 2 + r * Math.cos(angle), y: H / 2 + r * Math.sin(angle) });
    });
    for (let iter = 0; iter < 300; iter++) {
      for (let i = 0; i < topNodes.length; i++) {
        for (let j = i + 1; j < topNodes.length; j++) {
          const a = pos.get(topNodes[i].id)!; const b = pos.get(topNodes[j].id)!;
          const dx = b.x - a.x; const dy = b.y - a.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const force = 5500 / (dist * dist);
          const fx = (dx / dist) * force * 0.04; const fy = (dy / dist) * force * 0.04;
          a.x -= fx; a.y -= fy; b.x += fx; b.y += fy;
        }
      }
      for (const edge of edges) {
        const a = pos.get(edge.source); const b = pos.get(edge.target);
        if (!a || !b) continue;
        const dx = b.x - a.x; const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = dist * 0.0008 * Math.min(edge.weight, 6);
        a.x += (dx / dist) * force; a.y += (dy / dist) * force;
        b.x -= (dx / dist) * force; b.y -= (dy / dist) * force;
      }
      for (const node of topNodes) {
        const p = pos.get(node.id)!;
        p.x += (W / 2 - p.x) * 0.008;
        p.y += (H / 2 - p.y) * 0.008;
        p.x = Math.max(PAD, Math.min(W - PAD, p.x));
        p.y = Math.max(PAD, Math.min(H - PAD, p.y));
      }
    }
    setPositions(new Map(pos));
  }, [topNodes.length, edges.length]);

  const maxCount = Math.max(...topNodes.map((n) => n.articleCount), 1);
  const maxWeight = Math.max(...edges.map((e) => e.weight), 1);

  const selectedNode = selected ? topNodes.find((n) => n.id === selected) : null;
  const selectedEdges = selected ? edges.filter((e) => e.source === selected || e.target === selected) : [];
  const connectedIds = new Set(selectedEdges.flatMap((e) => [e.source, e.target]));

  return (
    <div className="space-y-4">
      {/* Explainer banner */}
      <div className="bg-primary/5 border border-primary/20 rounded-lg px-4 py-3 flex items-start gap-3">
        <Network className="h-4 w-4 text-primary shrink-0 mt-0.5" />
        <div className="space-y-0.5">
          <p className="text-xs font-semibold text-foreground">How to read this map</p>
          <p className="text-xs text-muted-foreground">Each node is a country, leader, or news topic extracted from current headlines. Larger nodes appear in more articles. Thicker lines mean those nodes co-occur more often in the same stories. <strong className="text-foreground/80">Click any node</strong> to see exactly what it represents and who it's connected to.</p>
        </div>
      </div>

      {/* Graph canvas */}
      <div className="relative w-full rounded-xl border border-border/50 bg-[#060d18] overflow-hidden">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="w-full h-auto"
          style={{ minHeight: 300 }}
          onClick={() => setSelected(null)}
        >
          <defs>
            <marker id="arr" markerWidth="5" markerHeight="4" refX="5" refY="2" orient="auto">
              <polygon points="0 0, 5 2, 0 4" fill="#334155" fillOpacity="0.7" />
            </marker>
            <marker id="arr-active" markerWidth="5" markerHeight="4" refX="5" refY="2" orient="auto">
              <polygon points="0 0, 5 2, 0 4" fill="#60a5fa" />
            </marker>
            <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="4" result="coloredBlur" />
              <feMerge><feMergeNode in="coloredBlur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>

          {/* Subtle dot grid */}
          {Array.from({ length: Math.ceil(H / 35) }).map((_, row) =>
            Array.from({ length: Math.ceil(W / 35) }).map((_, col) => (
              <circle key={`${row}-${col}`} cx={col * 35 + 17} cy={row * 35 + 17} r={0.7} fill="#1e293b" />
            ))
          )}

          {/* Edges */}
          {edges.map((edge, i) => {
            const a = positions.get(edge.source); const b = positions.get(edge.target);
            if (!a || !b) return null;
            const isActive = selected ? (edge.source === selected || edge.target === selected) : hovered ? (edge.source === hovered || edge.target === hovered) : false;
            const dimmed = selected ? !isActive : false;
            const sw = Math.max(0.8, (edge.weight / maxWeight) * 3.5);
            return (
              <line
                key={i}
                x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke={isActive ? "#60a5fa" : "#2d3f55"}
                strokeWidth={isActive ? Math.max(sw, 1.8) : sw}
                strokeOpacity={dimmed ? 0.06 : isActive ? 0.9 : 0.55}
                markerEnd={isActive ? "url(#arr-active)" : "url(#arr)"}
              />
            );
          })}

          {/* Nodes */}
          {topNodes.map((node) => {
            const pos = positions.get(node.id);
            if (!pos) return null;
            const r = 8 + (node.articleCount / maxCount) * 17;
            const style = getStyle(node.type);
            const isSelected = selected === node.id;
            const isHovered = hovered === node.id;
            const isConnected = connectedIds.has(node.id);
            const dimmed = selected ? (!isSelected && !isConnected) : false;
            const fullLabel = node.label;
            const label = fullLabel.length > 17 ? fullLabel.slice(0, 15) + "…" : fullLabel;
            const labelW = Math.max(label.length * 6.8 + 12, 58);

            return (
              <g
                key={node.id}
                style={{ cursor: "pointer" }}
                opacity={dimmed ? 0.15 : 1}
                onClick={(e) => { e.stopPropagation(); setSelected(node.id === selected ? null : node.id); }}
                onMouseEnter={() => setHovered(node.id)}
                onMouseLeave={() => setHovered(null)}
              >
                {/* Glow for selected */}
                {isSelected && (
                  <circle cx={pos.x} cy={pos.y} r={r + 9} fill="none" stroke={style.stroke} strokeWidth={2} strokeOpacity={0.45} filter="url(#glow)" />
                )}
                {/* Main circle */}
                <circle
                  cx={pos.x} cy={pos.y} r={r}
                  fill={style.fill}
                  fillOpacity={isSelected ? 1 : isHovered ? 0.85 : 0.65}
                  stroke={style.stroke}
                  strokeWidth={isSelected ? 2.5 : isHovered ? 2 : 1.5}
                />
                {/* Label background pill */}
                <rect
                  x={pos.x - labelW / 2} y={pos.y + r + 5}
                  width={labelW} height={17} rx={4}
                  fill="#080f1c" fillOpacity={0.88}
                />
                {/* Label text */}
                <text
                  x={pos.x} y={pos.y + r + 16.5}
                  textAnchor="middle"
                  fontSize={isSelected || isHovered ? 11 : 10}
                  fontWeight={isSelected ? "700" : "500"}
                  fill={isSelected ? style.textColor : isHovered ? "#e2e8f0" : "#94a3b8"}
                  fontFamily="ui-monospace, monospace"
                >
                  {label}
                </text>
                {/* Article count badge shown on hover/select */}
                {(isSelected || isHovered) && (
                  <g>
                    <rect x={pos.x - 22} y={pos.y + r + 25} width={44} height={14} rx={3} fill={style.fill} fillOpacity={0.25} />
                    <text x={pos.x} y={pos.y + r + 34.5} textAnchor="middle" fontSize={8.5} fontWeight="600" fill={style.textColor} fontFamily="ui-monospace, monospace">
                      {node.articleCount} art.
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </svg>

        {/* Hint overlay when nothing selected */}
        {!selected && (
          <div className="absolute top-3 right-3 bg-black/70 backdrop-blur-sm text-muted-foreground text-[10px] font-mono px-2.5 py-1.5 rounded-lg border border-border/30 pointer-events-none">
            Click a node to explore connections
          </div>
        )}
      </div>

      {/* Selected node detail panel */}
      {selectedNode && (() => {
        const style = getStyle(selectedNode.type);
        return (
          <div className="rounded-xl border border-border/60 bg-card overflow-hidden">
            {/* Header */}
            <div className="flex items-start gap-3 px-4 py-3.5 border-b border-border/30 bg-muted/10">
              <div className="h-3.5 w-3.5 rounded-full mt-0.5 shrink-0" style={{ backgroundColor: style.fill, boxShadow: `0 0 0 2px #0f172a, 0 0 0 4px ${style.stroke}` }} />
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-base font-bold text-foreground">{selectedNode.label}</span>
                  <span className={`text-[10px] font-bold tracking-wider px-2 py-0.5 rounded border ${style.badgeCls}`}>
                    {style.typeName}
                  </span>
                  <span className="text-xs text-muted-foreground font-mono ml-auto">{selectedNode.articleCount} news signals</span>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">{style.typeDesc}</p>
              </div>
              <button
                onClick={() => setSelected(null)}
                className="shrink-0 h-6 w-6 rounded-full bg-muted hover:bg-muted/80 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors text-sm"
              >✕</button>
            </div>

            {/* Connections list */}
            {selectedEdges.length > 0 ? (
              <div className="p-4 space-y-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {selectedEdges.length} Connection{selectedEdges.length !== 1 ? "s" : ""} — nodes that appear alongside <span className="text-foreground">{selectedNode.label}</span> in the same news stories
                </p>
                <div className="grid gap-2 grid-cols-1 sm:grid-cols-2">
                  {selectedEdges
                    .sort((a, b) => b.weight - a.weight)
                    .map((edge, i) => {
                      const otherId = edge.source === selected ? edge.target : edge.source;
                      const other = topNodes.find((n) => n.id === otherId);
                      if (!other) return null;
                      const oStyle = getStyle(other.type);
                      const strength = edge.weight >= 6 ? { label: "Strongly linked", cls: "text-emerald-400" } : edge.weight >= 3 ? { label: "Moderately linked", cls: "text-amber-400" } : { label: "Weakly linked", cls: "text-slate-400" };
                      return (
                        <button
                          key={i}
                          onClick={(e) => { e.stopPropagation(); setSelected(otherId); }}
                          className="flex items-start gap-2.5 p-3 rounded-lg bg-muted/30 hover:bg-muted/60 border border-border/30 hover:border-border/60 transition-colors text-left group"
                        >
                          <div className="h-2.5 w-2.5 rounded-full mt-1 shrink-0" style={{ backgroundColor: oStyle.fill }} />
                          <div className="flex-1 min-w-0 space-y-0.5">
                            <p className="text-xs font-bold text-foreground group-hover:text-primary transition-colors">{other.label}</p>
                            <p className="text-[10px] text-muted-foreground">{oStyle.typeName} · {other.articleCount} articles</p>
                            <p className={`text-[10px] font-semibold font-mono ${strength.cls}`}>{strength.label} · {edge.weight} shared stories</p>
                            {edge.categories.length > 0 && (
                              <p className="text-[10px] text-muted-foreground/70">Story types: {edge.categories.slice(0, 3).join(", ")}</p>
                            )}
                          </div>
                          <ArrowRight className="h-3 w-3 text-muted-foreground group-hover:text-primary shrink-0 mt-1 transition-colors" />
                        </button>
                      );
                    })}
                </div>
              </div>
            ) : (
              <p className="px-4 py-3 text-xs text-muted-foreground">No connections found in the current news dataset for this node.</p>
            )}
          </div>
        );
      })()}

      {/* Legend */}
      <div className="flex items-center gap-5 px-1 text-xs text-muted-foreground flex-wrap">
        {(["country", "leader", "topic"] as const).map((type) => {
          const s = getStyle(type);
          return (
            <div key={type} className="flex items-center gap-1.5">
              <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: s.fill }} />
              <span>{s.typeName}</span>
            </div>
          );
        })}
        <span className="ml-auto text-[10px] hidden sm:block">Node size = article mentions · Line thickness = co-occurrence frequency</span>
      </div>
    </div>
  );
}

// ─── Track Record UI ──────────────────────────────────────────────────────────

function AccuracyDonut({ pct, size = 64 }: { pct: number; size?: number }) {
  const r = size * 0.38;
  const circ = 2 * Math.PI * r;
  const dash = (pct / 100) * circ;
  const color = pct >= 70 ? "#34d399" : pct >= 50 ? "#f59e0b" : "#f87171";
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#1e293b" strokeWidth={size * 0.1} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={size * 0.1}
        strokeDasharray={`${dash} ${circ - dash}`} strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      <text x={size / 2} y={size / 2 + 5} textAnchor="middle" fontSize={size * 0.22} fontWeight="bold" fill={color} fontFamily="monospace">
        {pct}%
      </text>
    </svg>
  );
}

function TrackRecordEntryRow({ entry }: { entry: TrackRecordEntry }) {
  const [expanded, setExpanded] = useState(false);
  const dirArrow = { up: "↑", down: "↓", neutral: "→" }[entry.predictedDirection];
  const dirColor = { up: "text-emerald-400", down: "text-red-400", neutral: "text-slate-400" }[entry.predictedDirection];
  const statusCfg = {
    correct:   { icon: <CheckCircle2 className="h-4 w-4 text-emerald-400" />, label: "CORRECT",  bg: "bg-emerald-400/10 border-emerald-400/20", border: "border-emerald-400/20" },
    incorrect: { icon: <XCircle      className="h-4 w-4 text-red-400" />,     label: "WRONG",    bg: "bg-red-400/10 border-red-400/20",         border: "border-red-400/20" },
    pending:   { icon: <Timer        className="h-4 w-4 text-amber-400" />,   label: "PENDING",  bg: "bg-amber-400/10 border-amber-400/20",     border: "border-amber-400/20" },
  }[entry.status];
  const confColor = { high: "text-emerald-400", medium: "text-amber-400", low: "text-slate-400" }[entry.predictedConfidence];

  const hasDetail = !!(entry.triggerNewsSummary || entry.assumptions || entry.resolutionNotes || entry.flipReason || entry.lessonsLearned);

  return (
    <div className={`border rounded-lg overflow-hidden ${statusCfg.border}`}>
      {/* Summary row */}
      <div
        className={`flex items-center gap-3 px-4 py-3 ${statusCfg.bg} ${hasDetail ? "cursor-pointer hover:brightness-105" : ""}`}
        onClick={() => hasDetail && setExpanded((e) => !e)}
      >
        <div className="shrink-0">{statusCfg.icon}</div>

        <div className="shrink-0 w-12 text-center">
          <div className="text-[10px] font-bold font-mono text-muted-foreground">{entry.assetSymbol}</div>
          <div className={`text-base font-bold font-mono ${dirColor}`}>{dirArrow}</div>
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-foreground/80 line-clamp-1">{entry.dominantNarrative}</p>
          <div className="flex items-center gap-2 mt-0.5 text-[10px] text-muted-foreground font-mono flex-wrap">
            <span>{entry.priceImpactEstimate}</span>
            <span>·</span>
            <span>{entry.timeframe}</span>
            <span>·</span>
            <span className={confColor}>{entry.predictedConfidence} conf.</span>
            {entry.realPriceAtSnapshot != null && (
              <><span>·</span><span className="text-slate-400">price {entry.realPriceAtSnapshot.toLocaleString()}</span></>
            )}
            {entry.priceChangePct != null && (
              <><span>·</span><span className={entry.priceChangePct >= 0 ? "text-emerald-400" : "text-red-400"}>
                {entry.priceChangePct >= 0 ? "+" : ""}{entry.priceChangePct.toFixed(2)}%
              </span></>
            )}
          </div>
        </div>

        <div className="shrink-0 text-right space-y-0.5">
          <p className="text-[10px] font-mono text-muted-foreground">Logged: {formatRelativeTime(entry.snapshotAt)}</p>
          {entry.status === "pending"
            ? <p className="text-[10px] font-mono text-amber-400">Due: {formatRelativeTime(entry.resolveAfter)}</p>
            : <p className="text-[10px] font-mono text-muted-foreground">Resolved: {entry.resolvedAt ? formatRelativeTime(entry.resolvedAt) : "—"}</p>
          }
        </div>

        <div className="shrink-0 flex items-center gap-1.5">
          <span className={`text-[9px] font-bold tracking-wider px-2 py-1 rounded border ${statusCfg.bg} ${statusCfg.border}`}>
            {statusCfg.label}
          </span>
          {hasDetail && (expanded ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />)}
        </div>
      </div>

      {/* Expanded detail: the 3-part breakdown */}
      {expanded && hasDetail && (
        <div className="border-t border-border/30 bg-background/60 divide-y divide-border/20">

          {/* Part 1: What news triggered this */}
          {entry.triggerNewsSummary && (
            <div className="px-4 py-3 space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Info className="h-3 w-3 text-primary" />
                <p className="text-[10px] font-bold uppercase tracking-wider text-primary">1. News that triggered this prediction</p>
              </div>
              <div className="space-y-1">
                {entry.triggerNewsSummary.split("\n").map((line, i) => (
                  <p key={i} className="text-xs text-muted-foreground leading-relaxed font-mono">{line}</p>
                ))}
              </div>
            </div>
          )}

          {/* Part 2: Assumptions made */}
          {entry.assumptions && (
            <div className="px-4 py-3 space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Brain className="h-3 w-3 text-amber-400" />
                <p className="text-[10px] font-bold uppercase tracking-wider text-amber-400">2. Assumptions based on that news</p>
              </div>
              <div className="space-y-1">
                {entry.assumptions.split("\n").map((line, i) => (
                  <p key={i} className="text-xs text-muted-foreground leading-relaxed">{line}</p>
                ))}
              </div>
            </div>
          )}

          {/* Part 3: What happened / resolution */}
          {(entry.resolutionNotes || entry.flipReason) && (
            <div className="px-4 py-3 space-y-1.5">
              <div className="flex items-center gap-1.5">
                {entry.status === "correct"
                  ? <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                  : <XCircle className="h-3 w-3 text-red-400" />}
                <p className={`text-[10px] font-bold uppercase tracking-wider ${entry.status === "correct" ? "text-emerald-400" : "text-red-400"}`}>
                  3. What changed / {entry.status === "correct" ? "why it was correct" : "why it failed"}
                </p>
              </div>
              {entry.flipReason && (
                <p className="text-xs text-red-300/80 leading-relaxed italic">
                  ⚠ Early flip: {entry.flipReason}
                </p>
              )}
              {entry.resolutionNotes && (
                <p className="text-xs text-muted-foreground leading-relaxed">{entry.resolutionNotes}</p>
              )}
              {entry.realPriceAtResolution != null && entry.realPriceAtSnapshot != null && (
                <div className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground mt-1">
                  <span>Price at prediction: {entry.realPriceAtSnapshot.toLocaleString()}</span>
                  <span>→</span>
                  <span>Price at resolution: {entry.realPriceAtResolution.toLocaleString()}</span>
                  {entry.priceChangePct != null && (
                    <span className={entry.priceChangePct >= 0 ? "text-emerald-400 font-semibold" : "text-red-400 font-semibold"}>
                      ({entry.priceChangePct >= 0 ? "+" : ""}{entry.priceChangePct.toFixed(2)}%)
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Lessons learned — shown only for incorrect predictions */}
          {entry.lessonsLearned && entry.status === "incorrect" && (
            <div className="px-4 py-3 space-y-1.5 bg-orange-950/20">
              <div className="flex items-center gap-1.5">
                <AlertTriangle className="h-3 w-3 text-orange-400" />
                <p className="text-[10px] font-bold uppercase tracking-wider text-orange-400">Lesson learned (fed into next prediction)</p>
              </div>
              <p className="text-xs text-orange-200/70 leading-relaxed italic">{entry.lessonsLearned}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TrackRecordPanel({ stats, entries, isLoading }: {
  stats: TrackRecordStats | null;
  entries: TrackRecordEntry[];
  isLoading: boolean;
}) {
  const [filter, setFilter] = useState<"all" | "pending" | "correct" | "incorrect">("all");
  const assetNames: Record<string, string> = { gold: "Gold", silver: "Silver", oil: "Oil", usd: "USD", sp500: "S&P 500" };

  if (isLoading) {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-4 gap-3">
          {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-24 rounded-lg" />)}
        </div>
        <Skeleton className="h-48 rounded-lg" />
      </div>
    );
  }

  const pending   = entries.filter((e) => e.status === "pending").length;
  const correct   = entries.filter((e) => e.status === "correct").length;
  const incorrect = entries.filter((e) => e.status === "incorrect").length;
  const filtered  = filter === "all" ? entries : entries.filter((e) => e.status === filter);
  const sorted    = [...filtered].sort((a, b) => new Date(b.snapshotAt).getTime() - new Date(a.snapshotAt).getTime());

  return (
    <div className="space-y-5">
      {/* Explainer */}
      <div className="bg-primary/5 border border-primary/20 rounded-lg px-4 py-3 flex items-start gap-3">
        <Trophy className="h-4 w-4 text-primary shrink-0 mt-0.5" />
        <div className="space-y-0.5">
          <p className="text-xs font-semibold text-foreground">Self-validating accuracy tracker</p>
          <p className="text-xs text-muted-foreground">Every time you visit the Market Impact tab, the engine logs its directional call for each asset. When the prediction's timeframe expires, it compares the new analysis direction to the original call — if they agree, it was correct. This builds a live track record as data accumulates over time.</p>
        </div>
      </div>

      {entries.length === 0 ? (
        <Card className="p-10 text-center border-dashed">
          <Trophy className="h-10 w-10 mx-auto mb-3 opacity-20" />
          <p className="font-medium text-foreground">No predictions logged yet</p>
          <p className="text-sm text-muted-foreground mt-1">Visit the Market Impact tab to log your first prediction snapshot. The track record will build automatically over time.</p>
        </Card>
      ) : (
        <>
          {/* Overall stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Card className="p-4 flex flex-col items-center justify-center gap-2 text-center border-border/60">
              <AccuracyDonut pct={stats?.accuracyPct ?? 0} />
              <div>
                <p className="text-xs font-bold text-foreground">Overall Accuracy</p>
                <p className="text-[10px] text-muted-foreground font-mono">{stats?.correct ?? 0}/{stats?.resolved ?? 0} resolved</p>
              </div>
            </Card>
            <Card className="p-4 text-center border-amber-400/20 bg-amber-400/5">
              <p className="text-3xl font-bold font-mono text-amber-400">{pending}</p>
              <p className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mt-1">Pending</p>
              <p className="text-[10px] text-muted-foreground font-mono">awaiting resolution</p>
            </Card>
            <Card className="p-4 text-center border-emerald-400/20 bg-emerald-400/5">
              <p className="text-3xl font-bold font-mono text-emerald-400">{correct}</p>
              <p className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mt-1">Correct</p>
              <p className="text-[10px] text-muted-foreground font-mono">direction matched</p>
            </Card>
            <Card className="p-4 text-center border-red-400/20 bg-red-400/5">
              <p className="text-3xl font-bold font-mono text-red-400">{incorrect}</p>
              <p className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mt-1">Incorrect</p>
              <p className="text-[10px] text-muted-foreground font-mono">direction flipped</p>
            </Card>
          </div>

          {/* Per-asset breakdown */}
          {stats && Object.keys(stats.byAsset).length > 0 && (
            <Card className="border-border/60">
              <CardHeader className="pb-2 border-b border-border/40">
                <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Accuracy by Asset</p>
              </CardHeader>
              <CardContent className="p-0">
                <div className="divide-y divide-border/30">
                  {Object.entries(stats.byAsset).filter(([, v]) => v.total > 0).map(([assetId, acc]) => (
                    <div key={assetId} className="flex items-center gap-4 px-4 py-3">
                      <span className="text-xs font-bold font-mono text-foreground/80 w-16">{assetNames[assetId] ?? assetId}</span>
                      <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all bg-emerald-400"
                          style={{ width: `${acc.accuracyPct}%` }}
                        />
                      </div>
                      <span className="text-xs font-mono text-muted-foreground w-28 text-right">
                        {acc.correct}/{acc.resolved} resolved ({acc.accuracyPct}%)
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Confidence breakdown */}
          {stats && (
            <div className="grid grid-cols-3 gap-3">
              {(["high", "medium", "low"] as const).map((conf) => {
                const a = stats.byConfidence[conf];
                const color = conf === "high" ? "text-emerald-400" : conf === "medium" ? "text-amber-400" : "text-slate-400";
                return (
                  <Card key={conf} className="p-3 text-center border-border/60 space-y-1">
                    <p className={`text-[10px] uppercase tracking-wider font-bold ${color}`}>{conf} confidence</p>
                    <p className="text-xl font-bold font-mono text-foreground">{a.accuracyPct}%</p>
                    <p className="text-[10px] text-muted-foreground font-mono">{a.correct}/{a.resolved} correct</p>
                  </Card>
                );
              })}
            </div>
          )}

          {/* Filter bar */}
          <div className="flex items-center gap-2">
            <p className="text-xs font-semibold text-muted-foreground mr-1">Filter:</p>
            {(["all", "pending", "correct", "incorrect"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full border transition-colors ${
                  filter === f
                    ? "bg-primary/20 text-primary border-primary/30"
                    : "text-muted-foreground border-border hover:text-foreground"
                }`}
              >
                {f} {f !== "all" && `(${entries.filter((e) => e.status === f).length})`}
              </button>
            ))}
          </div>

          {/* Entry list */}
          <div className="space-y-2">
            {sorted.length === 0 ? (
              <p className="text-center text-sm text-muted-foreground py-6">No entries match this filter.</p>
            ) : (
              sorted.map((entry) => <TrackRecordEntryRow key={entry.id} entry={entry} />)
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Notification hook ────────────────────────────────────────────────────────

function useNotifications() {
  const supported = typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window;
  const [permission, setPermission] = useState<NotificationPermission>(
    () => (typeof Notification !== "undefined" ? Notification.permission : "default")
  );
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!supported) return;
    navigator.serviceWorker.ready.then((reg) => {
      reg.pushManager.getSubscription().then((sub) => setIsSubscribed(!!sub));
    }).catch(() => {});
  }, [supported]);

  const subscribe = async () => {
    if (!supported) return;
    setIsLoading(true);
    try {
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== "granted") return;

      const keyRes = await fetch("/api/push/vapid-key");
      if (!keyRes.ok) return;
      const { publicKey } = await keyRes.json() as { publicKey: string };

      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sub.toJSON()),
      });
      setIsSubscribed(true);
    } catch {
      // Non-fatal
    } finally {
      setIsLoading(false);
    }
  };

  const unsubscribe = async () => {
    if (!supported) return;
    setIsLoading(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/push/unsubscribe", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
        setIsSubscribed(false);
      }
    } catch {
      // Non-fatal
    } finally {
      setIsLoading(false);
    }
  };

  return { supported, permission, isSubscribed, isLoading, subscribe, unsubscribe };
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  return Uint8Array.from(rawData, (c) => c.charCodeAt(0));
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

type Tab = "markets" | "predictions" | "clusters" | "graph" | "trackrecord";

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Intelligence() {
  const [hasAccess, setHasAccess] = useState(getStoredAccess());
  const [selectedArticle, setSelectedArticle] = useState<NewsArticle | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("markets");
  useEffect(() => {
    debug("mount", { hasAccess, pathname: window.location.pathname });
  }, []);

  const { data: clusterData, isLoading: isLoadingClusters } = useGetIntelligenceClusters({
    query: { queryKey: getGetIntelligenceClustersQueryKey(), enabled: hasAccess },
  });
  const { data: predData, isLoading: isLoadingPredictions } = useGetIntelligencePredictions({
    query: { queryKey: getGetIntelligencePredictionsQueryKey(), enabled: hasAccess },
  });
  const { data: marketData, isLoading: isLoadingMarkets } = useGetIntelligenceMarketSignals({
    query: { queryKey: getGetIntelligenceMarketSignalsQueryKey(), enabled: hasAccess },
  });
  const { data: trackData, isLoading: isLoadingTrack } = useGetIntelligenceTrackRecord({
    query: { queryKey: getGetIntelligenceTrackRecordQueryKey(), enabled: hasAccess },
  });

  const clusters    = clusterData?.clusters ?? [];
  const graphData   = { nodes: clusterData?.nodes ?? [], edges: clusterData?.edges ?? [] };
  const predictions = predData?.predictions ?? [];
  const assets      = marketData?.assets ?? [];
  const allArticles = clusters.flatMap((c) => c.articles);

  const trackEntries = trackData?.entries ?? [];
  const trackStats   = trackData?.stats ?? null;

  const tabs: { id: Tab; label: string; shortLabel: string; icon: React.ReactNode; count?: number; mobileHidden?: boolean }[] = [
    { id: "markets",     label: "Market Impact",    shortLabel: "Markets",     icon: <BarChart3 className="h-4 w-4" />,  count: assets.length },
    { id: "trackrecord", label: "Track Record",     shortLabel: "Track",       icon: <Trophy className="h-4 w-4" />,     count: trackEntries.length > 0 ? trackEntries.length : undefined },
    { id: "predictions", label: "Event Forecast",   shortLabel: "Forecasts",   icon: <Telescope className="h-4 w-4" />, count: predictions.length },
    { id: "clusters",    label: "Story Clusters",   shortLabel: "Clusters",    icon: <Brain className="h-4 w-4" />,      count: clusters.length },
    { id: "graph",       label: "Relationship Map", shortLabel: "Graph",       icon: <Network className="h-4 w-4" />,    mobileHidden: true },
  ];

  const notif = useNotifications();

  return (
    <IntelligenceErrorBoundary>
      {!hasAccess ? (
        <PasswordGate onAccess={() => setHasAccess(true)} />
      ) : (
        <IntelligenceShell>
          <div className="space-y-3 bg-card border border-border p-4 rounded-lg shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <SidebarTrigger className="h-8 w-8 shrink-0 sm:hidden rounded-md border border-border" />
                <Brain className="h-5 w-5 text-primary shrink-0" />
                <h1 className="text-lg sm:text-xl font-bold tracking-tight truncate">Intelligence Analysis</h1>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {clusterData && (
                  <span className="hidden sm:inline text-xs font-mono text-muted-foreground">
                    {clusters.length} clusters · {marketData?.totalArticlesAnalyzed ?? 0} articles · {formatRelativeTime(clusterData.generatedAt)}
                  </span>
                )}
                {notif.supported && (
                  <button
                    onClick={notif.isSubscribed ? notif.unsubscribe : notif.subscribe}
                    disabled={notif.isLoading || notif.permission === "denied"}
                    title={
                      notif.permission === "denied"
                        ? "Notifications blocked — enable in browser settings"
                        : notif.isSubscribed
                        ? "Unsubscribe from alerts"
                        : "Subscribe to alerts"
                    }
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                      notif.isSubscribed
                        ? "bg-primary/15 border-primary/30 text-primary hover:bg-primary/25"
                        : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
                    }`}
                  >
                    {notif.isSubscribed
                      ? <Bell className="h-3.5 w-3.5" />
                      : <BellOff className="h-3.5 w-3.5" />}
                    <span className="hidden sm:inline">{notif.isLoading ? "…" : notif.isSubscribed ? "Alerts On" : "Alerts Off"}</span>
                    <span className="sm:hidden">{notif.isLoading ? "…" : notif.isSubscribed ? "On" : "Off"}</span>
                  </button>
                )}
              </div>
            </div>
            {clusterData && (
              <p className="sm:hidden text-[10px] font-mono text-muted-foreground">
                {clusters.length} clusters · {marketData?.totalArticlesAnalyzed ?? 0} articles · {formatRelativeTime(clusterData.generatedAt)}
              </p>
            )}
            <CommoditiesTicker />
          </div>

          {/* Tab bar */}
          <div className="flex border-b border-border gap-0.5 overflow-x-auto scrollbar-none">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-3 sm:px-4 py-2.5 text-xs font-bold uppercase tracking-wider border-b-2 whitespace-nowrap transition-colors ${
                  tab.mobileHidden ? "hidden sm:flex" : ""
                } ${
                  activeTab === tab.id
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {tab.icon}
                <span className="sm:hidden">{tab.shortLabel}</span>
                <span className="hidden sm:inline">{tab.label}</span>
                {tab.count !== undefined && tab.count > 0 && (
                  <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded-full ${
                    activeTab === tab.id ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"
                  }`}>
                    {tab.count}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* ── Market Impact tab ── */}
          {activeTab === "markets" && (
            <div className="space-y-4">
              {/* Explainer strip */}
              <div className="bg-primary/5 border border-primary/20 rounded-lg px-4 py-3 flex items-start gap-3">
                <Scale className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                <div className="space-y-0.5">
                  <p className="text-xs font-semibold text-foreground">Multi-angle agentic validation</p>
                  <p className="text-xs text-muted-foreground">For each asset, the engine independently collects all bullish and bearish forces from current news signals, scores them by strength and article count, then weighs both sides to produce a directional verdict. Expand each card to see the full bull vs bear debate. Each signal shows a deadline date — the point at which the prediction is compared against the new analysis for accuracy scoring.</p>
                </div>
              </div>

              {/* Notification info strip */}
              <div className="bg-amber-400/5 border border-amber-400/20 rounded-lg px-4 py-3 flex items-start gap-3">
                <Bell className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
                <div className="space-y-0.5">
                  <p className="text-xs font-semibold text-foreground">When will you get a push notification?</p>
                  <p className="text-xs text-muted-foreground">You receive an alert when: <span className="text-foreground font-medium">(1) the highest-scoring asset changes its direction</span> (e.g. was BULLISH, now BEARISH), or <span className="text-foreground font-medium">(2) more than 6 hours have passed</span> since the last notification for that asset. Neutral signals are never notified. Enable alerts with the bell button above.</p>
                </div>
              </div>

              {isLoadingMarkets ? (
                <div className="grid gap-4 grid-cols-1 lg:grid-cols-2">
                  {[...Array(5)].map((_, i) => (
                    <Card key={i} className="p-5 space-y-3">
                      <div className="flex gap-3">
                        <Skeleton className="h-12 w-12 rounded-lg" />
                        <div className="flex-1 space-y-2">
                          <Skeleton className="h-4 w-32" />
                          <Skeleton className="h-3 w-full" />
                        </div>
                      </div>
                      <Skeleton className="h-2 w-full rounded-full" />
                      <Skeleton className="h-16 w-full" />
                    </Card>
                  ))}
                </div>
              ) : assets.length === 0 ? (
                <Card className="p-10 text-center text-muted-foreground border-dashed">
                  <BarChart3 className="h-10 w-10 mx-auto mb-3 opacity-30" />
                  <p className="font-medium text-foreground">No market signals detected</p>
                  <p className="text-sm mt-1">Not enough recent news signals to generate market analysis. Check back after the next news fetch.</p>
                </Card>
              ) : (
                <>
                  {/* Quick overview bar */}
                  <div className="grid grid-cols-5 gap-2">
                    {assets.map((asset) => {
                      const dirConfig = {
                        up:      { arrow: "↑", color: "text-emerald-400", bg: "bg-emerald-400/10 border-emerald-400/30" },
                        down:    { arrow: "↓", color: "text-red-400",     bg: "bg-red-400/10 border-red-400/30" },
                        neutral: { arrow: "→", color: "text-slate-400",   bg: "bg-slate-400/10 border-slate-400/30" },
                      }[asset.direction];
                      return (
                        <button
                          key={asset.id}
                          onClick={() => setActiveTab("markets")}
                          className={`rounded-lg border p-2.5 text-center space-y-0.5 transition-colors ${dirConfig.bg}`}
                        >
                          <div className={`text-lg font-bold font-mono ${dirConfig.color}`}>{dirConfig.arrow}</div>
                          <div className="text-[10px] font-bold font-mono text-foreground/80">{asset.symbol}</div>
                          <div className={`text-[10px] font-mono font-semibold ${dirConfig.color}`}>{asset.priceImpactEstimate}</div>
                        </button>
                      );
                    })}
                  </div>

                  <div className="grid gap-4 grid-cols-1 lg:grid-cols-2">
                    {assets.map((asset) => (
                      <MarketAssetCard
                        key={asset.id}
                        asset={asset}
                        allArticles={allArticles}
                        onArticleClick={setSelectedArticle}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── Track Record tab ── */}
          {activeTab === "trackrecord" && (
            <TrackRecordPanel
              stats={trackStats}
              entries={trackEntries}
              isLoading={isLoadingTrack}
            />
          )}

          {/* ── Event Forecast tab ── */}
          {activeTab === "predictions" && (
            <div className="space-y-4">
              {isLoadingPredictions ? (
                [...Array(3)].map((_, i) => (
                  <Card key={i} className="p-5 space-y-3">
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-6 w-3/4" />
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-2 w-full rounded-full" />
                  </Card>
                ))
              ) : predictions.length === 0 ? (
                <Card className="p-10 text-center text-muted-foreground border-dashed">
                  <Telescope className="h-10 w-10 mx-auto mb-3 opacity-30" />
                  <p className="font-medium text-foreground">No event forecasts available yet</p>
                  <p className="text-sm mt-1">Not enough signals to generate predictions. Check back after the next news fetch.</p>
                </Card>
              ) : (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {(["critical", "high", "medium", "low"] as const).map((risk) => {
                      const count = predictions.filter((p) => p.riskLevel === risk).length;
                      const colors = {
                        critical: "border-red-400/30 bg-red-400/5 text-red-400",
                        high:     "border-orange-400/30 bg-orange-400/5 text-orange-400",
                        medium:   "border-amber-400/30 bg-amber-400/5 text-amber-400",
                        low:      "border-slate-400/30 bg-slate-400/5 text-slate-400",
                      };
                      return (
                        <div key={risk} className={`rounded-lg border p-3 text-center ${colors[risk]}`}>
                          <div className="text-2xl font-bold font-mono">{count}</div>
                          <div className="text-[10px] uppercase tracking-wider font-semibold mt-1">{risk} risk</div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="grid gap-4 grid-cols-1 lg:grid-cols-2">
                    {[...predictions]
                      .sort((a, b) => {
                        const o = { critical: 0, high: 1, medium: 2, low: 3 };
                        return o[a.riskLevel] - o[b.riskLevel];
                      })
                      .map((prediction) => (
                        <PredictionCard
                          key={prediction.id}
                          prediction={prediction}
                          onArticleClick={setSelectedArticle}
                          allArticles={allArticles}
                        />
                      ))}
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── Story Clusters tab ── */}
          {activeTab === "clusters" && (
            <div className="space-y-4">
              {isLoadingClusters ? (
                [...Array(4)].map((_, i) => (
                  <Card key={i} className="p-5 space-y-3">
                    <Skeleton className="h-5 w-48" />
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-32 w-full" />
                  </Card>
                ))
              ) : clusters.length === 0 ? (
                <Card className="p-8 text-center text-muted-foreground border-dashed">
                  <p>No story clusters detected yet.</p>
                </Card>
              ) : (
                <div className="grid gap-4 grid-cols-1 lg:grid-cols-2">
                  {clusters.map((cluster) => (
                    <ClusterCard key={cluster.id} cluster={cluster} onArticleClick={setSelectedArticle} />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Relationship Map tab ── */}
          {activeTab === "graph" && (
            <div className="space-y-3">
              {isLoadingClusters ? (
                <Skeleton className="h-96 w-full rounded-lg" />
              ) : graphData.nodes.length > 0 ? (
                <RelationshipGraph data={graphData} />
              ) : (
                <Card className="p-8 text-center text-muted-foreground border-dashed">
                  <p>No relationship data available yet.</p>
                </Card>
              )}
            </div>
          )}
          <ArticleModal article={selectedArticle} onClose={() => setSelectedArticle(null)} />
      </IntelligenceShell>
      )}
    </IntelligenceErrorBoundary>
  );
}

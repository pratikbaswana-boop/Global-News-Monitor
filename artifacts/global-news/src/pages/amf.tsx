import React, { useState, useEffect, useCallback } from "react";
import { AppLayout } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  TrendingUp,
  Wallet,
  Target,
  Activity,
  Brain,
  Shield,
  CircleDot,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
} from "lucide-react";

const API_BASE = "/api";

interface AmfPortfolio {
  totalCapital: number;
  totalPnl: number;
  totalPnlPct: number;
  monthlyTargetPct: number;
  condor: {
    allocatedCapital: number;
    pnl: number;
    winRate: number;
    totalPositions: number;
    winningPositions: number;
    active: any | null;
  };
  stocks: {
    allocatedCapital: number;
    pnl: number;
    openPositions: number;
  };
}

interface AmfStock {
  symbol: string;
  assetId: string;
  name: string;
  sector: string;
  ltp: number | null;
  lastTickAt: number | null;
  stale: boolean;
}

interface AmfSignal {
  assetId: string;
  direction: string;
  confidence: number;
  magnitude: string;
  narrative: string;
  bullScore: number;
  bearScore: number;
  regime: string | null;
  createdAt: string;
}

interface AmfPosition {
  id: string;
  assetSymbol: string;
  direction: string;
  quantity: number;
  entryPrice: number;
  currentPrice: number | null;
  unrealizedPnl: number | null;
  executedAt: string;
}

interface AmfCondorHistoryItem {
  id: string;
  entryDate: string;
  spotAtEntry: number;
  netPremium: number;
  maxProfit: number;
  maxLoss: number;
  realisedPnl: number | null;
  status: string;
  exitReason: string | null;
  legs: any[];
}

interface AmfData {
  portfolio: AmfPortfolio;
  niftySpot: number | null;
  stockUniverse: AmfStock[];
  sectors: string[];
  stocksBySector: Record<string, { symbol: string; name: string; ltp: number | null }[]>;
  signals: AmfSignal[];
  openPositions: AmfPosition[];
  condorHistory: AmfCondorHistoryItem[];
}

function formatCurrency(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 100000) return `₹${(n / 100000).toFixed(2)}L`;
  if (abs >= 1000) return `₹${(n / 1000).toFixed(1)}K`;
  return `₹${n.toFixed(0)}`;
}

function formatPnl(n: number): string {
  const sign = n >= 0 ? "+" : "-";
  return `${sign}${formatCurrency(Math.abs(n))}`;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function DirectionBadge({ direction }: { direction: string }) {
  if (direction === "up" || direction === "BULLISH") {
    return (
      <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20">
        <ArrowUpRight className="h-3 w-3 mr-0.5" />BULLISH
      </Badge>
    );
  }
  if (direction === "down" || direction === "BEARISH") {
    return (
      <Badge className="bg-red-500/15 text-red-400 border-red-500/30 hover:bg-red-500/20">
        <ArrowDownRight className="h-3 w-3 mr-0.5" />BEARISH
      </Badge>
    );
  }
  return (
    <Badge className="bg-zinc-500/15 text-zinc-400 border-zinc-500/30 hover:bg-zinc-500/20">
      <Minus className="h-3 w-3 mr-0.5" />NEUTRAL
    </Badge>
  );
}

function StatCard({
  label,
  value,
  sublabel,
  icon: Icon,
  accent = "default",
}: {
  label: string;
  value: string;
  sublabel?: string;
  icon: React.ElementType;
  accent?: "default" | "green" | "blue" | "amber";
}) {
  const accentClass = {
    default: "text-foreground",
    green: "text-emerald-400",
    blue: "text-blue-400",
    amber: "text-amber-400",
  }[accent];

  return (
    <Card className="bg-[#0f1117] border-border/40">
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{label}</span>
          <Icon className={`h-4 w-4 ${accentClass}`} />
        </div>
        <div className={`text-2xl font-bold ${accentClass}`} style={{ fontFamily: "'Inter', sans-serif", fontVariantNumeric: "tabular-nums" }}>
          {value}
        </div>
        {sublabel && <div className="text-xs text-muted-foreground mt-1">{sublabel}</div>}
      </CardContent>
    </Card>
  );
}

export default function AmfPage() {
  const [data, setData] = useState<AmfData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPortfolio = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/amf/portfolio`);
      if (!res.ok) throw new Error("Failed to fetch AMF portfolio");
      const json = await res.json();
      setData(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchPortfolio();
    const interval = setInterval(fetchPortfolio, 5000);
    return () => clearInterval(interval);
  }, [fetchPortfolio]);

  if (loading) {
    return (
      <AppLayout>
        <div className="p-6 space-y-4">
          <Skeleton className="h-8 w-64" />
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-28" />)}
          </div>
          <Skeleton className="h-96" />
        </div>
      </AppLayout>
    );
  }

  if (error || !data) {
    return (
      <AppLayout>
        <div className="p-6">
          <Card className="bg-[#0f1117] border-red-500/30">
            <CardContent className="p-6">
              <p className="text-red-400 text-sm">{error ?? "No data available"}</p>
              <button onClick={fetchPortfolio} className="mt-2 text-xs text-blue-400 hover:underline">Retry</button>
            </CardContent>
          </Card>
        </div>
      </AppLayout>
    );
  }

  const { portfolio, signals, openPositions, condorHistory, stockUniverse, stocksBySector, sectors } = data;
  const isProfit = portfolio.totalPnl >= 0;

  return (
    <AppLayout>
      <div className="flex flex-col h-full overflow-hidden">
        {/* Header */}
        <div className="border-b border-border/40 bg-[#0c0e14] px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold tracking-tight" style={{ fontFamily: "'Inter', sans-serif" }}>
                AMF <span className="text-muted-foreground font-medium">Aumorphic Future Maker</span>
              </h1>
              <p className="text-xs text-muted-foreground mt-0.5">AI-Powered Portfolio Manager · Condor + Stock Swing</p>
            </div>
            <div className="flex items-center gap-2">
              <CircleDot className="h-3 w-3 text-emerald-400 animate-pulse" />
              <span className="text-xs text-muted-foreground">Live</span>
              {data.niftySpot && (
                <Badge variant="outline" className="ml-2 text-xs">
                  NIFTY {data.niftySpot.toFixed(0)}
                </Badge>
              )}
            </div>
          </div>
        </div>

        <ScrollArea className="flex-1">
          <div className="p-6 space-y-6">
            {/* Portfolio Summary Cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard
                label="Total Portfolio"
                value={formatCurrency(portfolio.totalCapital)}
                sublabel={`${formatPnl(portfolio.totalPnl)} (${isProfit ? "+" : ""}${portfolio.totalPnlPct.toFixed(2)}%)`}
                icon={Wallet}
                accent={isProfit ? "green" : "default"}
              />
              <StatCard
                label="Condor Engine"
                value={formatCurrency(portfolio.condor.allocatedCapital)}
                sublabel={`${formatPnl(portfolio.condor.pnl)} · ${portfolio.condor.winningPositions}/${portfolio.condor.totalPositions} wins`}
                icon={Shield}
                accent={portfolio.condor.pnl >= 0 ? "green" : "default"}
              />
              <StatCard
                label="Stock Swing"
                value={formatCurrency(portfolio.stocks.allocatedCapital)}
                sublabel={`${formatPnl(portfolio.stocks.pnl)} · ${portfolio.stocks.openPositions} active`}
                icon={TrendingUp}
                accent={portfolio.stocks.pnl >= 0 ? "green" : "default"}
              />
              <StatCard
                label="Monthly Target"
                value={`${portfolio.monthlyTargetPct.toFixed(1)}%`}
                sublabel="of 10% monthly target"
                icon={Target}
                accent="amber"
              />
            </div>

            {/* Target Progress Bar */}
            <Card className="bg-[#0f1117] border-border/40">
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Monthly Target Progress</span>
                  <span className="text-sm font-bold text-amber-400">{portfolio.monthlyTargetPct.toFixed(1)}% / 100%</span>
                </div>
                <Progress value={portfolio.monthlyTargetPct} className="h-2 bg-muted/30" />
              </CardContent>
            </Card>

            {/* Two-column layout */}
            <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
              {/* Left: Active Positions */}
              <div className="lg:col-span-3 space-y-4">
                <Card className="bg-[#0f1117] border-border/40">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-bold uppercase tracking-wider">Active Positions</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <Tabs defaultValue="stocks">
                      <TabsList className="bg-muted/20 mb-4">
                        <TabsTrigger value="stocks" className="text-xs">Stocks ({openPositions.length})</TabsTrigger>
                        <TabsTrigger value="condor" className="text-xs">Condor ({condorHistory.filter(h => h.status === "open").length})</TabsTrigger>
                      </TabsList>

                      <TabsContent value="stocks">
                        {openPositions.length === 0 ? (
                          <div className="text-center py-8 text-muted-foreground text-sm">
                            No active stock positions
                          </div>
                        ) : (
                          <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                              <thead>
                                <tr className="border-b border-border/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                                  <th className="text-left py-2 px-2 font-bold">Symbol</th>
                                  <th className="text-right py-2 px-2 font-bold">Entry</th>
                                  <th className="text-right py-2 px-2 font-bold">Current</th>
                                  <th className="text-right py-2 px-2 font-bold">Qty</th>
                                  <th className="text-right py-2 px-2 font-bold">P&L</th>
                                  <th className="text-center py-2 px-2 font-bold">Dir</th>
                                </tr>
                              </thead>
                              <tbody>
                                {openPositions.map((pos) => {
                                  const pnlClass = pos.unrealizedPnl != null
                                    ? pos.unrealizedPnl >= 0 ? "text-emerald-400" : "text-red-400"
                                    : "text-muted-foreground";
                                  return (
                                    <tr key={pos.id} className="border-b border-border/20 hover:bg-muted/10">
                                      <td className="py-2 px-2 font-medium">{pos.assetSymbol}</td>
                                      <td className="py-2 px-2 text-right tabular-nums">{pos.entryPrice.toFixed(2)}</td>
                                      <td className="py-2 px-2 text-right tabular-nums">{pos.currentPrice?.toFixed(2) ?? "—"}</td>
                                      <td className="py-2 px-2 text-right tabular-nums">{pos.quantity}</td>
                                      <td className={`py-2 px-2 text-right tabular-nums font-medium ${pnlClass}`}>
                                        {pos.unrealizedPnl != null ? formatPnl(pos.unrealizedPnl) : "—"}
                                      </td>
                                      <td className="py-2 px-2 text-center">
                                        <DirectionBadge direction={pos.direction} />
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </TabsContent>

                      <TabsContent value="condor">
                        {condorHistory.filter(h => h.status === "open").length === 0 ? (
                          <div className="text-center py-8 text-muted-foreground text-sm">
                            No active condor positions
                          </div>
                        ) : (
                          <div className="space-y-3">
                            {condorHistory.filter(h => h.status === "open").map((pos) => (
                              <div key={pos.id} className="border border-border/40 rounded-lg p-3">
                                <div className="flex items-center justify-between mb-2">
                                  <span className="text-sm font-medium">Entry: {new Date(pos.entryDate).toLocaleDateString()}</span>
                                  <Badge variant="outline" className="text-xs">OPEN</Badge>
                                </div>
                                <div className="grid grid-cols-4 gap-2 text-xs">
                                  <div>
                                    <div className="text-muted-foreground">Spot</div>
                                    <div className="font-medium tabular-nums">{pos.spotAtEntry.toFixed(0)}</div>
                                  </div>
                                  <div>
                                    <div className="text-muted-foreground">Premium</div>
                                    <div className="font-medium tabular-nums text-emerald-400">₹{pos.netPremium.toFixed(0)}</div>
                                  </div>
                                  <div>
                                    <div className="text-muted-foreground">Max Profit</div>
                                    <div className="font-medium tabular-nums">₹{pos.maxProfit.toFixed(0)}</div>
                                  </div>
                                  <div>
                                    <div className="text-muted-foreground">Max Loss</div>
                                    <div className="font-medium tabular-nums text-red-400">₹{pos.maxLoss.toFixed(0)}</div>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                        {/* Closed condor history */}
                        {condorHistory.filter(h => h.status === "closed").length > 0 && (
                          <div className="mt-4">
                            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Closed Positions</div>
                            <div className="overflow-x-auto">
                              <table className="w-full text-sm">
                                <thead>
                                  <tr className="border-b border-border/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                                    <th className="text-left py-2 px-2 font-bold">Date</th>
                                    <th className="text-right py-2 px-2 font-bold">Premium</th>
                                    <th className="text-right py-2 px-2 font-bold">P&L</th>
                                    <th className="text-left py-2 px-2 font-bold">Exit</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {condorHistory.filter(h => h.status === "closed").slice(0, 10).map((pos) => (
                                    <tr key={pos.id} className="border-b border-border/20">
                                      <td className="py-2 px-2 text-xs">{new Date(pos.entryDate).toLocaleDateString()}</td>
                                      <td className="py-2 px-2 text-right tabular-nums text-xs">₹{pos.netPremium.toFixed(0)}</td>
                                      <td className={`py-2 px-2 text-right tabular-nums text-xs font-medium ${(pos.realisedPnl ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                                        {pos.realisedPnl != null ? formatPnl(pos.realisedPnl) : "—"}
                                      </td>
                                      <td className="py-2 px-2 text-xs text-muted-foreground">{pos.exitReason ?? "—"}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}
                      </TabsContent>
                    </Tabs>
                  </CardContent>
                </Card>
              </div>

              {/* Right: AI Signal Feed */}
              <div className="lg:col-span-2 space-y-4">
                <Card className="bg-[#0f1117] border-border/40">
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-sm font-bold uppercase tracking-wider">AI Signal Feed</CardTitle>
                      <div className="flex items-center gap-1">
                        <Brain className="h-3.5 w-3.5 text-blue-400" />
                        <span className="text-[10px] text-muted-foreground">GPT-4o Pipeline</span>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    {signals.length === 0 ? (
                      <div className="text-center py-8 text-muted-foreground text-sm">
                        No recent AI signals
                      </div>
                    ) : (
                      <div className="space-y-2 max-h-[400px] overflow-y-auto">
                        {signals.slice(0, 15).map((sig, i) => {
                          const stock = stockUniverse.find(s => s.assetId === sig.assetId);
                          const isBullish = sig.direction === "up" || sig.direction === "BULLISH";
                          const barColor = isBullish ? "bg-emerald-500" : sig.direction === "down" || sig.direction === "BEARISH" ? "bg-red-500" : "bg-zinc-500";
                          return (
                            <div key={i} className="flex items-start gap-3 p-2.5 rounded-lg border border-border/20 hover:border-border/40 transition-colors">
                              <div className={`w-1 h-full min-h-[40px] rounded-full ${barColor}`} />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between mb-1">
                                  <div className="flex items-center gap-2">
                                    <span className="text-sm font-medium">{stock?.symbol ?? sig.assetId}</span>
                                    {stock && <span className="text-[10px] text-muted-foreground">{stock.sector}</span>}
                                  </div>
                                  <span className="text-[10px] text-muted-foreground">{timeAgo(sig.createdAt)}</span>
                                </div>
                                <div className="flex items-center gap-2 mb-1">
                                  <DirectionBadge direction={sig.direction} />
                                  <span className="text-xs text-muted-foreground">{(sig.confidence ?? 0).toFixed(0)}% confidence</span>
                                </div>
                                <div className="flex items-center gap-1.5">
                                  <Progress value={sig.confidence ?? 0} className="h-1 flex-1 bg-muted/30" />
                                </div>
                                {sig.narrative && (
                                  <p className="text-xs text-muted-foreground mt-1.5 line-clamp-2">{sig.narrative}</p>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Market Regime */}
                {signals.find(s => s.assetId === "nifty50") && (
                  <Card className="bg-[#0f1117] border-border/40">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-sm font-bold uppercase tracking-wider">Market Regime</CardTitle>
                    </CardHeader>
                    <CardContent>
                      {(() => {
                        const niftySig = signals.find(s => s.assetId === "nifty50");
                        const regime = niftySig?.regime ?? "UNKNOWN";
                        const regimeColor = regime === "RISK_ON" ? "text-emerald-400" : regime === "RISK_OFF" ? "text-amber-400" : regime === "CRISIS" ? "text-red-400" : "text-muted-foreground";
                        return (
                          <div className="flex items-center justify-between">
                            <div>
                              <div className={`text-lg font-bold ${regimeColor}`}>{regime.replace("_", " ")}</div>
                              <div className="text-xs text-muted-foreground mt-0.5">NIFTY 50 regime classification</div>
                            </div>
                            <Activity className={`h-8 w-8 ${regimeColor} opacity-50`} />
                          </div>
                        );
                      })()}
                    </CardContent>
                  </Card>
                )}
              </div>
            </div>

            {/* Stock Universe Heatmap */}
            <Card className="bg-[#0f1117] border-border/40">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-bold uppercase tracking-wider">Stock Universe</CardTitle>
                  <Badge variant="outline" className="text-xs">{stockUniverse.length} stocks</Badge>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {sectors.map((sector) => {
                    const stocks = stocksBySector[sector] ?? [];
                    return (
                      <div key={sector}>
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2 font-bold">{sector}</div>
                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
                          {stocks.map((stock) => {
                            const liveStock = stockUniverse.find(s => s.symbol === stock.symbol);
                            const ltp = liveStock?.ltp ?? stock.ltp;
                            const stale = liveStock?.stale ?? true;
                            return (
                              <div
                                key={stock.symbol}
                                className={`rounded-lg p-2.5 border transition-colors ${
                                  stale
                                    ? "border-border/20 bg-muted/5"
                                    : "border-border/40 bg-muted/10 hover:bg-muted/20"
                                }`}
                              >
                                <div className="text-sm font-medium">{stock.symbol}</div>
                                <div className="text-xs text-muted-foreground truncate">{stock.name}</div>
                                <div className="text-sm font-bold tabular-nums mt-1" style={{ color: ltp ? "#e4e4e7" : "#71717a" }}>
                                  {ltp ? ltp.toFixed(2) : "—"}
                                </div>
                                <div className="flex items-center gap-1 mt-0.5">
                                  <CircleDot className={`h-2 w-2 ${stale ? "text-zinc-600" : "text-emerald-400 animate-pulse"}`} />
                                  <span className="text-[10px] text-muted-foreground">{stale ? "stale" : "live"}</span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          </div>
        </ScrollArea>
      </div>
    </AppLayout>
  );
}

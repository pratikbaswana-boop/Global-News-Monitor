import React, { useState, useEffect } from "react";
import { AppLayout } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useTradingWs } from "@/hooks/use-trading-ws";
import {
  TrendingUp,
  TrendingDown,
  Activity,
  Wallet,
  ArrowUpRight,
  ArrowDownRight,
  Trophy,
  Percent,
} from "lucide-react";

const API_BASE = "/api";

interface PaperTrade {
  id: string;
  assetSymbol: string;
  signal: string;
  direction: string;
  strike: number | null;
  quantity: number;
  entryPrice: number;
  exitPrice: number | null;
  realisedPnl: number | null;
  status: string;
  exitReason: string | null;
  executedAt: string;
  closedAt: string | null;
}

interface PaperTradingState {
  capital: number;
  initialCapital: number;
  activeTrade: {
    id: string;
    symbol: string;
    strike: number;
    entryPrice: number;
    currentPrice: number | null;
    quantity: number;
    signal: string;
    direction: string;
    highestPrice: number;
    stopLossPrice: number;
    unrealizedPnl: number | null;
    isFarOTM: boolean;
    executedAt: string;
  } | null;
  trades: PaperTrade[];
  totalPnl: number;
  totalTrades: number;
  winningTrades: number;
}

function formatNumber(n: number | null | undefined, decimals = 2): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("en-IN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function formatPnl(n: number | null | undefined): { text: string; color: string } {
  if (n === null || n === undefined) return { text: "—", color: "text-muted-foreground" };
  const text = (n >= 0 ? "+" : "") + formatNumber(n);
  const color = n >= 0 ? "text-emerald-400" : "text-red-400";
  return { text, color };
}

export default function PaperTradingPage() {
  const [restState, setRestState] = useState<PaperTradingState | null>(null);
  const [loading, setLoading] = useState(true);

  const [wsState, setWsState] = useState<PaperTradingState | null>(null);

  useTradingWs<PaperTradingState>("paper-trading", (d) => {
    setWsState((prev) => prev ? { ...prev, ...d } : d);
  });

  useEffect(() => {
    fetch(`${API_BASE}/paper-trading/state`)
      .then((res) => res.ok ? res.json() : null)
      .then((d) => { if (d) { setRestState(d); setLoading(false); } })
      .catch(() => setLoading(false));
  }, []);

  const state = wsState ?? restState;

  const capital = state?.capital ?? 0;
  const initialCapital = state?.initialCapital ?? 100000;
  const totalPnl = state?.totalPnl ?? 0;
  const totalTrades = state?.totalTrades ?? 0;
  const winningTrades = state?.winningTrades ?? 0;
  const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;
  const capitalPct = initialCapital > 0 ? ((capital - initialCapital) / initialCapital) * 100 : 0;

  const closedTrades = state?.trades.filter((t) => t.status === "closed") ?? [];
  const openTrade = state?.activeTrade ?? null;

  return (
    <AppLayout>
      <div className="flex-1 overflow-y-auto">
        <div className="p-6 max-w-screen-2xl mx-auto space-y-6">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Paper Trading</h1>
              <p className="text-sm text-muted-foreground mt-1">
                Virtual trading with Rs 1,00,000 compounding capital · Live signals · No real trades
              </p>
            </div>
            <Badge variant="outline" className="bg-amber-500/10 text-amber-400 border-amber-500/20">
              <Activity className="h-3 w-3 mr-1" /> Simulation
            </Badge>
          </div>

          {/* Summary Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card className="bg-[#10131b] border-border/20">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Wallet className="h-4 w-4 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Current Capital</span>
                </div>
                <p className="text-xl font-bold font-mono">₹{formatNumber(capital, 0)}</p>
                <p className={`text-[10px] mt-1 ${capitalPct >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {capitalPct >= 0 ? "+" : ""}{capitalPct.toFixed(2)}% from initial
                </p>
              </CardContent>
            </Card>

            <Card className="bg-[#10131b] border-border/20">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-2">
                  {totalPnl >= 0 ? <TrendingUp className="h-4 w-4 text-emerald-400" /> : <TrendingDown className="h-4 w-4 text-red-400" />}
                  <span className="text-xs text-muted-foreground">Total P&L</span>
                </div>
                <p className={`text-xl font-bold font-mono ${totalPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {totalPnl >= 0 ? "+" : ""}₹{formatNumber(totalPnl)}
                </p>
              </CardContent>
            </Card>

            <Card className="bg-[#10131b] border-border/20">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Trophy className="h-4 w-4 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Win Rate</span>
                </div>
                <p className="text-xl font-bold font-mono">{winRate.toFixed(1)}%</p>
                <p className="text-[10px] text-muted-foreground mt-1">
                  {winningTrades}/{totalTrades} trades
                </p>
              </CardContent>
            </Card>

            <Card className="bg-[#10131b] border-border/20">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Percent className="h-4 w-4 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Total Trades</span>
                </div>
                <p className="text-xl font-bold font-mono">{totalTrades}</p>
                <p className="text-[10px] text-muted-foreground mt-1">
                  Initial: ₹{formatNumber(initialCapital, 0)}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Active Trade */}
          <Card className="bg-[#10131b] border-border/20">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Activity className="h-4 w-4" /> Active Trade
              </CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? (
                <Skeleton className="h-16 bg-muted/30 rounded-lg" />
              ) : openTrade ? (
                <div className="rounded-lg border border-border/10 bg-[#0c0e14] p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className={`h-10 w-10 rounded-md flex items-center justify-center ${openTrade.signal === "BUY_CALL" ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"}`}>
                        {openTrade.signal === "BUY_CALL" ? <ArrowUpRight className="h-5 w-5" /> : <ArrowDownRight className="h-5 w-5" />}
                      </div>
                      <div>
                        <p className="text-sm font-mono font-medium">{openTrade.symbol}</p>
                        <p className="text-[10px] text-muted-foreground">
                          Strike: {openTrade.strike} · Qty: {openTrade.quantity} · {openTrade.signal}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      {(() => {
                        const pnl = formatPnl(openTrade.unrealizedPnl);
                        const pnlPct = openTrade.entryPrice > 0 && openTrade.currentPrice
                          ? ((openTrade.currentPrice - openTrade.entryPrice) / openTrade.entryPrice) * 100
                          : null;
                        return (
                          <>
                            <p className={`text-sm font-mono font-bold ${pnl.color}`}>{pnl.text}</p>
                            {pnlPct !== null && (
                              <p className={`text-[10px] ${pnlPct >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                                {pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(1)}%
                              </p>
                            )}
                          </>
                        );
                      })()}
                    </div>
                  </div>
                  <div className="grid grid-cols-4 gap-2 mt-3 text-[10px]">
                    <div>
                      <span className="text-muted-foreground">Entry: </span>
                      <span className="font-mono">₹{formatNumber(openTrade.entryPrice)}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Current: </span>
                      <span className="font-mono">₹{formatNumber(openTrade.currentPrice)}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Peak: </span>
                      <span className="font-mono">₹{formatNumber(openTrade.highestPrice)}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Stop: </span>
                      <span className="font-mono text-red-400">₹{formatNumber(openTrade.stopLossPrice)}</span>
                    </div>
                  </div>
                  {openTrade.isFarOTM && (
                    <div className="mt-2">
                      <Badge variant="outline" className="text-[9px] bg-orange-500/10 text-orange-400 border-orange-500/20">
                        Far OTM · Tighter stops
                      </Badge>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
                  <Activity className="h-8 w-8 mb-2 text-muted-foreground/30" />
                  <p className="text-sm">No active paper trade</p>
                  <p className="text-[10px] mt-1">Waiting for next signal...</p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Trade History */}
          <Card className="bg-[#10131b] border-border/20">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Trade History</CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="space-y-2">
                  {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-10 bg-muted/30 rounded-lg" />)}
                </div>
              ) : closedTrades.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
                  <p className="text-sm">No closed trades yet</p>
                </div>
              ) : (
                <div className="space-y-1 max-h-96 overflow-y-auto">
                  {closedTrades.map((trade) => {
                    const pnl = formatPnl(trade.realisedPnl);
                    const pnlPct = trade.entryPrice > 0 && trade.exitPrice
                      ? ((Number(trade.exitPrice) - trade.entryPrice) / trade.entryPrice) * 100
                      : null;
                    return (
                      <div key={trade.id} className="rounded-lg border border-border/10 bg-[#0c0e14] p-3 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className={`h-7 w-7 rounded-md flex items-center justify-center ${trade.signal === "BUY_CALL" ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"}`}>
                            {trade.signal === "BUY_CALL" ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
                          </div>
                          <div>
                            <p className="text-xs font-mono font-medium">{trade.assetSymbol}</p>
                            <p className="text-[9px] text-muted-foreground">
                              {trade.signal} · Strike {trade.strike ?? "—"} · Qty {trade.quantity}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-4">
                          <div className="text-right">
                            <p className={`text-xs font-mono font-bold ${pnl.color}`}>{pnl.text}</p>
                            {pnlPct !== null && (
                              <p className={`text-[9px] ${pnlPct >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                                {pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(1)}%
                              </p>
                            )}
                          </div>
                          <div className="text-right">
                            <p className="text-[9px] text-muted-foreground">
                              {trade.exitReason ?? "—"}
                            </p>
                            <p className="text-[9px] text-muted-foreground">
                              {new Date(trade.closedAt ?? trade.executedAt).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                            </p>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </AppLayout>
  );
}

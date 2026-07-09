import React, { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useTradingWs } from "@/hooks/use-trading-ws";
import { Shield, ArrowUpRight, ArrowDownRight, Wallet, TrendingUp, TrendingDown } from "lucide-react";

const API_BASE = "/api";

interface CondorLeg {
  leg: number;
  role: "sold_put" | "sold_call" | "hedge_put" | "hedge_call";
  strike: number;
  symbol: string;
  entryPremium: number;
  quantity: number;
  closed: boolean;
  exitPremium: number | null;
  currentPremium: number | null;
}

interface CondorActive {
  id: string;
  legs: CondorLeg[];
  spotAtEntry: number;
  expiryDate: string;
  directionTilt: string;
  netPremium: number;
  maxLoss: number;
  maxProfit: number;
  capitalInvested: number;
  lots: number;
  quantity: number;
  unrealizedPnl: number;
  realizedPnl: number;
  daysToExpiry: number;
  enteredAt: string;
}

interface CondorHistoryRow {
  id: string;
  status: string;
  realisedPnl: number | null;
  exitReason: string | null;
  directionTilt: string;
  netPremium: number;
  maxLoss: number;
  maxProfit: number;
  executedAt: string;
  closedAt: string | null;
}

interface CondorState {
  capital: number;
  initialCapital: number;
  active: CondorActive | null;
  history: CondorHistoryRow[];
  totalPnl: number;
  totalPositions: number;
  winningPositions: number;
}

function fmt(n: number | null | undefined, decimals = 2): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("en-IN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function pnlColor(n: number | null | undefined): string {
  if (n === null || n === undefined) return "text-muted-foreground";
  return n >= 0 ? "text-emerald-400" : "text-red-400";
}

const LEG_LABELS: Record<string, string> = {
  sold_put: "SELL PUT",
  sold_call: "SELL CALL",
  hedge_put: "BUY PUT (hedge)",
  hedge_call: "BUY CALL (hedge)",
};

export function CondorSection() {
  const [restState, setRestState] = useState<CondorState | null>(null);
  const [wsState, setWsState] = useState<CondorState | null>(null);
  const [loading, setLoading] = useState(true);

  useTradingWs<CondorState>("condor", (d) => {
    setWsState(d);
  });

  useEffect(() => {
    fetch(`${API_BASE}/condor/state`)
      .then((res) => (res.ok ? res.json() : null))
      .then((d) => { if (d) { setRestState(d); setLoading(false); } })
      .catch(() => setLoading(false));
  }, []);

  const state = wsState ?? restState;
  const active = state?.active ?? null;
  const totalPnl = state?.totalPnl ?? 0;
  const totalPositions = state?.totalPositions ?? 0;
  const winningPositions = state?.winningPositions ?? 0;
  const winRate = totalPositions > 0 ? (winningPositions / totalPositions) * 100 : 0;
  const history = state?.history?.filter((h) => h.status === "closed") ?? [];

  const totalLivePnl = active ? active.unrealizedPnl + active.realizedPnl : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-sky-400" />
          <h2 className="text-base font-semibold">Iron Condor (Option Selling)</h2>
        </div>
        <Badge variant="outline" className="bg-sky-500/10 text-sky-400 border-sky-500/20 text-[10px]">
          Sell far OTM · Hedge always · Theta income
        </Badge>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="bg-[#10131b] border-border/20">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <Wallet className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Available Capital</span>
            </div>
            <p className="text-xl font-bold font-mono">
              ₹{fmt(state?.capital ?? 0, 0)}
            </p>
            <p className="text-[10px] text-muted-foreground mt-1">
              {active
                ? `₹${fmt(active.capitalInvested, 0)} margin blocked · ${active.lots} lot(s)`
                : `of ₹${fmt(state?.initialCapital ?? 100000, 0)} initial pool`}
            </p>
          </CardContent>
        </Card>

        <Card className="bg-[#10131b] border-border/20">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              {totalLivePnl !== null && totalLivePnl >= 0 ? <TrendingUp className="h-4 w-4 text-emerald-400" /> : <TrendingDown className="h-4 w-4 text-red-400" />}
              <span className="text-xs text-muted-foreground">Current P&L</span>
            </div>
            <p className={`text-xl font-bold font-mono ${pnlColor(totalLivePnl)}`}>
              {totalLivePnl !== null ? `${totalLivePnl >= 0 ? "+" : ""}₹${fmt(totalLivePnl)}` : "—"}
            </p>
            <p className="text-[10px] text-muted-foreground mt-1">
              {active ? `${active.daysToExpiry.toFixed(1)}d to expiry` : "—"}
            </p>
          </CardContent>
        </Card>

        <Card className="bg-[#10131b] border-border/20">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <Shield className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Max Profit / Max Loss</span>
            </div>
            <p className="text-sm font-bold font-mono">
              {active ? (
                <>
                  <span className="text-emerald-400">+₹{fmt(active.maxProfit, 0)}</span>
                  {" / "}
                  <span className="text-red-400">-₹{fmt(active.maxLoss, 0)}</span>
                </>
              ) : "—"}
            </p>
            <p className="text-[10px] text-muted-foreground mt-1">
              Fixed at entry — hedge caps the loss
            </p>
          </CardContent>
        </Card>

        <Card className="bg-[#10131b] border-border/20">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Realised (net of costs)</span>
            </div>
            <p className={`text-xl font-bold font-mono ${pnlColor(totalPnl)}`}>
              {totalPnl >= 0 ? "+" : ""}₹{fmt(totalPnl)}
            </p>
            <p className="text-[10px] text-muted-foreground mt-1">
              {winRate.toFixed(0)}% win · {winningPositions}/{totalPositions} weeks
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Active condor legs */}
      <Card className="bg-[#10131b] border-border/20">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Shield className="h-4 w-4" /> Active Condor
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-24 bg-muted/30 rounded-lg" />
          ) : active ? (
            <div className="rounded-lg border border-border/10 bg-[#0c0e14] p-4 space-y-3">
              <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                <span>Spot at entry: <span className="font-mono text-foreground">{fmt(active.spotAtEntry, 0)}</span></span>
                <span>Expiry: <span className="font-mono text-foreground">{active.expiryDate}</span></span>
                <Badge variant="outline" className="text-[9px] capitalize">{active.directionTilt} tilt</Badge>
              </div>

              <div className="space-y-1.5">
                {active.legs.map((leg) => {
                  const isSold = leg.role === "sold_put" || leg.role === "sold_call";
                  const current = leg.closed ? leg.exitPremium : leg.currentPremium;
                  const legPnl = current !== null
                    ? (isSold ? (leg.entryPremium - current) : (current - leg.entryPremium)) * leg.quantity
                    : null;
                  return (
                    <div key={leg.leg} className="flex items-center justify-between text-xs bg-[#161a24] rounded-md px-3 py-2">
                      <div className="flex items-center gap-2">
                        <div className={`h-6 w-6 rounded flex items-center justify-center ${isSold ? "bg-emerald-500/10 text-emerald-400" : "bg-orange-500/10 text-orange-400"}`}>
                          {isSold ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                        </div>
                        <div>
                          <p className="font-mono font-medium">{LEG_LABELS[leg.role]} {leg.strike}</p>
                          <p className="text-[9px] text-muted-foreground font-mono">{leg.symbol}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="font-mono">
                          ₹{fmt(leg.entryPremium)} → ₹{fmt(current)}
                          {leg.closed && <span className="text-muted-foreground ml-1">(closed)</span>}
                        </p>
                        <p className={`text-[10px] font-mono ${pnlColor(legPnl)}`}>
                          {legPnl !== null ? `${legPnl >= 0 ? "+" : ""}₹${fmt(legPnl)}` : "—"}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="flex items-center justify-between text-[10px] text-muted-foreground pt-1 border-t border-border/10">
                <span>Net premium: <span className="font-mono text-foreground">₹{fmt(active.netPremium)}</span></span>
                <span>Entered: {new Date(active.enteredAt).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
              <Shield className="h-8 w-8 mb-2 text-muted-foreground/30" />
              <p className="text-sm">No active condor</p>
              <p className="text-[10px] mt-1">Enters weekday mornings when VIX, regime and event checks pass</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* History */}
      <Card className="bg-[#10131b] border-border/20">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Condor History</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">
              {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-10 bg-muted/30 rounded-lg" />)}
            </div>
          ) : history.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
              <p className="text-sm">No closed condors yet</p>
            </div>
          ) : (
            <div className="space-y-1 max-h-96 overflow-y-auto">
              {history.map((h) => (
                <div key={h.id} className="rounded-lg border border-border/10 bg-[#0c0e14] p-3 flex items-center justify-between">
                  <div>
                    <p className="text-xs font-mono font-medium capitalize">{h.directionTilt} tilt · Net ₹{fmt(h.netPremium)}</p>
                    <p className="text-[9px] text-muted-foreground">
                      Max +₹{fmt(h.maxProfit, 0)} / -₹{fmt(h.maxLoss, 0)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className={`text-xs font-mono font-bold ${pnlColor(h.realisedPnl)}`}>
                      {h.realisedPnl !== null ? `${h.realisedPnl >= 0 ? "+" : ""}₹${fmt(h.realisedPnl)}` : "—"}
                    </p>
                    <p className="text-[9px] text-muted-foreground">{h.exitReason ?? "—"}</p>
                    <p className="text-[9px] text-muted-foreground">
                      {new Date(h.closedAt ?? h.executedAt).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

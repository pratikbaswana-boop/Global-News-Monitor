import { useState, useEffect } from "react";
import { Loader2, TrendingUp, TrendingDown, AlertTriangle, Target, BarChart3, Lightbulb, CheckCircle2, XCircle, Clock, DollarSign, Activity, ArrowRight } from "lucide-react";

interface ReportData {
  generatedAt: string;
  paperTrades: Record<string, unknown>;
  condorPositions: Record<string, unknown>;
  signalExecutions: Record<string, unknown>;
  paperTradeHistory: TradeRow[];
  condorPositionHistory: CondorRow[];
  signalExecutionHistory: TradeRow[];
  missedSignals: MissedSignalRow[];
  exitAnalysis: ExitAnalysisRow[];
  directionAnalysis: DirectionRow[];
  tickComparisons: TickComparison[];
}

interface TradeRow {
  id: string;
  asset_symbol: string;
  direction: string;
  signal: string;
  quantity: number | string;
  entry_price: string | number | null;
  exit_price: string | number | null;
  realised_pnl: string | number | null;
  status: string;
  exit_strategy: string | null;
  exit_reason: string | null;
  executed_at: string;
  closed_at: string | null;
  capital_at_entry: string | number | null;
  highest_price_reached: string | number | null;
}

interface CondorRow {
  id: string;
  mode: string;
  status: string;
  spot_at_entry: string | number;
  expiry_date: string;
  direction_tilt: string;
  net_premium: string | number;
  max_loss: string | number;
  max_profit: string | number;
  lots: number;
  realised_pnl: string | number | null;
  exit_reason: string | null;
  executed_at: string;
  closed_at: string | null;
}

interface MissedSignalRow {
  id: string;
  asset_name: string;
  asset_symbol: string;
  predicted_direction: string;
  verdict: string;
  snapshot_at: string;
  resolved_at: string;
  resolution_direction: string | null;
  real_price_at_snapshot: string | number | null;
  real_price_at_resolution: string | number | null;
  price_change_pct: string | number | null;
  is_correct: boolean | null;
  bull_score: string | number | null;
  bear_score: string | number | null;
  dominant_narrative: string;
  regime_at_snapshot: string | null;
  trigger_news_summary: string;
}

interface ExitAnalysisRow {
  exit_reason: string;
  count: number;
  total_pnl: string | number;
  avg_pnl: string | number;
  wins: number;
  losses: number;
}

interface DirectionRow {
  direction: string;
  signal: string;
  total: number;
  wins: number;
  losses: number;
  total_pnl: string | number;
  avg_pnl: string | number;
}

interface TickComparison {
  tradeId: string;
  assetSymbol: string;
  entryPrice: number;
  exitPrice: number;
  realisedPnl: number;
  maxPrice: number | null;
  minPrice: number | null;
  optimalExit: number | null;
  potentialPnl: number | null;
  leftOnTable: number | null;
}

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function n(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const x = typeof v === "string" ? parseFloat(v) : Number(v);
  return Number.isFinite(x) ? x : 0;
}

function fmt(v: unknown, decimals = 2): string {
  const x = n(v);
  return x.toLocaleString("en-IN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtPnl(v: unknown): string {
  const x = n(v);
  const sign = x >= 0 ? "+" : "";
  return `${sign}${fmt(x)}`;
}

function pnlColor(v: unknown): string {
  const x = n(v);
  if (x > 0) return "text-emerald-400";
  if (x < 0) return "text-red-400";
  return "text-slate-400";
}

function fmtDate(s: string): string {
  if (!s) return "—";
  return new Date(s).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export default function ReportPage() {
  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"paper" | "condor" | "signals">("paper");

  useEffect(() => {
    fetch(`${basePath}/api/report/trading-performance`)
      .then((r) => { if (!r.ok) throw new Error("Failed to load"); return r.json(); })
      .then((d) => setData(d))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-center">
          <AlertTriangle className="w-8 h-8 text-red-400 mx-auto mb-2" />
          <p className="text-slate-400">{error || "No data available"}</p>
        </div>
      </div>
    );
  }

  const pt = data.paperTrades;
  const cp = data.condorPositions;
  const se = data.signalExecutions;
  const winRate = n(pt.winRate);
  const profitFactor = n(pt.profitFactor);
  const totalPnl = n(pt.total_pnl);
  const grossProfit = n(pt.gross_profit);
  const grossLoss = n(pt.gross_loss);
  const totalTrades = n(pt.total);
  const closedTrades = n(pt.closed);
  const openTrades = n(pt.open_count);
  const wins = n(pt.wins);
  const losses = n(pt.losses);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      {/* Header */}
      <div className="border-b border-slate-800 bg-slate-900/50">
        <div className="max-w-7xl mx-auto px-6 py-8">
          <div className="flex items-center gap-3 mb-2">
            <BarChart3 className="w-7 h-7 text-blue-400" />
            <h1 className="text-2xl font-bold text-white">Trading Performance Report</h1>
          </div>
          <p className="text-sm text-slate-400">
            Generated on {fmtDate(data.generatedAt)} · Based on paper trades, condor positions, signal executions, and tick-by-tick market data
          </p>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-8 space-y-8">
        {/* Executive Summary */}
        <section>
          <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
            <Activity className="w-5 h-5 text-blue-400" />
            Executive Summary — Paper Trading Engine
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
            <SummaryCard label="Total Trades" value={String(totalTrades)} sub={`${closedTrades} closed · ${openTrades} open`} icon={<BarChart3 className="w-4 h-4" />} />
            <SummaryCard label="Win Rate" value={`${winRate.toFixed(1)}%`} sub={`${wins}W / ${losses}L`} icon={winRate >= 50 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />} color={winRate >= 50 ? "text-emerald-400" : "text-red-400"} />
            <SummaryCard label="Net P&L" value={`₹${fmt(totalPnl)}`} sub={totalPnl >= 0 ? "Profit" : "Loss"} icon={<DollarSign className="w-4 h-4" />} color={pnlColor(totalPnl)} />
            <SummaryCard label="Profit Factor" value={profitFactor >= 999 ? "∞" : profitFactor.toFixed(2)} sub={`GP ₹${fmt(grossProfit)} / GL ₹${fmt(Math.abs(grossLoss))}`} icon={<Target className="w-4 h-4" />} color={profitFactor >= 1 ? "text-emerald-400" : "text-red-400"} />
            <SummaryCard label="Best Trade" value={`₹${fmt(pt.best_trade)}`} sub="Single best P&L" icon={<TrendingUp className="w-4 h-4" />} color="text-emerald-400" />
            <SummaryCard label="Worst Trade" value={`₹${fmt(pt.worst_trade)}`} sub="Single worst P&L" icon={<TrendingDown className="w-4 h-4" />} color="text-red-400" />
          </div>
        </section>

        {/* Condor & Signal Executions Summary */}
        <section className="grid md:grid-cols-2 gap-6">
          <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-5">
            <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-purple-400" />
              Iron Condor Positions
            </h3>
            <div className="grid grid-cols-3 gap-3 text-sm">
              <MiniStat label="Total" value={String(n(cp.total))} />
              <MiniStat label="Closed" value={String(n(cp.closed))} />
              <MiniStat label="Open" value={String(n(cp.open_count))} />
              <MiniStat label="Wins" value={String(n(cp.wins))} color="text-emerald-400" />
              <MiniStat label="Losses" value={String(n(cp.losses))} color="text-red-400" />
              <MiniStat label="Net P&L" value={`₹${fmt(cp.total_pnl)}`} color={pnlColor(cp.total_pnl)} />
            </div>
          </div>
          <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-5">
            <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-amber-400" />
              Signal Executions (Real Trades)
            </h3>
            <div className="grid grid-cols-3 gap-3 text-sm">
              <MiniStat label="Total" value={String(n(se.total))} />
              <MiniStat label="Closed" value={String(n(se.closed))} />
              <MiniStat label="Open" value={String(n(se.open_count))} />
              <MiniStat label="Wins" value={String(n(se.wins))} color="text-emerald-400" />
              <MiniStat label="Losses" value={String(n(se.losses))} color="text-red-400" />
              <MiniStat label="Net P&L" value={`₹${fmt(se.total_pnl)}`} color={pnlColor(se.total_pnl)} />
            </div>
          </div>
        </section>

        {/* Trade History Tabs */}
        <section>
          <div className="flex items-center gap-2 mb-4">
            <h2 className="text-lg font-semibold text-white">Trade History</h2>
            <div className="flex gap-1 ml-auto bg-slate-900 rounded-lg p-1 border border-slate-800">
              <TabButton active={activeTab === "paper"} onClick={() => setActiveTab("paper")} label="Paper Trades" />
              <TabButton active={activeTab === "condor"} onClick={() => setActiveTab("condor")} label="Condors" />
              <TabButton active={activeTab === "signals"} onClick={() => setActiveTab("signals")} label="Signal Execs" />
            </div>
          </div>

          {activeTab === "paper" && (
            <TradeTable rows={data.paperTradeHistory} />
          )}
          {activeTab === "condor" && (
            <CondorTable rows={data.condorPositionHistory} />
          )}
          {activeTab === "signals" && (
            <TradeTable rows={data.signalExecutionHistory} />
          )}
        </section>

        {/* Missed Signals */}
        <section>
          <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-amber-400" />
            Missed Signals — Hypothetical Opportunity Analysis
          </h2>
          <p className="text-sm text-slate-400 mb-4">
            Signals generated by the system with a clear directional verdict that were not acted upon. The table shows what would have happened if each signal had been traded.
          </p>
          {data.missedSignals.length === 0 ? (
            <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-8 text-center text-slate-400">
              <CheckCircle2 className="w-6 h-6 text-emerald-400 mx-auto mb-2" />
              No missed signals — every actionable signal was traded.
            </div>
          ) : (
            <div className="overflow-x-auto bg-slate-900/50 rounded-xl border border-slate-800">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400 text-xs uppercase tracking-wider">
                    <th className="text-left p-3">Date</th>
                    <th className="text-left p-3">Asset</th>
                    <th className="text-left p-3">Verdict</th>
                    <th className="text-right p-3">Bull Score</th>
                    <th className="text-right p-3">Bear Score</th>
                    <th className="text-right p-3">Price @ Signal</th>
                    <th className="text-right p-3">Price @ Resolution</th>
                    <th className="text-right p-3">Change %</th>
                    <th className="text-center p-3">Correct?</th>
                  </tr>
                </thead>
                <tbody>
                  {data.missedSignals.slice(0, 25).map((s) => {
                    const change = n(s.price_change_pct);
                    const correct = s.is_correct;
                    return (
                      <tr key={s.id} className="border-b border-slate-800/50 hover:bg-slate-800/30">
                        <td className="p-3 text-slate-400 text-xs">{fmtDate(s.snapshot_at)}</td>
                        <td className="p-3 text-white font-medium">{s.asset_name || s.asset_symbol}</td>
                        <td className="p-3">
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${s.verdict === "BULLISH" ? "bg-emerald-500/20 text-emerald-400" : s.verdict === "BEARISH" ? "bg-red-500/20 text-red-400" : "bg-slate-700 text-slate-300"}`}>
                            {s.verdict}
                          </span>
                        </td>
                        <td className="p-3 text-right text-slate-300">{s.bull_score ? fmt(s.bull_score, 1) : "—"}</td>
                        <td className="p-3 text-right text-slate-300">{s.bear_score ? fmt(s.bear_score, 1) : "—"}</td>
                        <td className="p-3 text-right text-slate-300">{s.real_price_at_snapshot ? fmt(s.real_price_at_snapshot) : "—"}</td>
                        <td className="p-3 text-right text-slate-300">{s.real_price_at_resolution ? fmt(s.real_price_at_resolution) : "—"}</td>
                        <td className={`p-3 text-right font-medium ${change >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                          {change >= 0 ? "+" : ""}{fmt(change)}%
                        </td>
                        <td className="p-3 text-center">
                          {correct === true && <CheckCircle2 className="w-4 h-4 text-emerald-400 mx-auto" />}
                          {correct === false && <XCircle className="w-4 h-4 text-red-400 mx-auto" />}
                          {correct === null && <span className="text-slate-500">—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {data.missedSignals.length > 25 && (
                <div className="p-3 text-center text-xs text-slate-500">
                  Showing 25 of {data.missedSignals.length} missed signals
                </div>
              )}
            </div>
          )}
        </section>

        {/* Tick-by-Tick Comparison */}
        <section>
          <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
            <Activity className="w-5 h-5 text-cyan-400" />
            Tick-by-Tick Exit Analysis — Actual vs Optimal Exit
          </h2>
          <p className="text-sm text-slate-400 mb-4">
            Compares actual exit prices against the best possible exit price from tick-by-tick market data during each trade's holding period. "Left on Table" quantifies unrealized profit.
          </p>
          {data.tickComparisons.length === 0 ? (
            <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-8 text-center text-slate-400">
              No tick data available for comparison.
            </div>
          ) : (
            <div className="overflow-x-auto bg-slate-900/50 rounded-xl border border-slate-800">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400 text-xs uppercase tracking-wider">
                    <th className="text-left p-3">Symbol</th>
                    <th className="text-right p-3">Entry</th>
                    <th className="text-right p-3">Exit</th>
                    <th className="text-right p-3">Realised P&L</th>
                    <th className="text-right p-3">Optimal Exit</th>
                    <th className="text-right p-3">Potential P&L</th>
                    <th className="text-right p-3">Left on Table</th>
                    <th className="text-right p-3">Capture %</th>
                  </tr>
                </thead>
                <tbody>
                  {data.tickComparisons.map((t) => {
                    const capture = t.potentialPnl && t.potentialPnl !== 0 ? (t.realisedPnl / t.potentialPnl) * 100 : null;
                    return (
                      <tr key={t.tradeId} className="border-b border-slate-800/50 hover:bg-slate-800/30">
                        <td className="p-3 text-white font-medium text-xs">{t.assetSymbol}</td>
                        <td className="p-3 text-right text-slate-300">{fmt(t.entryPrice)}</td>
                        <td className="p-3 text-right text-slate-300">{fmt(t.exitPrice)}</td>
                        <td className={`p-3 text-right font-medium ${pnlColor(t.realisedPnl)}`}>{fmtPnl(t.realisedPnl)}</td>
                        <td className="p-3 text-right text-slate-300">{t.optimalExit ? fmt(t.optimalExit) : "—"}</td>
                        <td className="p-3 text-right text-slate-300">{t.potentialPnl !== null ? fmtPnl(t.potentialPnl) : "—"}</td>
                        <td className={`p-3 text-right font-medium ${n(t.leftOnTable) > 0 ? "text-amber-400" : "text-slate-400"}`}>
                          {t.leftOnTable !== null ? fmtPnl(t.leftOnTable) : "—"}
                        </td>
                        <td className="p-3 text-right text-slate-300">
                          {capture !== null ? `${capture.toFixed(0)}%` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Exit Reason & Direction Analysis */}
        <section className="grid md:grid-cols-2 gap-6">
          <div>
            <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
              <Target className="w-5 h-5 text-blue-400" />
              Exit Strategy Analysis
            </h2>
            <div className="bg-slate-900/50 rounded-xl border border-slate-800 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400 text-xs uppercase tracking-wider">
                    <th className="text-left p-3">Exit Reason</th>
                    <th className="text-right p-3">Count</th>
                    <th className="text-right p-3">Win/Loss</th>
                    <th className="text-right p-3">Total P&L</th>
                    <th className="text-right p-3">Avg P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {data.exitAnalysis.map((e) => (
                    <tr key={e.exit_reason} className="border-b border-slate-800/50">
                      <td className="p-3 text-white capitalize">{e.exit_reason.replace(/_/g, " ")}</td>
                      <td className="p-3 text-right text-slate-300">{e.count}</td>
                      <td className="p-3 text-right text-xs">
                        <span className="text-emerald-400">{e.wins}W</span>
                        {" / "}
                        <span className="text-red-400">{e.losses}L</span>
                      </td>
                      <td className={`p-3 text-right font-medium ${pnlColor(e.total_pnl)}`}>{fmtPnl(e.total_pnl)}</td>
                      <td className={`p-3 text-right ${pnlColor(e.avg_pnl)}`}>{fmtPnl(e.avg_pnl)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
              <BarChart3 className="w-5 h-5 text-purple-400" />
              Directional Performance
            </h2>
            <div className="bg-slate-900/50 rounded-xl border border-slate-800 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400 text-xs uppercase tracking-wider">
                    <th className="text-left p-3">Signal</th>
                    <th className="text-right p-3">Total</th>
                    <th className="text-right p-3">Win Rate</th>
                    <th className="text-right p-3">Total P&L</th>
                    <th className="text-right p-3">Avg P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {data.directionAnalysis.map((d) => {
                    const wr = d.total > 0 ? (d.wins / d.total) * 100 : 0;
                    return (
                      <tr key={`${d.direction}-${d.signal}`} className="border-b border-slate-800/50">
                        <td className="p-3">
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${d.signal === "BUY_CALL" ? "bg-emerald-500/20 text-emerald-400" : "bg-red-500/20 text-red-400"}`}>
                            {d.signal}
                          </span>
                        </td>
                        <td className="p-3 text-right text-slate-300">{d.total}</td>
                        <td className="p-3 text-right text-slate-300">{wr.toFixed(0)}%</td>
                        <td className={`p-3 text-right font-medium ${pnlColor(d.total_pnl)}`}>{fmtPnl(d.total_pnl)}</td>
                        <td className={`p-3 text-right ${pnlColor(d.avg_pnl)}`}>{fmtPnl(d.avg_pnl)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* Auto-generated Insights */}
        <InsightsSection data={data} />
      </div>
    </div>
  );
}

function SummaryCard({ label, value, sub, icon, color }: { label: string; value: string; sub?: string; icon: React.ReactNode; color?: string }) {
  return (
    <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-4">
      <div className="flex items-center gap-2 text-slate-400 text-xs mb-1">
        {icon}
        {label}
      </div>
      <div className={`text-xl font-bold ${color || "text-white"}`}>{value}</div>
      {sub && <div className="text-xs text-slate-500 mt-1">{sub}</div>}
    </div>
  );
}

function MiniStat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div className="text-slate-500 text-xs mb-0.5">{label}</div>
      <div className={`font-semibold ${color || "text-white"}`}>{value}</div>
    </div>
  );
}

function TabButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${active ? "bg-slate-700 text-white" : "text-slate-400 hover:text-slate-200"}`}
    >
      {label}
    </button>
  );
}

function TradeTable({ rows }: { rows: TradeRow[] }) {
  if (rows.length === 0) {
    return <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-8 text-center text-slate-400">No trades found.</div>;
  }
  return (
    <div className="overflow-x-auto bg-slate-900/50 rounded-xl border border-slate-800">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-800 text-slate-400 text-xs uppercase tracking-wider">
            <th className="text-left p-3">Date</th>
            <th className="text-left p-3">Symbol</th>
            <th className="text-left p-3">Signal</th>
            <th className="text-right p-3">Qty</th>
            <th className="text-right p-3">Entry</th>
            <th className="text-right p-3">Exit</th>
            <th className="text-right p-3">P&L</th>
            <th className="text-left p-3">Exit Reason</th>
            <th className="text-center p-3">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 50).map((t) => (
            <tr key={t.id} className="border-b border-slate-800/50 hover:bg-slate-800/30">
              <td className="p-3 text-slate-400 text-xs">{fmtDate(t.executed_at)}</td>
              <td className="p-3 text-white font-medium text-xs">{t.asset_symbol}</td>
              <td className="p-3">
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${t.signal === "BUY_CALL" ? "bg-emerald-500/20 text-emerald-400" : t.signal === "BUY_PUT" ? "bg-red-500/20 text-red-400" : "bg-slate-700 text-slate-300"}`}>
                  {t.signal}
                </span>
              </td>
              <td className="p-3 text-right text-slate-300">{t.quantity}</td>
              <td className="p-3 text-right text-slate-300">{t.entry_price ? fmt(t.entry_price) : "—"}</td>
              <td className="p-3 text-right text-slate-300">{t.exit_price ? fmt(t.exit_price) : "—"}</td>
              <td className={`p-3 text-right font-medium ${pnlColor(t.realised_pnl)}`}>{t.realised_pnl !== null ? fmtPnl(t.realised_pnl) : "—"}</td>
              <td className="p-3 text-slate-400 text-xs capitalize">{t.exit_reason ? t.exit_reason.replace(/_/g, " ") : "—"}</td>
              <td className="p-3 text-center">
                <span className={`px-2 py-0.5 rounded text-xs ${t.status === "closed" ? "bg-slate-700 text-slate-300" : "bg-blue-500/20 text-blue-400"}`}>
                  {t.status}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 50 && <div className="p-3 text-center text-xs text-slate-500">Showing 50 of {rows.length} trades</div>}
    </div>
  );
}

function CondorTable({ rows }: { rows: CondorRow[] }) {
  if (rows.length === 0) {
    return <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-8 text-center text-slate-400">No condor positions found.</div>;
  }
  return (
    <div className="overflow-x-auto bg-slate-900/50 rounded-xl border border-slate-800">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-800 text-slate-400 text-xs uppercase tracking-wider">
            <th className="text-left p-3">Date</th>
            <th className="text-left p-3">Mode</th>
            <th className="text-right p-3">Spot</th>
            <th className="text-left p-3">Tilt</th>
            <th className="text-right p-3">Net Premium</th>
            <th className="text-right p-3">Max Profit</th>
            <th className="text-right p-3">Max Loss</th>
            <th className="text-right p-3">P&L</th>
            <th className="text-center p-3">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 50).map((c) => (
            <tr key={c.id} className="border-b border-slate-800/50 hover:bg-slate-800/30">
              <td className="p-3 text-slate-400 text-xs">{fmtDate(c.executed_at)}</td>
              <td className="p-3">
                <span className={`px-2 py-0.5 rounded text-xs ${c.mode === "real" ? "bg-amber-500/20 text-amber-400" : "bg-slate-700 text-slate-300"}`}>{c.mode}</span>
              </td>
              <td className="p-3 text-right text-slate-300">{fmt(c.spot_at_entry)}</td>
              <td className="p-3 text-slate-300 capitalize text-xs">{c.direction_tilt}</td>
              <td className="p-3 text-right text-slate-300">{fmt(c.net_premium)}</td>
              <td className="p-3 text-right text-emerald-400/70">{fmt(c.max_profit)}</td>
              <td className="p-3 text-right text-red-400/70">{fmt(c.max_loss)}</td>
              <td className={`p-3 text-right font-medium ${pnlColor(c.realised_pnl)}`}>{c.realised_pnl !== null ? fmtPnl(c.realised_pnl) : "—"}</td>
              <td className="p-3 text-center">
                <span className={`px-2 py-0.5 rounded text-xs ${c.status === "closed" ? "bg-slate-700 text-slate-300" : "bg-blue-500/20 text-blue-400"}`}>{c.status}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InsightsSection({ data }: { data: ReportData }) {
  const insights: { type: "positive" | "negative" | "neutral"; title: string; detail: string }[] = [];
  const recommendations: { title: string; detail: string }[] = [];

  const pt = data.paperTrades;
  const winRate = n(pt.winRate);
  const profitFactor = n(pt.profitFactor);
  const totalPnl = n(pt.total_pnl);

  // Positive insights
  if (winRate >= 50) {
    insights.push({ type: "positive", title: "Win Rate Above 50%", detail: `The paper trading engine maintains a ${winRate.toFixed(1)}% win rate across ${n(pt.closed)} closed trades, indicating the signal generation logic is directionally accurate.` });
  }
  if (profitFactor >= 1.5) {
    insights.push({ type: "positive", title: "Healthy Profit Factor", detail: `Profit factor of ${profitFactor.toFixed(2)} means gross profits exceed gross losses by ${((profitFactor - 1) * 100).toFixed(0)}%. This is a sustainable edge.` });
  }
  if (totalPnl > 0) {
    insights.push({ type: "positive", title: "Net Profitable", detail: `The system has generated ₹${fmt(totalPnl)} in net paper P&L, validating the end-to-end pipeline from signal generation to execution.` });
  }

  // Direction analysis insights
  for (const d of data.directionAnalysis) {
    const wr = d.total > 0 ? (d.wins / d.total) * 100 : 0;
    if (wr >= 60 && d.total >= 3) {
      insights.push({ type: "positive", title: `${d.signal} Performs Well`, detail: `${d.signal} has a ${wr.toFixed(0)}% win rate across ${d.total} trades with ₹${fmtPnl(d.total_pnl)} P&L. This directional edge should be maintained.` });
    }
    if (wr < 40 && d.total >= 3) {
      insights.push({ type: "negative", title: `${d.signal} Underperforming`, detail: `${d.signal} has only a ${wr.toFixed(0)}% win rate across ${d.total} trades. Consider tightening entry filters for this signal type.` });
    }
  }

  // Exit analysis insights
  for (const e of data.exitAnalysis) {
    if (e.exit_reason === "stop_loss" && n(e.total_pnl) < 0) {
      insights.push({ type: "negative", title: "Stop Losses Impacting P&L", detail: `${e.count} trades exited via stop loss for a total of ₹${fmt(n(e.total_pnl))}. Review stop-loss placement — may be too tight.` });
    }
    if (e.exit_reason === "target_hit" && n(e.total_pnl) > 0) {
      insights.push({ type: "positive", title: "Target Hits Profitable", detail: `${e.count} trades hit their target for ₹${fmt(n(e.total_pnl))} in profit. The fixed-target exit strategy is working.` });
    }
    if (e.exit_reason === "trailing_stop" && n(e.total_pnl) > 0) {
      insights.push({ type: "positive", title: "Trailing Ratchet Captures Profit", detail: `Trailing stop exits generated ₹${fmt(n(e.total_pnl))} across ${e.count} trades. The ratchet mechanism is effectively locking in gains.` });
    }
  }

  // Tick comparison insights
  const totalLeftOnTable = data.tickComparisons.reduce((sum, t) => sum + (n(t.leftOnTable) > 0 ? n(t.leftOnTable) : 0), 0);
  if (totalLeftOnTable > 0) {
    insights.push({ type: "negative", title: "Exit Timing Leaves Profit on Table", detail: `Across ${data.tickComparisons.length} analyzed trades, ₹${fmt(totalLeftOnTable)} in potential profit was captured suboptimally. Better exit timing could improve returns by ${((totalLeftOnTable / Math.max(1, n(pt.total_pnl))) * 100).toFixed(0)}%.` });
  }

  // Missed signals insights
  const missedCount = data.missedSignals.length;
  const missedCorrect = data.missedSignals.filter((s) => s.is_correct === true).length;
  if (missedCount > 0) {
    const missedWinRate = (missedCorrect / missedCount) * 100;
    insights.push({
      type: missedWinRate > 50 ? "negative" : "neutral",
      title: `${missedCount} Signals Missed`,
      detail: `${missedCorrect} of ${missedCount} missed signals were directionally correct (${missedWinRate.toFixed(0)}%). ${missedWinRate > 50 ? "These were actionable opportunities that were not captured." : "Many missed signals would have been incorrect, so skipping them was partially justified."}`,
    });
  }

  // Recommendations
  if (totalLeftOnTable > 0) {
    recommendations.push({ title: "Improve Exit Timing", detail: "Consider tighter trailing stops or partial profit booking at key levels to capture more of the intra-trade price movement. Tick data shows significant unrealized upside on several trades." });
  }
  if (missedCount > 5 && missedCorrect > missedCount * 0.4) {
    recommendations.push({ title: "Reduce Signal Rejection Rate", detail: `${missedCount} signals were generated but not traded. Review the trade-skip logic (confidence thresholds, risk limits, cooldowns) to ensure high-conviction signals are not being filtered out.` });
  }
  if (profitFactor < 1.5 && profitFactor > 0) {
    recommendations.push({ title: "Tighten Risk Management", detail: `Profit factor of ${profitFactor.toFixed(2)} is below the 1.5 threshold for sustainable trading. Consider reducing position size on low-confidence signals or widening stop-loss to avoid premature exits.` });
  }
  recommendations.push({ title: "Maintain Directional Edge", detail: "The signal generation pipeline (news → knowledge graph → reasoning → market signal) is producing actionable directional calls. Continue refining the Tier-3 signal buffer and HMM regime detection for better market context." });
  recommendations.push({ title: "Expand Tick Data Coverage", detail: "Ensure tick-by-tick data is archived for all traded instruments. This enables post-trade analysis, backtesting new exit strategies, and auditing slippage." });

  return (
    <section>
      <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
        <Lightbulb className="w-5 h-5 text-amber-400" />
        Insights & Recommendations
      </h2>

      {insights.length > 0 && (
        <div className="grid md:grid-cols-2 gap-3 mb-6">
          {insights.map((ins, i) => (
            <div key={i} className={`rounded-xl border p-4 ${ins.type === "positive" ? "border-emerald-800/50 bg-emerald-900/10" : ins.type === "negative" ? "border-red-800/50 bg-red-900/10" : "border-slate-800 bg-slate-900/50"}`}>
              <div className="flex items-start gap-3">
                {ins.type === "positive" && <CheckCircle2 className="w-5 h-5 text-emerald-400 flex-shrink-0 mt-0.5" />}
                {ins.type === "negative" && <AlertTriangle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />}
                {ins.type === "neutral" && <Clock className="w-5 h-5 text-slate-400 flex-shrink-0 mt-0.5" />}
                <div>
                  <h3 className="text-sm font-semibold text-white">{ins.title}</h3>
                  <p className="text-xs text-slate-400 mt-1">{ins.detail}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-3">
        {recommendations.map((rec, i) => (
          <div key={i} className="rounded-xl border border-blue-800/50 bg-blue-900/10 p-4">
            <div className="flex items-start gap-3">
              <ArrowRight className="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5" />
              <div>
                <h3 className="text-sm font-semibold text-white">{rec.title}</h3>
                <p className="text-xs text-slate-400 mt-1">{rec.detail}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

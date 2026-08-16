import { Router } from "express";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";

const router = Router();

function toNum(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "string" ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

router.get("/report/trading-performance", async (_req, res) => {
  try {
    const [paperSummary, condorSummary, execSummary] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status='closed') AS closed,
        COUNT(*) FILTER (WHERE status='open') AS open_count,
        COUNT(*) FILTER (WHERE status='closed' AND realised_pnl>0) AS wins,
        COUNT(*) FILTER (WHERE status='closed' AND realised_pnl<0) AS losses,
        COALESCE(SUM(realised_pnl) FILTER (WHERE status='closed'),0) AS total_pnl,
        COALESCE(AVG(realised_pnl) FILTER (WHERE status='closed'),0) AS avg_pnl,
        COALESCE(MAX(realised_pnl) FILTER (WHERE status='closed'),0) AS best_trade,
        COALESCE(MIN(realised_pnl) FILTER (WHERE status='closed'),0) AS worst_trade,
        COALESCE(SUM(realised_pnl) FILTER (WHERE status='closed' AND realised_pnl>0),0) AS gross_profit,
        COALESCE(SUM(realised_pnl) FILTER (WHERE status='closed' AND realised_pnl<0),0) AS gross_loss
        FROM paper_trades`),
      pool.query(`SELECT COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status='closed') AS closed,
        COUNT(*) FILTER (WHERE status='open') AS open_count,
        COUNT(*) FILTER (WHERE status='closed' AND realised_pnl>0) AS wins,
        COUNT(*) FILTER (WHERE status='closed' AND realised_pnl<0) AS losses,
        COALESCE(SUM(realised_pnl) FILTER (WHERE status='closed'),0) AS total_pnl,
        COALESCE(AVG(realised_pnl) FILTER (WHERE status='closed'),0) AS avg_pnl,
        COALESCE(MAX(realised_pnl) FILTER (WHERE status='closed'),0) AS best_trade,
        COALESCE(MIN(realised_pnl) FILTER (WHERE status='closed'),0) AS worst_trade
        FROM condor_positions`),
      pool.query(`SELECT COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status='closed') AS closed,
        COUNT(*) FILTER (WHERE status='open') AS open_count,
        COUNT(*) FILTER (WHERE status='closed' AND realised_pnl>0) AS wins,
        COUNT(*) FILTER (WHERE status='closed' AND realised_pnl<0) AS losses,
        COALESCE(SUM(realised_pnl) FILTER (WHERE status='closed'),0) AS total_pnl,
        COALESCE(AVG(realised_pnl) FILTER (WHERE status='closed'),0) AS avg_pnl
        FROM signal_executions`),
    ]);

    const [paperTrades, condorPositions, signalExecs, missedSignals, exitAnalysis, directionAnalysis] = await Promise.all([
      pool.query(`SELECT id,signal_snapshot_id,asset_symbol,direction,signal,strike,quantity,
        entry_price,exit_price,realised_pnl,status,stop_loss_price,highest_price_reached,
        trail_gap_pct,exit_strategy,exit_reason,notes,capital_at_entry,executed_at,closed_at
        FROM paper_trades ORDER BY executed_at DESC LIMIT 200`),
      pool.query(`SELECT id,mode,status,spot_at_entry,expiry_date,direction_tilt,legs_json,
        net_premium,max_loss,max_profit,lots,quantity,capital_at_entry,realised_pnl,
        exit_reason,notes_json,executed_at,closed_at
        FROM condor_positions ORDER BY executed_at DESC LIMIT 100`),
      pool.query(`SELECT id,signal_snapshot_id,asset_symbol,direction,quantity,
        entry_price,exit_price,realised_pnl,status,target_price,stop_loss_price,
        highest_price_reached,exit_strategy,exit_reason,executed_at,closed_at
        FROM signal_executions ORDER BY executed_at DESC LIMIT 200`),
      pool.query(`SELECT ms.id,ms.asset_name,ms.asset_symbol,ms.predicted_direction,
        ms.verdict,ms.snapshot_at,ms.resolved_at,ms.resolution_direction,
        ms.real_price_at_snapshot,ms.real_price_at_resolution,ms.price_change_pct,
        ms.is_correct,ms.bull_score,ms.bear_score,ms.dominant_narrative,
        ms.regime_at_snapshot,ms.trigger_news_summary
        FROM market_snapshots ms
        WHERE ms.verdict IS NOT NULL AND ms.verdict!='UNCERTAIN' AND ms.resolved_at IS NOT NULL
          AND ms.id NOT IN (SELECT signal_snapshot_id FROM paper_trades WHERE signal_snapshot_id IS NOT NULL)
          AND ms.id NOT IN (SELECT signal_snapshot_id FROM signal_executions WHERE signal_snapshot_id IS NOT NULL)
        ORDER BY ms.snapshot_at DESC LIMIT 100`),
      pool.query(`SELECT COALESCE(exit_reason,'unknown') AS exit_reason,
        COUNT(*) AS count, COALESCE(SUM(realised_pnl),0) AS total_pnl,
        COALESCE(AVG(realised_pnl),0) AS avg_pnl,
        COUNT(*) FILTER (WHERE realised_pnl>0) AS wins,
        COUNT(*) FILTER (WHERE realised_pnl<0) AS losses
        FROM paper_trades WHERE status='closed' GROUP BY exit_reason ORDER BY total_pnl DESC`),
      pool.query(`SELECT direction,signal,COUNT(*) AS total,
        COUNT(*) FILTER (WHERE realised_pnl>0) AS wins,
        COUNT(*) FILTER (WHERE realised_pnl<0) AS losses,
        COALESCE(SUM(realised_pnl),0) AS total_pnl,
        COALESCE(AVG(realised_pnl),0) AS avg_pnl
        FROM paper_trades WHERE status='closed' GROUP BY direction,signal ORDER BY total_pnl DESC`),
    ]);

    // Tick comparison for top 30 closed paper trades
    const tickComparisons: unknown[] = [];
    const closedTrades = paperTrades.rows.filter((t: Record<string, unknown>) => t.status === "closed" && t.closed_at && t.asset_symbol).slice(0, 30);
    for (const trade of closedTrades) {
      try {
        const td = await pool.query(
          `SELECT MAX(ltp) as max_price, MIN(ltp) as min_price FROM tick_archive
           WHERE tradingsymbol=$1 AND ts BETWEEN $2 AND $3 AND category='option'`,
          [trade.asset_symbol, trade.executed_at, trade.closed_at],
        );
        const maxP = td.rows[0]?.max_price ? toNum(td.rows[0].max_price) : null;
        const minP = td.rows[0]?.min_price ? toNum(td.rows[0].min_price) : null;
        const entry = toNum(trade.entry_price);
        const qty = toNum(trade.quantity);
        const isCall = trade.signal === "BUY_CALL";
        const opt = isCall ? maxP : minP;
        tickComparisons.push({
          tradeId: trade.id, assetSymbol: trade.asset_symbol,
          entryPrice: entry, exitPrice: toNum(trade.exit_price),
          realisedPnl: toNum(trade.realised_pnl),
          maxPrice: maxP, minPrice: minP, optimalExit: opt,
          potentialPnl: opt ? (opt - entry) * qty : null,
          leftOnTable: opt ? (opt - entry) * qty - toNum(trade.realised_pnl) : null,
        });
      } catch { /* skip tick errors */ }
    }

    // Aggregate stats
    const ps = paperSummary.rows[0];
    const cs = condorSummary.rows[0];
    const es = execSummary.rows[0];
    const winRate = toNum(ps.wins) / Math.max(1, toNum(ps.closed)) * 100;
    const profitFactor = toNum(ps.gross_loss) !== 0 ? toNum(ps.gross_profit) / Math.abs(toNum(ps.gross_loss)) : toNum(ps.gross_profit) > 0 ? 999 : 0;

    res.json({
      generatedAt: new Date().toISOString(),
      paperTrades: { ...ps, winRate, profitFactor },
      condorPositions: cs,
      signalExecutions: es,
      paperTradeHistory: paperTrades.rows,
      condorPositionHistory: condorPositions.rows,
      signalExecutionHistory: signalExecs.rows,
      missedSignals: missedSignals.rows,
      exitAnalysis: exitAnalysis.rows,
      directionAnalysis: directionAnalysis.rows,
      tickComparisons,
    });
  } catch (err) {
    logger.error({ err }, "report: trading-performance failed");
    res.status(500).json({ error: "Failed to generate report" });
  }
});

export default router;

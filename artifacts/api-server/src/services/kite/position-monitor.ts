import { db, signalExecutionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../../lib/logger.js";
import { placeOrder, placeProtectiveStop, cancelOrder, modifyOrder } from "./orders.js";
import { getPositions } from "./portfolio.js";
import { getGlobalKiteClient } from "./kite-option-chain.js";
import { getKiteClientForUser } from "./kite-client.js";
import { getLtpBySymbol, trackHeldSymbol, untrackHeldSymbol, marketTicker } from "./market-ticker.js";
import { enqueueAudit } from "../../lib/audit-queue.js";
import { markFlat, markPendingExit } from "./position-state.js";

// Asset symbol -> exchange mapping (mirrored from signal-executor.ts)
const ASSET_EXCHANGE_MAP: Record<string, string> = {
  nifty50: "NSE",
  sensex: "BSE",
  reliance: "NSE",
  tcs: "NSE",
  "hdfc-bank": "NSE",
};

// ── Tick-driven exit control (R5) ─────────────────────────────────────────────
// Evaluation is driven by the KiteTicker feed, but throttled: the exchange-side SL-M
// backstop fires the actual stop natively (zero latency), so our loop only has to raise
// the trailing trigger, catch fills/closes, and run time-stops — none of which needs
// sub-second cadence. getPositions() is a broker call, so we bound how often it runs.
const EVAL_THROTTLE_MS = 2_000;
const SAFETY_INTERVAL_MS = 30_000; // heartbeat in case ticks stop flowing

let started = false;
let lastEvalAt = 0;
let running = false;

/**
 * Mutable per-execution exit state, held in memory so the tick loop never depends on
 * reading back its own write-behind (R4) DB updates. Hydrated lazily from the execution
 * row, persisted write-behind.
 */
interface ExitState {
  peak: number;
  slOrderId?: string;
  slTrigger?: number;
  exitOrderId?: string;
  exitAttempts: number;
  exitReason?: string;
  hydrated: boolean;
}
const exitStates = new Map<string, ExitState>();

function roundTick(price: number): number {
  return Math.round(price / 0.05) * 0.05;
}

/**
 * Compute the ratchet floor/ceiling for a given execution. (Unchanged.)
 *
 * Milestones every `milestoneStep`% of profit from entry (10% for ATM/ITM, 5% for far
 * OTM). Floor = milestone_price * (1 - trailGapPct/100) for longs. Before the first
 * milestone, uses the hard stopLossPct from entry.
 */
export function computeRatchetStop(
  entryPrice: number,
  peakPrice: number,
  direction: "up" | "down",
  trailGapPct: number,
  hardStopPct: number,
  milestoneStep: number = 10
): { stopPrice: number; milestoneLevel: number } {
  const profitPct =
    direction === "up"
      ? ((peakPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - peakPrice) / entryPrice) * 100;

  const milestoneLevel = Math.max(0, Math.floor(profitPct / milestoneStep) * milestoneStep);

  let stopPrice: number;
  if (milestoneLevel === 0) {
    stopPrice =
      direction === "up"
        ? entryPrice * (1 - hardStopPct / 100)
        : entryPrice * (1 + hardStopPct / 100);
  } else {
    const milestonePrice =
      direction === "up"
        ? entryPrice * (1 + milestoneLevel / 100)
        : entryPrice * (1 - milestoneLevel / 100);
    stopPrice =
      direction === "up"
        ? milestonePrice * (1 - trailGapPct / 100)
        : milestonePrice * (1 + trailGapPct / 100);
    stopPrice =
      direction === "up"
        ? Math.max(stopPrice, entryPrice)
        : Math.min(stopPrice, entryPrice);
  }

  return { stopPrice, milestoneLevel };
}

function getExitState(exec: typeof signalExecutionsTable.$inferSelect): ExitState {
  let s = exitStates.get(exec.id);
  if (!s) {
    let n: Record<string, unknown> = {};
    try {
      n = exec.notes ? (JSON.parse(exec.notes as string) as Record<string, unknown>) : {};
    } catch {
      // notes may be non-JSON for legacy rows
    }
    s = {
      peak: Number(exec.highestPriceReached ?? exec.entryPrice ?? 0),
      slOrderId: typeof n.slOrderId === "string" ? n.slOrderId : undefined,
      slTrigger: typeof n.slTrigger === "number" ? n.slTrigger : undefined,
      exitOrderId: typeof n.exitOrderId === "string" ? n.exitOrderId : undefined,
      exitAttempts: typeof n.exitAttempts === "number" ? n.exitAttempts : 0,
      exitReason: typeof n.exitReason === "string" ? n.exitReason : undefined,
      hydrated: true,
    };
    exitStates.set(exec.id, s);
  }
  return s;
}

/** Persist the mutable exit fields onto the execution row, write-behind. */
function persistExitState(exec: typeof signalExecutionsTable.$inferSelect, s: ExitState): void {
  let base: Record<string, unknown> = {};
  try {
    base = exec.notes ? (JSON.parse(exec.notes as string) as Record<string, unknown>) : {};
  } catch {
    // ignore
  }
  const merged = {
    ...base,
    slOrderId: s.slOrderId,
    slTrigger: s.slTrigger,
    exitOrderId: s.exitOrderId,
    exitAttempts: s.exitAttempts,
    exitReason: s.exitReason,
  };
  const execId = exec.id;
  const peakStr = String(s.peak);
  enqueueAudit("exec-monitor-update", async () => {
    await db
      .update(signalExecutionsTable)
      .set({ notes: JSON.stringify(merged), highestPriceReached: peakStr })
      .where(eq(signalExecutionsTable.id, execId));
  });
}

function finalizeClose(
  exec: typeof signalExecutionsTable.$inferSelect,
  exitReason: string,
  exitPrice: number | null
): void {
  const s = exitStates.get(exec.id);
  // Cancel any resting protective stop so it can't fire after the position is gone.
  if (s?.slOrderId) {
    void cancelOrder(exec.userId, s.slOrderId).catch(() => {});
  }
  exitStates.delete(exec.id);
  untrackHeldSymbol(exec.assetSymbol);
  markFlat(exec.userId, exec.assetId); // sync the entry state machine (+cooldown)

  let realisedPnl: number | null = null;
  if (exitPrice !== null) {
    const entryPrice = Number(exec.entryPrice ?? 0);
    realisedPnl =
      exec.direction === "up"
        ? (exitPrice - entryPrice) * exec.quantity
        : (entryPrice - exitPrice) * exec.quantity;
  }

  const execId = exec.id;
  enqueueAudit("exec-close", async () => {
    await db
      .update(signalExecutionsTable)
      .set({
        status: "closed",
        exitReason,
        exitPrice: exitPrice !== null ? String(exitPrice) : undefined,
        realisedPnl: realisedPnl !== null ? String(realisedPnl.toFixed(2)) : undefined,
        closedAt: new Date(),
      })
      .where(eq(signalExecutionsTable.id, execId));
  });

  logger.info({ userId: exec.userId, execId, symbol: exec.assetSymbol, exitReason, exitPrice, realisedPnl }, "position-monitor: execution closed");
}

/**
 * Monitor all open executions: track peak, maintain the trailing exchange-side SL-M
 * backstop, run time-stops, and record closes. Called tick-driven (throttled) and from a
 * slow safety heartbeat.
 */
export async function monitorOpenPositions(): Promise<void> {
  const openExecs = await db
    .select()
    .from(signalExecutionsTable)
    .where(eq(signalExecutionsTable.status, "open"));

  if (openExecs.length === 0) return;

  // Group by user to batch broker position fetches.
  const byUser = new Map<string, typeof openExecs>();
  for (const exec of openExecs) {
    if (!byUser.has(exec.userId)) byUser.set(exec.userId, []);
    byUser.get(exec.userId)!.push(exec);
  }

  for (const [userId, execs] of byUser) {
    let allPositions: Array<Record<string, unknown>>;
    try {
      const positions = await getPositions(userId);
      allPositions = [...positions.net, ...positions.day] as Array<Record<string, unknown>>;
    } catch (err) {
      logger.error({ userId, err }, "position-monitor: failed to fetch positions");
      continue;
    }

    for (const exec of execs) {
      try {
        const isOption =
          exec.assetSymbol.startsWith("NIFTY") &&
          (exec.assetSymbol.endsWith("CE") || exec.assetSymbol.endsWith("PE"));
        const exchange = isOption ? "NFO" : (ASSET_EXCHANGE_MAP[exec.assetId] ?? "NSE");

        // Subscribe the held instrument so its ticks feed getLtpBySymbol (R5).
        if (isOption) void trackHeldSymbol(exec.assetSymbol);

        const pos = allPositions.find(
          (p) => String(p.tradingsymbol ?? "") === exec.assetSymbol && String(p.exchange ?? "") === exchange
        );

        if (!pos) {
          // Squared off externally.
          finalizeClose(exec, "manual", null);
          continue;
        }

        const posQty = Number(pos.quantity ?? 0);
        if (posQty === 0) {
          // Position gone — our exit filled, the SL-M fired, or a manual square-off.
          const s = exitStates.get(exec.id);
          const exitReason = s?.exitReason ?? (s?.slOrderId ? "stop_loss" : "manual");
          const exitPrice = s?.slTrigger && exitReason === "stop_loss" ? s.slTrigger : null;
          finalizeClose(exec, exitReason, exitPrice);
          continue;
        }

        // ── Current price: prefer the WebSocket tick, fall back to getQuote ──────
        let currentPrice = getLtpBySymbol(exec.assetSymbol) ?? 0;
        if (currentPrice <= 0) {
          try {
            const quoteKey = `${exchange}:${exec.assetSymbol}`;
            let kite = await getKiteClientForUser(userId);
            if (!kite) kite = await getGlobalKiteClient();
            if (kite) {
              const quotePromise = kite.getQuote([quoteKey]) as Promise<Record<string, unknown>>;
              const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000));
              const quotes = await Promise.race([quotePromise, timeoutPromise]);
              if (quotes) currentPrice = Number((quotes[quoteKey] as Record<string, unknown> | undefined)?.last_price ?? 0);
            }
          } catch (err) {
            logger.warn({ userId, execId: exec.id, err: err instanceof Error ? err.message : err }, "position-monitor: quote fallback failed");
          }
        }
        if (currentPrice <= 0 || Number.isNaN(currentPrice)) currentPrice = Number(pos.last_price ?? 0);
        if (currentPrice <= 0 || Number.isNaN(currentPrice)) continue;

        const entryPrice = Number(exec.entryPrice ?? 0);
        if (entryPrice <= 0) continue;

        const direction = exec.direction as "up" | "down";
        const trailGapPct = Number(exec.trailGapPct ?? 15);
        const hardStopPct = Number(
          exec.stopLossPrice && exec.entryPrice
            ? (Math.abs(entryPrice - Number(exec.stopLossPrice)) / entryPrice) * 100
            : 2.0
        );

        // Far-OTM config from notes.
        let milestoneStep = 10;
        let timeStopMs: number | null = null;
        let minGainPct: number | null = null;
        let isFarOTM = false;
        try {
          if (exec.notes) {
            const cfg = JSON.parse(exec.notes as string) as Record<string, unknown>;
            milestoneStep = typeof cfg.milestoneStep === "number" ? cfg.milestoneStep : 10;
            timeStopMs = typeof cfg.timeStopMs === "number" ? cfg.timeStopMs : null;
            minGainPct = typeof cfg.minGainPct === "number" ? cfg.minGainPct : null;
            isFarOTM = cfg.isFarOTM === true;
          }
        } catch {
          // legacy non-JSON notes
        }

        const state = getExitState(exec);

        // Update peak (most favourable since entry).
        const newPeak = direction === "up" ? Math.max(state.peak, currentPrice) : Math.min(state.peak, currentPrice);
        const peakMoved = newPeak !== state.peak;
        state.peak = newPeak;

        const { stopPrice, milestoneLevel } = computeRatchetStop(
          entryPrice,
          state.peak,
          direction,
          trailGapPct,
          hardStopPct,
          milestoneStep
        );

        // ── Exchange-side SL-M backstop (R5 / P10) ──────────────────────────────
        // Long options only (SELL to exit). Place once on a confirmed fill; then trail
        // the trigger UP as the ratchet rises so the exchange holds the stop natively.
        let backstopChanged = false;
        if (direction === "up" && !state.exitOrderId) {
          const desiredTrigger = roundTick(stopPrice);
          if (!state.slOrderId) {
            try {
              const sl = await placeProtectiveStop(userId, {
                exchange,
                tradingsymbol: exec.assetSymbol,
                quantity: posQty,
                triggerPrice: desiredTrigger,
                product: (exec.product ?? "MIS") as "CNC" | "MIS" | "NRML",
                tag: `sl-${exec.id.slice(0, 14)}`,
              });
              state.slOrderId = sl.kiteOrderId;
              state.slTrigger = desiredTrigger;
              backstopChanged = true;
              logger.info({ userId, execId: exec.id, symbol: exec.assetSymbol, trigger: desiredTrigger, slOrderId: sl.kiteOrderId }, "position-monitor: exchange SL-M backstop placed");
            } catch (err) {
              logger.error({ userId, execId: exec.id, err: err instanceof Error ? err.message : err }, "position-monitor: SL-M placement failed — in-process stop will cover");
            }
          } else if (state.slTrigger !== undefined && desiredTrigger > state.slTrigger + 0.05) {
            // Ratchet rose — raise the resting stop (never lower it).
            try {
              await modifyOrder(userId, state.slOrderId, "regular", { triggerPrice: desiredTrigger });
              state.slTrigger = desiredTrigger;
              backstopChanged = true;
              logger.info({ userId, execId: exec.id, symbol: exec.assetSymbol, trigger: desiredTrigger }, "position-monitor: SL-M trigger trailed up");
            } catch (err) {
              logger.warn({ userId, execId: exec.id, err: err instanceof Error ? err.message : err }, "position-monitor: SL-M modify failed");
            }
          }
        }

        // ── Time-stop for far OTM (theta) — always in-process ───────────────────
        let timeStopHit = false;
        if (timeStopMs !== null && minGainPct !== null) {
          const elapsedMs = Date.now() - new Date(exec.executedAt).getTime();
          const profitPct = direction === "up"
            ? ((state.peak - entryPrice) / entryPrice) * 100
            : ((entryPrice - state.peak) / entryPrice) * 100;
          if (elapsedMs >= timeStopMs && profitPct < minGainPct) timeStopHit = true;
        }

        // Price breach only drives an in-process exit when the exchange backstop is
        // absent (placement failed) — otherwise the SL-M fires natively (no double sell).
        const priceBreached = direction === "up" ? currentPrice <= stopPrice : currentPrice >= stopPrice;
        const needInProcessExit = timeStopHit || (!state.slOrderId && priceBreached);

        if (needInProcessExit && !state.exitOrderId) {
          await placeInProcessExit(userId, exec, exchange, currentPrice, direction, state, timeStopHit ? "time_stop" : "trailing_stop");
        } else if (needInProcessExit && state.exitOrderId) {
          // Previous in-process exit unfilled — retry more aggressively.
          try {
            await cancelOrder(userId, state.exitOrderId);
          } catch (err) {
            logger.warn({ userId, orderId: state.exitOrderId, err }, "position-monitor: cancel unfilled exit failed, replacing anyway");
          }
          await placeInProcessExit(userId, exec, exchange, currentPrice, direction, state, state.exitReason ?? "trailing_stop");
        } else if (peakMoved || backstopChanged) {
          persistExitState(exec, state);
        }

        logger.info({
          userId,
          symbol: exec.assetSymbol,
          ltp: currentPrice,
          entry: entryPrice,
          peak: state.peak,
          stop: stopPrice.toFixed(2),
          milestone: milestoneLevel,
          slTrigger: state.slTrigger,
          isFarOTM,
          timeStopHit,
        }, "position-monitor: position checked");
      } catch (innerErr) {
        logger.error({ userId, execId: exec.id, err: innerErr }, "position-monitor: failed to process execution");
      }
    }
  }
}

/** Place a progressively-aggressive in-process LIMIT exit (time-stop / SL-fallback). */
async function placeInProcessExit(
  userId: string,
  exec: typeof signalExecutionsTable.$inferSelect,
  exchange: string,
  currentPrice: number,
  direction: "up" | "down",
  state: ExitState,
  exitReason: string
): Promise<void> {
  // Cancel the resting exchange stop first so both can't sell (no double exit).
  if (state.slOrderId) {
    try {
      await cancelOrder(userId, state.slOrderId);
    } catch (err) {
      logger.warn({ userId, orderId: state.slOrderId, err }, "position-monitor: cancel SL before in-process exit failed");
    }
    state.slOrderId = undefined;
    state.slTrigger = undefined;
  }

  const discountPct = state.exitAttempts === 0 ? 0.01 : state.exitAttempts === 1 ? 0.03 : 0.05;
  const exitLimitPrice = roundTick(currentPrice * (direction === "up" ? 1 - discountPct : 1 + discountPct));

  const exitOrderResult = await placeOrder(userId, {
    exchange,
    tradingsymbol: exec.assetSymbol,
    transactionType: direction === "up" ? "SELL" : "BUY",
    quantity: exec.quantity,
    orderType: "LIMIT",
    price: exitLimitPrice,
    product: (exec.product ?? "MIS") as "CNC" | "MIS" | "NRML",
    tag: `exit-${exec.id.slice(0, 14)}`,
  });

  state.exitOrderId = exitOrderResult.kiteOrderId;
  state.exitAttempts += 1;
  state.exitReason = exitReason;
  markPendingExit(exec.userId, exec.assetId);
  persistExitState(exec, state);

  logger.info(
    { userId, execId: exec.id, exitOrderId: exitOrderResult.kiteOrderId, exitLimitPrice, attempt: state.exitAttempts, exitReason },
    "position-monitor: in-process exit order placed"
  );
}

async function runMonitorGuarded(): Promise<void> {
  if (running) return; // never overlap monitor passes
  running = true;
  try {
    await monitorOpenPositions();
  } catch (err) {
    logger.error({ err }, "position-monitor: monitor pass failed");
  } finally {
    running = false;
  }
}

/** Start tick-driven position monitoring (R5) + a slow safety heartbeat. */
export function startPositionMonitor(): void {
  if (started) return;
  started = true;
  logger.info("position-monitor: starting (tick-driven + exchange SL-M backstop)");

  marketTicker.on("tick", () => {
    const now = Date.now();
    if (now - lastEvalAt < EVAL_THROTTLE_MS) return;
    lastEvalAt = now;
    void runMonitorGuarded();
  });

  // Heartbeat so held positions are still managed if the tick feed stalls.
  setInterval(() => {
    void runMonitorGuarded();
  }, SAFETY_INTERVAL_MS);
}

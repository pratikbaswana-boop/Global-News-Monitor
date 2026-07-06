import { db, signalExecutionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../../lib/logger.js";
import { placeOrder, placeProtectiveStop, cancelOrder, modifyOrder, slLimitPriceForTrigger } from "./orders.js";
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
// Evaluation is driven by the KiteTicker feed. The ratchet check is a float comparison,
// so we run it on every tick of held instruments — no throttle. The `running` guard
// prevents overlapping passes (getPositions is a broker call). The exchange-side SL
// (stop-loss limit) backstop fires the actual stop natively (zero latency).
const SAFETY_INTERVAL_MS = 30_000; // heartbeat in case ticks stop flowing

let started = false;
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
  slLimit?: number;
  exitOrderId?: string;
  exitAttempts: number;
  exitReason?: string;
  lastMilestoneLevel: number;
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
      slLimit: typeof n.slLimit === "number" ? n.slLimit : undefined,
      exitOrderId: typeof n.exitOrderId === "string" ? n.exitOrderId : undefined,
      exitAttempts: typeof n.exitAttempts === "number" ? n.exitAttempts : 0,
      exitReason: typeof n.exitReason === "string" ? n.exitReason : undefined,
      lastMilestoneLevel: typeof n.lastMilestoneLevel === "number" ? n.lastMilestoneLevel : 0,
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
    slLimit: s.slLimit,
    exitOrderId: s.exitOrderId,
    exitAttempts: s.exitAttempts,
    exitReason: s.exitReason,
    lastMilestoneLevel: s.lastMilestoneLevel,
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
 * Monitor all open executions: track peak, maintain the trailing exchange-side SL
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
          // Position gone — our exit filled, the SL fired, or a manual square-off.
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

        // ── Exchange-side SL (stop-loss limit) backstop (R5 / P10) ──────────────
        // Long options only (SELL to exit). Place once on a confirmed fill; then trail
        // the trigger UP as the ratchet rises so the exchange holds the stop natively.
        // SL (not SL-M) because NSE/Kite reject SL-M on index options — the limit rests
        // SL_LIMIT_OFFSET_PCT below the trigger so it fills the moment it fires.
        let backstopChanged = false;
        if (direction === "up" && !state.exitOrderId) {
          const desiredTrigger = roundTick(stopPrice);
          const desiredLimit = slLimitPriceForTrigger(desiredTrigger);
          if (!state.slOrderId) {
            try {
              const sl = await placeProtectiveStop(userId, {
                exchange,
                tradingsymbol: exec.assetSymbol,
                quantity: posQty,
                triggerPrice: desiredTrigger,
                limitPrice: desiredLimit,
                product: (exec.product ?? "MIS") as "CNC" | "MIS" | "NRML",
                tag: `sl-${exec.id.slice(0, 14)}`,
              });
              state.slOrderId = sl.kiteOrderId;
              state.slTrigger = desiredTrigger;
              state.slLimit = sl.limitPrice;
              backstopChanged = true;
              logger.info({ userId, execId: exec.id, symbol: exec.assetSymbol, trigger: desiredTrigger, limit: sl.limitPrice, slOrderId: sl.kiteOrderId }, "position-monitor: exchange SL backstop placed");
            } catch (err) {
              logger.error({ userId, execId: exec.id, err: err instanceof Error ? err.message : err }, "position-monitor: SL placement failed — in-process stop will cover");
            }
          } else if (milestoneLevel > state.lastMilestoneLevel) {
            // Milestone stepped up — raise the resting stop (never lower it). Modify BOTH
            // the trigger and the limit together so the limit keeps tracking the trigger.
            // Only modify when the milestone actually increases, not on every tick, to
            // avoid spamming Kite modify-order calls against the rate limit.
            try {
              await modifyOrder(userId, state.slOrderId, "regular", { triggerPrice: desiredTrigger, price: desiredLimit });
              state.slTrigger = desiredTrigger;
              state.slLimit = desiredLimit;
              state.lastMilestoneLevel = milestoneLevel;
              backstopChanged = true;
              logger.info({ userId, execId: exec.id, symbol: exec.assetSymbol, trigger: desiredTrigger, limit: desiredLimit, milestone: milestoneLevel }, "position-monitor: SL trigger trailed up (milestone stepped)");
            } catch (err) {
              logger.warn({ userId, execId: exec.id, err: err instanceof Error ? err.message : err }, "position-monitor: SL modify failed");
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
        // absent (placement failed) — otherwise the resting SL fires natively (no double
        // sell). A time-stop always exits in-process, converting the resting SL rather
        // than cancelling it (see escalateExit).
        const priceBreached = direction === "up" ? currentPrice <= stopPrice : currentPrice >= stopPrice;
        const needInProcessExit = timeStopHit || (!state.slOrderId && priceBreached);

        if (needInProcessExit) {
          // escalateExit handles first-exit, retry, and SL-conversion in one path — it
          // never cancels the protective stop before an exit is working, so the position
          // is never unprotected between a cancel and a fill.
          const reason = timeStopHit ? "time_stop" : (state.exitReason ?? "trailing_stop");
          await escalateExit(userId, exec, exchange, currentPrice, direction, state, reason);
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

/**
 * Drive a progressively-aggressive exit WITHOUT ever leaving the position unprotected.
 *
 * The old flow cancelled the resting protective SL first and then placed a LIMIT exit —
 * a window where, if the exit didn't fill, the long option was naked. This one never
 * cancels-then-places. It reuses whatever order is already working:
 *
 *   (a) an in-process exit already rests  → modify its price lower (more marketable),
 *   (b) a protective SL still rests        → convert THAT order into the exit in place
 *                                            (trigger just below LTP + tight limit); the
 *                                            single exchange order becomes the exit, so
 *                                            there is no cancel gap and no double-sell,
 *   (c) neither exists (SL placement had failed) → place a fresh LIMIT exit.
 *
 * On a modify failure we return and let the next tick re-evaluate against fresh position
 * data (posQty), rather than racing a second order in — avoiding an oversell if the
 * order we tried to modify had actually just filled.
 */
async function escalateExit(
  userId: string,
  exec: typeof signalExecutionsTable.$inferSelect,
  exchange: string,
  currentPrice: number,
  direction: "up" | "down",
  state: ExitState,
  exitReason: string
): Promise<void> {
  const discountPct = state.exitAttempts === 0 ? 0.01 : state.exitAttempts === 1 ? 0.03 : 0.05;
  const exitLimitPrice = roundTick(currentPrice * (direction === "up" ? 1 - discountPct : 1 + discountPct));

  // (a) An exit order is already working — re-price it in place, no cancel/replace gap.
  if (state.exitOrderId) {
    try {
      await modifyOrder(userId, state.exitOrderId, "regular", { price: exitLimitPrice });
      state.exitAttempts += 1;
      state.exitReason = exitReason;
      persistExitState(exec, state);
      logger.info({ userId, execId: exec.id, exitOrderId: state.exitOrderId, exitLimitPrice, attempt: state.exitAttempts, exitReason }, "position-monitor: in-process exit re-priced (aggressive)");
    } catch (err) {
      // Modify failed — the order likely just filled or was rejected. Drop the ref and
      // let the next tick re-evaluate against fresh position quantity (avoids oversell).
      logger.warn({ userId, execId: exec.id, orderId: state.exitOrderId, err: err instanceof Error ? err.message : err }, "position-monitor: exit re-price failed, will re-evaluate next tick");
      state.exitOrderId = undefined;
    }
    return;
  }

  // (b) A protective SL still rests — convert it into the exit rather than cancelling it.
  // Modify its trigger to just below LTP so it fires immediately, and tighten the limit
  // so it fills. The same order id now carries the exit; the position is protected the
  // whole time.
  if (state.slOrderId) {
    const aggressiveTrigger = roundTick(currentPrice * (direction === "up" ? 0.999 : 1.001));
    try {
      await modifyOrder(userId, state.slOrderId, "regular", { triggerPrice: aggressiveTrigger, price: exitLimitPrice });
      state.exitOrderId = state.slOrderId; // the SL order IS the exit now
      state.slOrderId = undefined;
      state.slTrigger = undefined;
      state.slLimit = undefined;
      state.exitAttempts += 1;
      state.exitReason = exitReason;
      markPendingExit(exec.userId, exec.assetId);
      persistExitState(exec, state);
      logger.info({ userId, execId: exec.id, exitOrderId: state.exitOrderId, aggressiveTrigger, exitLimitPrice, exitReason }, "position-monitor: converted resting SL into aggressive exit");
    } catch (err) {
      // Convert failed — the SL is likely still resting (and still protecting us) or has
      // already fired. Either way, don't stack a second sell order this tick.
      logger.warn({ userId, execId: exec.id, orderId: state.slOrderId, err: err instanceof Error ? err.message : err }, "position-monitor: SL→exit convert failed, SL still guards; re-evaluate next tick");
    }
    return;
  }

  // (c) Nothing resting to reuse (SL placement had failed) — place a fresh LIMIT exit.
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
    "position-monitor: fresh in-process exit order placed"
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
  logger.info("position-monitor: starting (tick-driven + exchange SL backstop)");

  marketTicker.on("tick", () => {
    void runMonitorGuarded();
  });

  // Heartbeat so held positions are still managed if the tick feed stalls.
  setInterval(() => {
    void runMonitorGuarded();
  }, SAFETY_INTERVAL_MS);
}

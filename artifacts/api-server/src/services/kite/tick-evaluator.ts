// Tick-driven edge evaluator (R3).
//
// Subscribes to the KiteTicker feed and, on each (throttled) tick, computes the current
// option side for NIFTY from in-memory state only (hot context + live chain metrics +
// the intraday microstructure gate). It fires an entry ONLY when the side TRANSITIONS
// (edge-triggered) — so a steady "up" direction no longer re-enters after every exit,
// which is what produced 20 trades from a single signal.
//
// Slow spot equities (no option chain / no ticks of their own) are evaluated on the same
// NIFTY-tick cadence via their hot-context AI direction; they too fire only on a change.

import { logger } from "../../lib/logger.js";
import { marketTicker } from "./market-ticker.js";
import { getHotContext } from "../market/hot-context.js";
import {
  computeLiveOptionSide,
  dispatchEntryForSide,
  dispatchSpotForDirection,
  reconcilePositionStates,
} from "./signal-executor.js";

const OPTION_ASSET_ID = "nifty50";
// Spot equities the old level-scan also auto-traded (index/sensex excluded).
const SPOT_ASSET_IDS = ["reliance", "tcs", "hdfc-bank"];

const EVAL_THROTTLE_MS = 1_000; // evaluate at most once per second
const RECONCILE_INTERVAL_MS = 10_000; // sync the state machine with the DB every 10s

let started = false;
let lastEvalAt = 0;
let lastReconcileAt = 0;
let lastOptionSide: "BUY_CALL" | "BUY_PUT" | "NO_TRADE" = "NO_TRADE";
const lastSpotDirection = new Map<string, "up" | "down" | "neutral">();

/** IST trading-hours guard: 09:15–15:30, weekdays (mirrors the old scheduler). */
function isTradingOpen(): boolean {
  const now = new Date();
  const istMin = (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % (24 * 60);
  const istDay = new Date(now.getTime() + 330 * 60 * 1000).getUTCDay();
  if (istDay === 0 || istDay === 6) return false;
  return istMin >= 555 && istMin < 930;
}

async function evaluate(): Promise<void> {
  if (!isTradingOpen()) return;

  const now = Date.now();

  // Periodically reconcile the state machine with open executions (position closes,
  // restarts). Off the per-tick hot-path frequency.
  if (now - lastReconcileAt >= RECONCILE_INTERVAL_MS) {
    lastReconcileAt = now;
    try {
      await reconcilePositionStates();
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, "tick-evaluator: reconcile failed");
    }
  }

  // ── NIFTY option side (edge-triggered) ──────────────────────────────────────
  const optionSide = computeLiveOptionSide(OPTION_ASSET_ID).signal;
  if (optionSide !== lastOptionSide) {
    logger.info({ assetId: OPTION_ASSET_ID, from: lastOptionSide, to: optionSide }, "tick-evaluator: option side transition");
    lastOptionSide = optionSide;
    if (optionSide === "BUY_CALL" || optionSide === "BUY_PUT") {
      try {
        await dispatchEntryForSide(OPTION_ASSET_ID, optionSide);
      } catch (err) {
        logger.error({ err }, "tick-evaluator: option dispatch failed");
      }
    }
  }

  // ── Spot equities (edge on AI-direction change) ─────────────────────────────
  for (const assetId of SPOT_ASSET_IDS) {
    const dir = (getHotContext(assetId)?.direction ?? "neutral");
    const mapped = dir === "uncertain" ? "neutral" : dir;
    const prev = lastSpotDirection.get(assetId) ?? "neutral";
    if (mapped === prev) continue;
    lastSpotDirection.set(assetId, mapped);
    if (mapped === "up" || mapped === "down") {
      try {
        await dispatchSpotForDirection(assetId, mapped);
      } catch (err) {
        logger.error({ assetId, err }, "tick-evaluator: spot dispatch failed");
      }
    }
  }
}

export function startTickEvaluator(): void {
  if (started) return;
  started = true;
  logger.info("tick-evaluator: starting (edge-triggered execution)");

  marketTicker.on("tick", () => {
    const now = Date.now();
    if (now - lastEvalAt < EVAL_THROTTLE_MS) return;
    lastEvalAt = now;
    void evaluate();
  });
}

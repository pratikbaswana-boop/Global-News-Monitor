// Fill-confirmed entry tracker (R6).
//
// An entry order being ACCEPTED by Kite is not the same as it being FILLED. The old flow
// persisted the execution as `open` the instant placeOrder() returned and let the position
// monitor start managing it — so an unfilled or partially-filled LIMIT entry left us
// trailing a phantom, and the exchange SL backstop, if it fired, opened a naked short
// option. This module closes that gap: an entry is persisted as `pending_entry` and is only
// promoted to `open` (and handed to the position monitor + entry state machine) once we
// confirm an actual fill.
//
//   PENDING_ENTRY ──(order COMPLETE / partial fill)──▶ OPEN
//        │
//        └──(REJECTED / CANCELLED / no fill within timeout)──▶ FLAT (order cancelled)
//
// Fills are confirmed two ways, whichever is first:
//   1. Kite order postback — delivered on the KiteTicker WebSocket we already hold
//      (market-ticker re-emits it as `order_update` on the shared bus). Sub-second.
//   2. A short poll of getOrderHistory() as a backstop — covers accounts whose postbacks
//      don't route to the global ticker connection, and a hard timeout that cancels an
//      entry that never fills.
//
// On restart the in-memory map is lost; reconcilePendingEntries() re-adopts any orphaned
// `pending_entry` rows from the DB and resolves them the same way.

import { db, signalExecutionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../../lib/logger.js";
import { marketTicker } from "./market-ticker.js";
import { cancelOrder, getOrderHistory } from "./orders.js";
import { enqueueAudit } from "../../lib/audit-queue.js";
import { markOpen, markFlat } from "./position-state.js";

export interface PendingEntry {
  kiteOrderId: string;
  userId: string;
  assetId: string;
  execId: string;
  symbol: string;
  side: "CALL" | "PUT" | null;
  intendedQty: number;
  placedAt: number;
  lastPollAt: number;
  resolving: boolean;
}

// How long to wait for an entry to fill before cancelling it and returning to FLAT.
const ENTRY_FILL_TIMEOUT_MS = Number(process.env["ENTRY_FILL_TIMEOUT_MS"] ?? 20_000);
// Don't poll immediately — give the postback a chance first (it's usually sub-second).
const POLL_AFTER_MS = 3_000;
const POLL_INTERVAL_MS = 3_000;
const SWEEP_INTERVAL_MS = 2_000;

const COMPLETE = "COMPLETE";
const TERMINAL_FAIL = new Set(["REJECTED", "CANCELLED"]);

const pending = new Map<string, PendingEntry>();
let started = false;

/** Infer the state-machine side from an option symbol (spot equities have no side). */
function sideFromSymbol(symbol: string): "CALL" | "PUT" | null {
  if (symbol.endsWith("CE")) return "CALL";
  if (symbol.endsWith("PE")) return "PUT";
  return null;
}

/**
 * Register an accepted entry order so its fill can be confirmed. The caller must have
 * already persisted the execution row with status `pending_entry`.
 */
export function trackEntryOrder(entry: {
  kiteOrderId: string;
  userId: string;
  assetId: string;
  execId: string;
  symbol: string;
  side: "CALL" | "PUT" | null;
  intendedQty: number;
}): void {
  pending.set(entry.kiteOrderId, {
    ...entry,
    placedAt: Date.now(),
    lastPollAt: 0,
    resolving: false,
  });
  logger.info({ userId: entry.userId, assetId: entry.assetId, execId: entry.execId, orderId: entry.kiteOrderId }, "entry-tracker: tracking entry order for fill confirmation");
}

/** Promote a confirmed (possibly partial) fill to an OPEN, monitor-managed position. */
function resolveFill(entry: PendingEntry, avgPrice: number, filledQty: number): void {
  if (entry.resolving) return;
  entry.resolving = true;
  pending.delete(entry.kiteOrderId);

  const qty = filledQty > 0 ? filledQty : entry.intendedQty;
  const execId = entry.execId;
  enqueueAudit("entry-fill-open", async () => {
    const set: Record<string, unknown> = { status: "open", quantity: qty };
    if (avgPrice > 0) {
      set.entryPrice = String(avgPrice);
      set.highestPriceReached = String(avgPrice);
    }
    await db.update(signalExecutionsTable).set(set).where(eq(signalExecutionsTable.id, execId));
  });

  // Only now does the position monitor (status = "open") and the entry state machine
  // treat this as a live position.
  markOpen(entry.userId, entry.assetId, entry.side);
  logger.info({ userId: entry.userId, assetId: entry.assetId, execId, orderId: entry.kiteOrderId, avgPrice, filledQty: qty }, "entry-tracker: entry FILLED → OPEN");
}

/** An entry that never became a position — cancel the order (best effort) and go FLAT. */
function resolveFail(entry: PendingEntry, reason: string): void {
  if (entry.resolving) return;
  entry.resolving = true;
  pending.delete(entry.kiteOrderId);

  const execId = entry.execId;
  enqueueAudit("entry-fail-cancel", async () => {
    await db
      .update(signalExecutionsTable)
      .set({ status: "cancelled", exitReason: reason, closedAt: new Date() })
      .where(eq(signalExecutionsTable.id, execId));
  });

  // Return to FLAT with no cooldown so a later edge can retry.
  markFlat(entry.userId, entry.assetId, 0);
  logger.info({ userId: entry.userId, assetId: entry.assetId, execId, orderId: entry.kiteOrderId, reason }, "entry-tracker: entry did not fill → FLAT");
}

function parseLatest(history: unknown[]): { status: string; avgPrice: number; filledQty: number } {
  if (!history.length) return { status: "UNKNOWN", avgPrice: 0, filledQty: 0 };
  const l = history[history.length - 1] as Record<string, unknown>;
  return {
    status: String(l["status"] ?? "UNKNOWN").toUpperCase(),
    avgPrice: Number(l["average_price"] ?? 0),
    filledQty: Number(l["filled_quantity"] ?? 0),
  };
}

/** Fast path: a Kite order postback (re-emitted from the ticker) for a tracked entry. */
function handleOrderUpdate(order: unknown): void {
  const o = order as Record<string, unknown>;
  const orderId = String(o["order_id"] ?? "");
  if (!orderId) return;
  const entry = pending.get(orderId);
  if (!entry || entry.resolving) return;

  const status = String(o["status"] ?? "").toUpperCase();
  const filledQty = Number(o["filled_quantity"] ?? 0);
  const avgPrice = Number(o["average_price"] ?? 0);

  if (status === COMPLETE) {
    resolveFill(entry, avgPrice, filledQty);
  } else if (TERMINAL_FAIL.has(status)) {
    // A cancel/reject that still filled part of the order IS a real (partial) position.
    if (filledQty > 0) resolveFill(entry, avgPrice, filledQty);
    else resolveFail(entry, status.toLowerCase());
  }
  // OPEN / TRIGGER PENDING / etc. — not terminal, keep waiting.
}

/**
 * Backstop path: poll the order's history. When `forceCancel` (timed out), cancel a
 * still-resting order and go FLAT — but only ever resolveFail when we've positively
 * confirmed the order is not (partially) filled, so a filled entry is never mislabelled
 * cancelled (which would leave a real position unmanaged / naked).
 */
async function pollEntry(entry: PendingEntry, forceCancel: boolean): Promise<void> {
  if (entry.resolving) return;
  try {
    const latest = parseLatest(await getOrderHistory(entry.userId, entry.kiteOrderId));

    if (latest.status === COMPLETE || (latest.filledQty > 0 && latest.filledQty >= entry.intendedQty)) {
      resolveFill(entry, latest.avgPrice, latest.filledQty);
      return;
    }
    if (TERMINAL_FAIL.has(latest.status)) {
      if (latest.filledQty > 0) resolveFill(entry, latest.avgPrice, latest.filledQty);
      else resolveFail(entry, latest.status.toLowerCase());
      return;
    }

    if (!forceCancel) return; // still working, not timed out — keep waiting

    // Timed out and still resting/pending → cancel, then re-read to catch a fill that
    // landed during cancellation before deciding.
    let cancelled = false;
    try {
      await cancelOrder(entry.userId, entry.kiteOrderId);
      cancelled = true;
    } catch (err) {
      // Cancel can fail because the order already reached a terminal state (e.g. filled).
      logger.warn({ userId: entry.userId, orderId: entry.kiteOrderId, err: err instanceof Error ? err.message : err }, "entry-tracker: cancel on timeout failed, re-checking status");
    }

    try {
      const after = parseLatest(await getOrderHistory(entry.userId, entry.kiteOrderId));
      if (after.filledQty > 0) {
        resolveFill(entry, after.avgPrice, after.filledQty);
      } else if (TERMINAL_FAIL.has(after.status) || cancelled) {
        resolveFail(entry, "entry_timeout");
      }
      // else: indeterminate — leave for the next sweep rather than guess.
    } catch {
      // Couldn't re-read. Only fail if we know we cancelled a resting (unfilled) order.
      if (cancelled) resolveFail(entry, "entry_timeout");
    }
  } catch (err) {
    logger.warn({ userId: entry.userId, orderId: entry.kiteOrderId, err: err instanceof Error ? err.message : err }, "entry-tracker: poll failed");
  }
}

function sweep(): void {
  const now = Date.now();
  for (const entry of [...pending.values()]) {
    if (entry.resolving) continue;
    const age = now - entry.placedAt;
    if (age >= ENTRY_FILL_TIMEOUT_MS) {
      void pollEntry(entry, true);
    } else if (age >= POLL_AFTER_MS && now - entry.lastPollAt >= POLL_INTERVAL_MS) {
      entry.lastPollAt = now;
      void pollEntry(entry, false);
    }
  }
}

/**
 * Re-adopt orphaned `pending_entry` rows after a restart (the in-memory map is volatile).
 * Only touches rows older than the fill timeout so the live tracker owns fresh ones.
 * Called from the tick evaluator's periodic reconcile.
 */
export async function reconcilePendingEntries(): Promise<void> {
  const rows = await db
    .select()
    .from(signalExecutionsTable)
    .where(eq(signalExecutionsTable.status, "pending_entry"));

  const now = Date.now();
  for (const row of rows) {
    if (pending.has(row.brokerOrderId)) continue; // already tracked live
    const age = now - new Date(row.executedAt).getTime();
    if (age < ENTRY_FILL_TIMEOUT_MS) continue; // let the live tracker handle recent ones

    const entry: PendingEntry = {
      kiteOrderId: row.brokerOrderId,
      userId: row.userId,
      assetId: row.assetId,
      execId: row.id,
      symbol: row.assetSymbol,
      side: sideFromSymbol(row.assetSymbol),
      intendedQty: row.quantity,
      placedAt: new Date(row.executedAt).getTime(),
      lastPollAt: 0,
      resolving: false,
    };
    pending.set(entry.kiteOrderId, entry);
    logger.info({ userId: entry.userId, execId: entry.execId, orderId: entry.kiteOrderId }, "entry-tracker: re-adopted orphaned pending entry after restart");
    void pollEntry(entry, true);
  }
}

/** Wire the postback bus + timeout sweeper. Idempotent. */
export function startEntryTracker(): void {
  if (started) return;
  started = true;
  marketTicker.on("order_update", (order: unknown) => {
    try {
      handleOrderUpdate(order);
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : err }, "entry-tracker: order_update handler failed");
    }
  });
  setInterval(sweep, SWEEP_INTERVAL_MS);
  logger.info({ timeoutMs: ENTRY_FILL_TIMEOUT_MS }, "entry-tracker: started (postback + timeout fill confirmation)");
}

/** Test / diagnostics: current tracked entry count. */
export function getPendingEntryCount(): number {
  return pending.size;
}

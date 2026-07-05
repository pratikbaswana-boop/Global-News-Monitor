// Per-user, per-asset position state machine (R3).
//
// Replaces the old "does a signal_executions row already exist for this snapshot+user"
// DB dedup with an explicit in-memory state machine. This is what makes execution
// edge-triggered: the tick evaluator fires an entry only on a signal-side transition
// AND only when the user's state for that asset is FLAT and past its cooldown — which
// kills the re-entry churn that produced 20 trades from a single direction.
//
//   FLAT ──(edge, canEnter)──▶ PENDING_ENTRY ──(order placed)──▶ OPEN
//     ▲                              │                            │
//     └────(order declined)─────────┘                            │
//     └────(position closed / reconcile, + cooldown)◀── PENDING_EXIT ◀─(exit placed, B5)
//
// State is reconciled against open signal_executions (see reconcilePositionStates in
// signal-executor.ts) so it survives restarts and reflects position-monitor closes.

export type PositionState = "FLAT" | "PENDING_ENTRY" | "OPEN" | "PENDING_EXIT";

export interface PosState {
  userId: string;
  assetId: string;
  state: PositionState;
  side: "CALL" | "PUT" | null;
  cooldownUntil: number; // epoch ms — no new entry before this
  updatedAt: number;
}

// Cooldown after a position goes flat before the same user+asset may re-enter.
export const ENTRY_COOLDOWN_MS = 3 * 60 * 1000; // 3 minutes

const states = new Map<string, PosState>();

function key(userId: string, assetId: string): string {
  return `${userId}::${assetId}`;
}

export function getPositionState(userId: string, assetId: string): PosState {
  return (
    states.get(key(userId, assetId)) ?? {
      userId,
      assetId,
      state: "FLAT",
      side: null,
      cooldownUntil: 0,
      updatedAt: 0,
    }
  );
}

function set(userId: string, assetId: string, patch: Partial<PosState>): void {
  const cur = getPositionState(userId, assetId);
  states.set(key(userId, assetId), { ...cur, ...patch, userId, assetId, updatedAt: Date.now() });
}

/** True only when the user may open a fresh position for this asset. */
export function canEnter(userId: string, assetId: string, now: number = Date.now()): boolean {
  const s = getPositionState(userId, assetId);
  return s.state === "FLAT" && now >= s.cooldownUntil;
}

export function markPendingEntry(userId: string, assetId: string, side: "CALL" | "PUT" | null): void {
  set(userId, assetId, { state: "PENDING_ENTRY", side });
}

export function markOpen(userId: string, assetId: string, side: "CALL" | "PUT" | null): void {
  set(userId, assetId, { state: "OPEN", side });
}

export function markPendingExit(userId: string, assetId: string): void {
  set(userId, assetId, { state: "PENDING_EXIT" });
}

/** Go flat and start the re-entry cooldown (0 ms = allow retry on the next edge). */
export function markFlat(userId: string, assetId: string, cooldownMs: number = ENTRY_COOLDOWN_MS): void {
  set(userId, assetId, { state: "FLAT", side: null, cooldownUntil: Date.now() + cooldownMs });
}

export function getAllPositionStates(): PosState[] {
  return [...states.values()];
}

/** Clear all state (call at session reset). */
export function resetPositionStates(): void {
  states.clear();
}

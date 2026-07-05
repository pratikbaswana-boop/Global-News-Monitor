// Unit tests for the per-user position state machine (R3). Pure in-memory state.
// The key property under test is the ANTI-CHURN invariant: once a user is OPEN (or in
// cooldown) for an asset, canEnter() is false — so a steady signal cannot re-enter.

import { describe, it, expect, beforeEach } from "vitest";
import {
  canEnter,
  markPendingEntry,
  markOpen,
  markPendingExit,
  markFlat,
  getPositionState,
  getAllPositionStates,
  resetPositionStates,
  ENTRY_COOLDOWN_MS,
} from "../position-state.js";

const U = "user-1";
const A = "nifty50";

describe("position-state", () => {
  beforeEach(() => resetPositionStates());

  it("starts FLAT and enterable", () => {
    expect(getPositionState(U, A).state).toBe("FLAT");
    expect(canEnter(U, A)).toBe(true);
  });

  it("blocks entry while PENDING_ENTRY and OPEN (anti-churn)", () => {
    markPendingEntry(U, A, "CALL");
    expect(getPositionState(U, A).state).toBe("PENDING_ENTRY");
    expect(canEnter(U, A)).toBe(false);

    markOpen(U, A, "CALL");
    expect(getPositionState(U, A).state).toBe("OPEN");
    // A steady signal must NOT be able to re-enter while a position is open.
    expect(canEnter(U, A)).toBe(false);
  });

  it("applies a cooldown after going flat", () => {
    markOpen(U, A, "CALL");
    const t0 = Date.now();
    markFlat(U, A); // default cooldown
    expect(canEnter(U, A, t0)).toBe(false);
    expect(canEnter(U, A, t0 + ENTRY_COOLDOWN_MS + 1)).toBe(true);
  });

  it("markFlat(…, 0) allows immediate re-entry (retry on next edge)", () => {
    markPendingEntry(U, A, "CALL");
    markFlat(U, A, 0);
    expect(getPositionState(U, A).state).toBe("FLAT");
    expect(canEnter(U, A)).toBe(true);
  });

  it("full lifecycle FLAT→PENDING_ENTRY→OPEN→PENDING_EXIT→FLAT", () => {
    expect(getPositionState(U, A).state).toBe("FLAT");
    markPendingEntry(U, A, "PUT");
    expect(getPositionState(U, A).state).toBe("PENDING_ENTRY");
    markOpen(U, A, "PUT");
    expect(getPositionState(U, A).state).toBe("OPEN");
    markPendingExit(U, A);
    expect(getPositionState(U, A).state).toBe("PENDING_EXIT");
    expect(canEnter(U, A)).toBe(false);
    markFlat(U, A, 0);
    expect(getPositionState(U, A).state).toBe("FLAT");
  });

  it("tracks independent state per user and per asset", () => {
    markOpen("user-1", A, "CALL");
    expect(canEnter("user-2", A)).toBe(true); // different user still flat
    expect(canEnter("user-1", "reliance")).toBe(true); // different asset still flat
    expect(getAllPositionStates().length).toBe(1);
  });

  it("resetPositionStates clears everything", () => {
    markOpen(U, A, "CALL");
    resetPositionStates();
    expect(getAllPositionStates().length).toBe(0);
    expect(canEnter(U, A)).toBe(true);
  });
});

// Unit tests for the time-based direction EMA (#4). The key property is that the EMA now
// advances by ELAPSED TIME keyed on the latest observation, so:
//   (a) redundant compute calls with no new observation don't move D (idempotent), and
//   (b) a new observation does move D.
// Together these are what make the smoothing invariant to the feed rate.

import { describe, it, expect, beforeEach } from "vitest";
import { resetSignalState, recordObservation, computeIntradaySignal } from "../tier3-signal.js";

/** Feed a warmed buffer spanning > 150s (READY_FRACTION × WINDOW_MS) with a gentle uptrend. */
function warmBuffer(): void {
  let callOI = 1_000_000;
  let putOI = 1_200_000;
  for (let i = 0; i <= 40; i++) {
    callOI += 500;
    putOI -= 300;
    recordObservation({
      t: i * 5000, // 5s steps → 200s span
      price: 24000 + i * 2,
      callOI,
      putOI,
      optionVolume: i * 100,
      atmIV: 12,
      atmGamma: 0.0004,
    });
  }
}

describe("tier3 time-based EMA (#4)", () => {
  beforeEach(() => resetSignalState());

  it("is ready after covering the direction window", () => {
    warmBuffer();
    expect(computeIntradaySignal().ready).toBe(true);
  });

  it("does not advance D on a redundant compute (no new observation)", () => {
    warmBuffer();
    const first = computeIntradaySignal();
    const second = computeIntradaySignal(); // same latest.t → dt=0 → alpha=0
    expect(second.D).toBeCloseTo(first.D, 12);
    expect(second.signalRaw).toBeCloseTo(first.signalRaw, 12);
  });

  it("advances D when a new observation arrives", () => {
    warmBuffer();
    const before = computeIntradaySignal().D;
    // Push a strongly bearish observation ~5s later; the EMA should move toward it.
    recordObservation({ t: 205_000, price: 23_980, callOI: 1_010_000, putOI: 1_260_000, optionVolume: 4200, atmIV: 12, atmGamma: 0.0004 });
    const after = computeIntradaySignal().D;
    expect(after).not.toBeCloseTo(before, 6);
  });

  it("resets EMA state on session reset", () => {
    warmBuffer();
    computeIntradaySignal();
    resetSignalState();
    expect(computeIntradaySignal().ready).toBe(false); // buffer empty → warmup
  });
});

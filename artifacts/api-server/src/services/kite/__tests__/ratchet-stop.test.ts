// Unit tests for the trailing-ratchet stop math (R5 exit core). Pure function — the SL-M
// trigger the exchange backstop rests at is derived from this, so its behaviour is
// safety-critical. Values mirror the worked examples in SYSTEM_BLUEPRINT.md §7a.

import { describe, it, expect, vi } from "vitest";

vi.mock("@workspace/db", () => ({ db: {}, signalExecutionsTable: {} }));
vi.mock("../orders.js", () => ({ placeOrder: vi.fn(), placeProtectiveStop: vi.fn(), cancelOrder: vi.fn(), modifyOrder: vi.fn() }));
vi.mock("../portfolio.js", () => ({ getPositions: vi.fn() }));
vi.mock("../kite-option-chain.js", () => ({ getGlobalKiteClient: vi.fn() }));
vi.mock("../kite-client.js", () => ({ getKiteClientForUser: vi.fn() }));
vi.mock("../market-ticker.js", () => ({ getLtpBySymbol: vi.fn(), trackHeldSymbol: vi.fn(), untrackHeldSymbol: vi.fn(), marketTicker: { on: vi.fn() } }));
vi.mock("../../lib/audit-queue.js", () => ({ enqueueAudit: vi.fn() }));
vi.mock("../position-state.js", () => ({ markFlat: vi.fn(), markPendingExit: vi.fn() }));
vi.mock("../../lib/logger.js", () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));

import { computeRatchetStop } from "../position-monitor.js";

describe("computeRatchetStop", () => {
  it("uses the hard stop before the first milestone", () => {
    // entry 100, peak 105 (5% < 10% step) → milestone 0 → hard stop 30% below.
    const { stopPrice, milestoneLevel } = computeRatchetStop(100, 105, "up", 15, 30, 10);
    expect(milestoneLevel).toBe(0);
    expect(stopPrice).toBeCloseTo(70, 6);
  });

  it("caps the first milestone stop at breakeven (never gives back below entry)", () => {
    // Blueprint example: peak 115 → milestone 10% → 110*0.85=93.5 → capped at entry 100.
    const { stopPrice, milestoneLevel } = computeRatchetStop(100, 115, "up", 15, 30, 10);
    expect(milestoneLevel).toBe(10);
    expect(stopPrice).toBeCloseTo(100, 6);
  });

  it("ratchets the stop up past breakeven at higher milestones", () => {
    // Blueprint example: peak 125 → milestone 20% → 120*0.85 = 102.
    const { stopPrice, milestoneLevel } = computeRatchetStop(100, 125, "up", 15, 30, 10);
    expect(milestoneLevel).toBe(20);
    expect(stopPrice).toBeCloseTo(102, 6);
  });

  it("honours a tighter far-OTM config (5% step, 8% gap)", () => {
    // peak 110 → 10% profit → milestone 10 (step 5) → 110*(0.92)=101.2 (> entry).
    const { stopPrice, milestoneLevel } = computeRatchetStop(100, 110, "up", 8, 15, 5);
    expect(milestoneLevel).toBe(10);
    expect(stopPrice).toBeCloseTo(101.2, 6);
  });

  it("is monotonic non-decreasing as the peak rises (long)", () => {
    let prev = -Infinity;
    for (let peak = 100; peak <= 160; peak += 1) {
      const { stopPrice } = computeRatchetStop(100, peak, "up", 15, 30, 10);
      expect(stopPrice).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = stopPrice;
    }
  });
});

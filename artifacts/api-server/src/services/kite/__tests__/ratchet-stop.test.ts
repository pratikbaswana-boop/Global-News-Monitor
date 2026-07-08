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
    // entry 100, peak 105 (5% < 10%) → milestone 0 → hard stop 30% below.
    const { stopPrice, milestoneLevel } = computeRatchetStop(100, 105, "up", 15, 30, 10);
    expect(milestoneLevel).toBe(0);
    expect(stopPrice).toBeCloseTo(70, 6);
  });

  it("locks 8% profit at the 10% milestone", () => {
    // peak 115 → 15% profit → milestone 10 → lock 8% → stop = 108.
    const { stopPrice, milestoneLevel } = computeRatchetStop(100, 115, "up", 15, 30, 10);
    expect(milestoneLevel).toBe(10);
    expect(stopPrice).toBeCloseTo(108, 6);
  });

  it("ratchets the stop 2% up at the 15% milestone", () => {
    // peak 116 → 16% profit → milestone 15 → lock 10% → stop = 110.
    const { stopPrice, milestoneLevel } = computeRatchetStop(100, 116, "up", 15, 30, 10);
    expect(milestoneLevel).toBe(15);
    expect(stopPrice).toBeCloseTo(110, 6);
  });

  it("ratchets the stop 2% up at the 20% milestone", () => {
    // peak 125 → 25% profit → milestone 20 → lock 12% → stop = 112.
    const { stopPrice, milestoneLevel } = computeRatchetStop(100, 125, "up", 15, 30, 10);
    expect(milestoneLevel).toBe(20);
    expect(stopPrice).toBeCloseTo(112, 6);
  });

  it("ratchets further at the 30% milestone", () => {
    // peak 135 → 35% profit → milestone 30 → lock 16% → stop = 116.
    const { stopPrice, milestoneLevel } = computeRatchetStop(100, 135, "up", 15, 30, 10);
    expect(milestoneLevel).toBe(30);
    expect(stopPrice).toBeCloseTo(116, 6);
  });

  it("honours far-OTM hard stop (15%) below 10% profit", () => {
    // peak 105 → 5% profit → milestone 0 → hard stop 15% → stop = 85.
    const { stopPrice, milestoneLevel } = computeRatchetStop(100, 105, "up", 8, 15, 5);
    expect(milestoneLevel).toBe(0);
    expect(stopPrice).toBeCloseTo(85, 6);
  });

  it("locks 8% profit for far-OTM at 10% milestone too", () => {
    // peak 110 → 10% profit → milestone 10 → lock 8% → stop = 108.
    const { stopPrice, milestoneLevel } = computeRatchetStop(100, 110, "up", 8, 15, 5);
    expect(milestoneLevel).toBe(10);
    expect(stopPrice).toBeCloseTo(108, 6);
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

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
    // entry 100, peak 105 (5% < 10%) → milestone 0 → hard stop 15% below.
    const { stopPrice, milestoneLevel } = computeRatchetStop(100, 105, "up", 8, 15, 10);
    expect(milestoneLevel).toBe(0);
    expect(stopPrice).toBeCloseTo(85, 6);
  });

  it("locks 8% profit at the 10% milestone (floor min dominates)", () => {
    // peak 110 → 10% profit → trailing = 101.2, floor = max(8, 7) = 8% → 108 → stop = 108.
    const { stopPrice, milestoneLevel } = computeRatchetStop(100, 110, "up", 8, 15, 10);
    expect(milestoneLevel).toBe(10);
    expect(stopPrice).toBeCloseTo(108, 6);
  });

  it("locks 10.5% profit at 15% milestone (70% of 15% = 10.5%)", () => {
    // peak 115 → 15% profit → trailing = 105.8, floor = max(8, 10.5) = 10.5% → 110.5 → stop = 110.5.
    const { stopPrice, milestoneLevel } = computeRatchetStop(100, 115, "up", 8, 15, 10);
    expect(milestoneLevel).toBe(15);
    expect(stopPrice).toBeCloseTo(110.5, 6);
  });

  it("locks 14% profit at 20% milestone (70% of 20% = 14%)", () => {
    // peak 120 → 20% profit → trailing = 110.4, floor = max(8, 14) = 14% → 114 → stop = 114.
    const { stopPrice, milestoneLevel } = computeRatchetStop(100, 120, "up", 8, 15, 10);
    expect(milestoneLevel).toBe(20);
    expect(stopPrice).toBeCloseTo(114, 6);
  });

  it("trailing takes over at 30% profit (8% below peak > 70% floor)", () => {
    // peak 130 → 30% profit → trailing = 119.6, floor = max(8, 21) = 21% → 121 → stop = 121.
    const { stopPrice, milestoneLevel } = computeRatchetStop(100, 130, "up", 8, 15, 10);
    expect(milestoneLevel).toBe(30);
    expect(stopPrice).toBeCloseTo(121, 6);
  });

  it("trailing dominates at 40% profit", () => {
    // peak 140 → 40% profit → trailing = 128.8, floor = max(8, 28) = 28% → 128 → stop = 128.8.
    const { stopPrice, milestoneLevel } = computeRatchetStop(100, 140, "up", 8, 15, 10);
    expect(milestoneLevel).toBe(40);
    expect(stopPrice).toBeCloseTo(128.8, 6);
  });

  it("honours far-OTM hard stop (15%) below 5% profit", () => {
    // peak 104 → 4% profit → milestone 0 → hard stop 15% → stop = 85.
    const { stopPrice, milestoneLevel } = computeRatchetStop(100, 104, "up", 8, 15, 5);
    expect(milestoneLevel).toBe(0);
    expect(stopPrice).toBeCloseTo(85, 6);
  });

  it("locks 3% profit for far-OTM at 5% milestone (floor min dominates)", () => {
    // peak 105 → 5% profit → trailing = 96.6, floor = max(3, 3.5) = 3.5% → 103.5 → stop = 103.5.
    const { stopPrice, milestoneLevel } = computeRatchetStop(100, 105, "up", 8, 15, 5);
    expect(milestoneLevel).toBe(5);
    expect(stopPrice).toBeCloseTo(103.5, 6);
  });

  it("locks 70% profit for far-OTM at 10% profit", () => {
    // peak 110 → 10% profit → trailing = 101.2, floor = max(3, 7) = 7% → 107 → stop = 107.
    const { stopPrice, milestoneLevel } = computeRatchetStop(100, 110, "up", 8, 15, 5);
    expect(milestoneLevel).toBe(10);
    expect(stopPrice).toBeCloseTo(107, 6);
  });

  it("is monotonic non-decreasing as the peak rises (long)", () => {
    let prev = -Infinity;
    for (let peak = 100; peak <= 160; peak += 1) {
      const { stopPrice } = computeRatchetStop(100, peak, "up", 8, 15, 10);
      expect(stopPrice).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = stopPrice;
    }
  });

  it("never gives back more than 8% from peak (long, above milestone)", () => {
    for (let peak = 110; peak <= 200; peak += 1) {
      const { stopPrice } = computeRatchetStop(100, peak, "up", 8, 15, 10);
      const giveBackPct = ((peak - stopPrice) / peak) * 100;
      expect(giveBackPct).toBeLessThanOrEqual(8.01);
    }
  });
});

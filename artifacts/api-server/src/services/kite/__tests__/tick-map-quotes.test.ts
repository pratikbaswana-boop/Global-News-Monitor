// Unit test for #2 — selecting option premiums from the in-memory tick map instead of a
// REST getQuote. Verifies the mapper reads getLtpBySymbol and drops candidates with no
// live premium. Heavy imports of signal-executor are mocked (as in ratchet-stop.test).

import { describe, it, expect, vi } from "vitest";

const ltpBySymbol: Record<string, number> = {};

vi.mock("@workspace/db", () => ({
  db: {}, brokerAccountsTable: {}, brokerOrdersTable: {}, brokerPositionsTable: {},
  signalExecutionsTable: {}, marketSnapshotsTable: {}, userTradePreferencesTable: {},
}));
vi.mock("../orders.js", () => ({ placeOrder: vi.fn() }));
vi.mock("../portfolio.js", () => ({ getMargins: vi.fn(), syncPortfolio: vi.fn() }));
vi.mock("../kite-option-chain.js", () => ({ getGlobalKiteClient: vi.fn(), getNearestExpiry: vi.fn() }));
vi.mock("../market-ticker.js", () => ({
  getLatestChainMetrics: vi.fn(),
  getLtpBySymbol: vi.fn((sym: string) => (sym in ltpBySymbol ? ltpBySymbol[sym] : null)),
}));
vi.mock("../hot-context.js", () => ({ getHotContext: vi.fn() }));
vi.mock("../../lib/audit-queue.js", () => ({ enqueueAudit: vi.fn() }));
vi.mock("../position-state.js", () => ({
  canEnter: vi.fn(), markPendingEntry: vi.fn(), markOpen: vi.fn(), markFlat: vi.fn(),
  getPositionState: vi.fn(), getAllPositionStates: vi.fn(() => []),
}));
vi.mock("../../lib/logger.js", () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));

import { quoteCandidatesFromTicks } from "../signal-executor.js";

describe("quoteCandidatesFromTicks (#2 tick-map selection)", () => {
  it("reads premiums from the tick map and keeps only live ones", () => {
    ltpBySymbol["NIFTY24250CE"] = 85;
    ltpBySymbol["NIFTY24300CE"] = 42;
    // NIFTY24350CE intentionally absent (no live tick)

    const out = quoteCandidatesFromTicks([
      { symbol: "NIFTY24250CE", strike: 24250, deltaEstimate: 0.5 },
      { symbol: "NIFTY24300CE", strike: 24300, deltaEstimate: 0.35 },
      { symbol: "NIFTY24350CE", strike: 24350, deltaEstimate: 0.2 },
    ]);

    expect(out.map((c) => c.symbol)).toEqual(["NIFTY24250CE", "NIFTY24300CE"]);
    expect(out[0]!.premium).toBe(85);
    expect(out[1]!.premium).toBe(42);
    expect(out.every((c) => c.lots === 0)).toBe(true); // lots filled later by selectBestOption
  });

  it("returns empty when no candidate has a live tick (caller falls back to REST)", () => {
    const out = quoteCandidatesFromTicks([
      { symbol: "NIFTY99999CE", strike: 99999, deltaEstimate: 0.1 },
    ]);
    expect(out).toEqual([]);
  });
});

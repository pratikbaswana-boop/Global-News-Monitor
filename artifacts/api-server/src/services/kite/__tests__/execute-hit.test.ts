// End-to-end "does an approved tier-3 signal literally hit the broker?" test.
//
// We mock ONLY the two real-world boundaries — the database (@workspace/db) and the
// Kite SDK (kite-client + portfolio) — and let the entire chain run for real:
//   processSignalForAutoTrade → executeOptionSignalForUser → deriveOptionSignalFromSnapshot
//   (the tier-3 microstructure GATE) → strike search → placeOrder → kite.placeOrder
//
// The assertion is that the fake broker's placeOrder is (or isn't) actually called.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock: database ────────────────────────────────────────────────────────────
// Sentinel table objects + a chainable, thenable query builder whose rows are
// configured per-test via __setRows. Inserts/updates just resolve.
vi.mock("@workspace/db", () => {
  const tbl = (name: string) => ({ _t: name });
  const tables = {
    brokerAccountsTable: tbl("brokerAccounts"),
    brokerOrdersTable: tbl("brokerOrders"),
    brokerPositionsTable: tbl("brokerPositions"),
    brokerHoldingsTable: tbl("brokerHoldings"),
    signalExecutionsTable: tbl("signalExecutions"),
    marketSnapshotsTable: tbl("marketSnapshots"),
    userTradePreferencesTable: tbl("userTradePreferences"),
  };

  const rows: Record<string, unknown[]> = {};
  const inserts: { table: string; values: unknown }[] = [];

  function builder() {
    let table = "";
    const b: any = {
      from(t: any) { table = t?._t ?? ""; return b; },
      where() { return b; },
      limit() { return b; },
      orderBy() { return b; },
      innerJoin() { return b; },
      set() { return b; },
      values(v: unknown) { inserts.push({ table, values: v }); return Promise.resolve([]); },
      then(res: (r: unknown[]) => void) { res(rows[table] ?? []); },
    };
    return b;
  }

  const db = {
    select() { return builder(); },
    insert(t: any) { const b = builder(); b.from(t); return b; },
    update(t: any) { const b = builder(); b.from(t); return b; },
  };

  return {
    ...tables,
    db,
    __setRows: (t: string, r: unknown[]) => { rows[t] = r; },
    __reset: () => { for (const k of Object.keys(rows)) delete rows[k]; inserts.length = 0; },
    __inserts: inserts,
  };
});

// ── Mock: Kite client (the broker boundary) ──────────────────────────────────
const placeOrderSpy = vi.fn(async () => ({ order_id: "MOCK-ORDER-1" }));
const getQuoteSpy = vi.fn(async (instruments: string[]) => {
  // Every requested NFO option quotes at ₹120 premium.
  const out: Record<string, unknown> = {};
  for (const key of instruments) out[key] = { last_price: 120 };
  return out;
});
vi.mock("../kite-client.js", () => ({
  getKiteClientForUser: vi.fn(async () => ({ placeOrder: placeOrderSpy, getQuote: getQuoteSpy })),
}));

// ── Mock: portfolio (margins + sync) ─────────────────────────────────────────
vi.mock("../portfolio.js", () => ({
  getMargins: vi.fn(async () => ({ equity: { available: { cash: 100000 } } })),
  syncPortfolio: vi.fn(async () => {}),
}));

// Quiet the logger.
vi.mock("../../lib/logger.js", () => ({
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}));

// ── System under test + mock controls ────────────────────────────────────────
import { processSignalForAutoTrade } from "../signal-executor.js";
import * as dbmock from "@workspace/db";

const setRows = (dbmock as any).__setRows as (t: string, r: unknown[]) => void;
const reset = (dbmock as any).__reset as () => void;

// Build a snapshot whose BASE signal derives to BUY_CALL (AI up + neutral tier-3),
// with an injected intraday microstructure verdict.
function snapshotWith(intradaySignal: unknown) {
  return {
    id: "snap-1",
    assetId: "nifty50",
    assetSymbol: "NIFTY 50",
    predictedDirection: "up",
    predictedConfidence: "high",
    timeframe: "intraday",
    realPriceAtSnapshot: "22000",
    maxPainDistancePct: 0.2,          // mild, no conflict
    shortCoveringSignal: "none",
    sgxNiftyChangePct: 0.1,
    tier3Evidence: JSON.stringify({ putCallRatio: 1.0, intradaySignal }),
  };
}

const account = {
  id: "acct-1", userId: "user-1", isActive: true, autoTradeEnabled: true,
  defaultProduct: "MIS", defaultOrderType: "MARKET", maxRiskPerTradePct: 5,
};
const optionPref = {
  userId: "user-1", assetId: "nifty50", enabled: true, useOptions: true,
  minConfidence: "low", onlyIntraday: false, defaultProduct: "MIS",
  defaultOrderType: "MARKET", maxCapitalPerTrade: "100000",
};

function primeCommonRows(snapshot: unknown) {
  setRows("marketSnapshots", [snapshot]);
  setRows("brokerAccounts", [account]);          // active accounts + placeOrder lookup
  setRows("userTradePreferences", [optionPref]);
  setRows("brokerOrders", []);                    // no existing order
  setRows("brokerPositions", []);                 // no existing position
  setRows("signalExecutions", []);
}

describe("tier-3 gate → broker order (end to end)", () => {
  beforeEach(() => { reset(); placeOrderSpy.mockClear(); getQuoteSpy.mockClear(); });

  it("HITS the broker when the microstructure signal agrees (CALL)", async () => {
    primeCommonRows(snapshotWith({ signal: "CALL", ready: true, D: 0.8, P: 0.5, regime: "aligned" }));

    await processSignalForAutoTrade("snap-1");

    expect(placeOrderSpy).toHaveBeenCalledTimes(1);
    const [variety, params] = placeOrderSpy.mock.calls[0] as [string, any];
    expect(variety).toBe("regular");
    expect(params.transaction_type).toBe("BUY");
    expect(params.exchange).toBe("NFO");
    expect(String(params.tradingsymbol)).toMatch(/^NIFTY.*CE$/); // a CALL option
    expect(params.quantity % 75).toBe(0);                         // whole NIFTY lots
  });

  it("does NOT hit the broker when the gate disagrees (signal = PUT vs BUY_CALL)", async () => {
    primeCommonRows(snapshotWith({ signal: "PUT", ready: true, D: -0.6, P: 0.5, regime: "aligned" }));

    await processSignalForAutoTrade("snap-1");

    expect(placeOrderSpy).not.toHaveBeenCalled();
  });

  it("does NOT hit the broker when the microstructure signal is NONE", async () => {
    primeCommonRows(snapshotWith({ signal: "NONE", ready: true, D: 0.1, P: 0.2, regime: "aligned" }));

    await processSignalForAutoTrade("snap-1");

    expect(placeOrderSpy).not.toHaveBeenCalled();
  });

  it("passes through (HITS) while the engine is still warming up (ready=false)", async () => {
    primeCommonRows(snapshotWith({ signal: "NONE", ready: false, D: 0, P: 0, regime: "warmup" }));

    await processSignalForAutoTrade("snap-1");

    expect(placeOrderSpy).toHaveBeenCalledTimes(1); // fail-safe: don't block on cold buffer
  });
});

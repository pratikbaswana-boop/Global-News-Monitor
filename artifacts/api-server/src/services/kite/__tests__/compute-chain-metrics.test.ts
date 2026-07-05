// Unit tests for computeChainMetrics — the pure option-chain aggregation shared by
// the legacy getQuote fetch and the new KiteTicker WebSocket feed. Guarantees the
// two paths produce identical OI / PCR / maxPain / volume output (parity check C3),
// and that IV/gamma are derived only from the ATM call premium.
//
// Pure function, no DB or Kite SDK — nothing to mock.

import { describe, it, expect } from "vitest";
import { computeChainMetrics, type ResolvedChain, type TickData } from "../kite-option-chain.js";

const EXPIRY = "2026-07-09";

/** Build a ResolvedChain with CE+PE at each of the given strikes. */
function makeChain(atmStrike: number, strikes: number[]): ResolvedChain {
  let token = 1;
  const relevantInstruments = strikes.flatMap((strike) => [
    { instrument_token: token++, tradingsymbol: `NIFTY${strike}CE`, strike, instrument_type: "CE" as const, expiry: EXPIRY, name: "NIFTY" },
    { instrument_token: token++, tradingsymbol: `NIFTY${strike}PE`, strike, instrument_type: "PE" as const, expiry: EXPIRY, name: "NIFTY" },
  ]);
  return { expiryStr: EXPIRY, atmStrike, relevantInstruments };
}

/** Map every instrument in the chain to a tick with the given per-leg values. */
function fullTickMap(
  chain: ResolvedChain,
  valueFor: (strike: number, type: "CE" | "PE") => TickData
): Map<number, TickData> {
  const m = new Map<number, TickData>();
  for (const inst of chain.relevantInstruments) {
    m.set(inst.instrument_token, valueFor(inst.strike, inst.instrument_type));
  }
  return m;
}

describe("computeChainMetrics", () => {
  it("aggregates OI, volume, PCR and max pain across strikes", () => {
    const chain = makeChain(24250, [24200, 24250, 24300]);
    // CE OI: 100 each = 300; PE OI: 200 each = 600 → PCR = 2.0
    const tickMap = fullTickMap(chain, (_strike, type) => ({
      ltp: type === "CE" ? 50 : 40,
      oi: type === "CE" ? 100 : 200,
      volume: 10,
    }));

    const m = computeChainMetrics(tickMap, chain, 24250);
    expect(m).not.toBeNull();
    expect(m!.callOI).toBe(300);
    expect(m!.putOI).toBe(600);
    expect(m!.pcr).toBeCloseTo(2.0, 6);
    // volume summed over all 6 legs (CE+PE) = 60
    expect(m!.optionVolume).toBe(60);
    // pain = strike × (ceOI+peOI) = strike × 300 → minimised at the lowest strike
    expect(m!.maxPainStrike).toBe(24200);
    expect(m!.source).toBe("kite");
  });

  it("derives a positive IV/gamma from the ATM call premium", () => {
    const chain = makeChain(24250, [24200, 24250, 24300]);
    const tickMap = fullTickMap(chain, (strike, type) => ({
      // Only the ATM call carries a premium used for IV inversion.
      ltp: strike === 24250 && type === "CE" ? 102.15 : 0,
      oi: 100,
      volume: 5,
    }));

    const m = computeChainMetrics(tickMap, chain, 24270.85);
    expect(m).not.toBeNull();
    expect(m!.atmIV).toBeGreaterThan(0);
    expect(m!.atmGamma).toBeGreaterThan(0);
  });

  it("returns null when either side has zero OI (incomplete data)", () => {
    const chain = makeChain(24250, [24200, 24250]);
    // Puts have no OI → putOI === 0 → incomplete
    const tickMap = fullTickMap(chain, (_strike, type) => ({
      ltp: 30,
      oi: type === "CE" ? 100 : 0,
      volume: 1,
    }));

    expect(computeChainMetrics(tickMap, chain, 24250)).toBeNull();
  });

  it("treats instruments missing from the tick map as zero", () => {
    const chain = makeChain(24250, [24200, 24250, 24300]);
    const full = fullTickMap(chain, (_s, type) => ({ ltp: 20, oi: type === "CE" ? 100 : 100, volume: 2 }));
    // Drop one CE leg from the map — it must contribute 0, not throw.
    const firstCe = chain.relevantInstruments.find((i) => i.instrument_type === "CE")!;
    full.delete(firstCe.instrument_token);

    const m = computeChainMetrics(full, chain, 24250);
    expect(m).not.toBeNull();
    expect(m!.callOI).toBe(200); // 3 CE strikes × 100, minus the dropped one
    expect(m!.putOI).toBe(300);
  });
});

// Unit tests for the in-memory hot context (R2). Pure module state, no deps.

import { describe, it, expect, beforeEach } from "vitest";
import {
  publishAssetContext,
  getHotContext,
  getAllHotContext,
  getContextVersion,
  resetHotContext,
  type HotAssetContext,
} from "../hot-context.js";

type Input = Omit<HotAssetContext, "version" | "publishedAt">;

function input(assetId: string, overrides: Partial<Input> = {}): Input {
  return {
    assetId,
    direction: "up",
    confidence: "high",
    regime: "RISK_ON",
    crisisProbability: 0.1,
    flipConfirmed: true,
    priceScore: 0.4,
    uncertaintyFlag: false,
    sgxNiftyChangePct: 0.3,
    shortCoveringSignal: "none",
    priceImpactEstimate: "+0.5% to +1.2%",
    ...overrides,
  };
}

describe("hot-context", () => {
  beforeEach(() => resetHotContext());

  it("returns null before the first publish for an asset", () => {
    expect(getHotContext("nifty50")).toBeNull();
  });

  it("publishes and reads back an asset context", () => {
    publishAssetContext(input("nifty50", { direction: "down" }));
    const ctx = getHotContext("nifty50");
    expect(ctx).not.toBeNull();
    expect(ctx!.direction).toBe("down");
    expect(ctx!.regime).toBe("RISK_ON");
  });

  it("increments a monotonic version on every publish", () => {
    const v0 = getContextVersion();
    const a = publishAssetContext(input("nifty50"));
    const b = publishAssetContext(input("sensex"));
    expect(a.version).toBe(v0 + 1);
    expect(b.version).toBe(v0 + 2);
    expect(getContextVersion()).toBe(v0 + 2);
  });

  it("swaps the reference atomically — a captured map is not mutated by later publishes", () => {
    publishAssetContext(input("nifty50", { direction: "up" }));
    const captured = getAllHotContext();
    // A later publish must not change what the captured reference sees.
    publishAssetContext(input("nifty50", { direction: "down" }));
    expect(captured.get("nifty50")!.direction).toBe("up");
    expect(getHotContext("nifty50")!.direction).toBe("down");
  });

  it("freezes published entries (immutability)", () => {
    const entry = publishAssetContext(input("nifty50"));
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { direction: string }).direction = "down";
    }).toThrow();
  });

  it("keeps independent context per asset", () => {
    publishAssetContext(input("nifty50", { direction: "up" }));
    publishAssetContext(input("sensex", { direction: "down" }));
    expect(getHotContext("nifty50")!.direction).toBe("up");
    expect(getHotContext("sensex")!.direction).toBe("down");
  });

  it("resetHotContext clears all published context", () => {
    publishAssetContext(input("nifty50"));
    resetHotContext();
    expect(getHotContext("nifty50")).toBeNull();
    expect(getAllHotContext().size).toBe(0);
  });
});

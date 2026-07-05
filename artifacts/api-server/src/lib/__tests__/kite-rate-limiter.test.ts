// Unit tests for the Kite REST rate limiter (#3).

import { describe, it, expect } from "vitest";
import { runKiteLimited, kiteLimiterDepth } from "../kite-rate-limiter.js";

describe("kite-rate-limiter", () => {
  it("starts jobs FIFO and propagates their results", async () => {
    const starts: number[] = [];
    const results = await Promise.all(
      [1, 2, 3].map((n) =>
        runKiteLimited(async () => {
          starts.push(n);
          return n * 10;
        })
      )
    );
    expect(starts).toEqual([1, 2, 3]); // fair, arrival order
    expect(results).toEqual([10, 20, 30]);
  });

  it("propagates a rejection without stalling the queue", async () => {
    const ok = runKiteLimited(async () => "ok");
    const bad = runKiteLimited(async () => {
      throw new Error("boom");
    });
    const later = runKiteLimited(async () => "still-runs");

    await expect(bad).rejects.toThrow("boom");
    await expect(ok).resolves.toBe("ok");
    await expect(later).resolves.toBe("still-runs");
  });

  it("drains to empty depth", async () => {
    await runKiteLimited(async () => 1);
    expect(kiteLimiterDepth()).toBe(0);
  });
});

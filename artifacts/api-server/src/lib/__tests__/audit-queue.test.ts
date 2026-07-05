// Unit tests for the write-behind audit queue (R4).

import { describe, it, expect, vi } from "vitest";

vi.mock("../logger.js", () => ({
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}));

import { enqueueAudit, flushAuditQueue, getAuditQueueDepth } from "../audit-queue.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("audit-queue", () => {
  it("defers the task's I/O off the caller (write-behind)", async () => {
    let ran = false;
    enqueueAudit("t", async () => {
      await tick(); // force the work past the synchronous prefix
      ran = true;
    });
    // The caller returned without waiting for the deferred work.
    expect(ran).toBe(false);
    await flushAuditQueue();
    expect(ran).toBe(true);
  });

  it("runs every enqueued task", async () => {
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) {
      enqueueAudit(`t${i}`, async () => {
        await tick();
        seen.push(i);
      });
    }
    await flushAuditQueue();
    expect(seen.sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it("swallows a failing task and still runs the rest", async () => {
    const seen: string[] = [];
    enqueueAudit("ok-1", async () => { await tick(); seen.push("ok-1"); });
    enqueueAudit("boom", async () => { await tick(); throw new Error("db down"); });
    enqueueAudit("ok-2", async () => { await tick(); seen.push("ok-2"); });

    // enqueue must never throw, even for a task that will reject.
    await expect(flushAuditQueue()).resolves.toBeUndefined();
    expect(seen).toContain("ok-1");
    expect(seen).toContain("ok-2");
  });

  it("drains to empty after flush", async () => {
    enqueueAudit("t", async () => { await tick(); });
    await flushAuditQueue();
    expect(getAuditQueueDepth()).toBe(0);
  });
});

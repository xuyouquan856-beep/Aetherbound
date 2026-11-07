import { describe, expect, it, vi } from "vitest";
// import { asyncPool } from "../../src/backend/library-scan/async-pool.js";

describe("asyncPool", () => {
  it("limits concurrency to N and runs all tasks", async () => {
    // RED: asyncPool not implemented yet
    const { asyncPool } = await import("../../src/backend/library-scan/async-pool.js");
    let running = 0;
    let maxRunning = 0;
    const started: number[] = [];
    const finished: number[] = [];

    const tasks = Array.from({ length: 10 }, (_, i) => i);
    const worker = async (n: number) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      started.push(n);
      await new Promise((r) => setTimeout(r, 10 + n * 2));
      running--;
      finished.push(n);
      return `result-${n}`;
    };

    const results = await asyncPool(tasks, 3, worker);
    expect(maxRunning).toBeLessThanOrEqual(3);
    expect(results).toEqual(tasks.map((n) => `result-${n}`));
    expect(finished.length).toBe(10);
  });

  it("propagates errors from tasks", async () => {
    const { asyncPool } = await import("../../src/backend/library-scan/async-pool.js");
    const tasks = [1, 2, 3];
    const worker = async (n: number) => {
      if (n === 2) throw new Error("task-failed");
      return n * 2;
    };

    await expect(asyncPool(tasks, 2, worker)).rejects.toThrow("task-failed");
  });

  it("handles empty task list", async () => {
    const { asyncPool } = await import("../../src/backend/library-scan/async-pool.js");
    const results = await asyncPool([], 3, async () => "unreachable");
    expect(results).toEqual([]);
  });

  it("completes all tasks even when concurrency is higher than task count", async () => {
    const { asyncPool } = await import("../../src/backend/library-scan/async-pool.js");
    const tasks = [1, 2];
    const results = await asyncPool(tasks, 10, async (n) => n * 10);
    expect(results).toEqual([10, 20]);
  });
});

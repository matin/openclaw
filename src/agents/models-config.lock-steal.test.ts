import { describe, expect, it, vi } from "vitest";

describe("withModelsJsonWriteLock bounded wait (tulgey#238)", () => {
  it("steals the lock from a holder that never settles instead of deadlocking", async () => {
    vi.stubEnv("OPENCLAW_MODELS_JSON_LOCK_WAIT_MS", "50");
    const { __withModelsJsonWriteLockForTest: withLock } = await import("./models-config.js");

    // Holder hangs forever inside run() — its finally never executes, so the
    // chained gate never resolves. Pre-fix, the second caller awaited it forever.
    void withLock("/tmp/models-test.json", () => new Promise<never>(() => {}));

    const second = withLock("/tmp/models-test.json", async () => "ran");
    await expect(
      Promise.race([
        second,
        new Promise((_, reject) => setTimeout(() => reject(new Error("deadlocked")), 5_000)),
      ]),
    ).resolves.toBe("ran");
    vi.unstubAllEnvs();
  });

  it("preserves serialization when holders settle normally", async () => {
    const { __withModelsJsonWriteLockForTest: withLock } = await import("./models-config.js");
    const order: number[] = [];
    const first = withLock("/tmp/models-test-2.json", async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push(1);
    });
    const second = withLock("/tmp/models-test-2.json", async () => {
      order.push(2);
    });
    await Promise.all([first, second]);
    expect(order).toEqual([1, 2]);
  });
});

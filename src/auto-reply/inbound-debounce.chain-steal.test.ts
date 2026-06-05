import { describe, expect, it, vi } from "vitest";

describe("inbound debounce chain steal (tulgey#238)", () => {
  it("a flush that never settles does not deafen later messages for the chat", async () => {
    vi.stubEnv("OPENCLAW_INBOUND_CHAIN_WAIT_MS", "50");
    vi.resetModules();
    const { createInboundDebouncer } = await import("./inbound-debounce.js");

    const flushed: string[][] = [];
    let first = true;
    const debouncer = createInboundDebouncer<string>({
      debounceMs: 0,
      buildKey: () => "chat-1",
      onFlush: async (items) => {
        if (first) {
          first = false;
          // Hung downstream work (e.g. media understanding) — never settles.
          await new Promise<never>(() => {});
        }
        flushed.push(items);
      },
    });

    void debouncer.enqueue("poisoned");
    const second = debouncer.enqueue("hi");
    await expect(
      Promise.race([
        second,
        new Promise((_, reject) => setTimeout(() => reject(new Error("chat deafened")), 5_000)),
      ]),
    ).resolves.toBeUndefined();
    expect(flushed).toEqual([["hi"]]);
    vi.unstubAllEnvs();
  });

  it("normal same-key ordering is preserved when flushes settle", async () => {
    vi.resetModules();
    const { createInboundDebouncer } = await import("./inbound-debounce.js");
    const flushed: string[] = [];
    const debouncer = createInboundDebouncer<string>({
      debounceMs: 0,
      buildKey: () => "chat-2",
      onFlush: async (items) => {
        await new Promise((r) => setTimeout(r, 20));
        flushed.push(...items);
      },
    });
    await Promise.all([debouncer.enqueue("a"), debouncer.enqueue("b")]);
    expect(flushed).toEqual(["a", "b"]);
  });
});

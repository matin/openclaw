import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { registerAgentRunContext, resetAgentRunContextForTest } from "../infra/agent-events.js";

const hoisted = vi.hoisted(() => ({
  loadConfigMock: vi.fn<() => OpenClawConfig>(),
  loadCombinedSessionEntriesForGatewayMock: vi.fn(),
}));

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => hoisted.loadConfigMock(),
}));

vi.mock("./session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("./session-utils.js")>("./session-utils.js");
  return {
    ...actual,
    loadCombinedSessionEntriesForGateway: (
      cfg: OpenClawConfig,
      opts?: { agentId?: string; configuredAgentsOnly?: boolean },
    ) => hoisted.loadCombinedSessionEntriesForGatewayMock(cfg, opts),
  };
});

const { resolveSessionKeyForRun, resetResolvedSessionKeyForRunCacheForTest } =
  await import("./server-session-key.js");

describe("resolveSessionKeyForRun", () => {
  beforeEach(() => {
    hoisted.loadConfigMock.mockReset();
    hoisted.loadCombinedSessionEntriesForGatewayMock.mockReset();
    resetAgentRunContextForTest();
    resetResolvedSessionKeyForRunCacheForTest();
  });

  afterEach(() => {
    resetAgentRunContextForTest();
    resetResolvedSessionKeyForRunCacheForTest();
  });

  it("resolves run ids from the combined gateway store and caches the result", () => {
    const cfg: OpenClawConfig = {
      session: {},
    };
    hoisted.loadConfigMock.mockReturnValue(cfg);
    hoisted.loadCombinedSessionEntriesForGatewayMock.mockReturnValue({
      databasePath: "(multiple)",
      entries: {
        "agent:main:acp:run-1": { sessionId: "run-1", updatedAt: 123 },
      },
    });

    expect(resolveSessionKeyForRun("run-1")).toBe("acp:run-1");
    expect(resolveSessionKeyForRun("run-1")).toBe("acp:run-1");
    expect(hoisted.loadCombinedSessionEntriesForGatewayMock).toHaveBeenCalledTimes(1);
    expect(hoisted.loadCombinedSessionEntriesForGatewayMock).toHaveBeenCalledWith(cfg, {
      agentId: "main",
    });
  });

  it("uses the requested agent scope for run lookups", () => {
    const cfg: OpenClawConfig = {
      session: {},
    };
    hoisted.loadConfigMock.mockReturnValue(cfg);
    hoisted.loadCombinedSessionEntriesForGatewayMock.mockReturnValue({
      databasePath: "(multiple)",
      entries: {
        "agent:retired:acp:run-1": { sessionId: "run-1", updatedAt: 123 },
      },
    });

    expect(resolveSessionKeyForRun("run-1", { agentId: "retired" })).toBe("acp:run-1");
    expect(hoisted.loadCombinedSessionEntriesForGatewayMock).toHaveBeenCalledWith(cfg, {
      agentId: "retired",
    });
  });

  it("defaults run id lookups without explicit agent scope to the default agent", () => {
    const cfg: OpenClawConfig = {
      session: {},
    };
    hoisted.loadConfigMock.mockReturnValue(cfg);
    hoisted.loadCombinedSessionEntriesForGatewayMock.mockReturnValue({
      databasePath: "(multiple)",
      entries: {
        "agent:retired:acp:run-1": { sessionId: "run-1", updatedAt: 123 },
      },
    });

    expect(resolveSessionKeyForRun("run-1")).toBeUndefined();
    expect(hoisted.loadCombinedSessionEntriesForGatewayMock).toHaveBeenCalledWith(cfg, {
      agentId: "main",
    });
  });

  it("filters same-run matches by requested agent for shared stores", () => {
    const cfg: OpenClawConfig = {
      session: {},
    };
    hoisted.loadConfigMock.mockReturnValue(cfg);
    hoisted.loadCombinedSessionEntriesForGatewayMock.mockReturnValue({
      databasePath: "/custom/root/sessions/sessions.json",
      entries: {
        "agent:retired:acp:run-1": { sessionId: "run-1", updatedAt: 123 },
        "agent:main:acp:run-1": { sessionId: "run-1", updatedAt: 122 },
      },
    });

    expect(resolveSessionKeyForRun("run-1", { agentId: "retired" })).toBe("acp:run-1");
    expect(resolveSessionKeyForRun("run-1", { agentId: "main" })).toBe("acp:run-1");
    expect(hoisted.loadCombinedSessionEntriesForGatewayMock).toHaveBeenCalledWith(cfg, {
      agentId: "retired",
    });
    expect(hoisted.loadCombinedSessionEntriesForGatewayMock).toHaveBeenCalledWith(cfg, {
      agentId: "main",
    });
  });

  it("lets active run context override a cached miss", () => {
    hoisted.loadConfigMock.mockReturnValue({});
    hoisted.loadCombinedSessionEntriesForGatewayMock.mockReturnValue({
      databasePath: "(multiple)",
      entries: {},
    });

    expect(resolveSessionKeyForRun("run-race")).toBeUndefined();
    registerAgentRunContext("run-race", { sessionKey: "agent:main:main" });

    expect(resolveSessionKeyForRun("run-race")).toBe("agent:main:main");
    expect(hoisted.loadCombinedSessionEntriesForGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("caches misses briefly before re-checking the combined store", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-12T15:00:00Z"));
    hoisted.loadConfigMock.mockReturnValue({});
    hoisted.loadCombinedSessionEntriesForGatewayMock.mockReturnValue({
      databasePath: "(multiple)",
      entries: {},
    });

    expect(resolveSessionKeyForRun("missing-run")).toBeUndefined();
    expect(resolveSessionKeyForRun("missing-run")).toBeUndefined();
    expect(hoisted.loadCombinedSessionEntriesForGatewayMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_001);

    expect(resolveSessionKeyForRun("missing-run")).toBeUndefined();
    expect(hoisted.loadCombinedSessionEntriesForGatewayMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("prefers the structurally matching session key when duplicate session ids exist", () => {
    hoisted.loadConfigMock.mockReturnValue({});
    hoisted.loadCombinedSessionEntriesForGatewayMock.mockReturnValue({
      databasePath: "(multiple)",
      entries: {
        "agent:main:other": { sessionId: "run-dup", updatedAt: 999 },
        "agent:main:acp:run-dup": { sessionId: "run-dup", updatedAt: 100 },
      },
    });

    expect(resolveSessionKeyForRun("run-dup")).toBe("acp:run-dup");
  });

  it("refuses ambiguous duplicate session ids without a clear best match", () => {
    hoisted.loadConfigMock.mockReturnValue({});
    hoisted.loadCombinedSessionEntriesForGatewayMock.mockReturnValue({
      databasePath: "(multiple)",
      entries: {
        "agent:main:first": { sessionId: "run-ambiguous", updatedAt: 100 },
        "agent:main:second": { sessionId: "run-ambiguous", updatedAt: 100 },
      },
    });

    expect(resolveSessionKeyForRun("run-ambiguous")).toBeUndefined();
  });
});

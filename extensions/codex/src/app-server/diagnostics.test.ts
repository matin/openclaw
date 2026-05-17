import { beforeEach, describe, expect, it, vi } from "vitest";

const diagnosticsMocks = vi.hoisted(() => ({
  store: {
    version: 1,
    profiles: {},
    order: {},
  },
  effectiveOrder: [] as string[],
  requestCodexAppServerJson: vi.fn(),
  refreshCodexAppServerAuthTokens: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  formatErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  ensureAuthProfileStore: () => diagnosticsMocks.store,
  resolveAuthProfileOrder: () => diagnosticsMocks.effectiveOrder,
}));

vi.mock("./auth-bridge.js", () => ({
  refreshCodexAppServerAuthTokens: diagnosticsMocks.refreshCodexAppServerAuthTokens,
}));

vi.mock("./config.js", () => ({
  resolveCodexAppServerRuntimeOptions: () => ({ start: { command: "codex" } }),
}));

vi.mock("./request.js", () => ({
  requestCodexAppServerJson: diagnosticsMocks.requestCodexAppServerJson,
}));

const { runCodexAppServerStatusProbe } = await import("./diagnostics.js");

describe("Codex app-server diagnostics", () => {
  beforeEach(() => {
    diagnosticsMocks.store.profiles = {};
    diagnosticsMocks.store.order = {};
    diagnosticsMocks.effectiveOrder = [];
    diagnosticsMocks.requestCodexAppServerJson.mockReset();
    diagnosticsMocks.refreshCodexAppServerAuthTokens.mockReset();
  });

  it("reports auth when account/read says OpenAI auth is still required", async () => {
    diagnosticsMocks.requestCodexAppServerJson.mockResolvedValueOnce({
      account: null,
      requiresOpenaiAuth: true,
    });

    const result = await runCodexAppServerStatusProbe({
      config: {},
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      provider: "openai-codex",
      modelId: "gpt-5.5",
      timeoutMs: 1000,
      maxTokens: 8,
    });

    expect(result.appServerProbe).toMatchObject({
      status: "auth",
      reasonCode: "openai_auth_required",
      error: "Codex app-server requires OpenAI authentication.",
    });
    expect(result.fallbackChain).toStrictEqual([
      {
        model: "openai-codex/gpt-5.5",
        status: "auth",
      },
    ]);
  });

  it("reports ok when account/read returns an authenticated account", async () => {
    diagnosticsMocks.requestCodexAppServerJson.mockResolvedValueOnce({
      account: { type: "chatgpt", email: "codex@example.test" },
      requiresOpenaiAuth: true,
    });

    const result = await runCodexAppServerStatusProbe({
      config: {},
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      provider: "openai-codex",
      modelId: "gpt-5.5",
      timeoutMs: 1000,
      maxTokens: 8,
    });

    expect(result.appServerProbe?.status).toBe("ok");
  });

  it("classifies invalid API-key app-server errors as auth failures", async () => {
    diagnosticsMocks.requestCodexAppServerJson.mockRejectedValueOnce(
      new Error("invalid_api_key: API key is invalid"),
    );

    const result = await runCodexAppServerStatusProbe({
      config: {},
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      provider: "openai-codex",
      modelId: "gpt-5.5",
      timeoutMs: 1000,
      maxTokens: 8,
    });

    expect(result.appServerProbe).toMatchObject({
      status: "auth",
      error: "invalid_api_key: API key is invalid",
    });
  });

  it("bounds OAuth refresh probes by the requested timeout", async () => {
    vi.useFakeTimers();
    diagnosticsMocks.store.profiles = {
      "openai-codex:default": {
        type: "oauth",
        provider: "openai-codex",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
      },
    };
    diagnosticsMocks.effectiveOrder = ["openai-codex:default"];
    diagnosticsMocks.refreshCodexAppServerAuthTokens.mockImplementationOnce(
      () => new Promise(() => {}),
    );
    diagnosticsMocks.requestCodexAppServerJson.mockResolvedValueOnce({
      account: { type: "chatgpt" },
      requiresOpenaiAuth: false,
    });

    try {
      const pending = runCodexAppServerStatusProbe({
        config: {},
        agentDir: "/tmp/agent",
        workspaceDir: "/tmp/workspace",
        provider: "openai-codex",
        modelId: "gpt-5.5",
        timeoutMs: 50,
        maxTokens: 8,
      });
      await vi.advanceTimersByTimeAsync(50);
      const result = await pending;

      expect(result.refreshProbe).toMatchObject({
        status: "timeout",
        error: "Codex app-server OAuth refresh probe timed out after 50ms",
      });
      expect(result.appServerProbe?.status).toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });

  it("includes the selected model in fallbackChain even when aliases provide fallbacks", async () => {
    diagnosticsMocks.requestCodexAppServerJson.mockResolvedValueOnce({
      account: { type: "chatgpt" },
      requiresOpenaiAuth: false,
    });

    const result = await runCodexAppServerStatusProbe({
      config: {},
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      provider: "openai-codex",
      modelId: "gpt-5.5",
      timeoutMs: 1000,
      maxTokens: 8,
      fallbackModels: ["codex/gpt-5.5", "openai-codex/gpt-5.5"],
    });

    expect(result.fallbackChain).toStrictEqual([
      {
        model: "openai-codex/gpt-5.5",
        status: "ok",
      },
      {
        model: "codex/gpt-5.5",
        status: "skipped",
        reason: "not_selected_for_probe",
      },
    ]);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import type { OpenClawConfig } from "../../config/config.js";

let mockStore: AuthProfileStore;
let mockAgentStore: AuthProfileStore | undefined;
let mockAllowedProfiles: string[];
const loadModelCatalogMock = vi.fn<() => Promise<ModelCatalogEntry[]>>(async () => []);
const probeRuntimeMocks = vi.hoisted(() => ({
  ensureSelectedAgentHarnessPlugin: vi.fn(async () => undefined),
  runEmbeddedPiAgent: vi.fn(async () => ({})),
  selectAgentHarness: vi.fn(),
  statusProbe: vi.fn(),
}));

const resolveAuthProfileOrderMock = vi.fn(() => mockAllowedProfiles);
const resolveAuthProfileEligibilityMock = vi.fn(() => ({
  eligible: false,
  reasonCode: "invalid_expires" as const,
}));
const resolveSecretRefStringMock = vi.fn(async () => "resolved-secret");
const externalCliDiscoveryScopedMock = vi.fn((params: Record<string, unknown> = {}) => ({
  mode: "scoped",
  ...params,
}));

vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: loadModelCatalogMock,
}));
vi.mock("../../agents/model-auth.js", () => ({
  hasUsableCustomProviderApiKey: (cfg: OpenClawConfig, provider: string) => {
    const raw = cfg.models?.providers?.[provider]?.apiKey;
    return typeof raw === "string" && raw.trim().length > 0 && raw !== "ollama-local";
  },
  resolveEnvApiKey: (
    provider: string,
    _env?: NodeJS.ProcessEnv,
    options?: { workspaceDir?: string },
  ) => {
    if (provider === "workspace-cloud") {
      return options?.workspaceDir === "/tmp/workspace"
        ? {
            source: "workspace cloud credentials",
            apiKey: "workspace-cloud-local-credentials",
          }
        : null;
    }
    const keys =
      provider === "anthropic"
        ? ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"]
        : provider === "openai"
          ? ["OPENAI_API_KEY"]
          : provider === "openai-codex"
            ? ["OPENAI_OAUTH_TOKEN"]
            : provider === "zai"
              ? ["ZAI_API_KEY", "Z_AI_API_KEY"]
              : [];
    const source = keys.find((key) => process.env[key]?.trim());
    return source ? { source, value: process.env[source] } : null;
  },
}));
vi.mock("../../agents/model-selection.js", () => {
  const normalizeProviderId = (value: string) =>
    value.trim().toLowerCase() === "z.ai" || value.trim().toLowerCase() === "z-ai"
      ? "zai"
      : value.trim().toLowerCase();
  return {
    normalizeProviderId,
    findNormalizedProviderValue: (record: Record<string, unknown> | undefined, provider: string) =>
      Object.entries(record ?? {}).find(([key]) => normalizeProviderId(key) === provider)?.[1],
    parseModelRef: (raw: string, defaultProvider: string) => {
      const [provider, ...modelParts] = raw.includes("/") ? raw.split("/") : [defaultProvider, raw];
      const model = modelParts.join("/");
      return provider && model ? { provider: normalizeProviderId(provider), model } : null;
    },
  };
});
vi.mock("../../secrets/resolve.js", () => ({
  resolveSecretRefString: resolveSecretRefStringMock,
}));
vi.mock("../status-all/format.js", () => ({
  redactSecrets: (value: string) => value,
}));
vi.mock("./shared.js", () => ({
  DEFAULT_PROVIDER: "openai",
  formatMs: (ms: number) => `${ms}ms`,
}));

vi.mock("../../agents/auth-profiles.js", () => ({
  externalCliDiscoveryScoped: externalCliDiscoveryScopedMock,
  ensureAuthProfileStore: (agentDir?: string) =>
    agentDir === "/tmp/coder-agent" && mockAgentStore ? mockAgentStore : mockStore,
  listProfilesForProvider: (store: AuthProfileStore, provider: string) =>
    Object.entries(store.profiles)
      .filter(
        ([, profile]) =>
          typeof profile.provider === "string" && profile.provider.toLowerCase() === provider,
      )
      .map(([profileId]) => profileId),
  resolveAuthProfileDisplayLabel: ({ profileId }: { profileId: string }) => profileId,
  resolveAuthProfileOrder: resolveAuthProfileOrderMock,
  resolveAuthProfileEligibility: resolveAuthProfileEligibilityMock,
}));
vi.mock("../../agents/harness/selection.js", () => ({
  selectAgentHarness: probeRuntimeMocks.selectAgentHarness,
}));
vi.mock("../../agents/harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: probeRuntimeMocks.ensureSelectedAgentHarnessPlugin,
}));
vi.mock("../../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: probeRuntimeMocks.runEmbeddedPiAgent,
}));

const { buildProbeTargets, runAuthProbes } = await import("./list.probe.js");

async function buildAnthropicProbePlan(order: string[]) {
  return buildProbeTargets({
    cfg: {
      auth: {
        order: {
          anthropic: order,
        },
      },
    } as OpenClawConfig,
    providers: ["anthropic"],
    modelCandidates: ["anthropic/claude-sonnet-4-6"],
    options: {
      timeoutMs: 5_000,
      concurrency: 1,
      maxTokens: 16,
    },
  });
}

async function withClearedAnthropicEnv<T>(fn: () => Promise<T>): Promise<T> {
  const previousAnthropic = process.env.ANTHROPIC_API_KEY;
  const previousAnthropicOauth = process.env.ANTHROPIC_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_OAUTH_TOKEN;
  try {
    return await fn();
  } finally {
    if (previousAnthropic === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = previousAnthropic;
    }
    if (previousAnthropicOauth === undefined) {
      delete process.env.ANTHROPIC_OAUTH_TOKEN;
    } else {
      process.env.ANTHROPIC_OAUTH_TOKEN = previousAnthropicOauth;
    }
  }
}

async function withClearedZaiEnv<T>(fn: () => Promise<T>): Promise<T> {
  const previousZai = process.env.ZAI_API_KEY;
  const previousLegacyZai = process.env.Z_AI_API_KEY;
  delete process.env.ZAI_API_KEY;
  delete process.env.Z_AI_API_KEY;
  try {
    return await fn();
  } finally {
    if (previousZai === undefined) {
      delete process.env.ZAI_API_KEY;
    } else {
      process.env.ZAI_API_KEY = previousZai;
    }
    if (previousLegacyZai === undefined) {
      delete process.env.Z_AI_API_KEY;
    } else {
      process.env.Z_AI_API_KEY = previousLegacyZai;
    }
  }
}

async function withClearedCodexEnv<T>(fn: () => Promise<T>): Promise<T> {
  const previousCodex = process.env.CODEX_API_KEY;
  const previousOpenAi = process.env.OPENAI_API_KEY;
  const previousOpenAiOauth = process.env.OPENAI_OAUTH_TOKEN;
  delete process.env.CODEX_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_OAUTH_TOKEN;
  try {
    return await fn();
  } finally {
    if (previousCodex === undefined) {
      delete process.env.CODEX_API_KEY;
    } else {
      process.env.CODEX_API_KEY = previousCodex;
    }
    if (previousOpenAi === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousOpenAi;
    }
    if (previousOpenAiOauth === undefined) {
      delete process.env.OPENAI_OAUTH_TOKEN;
    } else {
      process.env.OPENAI_OAUTH_TOKEN = previousOpenAiOauth;
    }
  }
}

async function buildAnthropicPlanFromModelsJsonApiKey(apiKey: string) {
  return await buildProbeTargets({
    cfg: {
      models: {
        providers: {
          anthropic: {
            baseUrl: "https://api.anthropic.com/v1",
            api: "anthropic-messages",
            apiKey,
            models: [],
          },
        },
      },
    } as OpenClawConfig,
    providers: ["anthropic"],
    modelCandidates: ["anthropic/claude-sonnet-4-6"],
    options: {
      timeoutMs: 5_000,
      concurrency: 1,
      maxTokens: 16,
    },
  });
}

function expectLegacyMissingCredentialsError(
  result: { reasonCode?: string; error?: string } | undefined,
  reasonCode: string,
) {
  expect(result?.reasonCode).toBe(reasonCode);
  expect(result?.error?.split("\n")[0]).toBe("Auth profile credentials are missing or expired.");
  expect(result?.error).toContain(`[${reasonCode}]`);
}

describe("buildProbeTargets reason codes", () => {
  beforeEach(() => {
    mockStore = {
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "token",
          provider: "anthropic",
          tokenRef: { source: "env", provider: "default", id: "ANTHROPIC_TOKEN" },
          expires: 0,
        },
      },
      order: {
        anthropic: ["anthropic:default"],
      },
    };
    mockAgentStore = undefined;
    mockAllowedProfiles = [];
    loadModelCatalogMock.mockReset();
    loadModelCatalogMock.mockResolvedValue([]);
    externalCliDiscoveryScopedMock.mockClear();
    resolveAuthProfileOrderMock.mockClear();
    resolveAuthProfileEligibilityMock.mockClear();
    resolveSecretRefStringMock.mockReset();
    resolveSecretRefStringMock.mockResolvedValue("resolved-secret");
    resolveAuthProfileEligibilityMock.mockReturnValue({
      eligible: false,
      reasonCode: "invalid_expires",
    });
    probeRuntimeMocks.ensureSelectedAgentHarnessPlugin.mockClear();
    probeRuntimeMocks.ensureSelectedAgentHarnessPlugin.mockResolvedValue(undefined);
    probeRuntimeMocks.runEmbeddedPiAgent.mockClear();
    probeRuntimeMocks.runEmbeddedPiAgent.mockResolvedValue({});
    probeRuntimeMocks.statusProbe.mockClear();
    probeRuntimeMocks.statusProbe.mockResolvedValue({
      harnessId: "codex",
      provider: "openai-codex",
      appServerProbe: { status: "ok" },
    });
    probeRuntimeMocks.selectAgentHarness.mockClear();
    probeRuntimeMocks.selectAgentHarness.mockReturnValue({
      id: "codex",
      label: "Codex",
      supports: () => ({ supported: true }),
      runAttempt: vi.fn(),
      statusProbe: probeRuntimeMocks.statusProbe,
    });
  });

  it("reports invalid_expires with a legacy-compatible first error line", async () => {
    const plan = await buildAnthropicProbePlan(["anthropic:default"]);

    expect(plan.targets).toStrictEqual([]);
    expect(plan.results).toStrictEqual([
      {
        error:
          "Auth profile credentials are missing or expired.\n↳ Auth reason [invalid_expires]: token expires must be a positive Unix ms timestamp.",
        label: "anthropic:default",
        mode: "token",
        model: "anthropic/claude-sonnet-4-6",
        profileId: "anthropic:default",
        provider: "anthropic",
        reasonCode: "invalid_expires",
        source: "profile",
        status: "unknown",
      },
    ]);
  });

  it("reports excluded_by_auth_order when profile id is not present in explicit order", async () => {
    mockStore.order = {
      anthropic: ["anthropic:work"],
    };
    const plan = await buildAnthropicProbePlan(["anthropic:work"]);

    expect(plan.targets).toStrictEqual([]);
    expect(plan.results).toStrictEqual([
      {
        error: "Excluded by auth.order for this provider.",
        label: "anthropic:default",
        mode: "token",
        model: "anthropic/claude-sonnet-4-6",
        profileId: "anthropic:default",
        provider: "anthropic",
        reasonCode: "excluded_by_auth_order",
        source: "profile",
        status: "unknown",
      },
    ]);
  });

  it("reports unresolved_ref when a ref-only profile cannot resolve its SecretRef", async () => {
    mockStore = {
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "token",
          provider: "anthropic",
          tokenRef: { source: "env", provider: "default", id: "MISSING_ANTHROPIC_TOKEN" },
        },
      },
      order: {
        anthropic: ["anthropic:default"],
      },
    };
    mockAllowedProfiles = ["anthropic:default"];
    resolveSecretRefStringMock.mockRejectedValueOnce(new Error("missing secret"));

    const plan = await buildAnthropicProbePlan(["anthropic:default"]);

    expect(plan.targets).toHaveLength(0);
    expect(plan.results).toHaveLength(1);
    expectLegacyMissingCredentialsError(plan.results[0], "unresolved_ref");
    expect(plan.results[0]?.error).toContain("env:default:MISSING_ANTHROPIC_TOKEN");
  });

  it("skips marker-only models.json credentials when building probe targets", async () => {
    mockStore = {
      version: 1,
      profiles: {},
      order: {},
    };
    await withClearedAnthropicEnv(async () => {
      const plan = await buildAnthropicPlanFromModelsJsonApiKey("ollama-local");
      expect(plan.targets).toStrictEqual([]);
      expect(plan.results).toStrictEqual([]);
    });
  });

  it("does not treat arbitrary all-caps models.json apiKey values as markers", async () => {
    mockStore = {
      version: 1,
      profiles: {},
      order: {},
    };
    await withClearedAnthropicEnv(async () => {
      const plan = await buildAnthropicPlanFromModelsJsonApiKey("ALLCAPS_SAMPLE");
      expect(plan.results).toStrictEqual([]);
      expect(plan.targets).toStrictEqual([
        {
          label: "models.json",
          mode: "api_key",
          model: { provider: "anthropic", model: "claude-sonnet-4-6" },
          provider: "anthropic",
          source: "models.json",
        },
      ]);
    });
  });

  it("matches canonical providers against alias-valued catalog probe models", async () => {
    await withClearedZaiEnv(async () => {
      mockStore = {
        version: 1,
        profiles: {},
        order: {},
      };
      loadModelCatalogMock.mockResolvedValueOnce([
        { provider: "z.ai", id: "glm-4.7", name: "GLM-4.7" },
      ]);

      const plan = await buildProbeTargets({
        cfg: {
          models: {
            providers: {
              zai: {
                baseUrl: "https://api.z.ai/v1",
                api: "openai-responses",
                apiKey: "sk-zai-test", // pragma: allowlist secret
                models: [],
              },
            },
          },
        } as OpenClawConfig,
        providers: ["zai"],
        modelCandidates: [],
        options: {
          timeoutMs: 5_000,
          concurrency: 1,
          maxTokens: 16,
        },
      });

      expect(plan.results).toStrictEqual([]);
      expect(plan.targets).toStrictEqual([
        {
          label: "models.json",
          mode: "api_key",
          model: { provider: "zai", model: "glm-4.7" },
          provider: "zai",
          source: "models.json",
        },
      ]);
    });
  });

  it("prefers live Anthropic Haiku 4.5 catalog entries over stale Claude 3 probes", async () => {
    mockStore = {
      version: 1,
      profiles: {},
      order: {},
    };
    loadModelCatalogMock.mockResolvedValueOnce([
      { provider: "anthropic", id: "claude-3-haiku-20240307", name: "Claude Haiku 3" },
      {
        provider: "anthropic",
        id: "claude-haiku-4-5-20251001",
        name: "Claude Haiku 4.5",
      },
      { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    ]);

    const plan = await withClearedAnthropicEnv(async () =>
      buildProbeTargets({
        cfg: {
          models: {
            providers: {
              anthropic: {
                baseUrl: "https://api.anthropic.com/v1",
                api: "anthropic-messages",
                apiKey: "sk-ant-test",
                models: [],
              },
            },
          },
        } as OpenClawConfig,
        providers: ["anthropic"],
        modelCandidates: [],
        options: {
          timeoutMs: 5_000,
          concurrency: 1,
          maxTokens: 16,
        },
      }),
    );

    expect(plan.results).toStrictEqual([]);
    expect(plan.targets).toStrictEqual([
      {
        label: "models.json",
        mode: "api_key",
        model: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
        provider: "anthropic",
        source: "models.json",
      },
    ]);
  });

  it("uses workspace-scoped auth evidence when building env probe targets", async () => {
    mockStore = {
      version: 1,
      profiles: {},
      order: {},
    };
    loadModelCatalogMock.mockResolvedValue([
      { provider: "workspace-cloud", id: "workspace-model", name: "Workspace Model" },
    ]);

    const withoutWorkspace = await buildProbeTargets({
      cfg: {} as OpenClawConfig,
      providers: ["workspace-cloud"],
      modelCandidates: [],
      options: {
        timeoutMs: 5_000,
        concurrency: 1,
        maxTokens: 16,
      },
    });
    const withWorkspace = await buildProbeTargets({
      cfg: {} as OpenClawConfig,
      workspaceDir: "/tmp/workspace",
      providers: ["workspace-cloud"],
      modelCandidates: [],
      options: {
        timeoutMs: 5_000,
        concurrency: 1,
        maxTokens: 16,
      },
    });

    expect(withoutWorkspace.targets).toStrictEqual([]);
    expect(withWorkspace.targets).toStrictEqual([
      {
        label: "env",
        mode: "api_key",
        model: { provider: "workspace-cloud", model: "workspace-model" },
        provider: "workspace-cloud",
        source: "env",
      },
    ]);
  });

  it("uses OpenAI API-key profiles as Codex app-server probe targets", async () => {
    mockStore = {
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "sk-openai-profile",
        },
      },
      order: {},
    };
    mockAllowedProfiles = ["openai:default"];

    const plan = await buildProbeTargets({
      cfg: {} as OpenClawConfig,
      providers: ["openai-codex"],
      modelCandidates: ["openai-codex/gpt-5.5"],
      options: {
        provider: "openai-codex",
        timeoutMs: 5_000,
        concurrency: 1,
        maxTokens: 16,
      },
    });

    expect(plan.results).toStrictEqual([]);
    expect(plan.targets).toStrictEqual([
      {
        label: "openai:default",
        mode: "api_key",
        model: { provider: "openai-codex", model: "gpt-5.5" },
        profileId: "openai:default",
        provider: "openai-codex",
        source: "profile",
      },
    ]);
  });

  it("uses OpenAI API-key profiles as canonical Codex app-server probe targets", async () => {
    mockStore = {
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "sk-openai-profile",
        },
      },
      order: {},
    };
    mockAllowedProfiles = ["openai:default"];

    const plan = await buildProbeTargets({
      cfg: {} as OpenClawConfig,
      providers: ["codex"],
      modelCandidates: ["codex/gpt-5.5"],
      options: {
        provider: "codex",
        timeoutMs: 5_000,
        concurrency: 1,
        maxTokens: 16,
      },
    });

    expect(plan.results).toStrictEqual([]);
    expect(plan.targets).toStrictEqual([
      {
        label: "openai:default",
        mode: "api_key",
        model: { provider: "codex", model: "gpt-5.5" },
        profileId: "openai:default",
        provider: "codex",
        source: "profile",
      },
    ]);
  });

  it("reports explicitly ordered unusable OpenAI backup profiles in Codex probes", async () => {
    mockStore = {
      version: 1,
      profiles: {
        "openai:empty": {
          type: "api_key",
          provider: "openai",
        },
      },
      order: {},
    };
    mockAllowedProfiles = [];
    resolveAuthProfileEligibilityMock.mockReturnValue({
      eligible: false,
      reasonCode: "missing_credential",
    });

    const plan = await withClearedCodexEnv(() =>
      buildProbeTargets({
        cfg: {
          auth: {
            order: {
              "openai-codex": ["openai:empty"],
            },
          },
        } as OpenClawConfig,
        providers: ["openai-codex"],
        modelCandidates: ["openai-codex/gpt-5.5"],
        options: {
          provider: "openai-codex",
          profileIds: ["openai:empty"],
          timeoutMs: 5_000,
          concurrency: 1,
          maxTokens: 16,
        },
      }),
    );

    expect(plan.targets).toStrictEqual([]);
    expect(plan.results).toStrictEqual([
      {
        error:
          "Auth profile credentials are missing or expired.\n↳ Auth reason [missing_credential]: no inline credential or SecretRef is configured.",
        label: "openai:empty",
        mode: "api_key",
        model: "openai-codex/gpt-5.5",
        profileId: "openai:empty",
        provider: "openai-codex",
        reasonCode: "missing_credential",
        source: "profile",
        status: "unknown",
      },
    ]);
  });

  it("reports auth-order exclusions for requested OpenAI backup Codex profiles", async () => {
    mockStore = {
      version: 1,
      profiles: {
        "openai:backup": {
          type: "api_key",
          provider: "openai",
          key: "sk-openai-backup",
        },
      },
      order: {},
    };
    mockAllowedProfiles = [];

    const plan = await withClearedCodexEnv(() =>
      buildProbeTargets({
        cfg: {
          auth: {
            order: {
              "openai-codex": ["openai:other"],
            },
          },
        } as OpenClawConfig,
        providers: ["openai-codex"],
        modelCandidates: ["openai-codex/gpt-5.5"],
        options: {
          provider: "openai-codex",
          profileIds: ["openai:backup"],
          timeoutMs: 5_000,
          concurrency: 1,
          maxTokens: 16,
        },
      }),
    );

    expect(plan.targets).toStrictEqual([]);
    expect(plan.results).toStrictEqual([
      {
        error: "Excluded by auth.order for this provider.",
        label: "openai:backup",
        mode: "api_key",
        model: "openai-codex/gpt-5.5",
        profileId: "openai:backup",
        provider: "openai-codex",
        reasonCode: "excluded_by_auth_order",
        source: "profile",
        status: "unknown",
      },
    ]);
  });

  it("honors OpenAI auth-order aliases for requested Codex backup profiles", async () => {
    mockStore = {
      version: 1,
      profiles: {
        "openai:backup": {
          type: "api_key",
          provider: "openai",
          key: "sk-openai-backup",
        },
      },
      order: {},
    };
    mockAllowedProfiles = [];

    const plan = await withClearedCodexEnv(() =>
      buildProbeTargets({
        cfg: {
          auth: {
            order: {
              openai: ["openai:allowed"],
            },
          },
        } as OpenClawConfig,
        providers: ["openai-codex"],
        modelCandidates: ["openai-codex/gpt-5.5"],
        options: {
          provider: "openai-codex",
          profileIds: ["openai:backup"],
          timeoutMs: 5_000,
          concurrency: 1,
          maxTokens: 16,
        },
      }),
    );

    expect(plan.targets).toStrictEqual([]);
    expect(plan.results).toStrictEqual([
      {
        error: "Excluded by auth.order for this provider.",
        label: "openai:backup",
        mode: "api_key",
        model: "openai-codex/gpt-5.5",
        profileId: "openai:backup",
        provider: "openai-codex",
        reasonCode: "excluded_by_auth_order",
        source: "profile",
        status: "unknown",
      },
    ]);
  });

  it("reports requested non-api-key OpenAI Codex backup profiles as ineligible", async () => {
    mockStore = {
      version: 1,
      profiles: {
        "openai:oauth": {
          type: "token",
          provider: "openai",
          token: "oauth-token",
        },
      },
      order: {},
    };
    mockAllowedProfiles = [];

    const plan = await withClearedCodexEnv(() =>
      buildProbeTargets({
        cfg: {} as OpenClawConfig,
        providers: ["openai-codex"],
        modelCandidates: ["openai-codex/gpt-5.5"],
        options: {
          provider: "openai-codex",
          profileIds: ["openai:oauth"],
          timeoutMs: 5_000,
          concurrency: 1,
          maxTokens: 16,
        },
      }),
    );

    expect(plan.targets).toStrictEqual([]);
    expect(plan.results).toStrictEqual([
      {
        error:
          "Auth profile credentials are missing or expired.\n↳ Auth reason [ineligible_profile]: profile is incompatible with provider config.",
        label: "openai:oauth",
        mode: "token",
        model: "openai-codex/gpt-5.5",
        profileId: "openai:oauth",
        provider: "openai-codex",
        reasonCode: "ineligible_profile",
        source: "profile",
        status: "unknown",
      },
    ]);
  });

  it("uses OPENAI_API_KEY as a Codex app-server env probe target", async () => {
    mockStore = {
      version: 1,
      profiles: {},
      order: {},
    };
    mockAllowedProfiles = [];
    const previousOpenAi = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-openai-env";
    try {
      const plan = await buildProbeTargets({
        cfg: {} as OpenClawConfig,
        providers: ["openai-codex"],
        modelCandidates: ["openai-codex/gpt-5.5"],
        options: {
          provider: "openai-codex",
          timeoutMs: 5_000,
          concurrency: 1,
          maxTokens: 16,
        },
      });

      expect(plan.results).toStrictEqual([]);
      expect(plan.targets).toStrictEqual([
        {
          label: "env",
          mode: "api_key",
          model: { provider: "openai-codex", model: "gpt-5.5" },
          provider: "openai-codex",
          source: "env",
        },
      ]);
    } finally {
      if (previousOpenAi === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAi;
      }
    }
  });

  it("uses the canonical Codex catalog model for OpenAI-Codex env probes", async () => {
    mockStore = {
      version: 1,
      profiles: {},
      order: {},
    };
    mockAllowedProfiles = [];
    loadModelCatalogMock.mockResolvedValueOnce([
      { provider: "codex", id: "gpt-5.5", name: "gpt-5.5" },
    ]);
    const previousOpenAi = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-openai-env";
    try {
      const plan = await buildProbeTargets({
        cfg: {} as OpenClawConfig,
        providers: ["openai-codex"],
        modelCandidates: [],
        options: {
          provider: "openai-codex",
          timeoutMs: 5_000,
          concurrency: 1,
          maxTokens: 16,
        },
      });

      expect(plan.results).toStrictEqual([]);
      expect(plan.targets).toStrictEqual([
        {
          label: "env",
          mode: "api_key",
          model: { provider: "openai-codex", model: "gpt-5.5" },
          provider: "openai-codex",
          source: "env",
        },
      ]);
    } finally {
      if (previousOpenAi === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAi;
      }
    }
  });

  it("uses OpenAI-Codex catalog aliases for canonical Codex env probes", async () => {
    mockStore = {
      version: 1,
      profiles: {},
      order: {},
    };
    mockAllowedProfiles = [];
    loadModelCatalogMock.mockResolvedValueOnce([
      { provider: "openai-codex", id: "gpt-5.5", name: "gpt-5.5" },
    ]);
    const previousOpenAi = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-openai-env";
    try {
      const plan = await buildProbeTargets({
        cfg: {} as OpenClawConfig,
        providers: ["codex"],
        modelCandidates: [],
        options: {
          provider: "codex",
          timeoutMs: 5_000,
          concurrency: 1,
          maxTokens: 16,
        },
      });

      expect(plan.results).toStrictEqual([]);
      expect(plan.targets).toStrictEqual([
        {
          label: "env",
          mode: "api_key",
          model: { provider: "codex", model: "gpt-5.5" },
          provider: "codex",
          source: "env",
        },
      ]);
    } finally {
      if (previousOpenAi === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAi;
      }
    }
  });

  it("uses CODEX_API_KEY for canonical OpenAI Codex-runtime env probes", async () => {
    mockStore = {
      version: 1,
      profiles: {},
      order: {},
    };
    mockAllowedProfiles = [];
    const previousCodex = process.env.CODEX_API_KEY;
    const previousOpenAi = process.env.OPENAI_API_KEY;
    process.env.CODEX_API_KEY = "sk-codex-env";
    delete process.env.OPENAI_API_KEY;
    try {
      const plan = await buildProbeTargets({
        cfg: {} as OpenClawConfig,
        providers: ["openai"],
        modelCandidates: ["openai/gpt-5.5"],
        options: {
          provider: "openai",
          timeoutMs: 5_000,
          concurrency: 1,
          maxTokens: 16,
        },
      });

      expect(plan.results).toStrictEqual([]);
      expect(plan.targets).toStrictEqual([
        {
          label: "env",
          mode: "api_key",
          model: { provider: "openai", model: "gpt-5.5" },
          provider: "openai",
          source: "env",
        },
      ]);
    } finally {
      if (previousCodex === undefined) {
        delete process.env.CODEX_API_KEY;
      } else {
        process.env.CODEX_API_KEY = previousCodex;
      }
      if (previousOpenAi === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAi;
      }
    }
  });

  it("uses OpenAI-Codex OAuth profiles for canonical OpenAI Codex-runtime probes", async () => {
    mockStore = {
      version: 1,
      profiles: {
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
          accountId: "account-default",
        },
      },
      order: {},
    };
    mockAllowedProfiles = ["openai-codex:default"];

    const plan = await withClearedCodexEnv(() =>
      buildProbeTargets({
        cfg: {} as OpenClawConfig,
        providers: ["openai"],
        modelCandidates: ["openai/gpt-5.5"],
        options: {
          provider: "openai",
          timeoutMs: 5_000,
          concurrency: 1,
          maxTokens: 16,
        },
      }),
    );

    expect(plan.results).toStrictEqual([]);
    expect(plan.targets).toStrictEqual([
      {
        label: "openai-codex:default",
        mode: "oauth",
        model: { provider: "openai", model: "gpt-5.5" },
        profileId: "openai-codex:default",
        provider: "openai",
        source: "profile",
      },
    ]);
    expect(externalCliDiscoveryScopedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        providerIds: ["openai", "openai-codex"],
      }),
    );
  });

  it("uses OpenAI auth and does not force Codex when OpenAI models pin Pi runtime", async () => {
    mockStore = {
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "sk-openai-profile",
        },
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
      order: {},
    };
    mockAllowedProfiles = ["openai:default", "openai-codex:default"];
    resolveAuthProfileEligibilityMock.mockReturnValue({
      eligible: true,
    });
    probeRuntimeMocks.selectAgentHarness.mockReturnValueOnce({
      id: "pi",
      label: "PI",
      supports: () => ({ supported: true }),
      runAttempt: vi.fn(),
    });

    const summary = await withClearedCodexEnv(() =>
      runAuthProbes({
        cfg: {
          agents: {
            defaults: {
              models: {
                "openai/gpt-5.5": { agentRuntime: { id: "pi" } },
              },
            },
          },
        } as OpenClawConfig,
        agentId: "main",
        agentDir: "/tmp/openclaw-agent",
        workspaceDir: "/tmp/openclaw-workspace",
        providers: ["openai"],
        modelCandidates: ["openai/gpt-5.5"],
        options: {
          provider: "openai",
          timeoutMs: 5_000,
          concurrency: 1,
          maxTokens: 16,
        },
      }),
    );

    expect(probeRuntimeMocks.ensureSelectedAgentHarnessPlugin).toHaveBeenCalledWith(
      expect.not.objectContaining({
        agentHarnessRuntimeOverride: "codex",
      }),
    );
    expect(probeRuntimeMocks.statusProbe).not.toHaveBeenCalled();
    expect(probeRuntimeMocks.runEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        authProfileId: "openai:default",
        model: "gpt-5.5",
        provider: "openai",
      }),
    );
    expect(probeRuntimeMocks.runEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.not.objectContaining({
        agentHarnessRuntimeOverride: "codex",
      }),
    );
    expect(summary.results).toHaveLength(1);
    expect(summary.results[0]).toMatchObject({
      provider: "openai",
      profileId: "openai:default",
      status: "ok",
    });
  });

  it("does not use CODEX_API_KEY for custom-base OpenAI env probes", async () => {
    mockStore = {
      version: 1,
      profiles: {},
      order: {},
    };
    mockAllowedProfiles = [];
    const previousCodex = process.env.CODEX_API_KEY;
    const previousOpenAi = process.env.OPENAI_API_KEY;
    process.env.CODEX_API_KEY = "sk-codex-env";
    delete process.env.OPENAI_API_KEY;
    try {
      const plan = await buildProbeTargets({
        cfg: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://proxy.example.test/v1",
                api: "openai-responses",
                models: [],
              },
            },
          },
        } as OpenClawConfig,
        providers: ["openai"],
        modelCandidates: ["openai/gpt-5.5"],
        options: {
          provider: "openai",
          timeoutMs: 5_000,
          concurrency: 1,
          maxTokens: 16,
        },
      });

      expect(plan.results).toStrictEqual([]);
      expect(plan.targets).toStrictEqual([]);
    } finally {
      if (previousCodex === undefined) {
        delete process.env.CODEX_API_KEY;
      } else {
        process.env.CODEX_API_KEY = previousCodex;
      }
      if (previousOpenAi === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAi;
      }
    }
  });

  it("uses OPENAI_API_KEY as a canonical Codex app-server env probe target", async () => {
    mockStore = {
      version: 1,
      profiles: {},
      order: {},
    };
    mockAllowedProfiles = [];
    const previousOpenAi = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-openai-env";
    try {
      const plan = await buildProbeTargets({
        cfg: {} as OpenClawConfig,
        providers: ["codex"],
        modelCandidates: ["codex/gpt-5.5"],
        options: {
          provider: "codex",
          timeoutMs: 5_000,
          concurrency: 1,
          maxTokens: 16,
        },
      });

      expect(plan.results).toStrictEqual([]);
      expect(plan.targets).toStrictEqual([
        {
          label: "env",
          mode: "api_key",
          model: { provider: "codex", model: "gpt-5.5" },
          provider: "codex",
          source: "env",
        },
      ]);
    } finally {
      if (previousOpenAi === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAi;
      }
    }
  });

  it("pins Codex app-server probe turns to the selected harness", async () => {
    mockStore = {
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "sk-openai-test",
        },
      },
      order: {},
    };
    mockAllowedProfiles = ["openai:default"];
    resolveAuthProfileEligibilityMock.mockReturnValue({
      eligible: true,
    });

    const summary = await withClearedCodexEnv(() =>
      runAuthProbes({
        cfg: {} as OpenClawConfig,
        agentId: "main",
        agentDir: "/tmp/openclaw-agent",
        workspaceDir: "/tmp/openclaw-workspace",
        providers: ["openai-codex"],
        modelCandidates: ["openai-codex/gpt-5.5"],
        options: {
          provider: "openai-codex",
          timeoutMs: 5_000,
          concurrency: 1,
          maxTokens: 16,
        },
      }),
    );

    expect(probeRuntimeMocks.statusProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        authProfileId: "openai:default",
        provider: "openai-codex",
        modelId: "gpt-5.5",
      }),
    );
    expect(probeRuntimeMocks.ensureSelectedAgentHarnessPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        config: {},
        modelId: "gpt-5.5",
        provider: "openai-codex",
        workspaceDir: "/tmp/openclaw-workspace",
      }),
    );
    expect(
      probeRuntimeMocks.ensureSelectedAgentHarnessPlugin.mock.invocationCallOrder[0],
    ).toBeLessThan(probeRuntimeMocks.selectAgentHarness.mock.invocationCallOrder[0] ?? 0);
    expect(probeRuntimeMocks.runEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentHarnessRuntimeOverride: "codex",
        authProfileId: "openai:default",
        model: "gpt-5.5",
        provider: "openai-codex",
      }),
    );
    expect(summary.totalTargets).toBe(1);
    expect(summary.results[0]).toMatchObject({
      provider: "openai-codex",
      status: "ok",
      runtimeProbe: {
        harnessId: "codex",
        appServerProbe: { status: "ok" },
        trivialTurnProbe: { status: "ok" },
      },
    });
  });

  it("forces the Codex harness when probing canonical Codex aliases", async () => {
    mockStore = {
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "sk-openai-test",
        },
      },
      order: {},
    };
    mockAllowedProfiles = ["openai:default"];
    resolveAuthProfileEligibilityMock.mockReturnValue({
      eligible: true,
    });

    const summary = await withClearedCodexEnv(() =>
      runAuthProbes({
        cfg: {} as OpenClawConfig,
        agentId: "main",
        agentDir: "/tmp/openclaw-agent",
        workspaceDir: "/tmp/openclaw-workspace",
        providers: ["codex"],
        modelCandidates: ["codex/gpt-5.5"],
        options: {
          provider: "codex",
          timeoutMs: 5_000,
          concurrency: 1,
          maxTokens: 16,
        },
      }),
    );

    expect(probeRuntimeMocks.ensureSelectedAgentHarnessPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        agentHarnessRuntimeOverride: "codex",
        modelId: "gpt-5.5",
        provider: "codex",
      }),
    );
    expect(probeRuntimeMocks.selectAgentHarness).toHaveBeenCalledWith(
      expect.objectContaining({
        agentHarnessRuntimeOverride: "codex",
        modelId: "gpt-5.5",
        provider: "codex",
      }),
    );
    expect(probeRuntimeMocks.statusProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        authProfileId: "openai:default",
        provider: "codex",
        modelId: "gpt-5.5",
      }),
    );
    expect(probeRuntimeMocks.runEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentHarnessRuntimeOverride: "codex",
        authProfileId: "openai:default",
        model: "gpt-5.5",
        provider: "codex",
      }),
    );
    expect(summary.results[0]).toMatchObject({
      provider: "codex",
      status: "ok",
      runtimeProbe: {
        harnessId: "codex",
        appServerProbe: { status: "ok" },
        trivialTurnProbe: { status: "ok" },
      },
    });
  });

  it("reports status probe harness selection failures per target", async () => {
    mockStore = {
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "sk-openai-test",
        },
      },
      order: {},
    };
    mockAllowedProfiles = ["openai:default"];
    probeRuntimeMocks.selectAgentHarness.mockImplementationOnce(() => {
      throw new Error('Requested agent harness "codex" is not registered.');
    });

    const summary = await withClearedCodexEnv(() =>
      runAuthProbes({
        cfg: {} as OpenClawConfig,
        agentId: "main",
        agentDir: "/tmp/openclaw-agent",
        workspaceDir: "/tmp/openclaw-workspace",
        providers: ["openai-codex"],
        modelCandidates: ["openai-codex/gpt-5.5"],
        options: {
          provider: "openai-codex",
          timeoutMs: 5_000,
          concurrency: 1,
          maxTokens: 16,
        },
      }),
    );

    expect(probeRuntimeMocks.runEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.not.objectContaining({
        agentHarnessRuntimeOverride: "unavailable",
      }),
    );
    expect(summary.results[0]).toMatchObject({
      provider: "openai-codex",
      status: "ok",
      runtimeProbe: {
        harnessId: "unavailable",
        appServerProbe: {
          status: "unknown",
          error: 'Requested agent harness "codex" is not registered.',
        },
        trivialTurnProbe: { status: "ok" },
      },
    });
  });

  it("uses the requested agent auth store when building profile probe targets", async () => {
    mockStore = {
      version: 1,
      profiles: {},
      order: {},
    };
    mockAgentStore = {
      version: 1,
      profiles: {
        "anthropic:coder": {
          type: "api_key",
          provider: "anthropic",
          key: "sk-ant-coder-profile",
        },
      },
      order: {},
    };

    const { defaultPlan, agentPlan } = await withClearedAnthropicEnv(async () => ({
      defaultPlan: await buildProbeTargets({
        cfg: {} as OpenClawConfig,
        providers: ["anthropic"],
        modelCandidates: ["anthropic/claude-sonnet-4-6"],
        options: {
          timeoutMs: 5_000,
          concurrency: 1,
          maxTokens: 16,
        },
      }),
      agentPlan: await buildProbeTargets({
        cfg: {} as OpenClawConfig,
        agentDir: "/tmp/coder-agent",
        providers: ["anthropic"],
        modelCandidates: ["anthropic/claude-sonnet-4-6"],
        options: {
          timeoutMs: 5_000,
          concurrency: 1,
          maxTokens: 16,
        },
      }),
    }));

    expect(defaultPlan.targets).toStrictEqual([]);
    expect(agentPlan.results).toStrictEqual([]);
    expect(agentPlan.targets).toStrictEqual([
      {
        label: "anthropic:coder",
        mode: "api_key",
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
        profileId: "anthropic:coder",
        provider: "anthropic",
        source: "profile",
      },
    ]);
  });
});

import {
  formatErrorMessage,
  type AgentHarnessStatusProbeParams,
  type AgentHarnessStatusProbePhase,
  type AgentHarnessStatusProbePhaseStatus,
  type AgentHarnessStatusProbeResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  ensureAuthProfileStore,
  resolveAuthProfileOrder,
  type AuthProfileCredential,
  type AuthProfileFailureReason,
  type ProfileUsageStats,
} from "openclaw/plugin-sdk/agent-runtime";
import { refreshCodexAppServerAuthTokens } from "./auth-bridge.js";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import type { CodexGetAccountResponse } from "./protocol.js";
import { requestCodexAppServerJson } from "./request.js";

const CODEX_APP_SERVER_AUTH_PROVIDER = "openai-codex";
const CODEX_API_KEY_ENV_VAR = "CODEX_API_KEY";
const OPENAI_API_KEY_ENV_VAR = "OPENAI_API_KEY";

function classifyProbeError(error: unknown): AgentHarnessStatusProbePhaseStatus {
  const message = formatErrorMessage(error).toLowerCase();
  if (message.includes("timed out") || message.includes("timeout")) {
    return "timeout";
  }
  if (
    message.includes("unauthorized") ||
    message.includes("forbidden") ||
    message.includes("auth") ||
    message.includes("login") ||
    message.includes("invalid_api_key") ||
    message.includes("invalid api key")
  ) {
    return "auth";
  }
  if (message.includes("rate limit") || message.includes("rate_limit") || message.includes("429")) {
    return "rate_limit";
  }
  if (
    message.includes("billing") ||
    message.includes("subscription") ||
    message.includes("quota") ||
    message.includes("usage limit")
  ) {
    return "billing";
  }
  if (message.includes("invalid")) {
    return "format";
  }
  return "unknown";
}

async function runProbePhase(
  run: () => Promise<AgentHarnessStatusProbePhase | void>,
): Promise<AgentHarnessStatusProbePhase> {
  const start = Date.now();
  try {
    const result = await run();
    if (result) {
      return { ...result, latencyMs: result.latencyMs ?? Date.now() - start };
    }
    return { status: "ok", latencyMs: Date.now() - start };
  } catch (error) {
    return {
      status: classifyProbeError(error),
      error: formatErrorMessage(error),
      latencyMs: Date.now() - start,
    };
  }
}

function withProbeTimeout<T>(params: {
  label: string;
  timeoutMs: number;
  run: () => Promise<T>;
}): Promise<T> {
  const timeoutMs = Math.max(1, Math.floor(params.timeoutMs));
  let timeoutHandle: NodeJS.Timeout | undefined;
  return new Promise<T>((resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`${params.label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    params.run().then(resolve, reject);
  }).finally(() => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  });
}

function classifyAccountReadResponse(
  response: CodexGetAccountResponse,
): AgentHarnessStatusProbePhase | undefined {
  if (!response.account && response.requiresOpenaiAuth) {
    return {
      status: "auth",
      reasonCode: "openai_auth_required",
      error: "Codex app-server requires OpenAI authentication.",
    };
  }
  return undefined;
}

function hasEnvAuth(): boolean {
  return Boolean(
    process.env[CODEX_API_KEY_ENV_VAR]?.trim() || process.env[OPENAI_API_KEY_ENV_VAR]?.trim(),
  );
}

function resolveOauthMetadata(
  credential: AuthProfileCredential | undefined,
): AgentHarnessStatusProbeResult["oauthMetadata"] {
  if (!credential) {
    return hasEnvAuth() ? "not_applicable" : "missing";
  }
  if (credential.type === "api_key") {
    return "not_applicable";
  }
  if (credential.type === "token") {
    return credential.token || credential.tokenRef ? "ok" : "missing";
  }
  if (credential.type !== "oauth") {
    return "unknown";
  }
  return credential.access && credential.refresh ? "ok" : "missing";
}

function resolveRefreshProbe(params: {
  agentDir: string;
  authProfileId?: string;
  credential?: AuthProfileCredential;
  config: AgentHarnessStatusProbeParams["config"];
  timeoutMs: number;
}): Promise<AgentHarnessStatusProbePhase> {
  if (!params.authProfileId || params.credential?.type !== "oauth") {
    return Promise.resolve({
      status: "skipped",
      reasonCode: "not_oauth_profile",
    });
  }
  return runProbePhase(async () => {
    await withProbeTimeout({
      label: "Codex app-server OAuth refresh probe",
      timeoutMs: params.timeoutMs,
      run: () =>
        refreshCodexAppServerAuthTokens({
          agentDir: params.agentDir,
          authProfileId: params.authProfileId,
          config: params.config,
        }),
    });
  });
}

function topFailureReason(
  stats: ProfileUsageStats | undefined,
): AuthProfileFailureReason | undefined {
  let selected: AuthProfileFailureReason | undefined;
  let selectedCount = 0;
  for (const [reason, count] of Object.entries(stats?.failureCounts ?? {})) {
    if (typeof count === "number" && count > selectedCount) {
      selected = reason as AuthProfileFailureReason;
      selectedCount = count;
    }
  }
  return selected ?? stats?.cooldownReason ?? stats?.disabledReason;
}

function resolveLastRuntimeFailure(
  stats: ProfileUsageStats | undefined,
): AgentHarnessStatusProbeResult["lastRuntimeFailure"] | undefined {
  if (!stats?.lastFailureAt) {
    return undefined;
  }
  return {
    at: stats.lastFailureAt,
    reason: topFailureReason(stats),
  };
}

function resolveAuthSource(params: {
  selectedProfile?: string;
  credential?: AuthProfileCredential;
}): AgentHarnessStatusProbeResult["authSource"] {
  if (params.selectedProfile && params.credential) {
    return "profile";
  }
  if (hasEnvAuth()) {
    return "env";
  }
  return "none";
}

function resolveFallbackChainModels(modelLabel: string, fallbackModels: string[] | undefined) {
  const models: string[] = [];
  const seen = new Set<string>();
  for (const model of [modelLabel, ...(fallbackModels ?? [])]) {
    const trimmed = model.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    models.push(trimmed);
  }
  return models;
}

export async function runCodexAppServerStatusProbe(
  params: AgentHarnessStatusProbeParams & { pluginConfig?: unknown },
): Promise<AgentHarnessStatusProbeResult> {
  const store = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
    config: params.config,
    externalCliProviderIds: [CODEX_APP_SERVER_AUTH_PROVIDER],
    ...(params.authProfileId ? { externalCliProfileIds: [params.authProfileId] } : {}),
  });
  const effectiveOrder = resolveAuthProfileOrder({
    cfg: params.config,
    store,
    provider: CODEX_APP_SERVER_AUTH_PROVIDER,
    preferredProfile: params.authProfileId,
  });
  const selectedProfile = params.authProfileId?.trim() || effectiveOrder[0]?.trim();
  const credential = selectedProfile ? store.profiles[selectedProfile] : undefined;
  const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig: params.pluginConfig });
  const refreshProbe = await resolveRefreshProbe({
    agentDir: params.agentDir,
    authProfileId: selectedProfile,
    credential,
    config: params.config,
    timeoutMs: params.timeoutMs,
  });
  const appServerProbe = await runProbePhase(async () => {
    const response = await requestCodexAppServerJson({
      method: "account/read",
      requestParams: { refreshToken: false },
      timeoutMs: params.timeoutMs,
      startOptions: runtime.start,
      authProfileId: selectedProfile,
      agentDir: params.agentDir,
      config: params.config,
      isolated: true,
    });
    return classifyAccountReadResponse(response);
  });
  const modelLabel = params.modelId ? `${params.provider}/${params.modelId}` : params.provider;

  return {
    harnessId: "codex",
    provider: params.provider,
    ...(params.modelId ? { model: modelLabel } : {}),
    effectiveFor: params.effectiveFor?.length ? params.effectiveFor : [modelLabel],
    ...(selectedProfile ? { selectedProfile } : {}),
    effectiveOrder,
    authSource: resolveAuthSource({ selectedProfile, credential }),
    oauthMetadata: resolveOauthMetadata(credential),
    refreshProbe,
    appServerProbe,
    lastRuntimeFailure: resolveLastRuntimeFailure(
      selectedProfile ? store.usageStats?.[selectedProfile] : undefined,
    ),
    fallbackChain: resolveFallbackChainModels(modelLabel, params.fallbackModels).map((model) => {
      const entry: NonNullable<AgentHarnessStatusProbeResult["fallbackChain"]>[number] = {
        model,
        status: model === modelLabel ? appServerProbe.status : "skipped",
      };
      if (model !== modelLabel) {
        entry.reason = "not_selected_for_probe";
      }
      return entry;
    }),
  };
}

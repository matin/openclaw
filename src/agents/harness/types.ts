export type AgentHarnessSupportContext = {
  provider: string;
  modelId?: string;
  requestedRuntime: import("../pi-embedded-runner/runtime.js").EmbeddedAgentRuntime;
};

export type AgentHarnessSupport =
  | { supported: true; priority?: number; reason?: string }
  | { supported: false; reason?: string };

export type AgentHarnessAttemptParams =
  import("../pi-embedded-runner/run/types.js").EmbeddedRunAttemptParams;
export type AgentHarnessAttemptResult =
  import("../pi-embedded-runner/run/types.js").EmbeddedRunAttemptResult;
export type AgentHarnessSideQuestionParams = {
  cfg: import("../../config/types.openclaw.js").OpenClawConfig;
  agentDir: string;
  provider: string;
  model: string;
  runtimeModel?: import("@earendil-works/pi-ai").Model<import("@earendil-works/pi-ai").Api>;
  question: string;
  sessionEntry: import("../../config/sessions.js").SessionEntry;
  sessionStore?: Record<string, import("../../config/sessions.js").SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  resolvedThinkLevel?: import("../../auto-reply/thinking.js").ThinkLevel;
  resolvedReasoningLevel: import("../../auto-reply/thinking.js").ReasoningLevel;
  blockReplyChunking?: import("../pi-embedded-block-chunker.js").BlockReplyChunking;
  resolvedBlockStreamingBreak?: "text_end" | "message_end";
  opts?: import("../../auto-reply/get-reply-options.types.js").GetReplyOptions;
  isNewSession: boolean;
  sessionId: string;
  sessionFile: string;
  agentId?: string;
  workspaceDir?: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
};
export type AgentHarnessSideQuestionResult = {
  text: string;
};
export type AgentHarnessCompactParams =
  import("../pi-embedded-runner/compact.types.js").CompactEmbeddedPiSessionParams;
export type AgentHarnessCompactResult =
  import("../pi-embedded-runner/types.js").EmbeddedPiCompactResult;
export type AgentHarnessResetParams = {
  sessionId?: string;
  sessionKey?: string;
  sessionFile?: string;
  reason?: "new" | "reset" | "idle" | "daily" | "compaction" | "deleted" | "unknown";
};

export type AgentHarnessStatusProbePhaseStatus =
  | "ok"
  | "skipped"
  | "auth"
  | "rate_limit"
  | "billing"
  | "timeout"
  | "format"
  | "unknown"
  | "no_model";

export type AgentHarnessStatusProbePhase = {
  status: AgentHarnessStatusProbePhaseStatus;
  reasonCode?: string;
  error?: string;
  latencyMs?: number;
};

export type AgentHarnessStatusProbeResult = {
  harnessId: string;
  provider: string;
  model?: string;
  effectiveFor?: string[];
  selectedProfile?: string;
  effectiveOrder?: string[];
  authSource?: "profile" | "env" | "native" | "none";
  oauthMetadata?: "ok" | "missing" | "not_applicable" | "unknown";
  refreshProbe?: AgentHarnessStatusProbePhase;
  appServerProbe?: AgentHarnessStatusProbePhase;
  trivialTurnProbe?: AgentHarnessStatusProbePhase;
  lastRuntimeFailure?: {
    reason?: string;
    at?: number;
    message?: string;
  };
  fallbackChain?: Array<{
    model: string;
    status: AgentHarnessStatusProbePhaseStatus;
    reason?: string;
  }>;
};

export type AgentHarnessStatusProbeParams = {
  config: import("../../config/types.openclaw.js").OpenClawConfig;
  agentDir: string;
  workspaceDir: string;
  agentId?: string;
  provider: string;
  modelId?: string;
  authProfileId?: string;
  timeoutMs: number;
  maxTokens: number;
  effectiveFor?: string[];
  fallbackModels?: string[];
};

export type AgentHarnessResultClassification =
  | "ok"
  | NonNullable<AgentHarnessAttemptResult["agentHarnessResultClassification"]>;

export type AgentHarnessDeliveryDefaults = {
  /**
   * Preferred default for visible source replies when user config has not
   * explicitly selected automatic or message-tool delivery.
   */
  sourceVisibleReplies?: "automatic" | "message_tool";
};

export type AgentHarness = {
  id: string;
  label: string;
  pluginId?: string;
  deliveryDefaults?: AgentHarnessDeliveryDefaults;
  supports(ctx: AgentHarnessSupportContext): AgentHarnessSupport;
  runAttempt(params: AgentHarnessAttemptParams): Promise<AgentHarnessAttemptResult>;
  statusProbe?(
    params: AgentHarnessStatusProbeParams,
  ): Promise<AgentHarnessStatusProbeResult | undefined>;
  runSideQuestion?(params: AgentHarnessSideQuestionParams): Promise<AgentHarnessSideQuestionResult>;
  classify?(
    result: AgentHarnessAttemptResult,
    ctx: AgentHarnessAttemptParams,
  ): AgentHarnessResultClassification | undefined;
  compact?(params: AgentHarnessCompactParams): Promise<AgentHarnessCompactResult | undefined>;
  reset?(params: AgentHarnessResetParams): Promise<void> | void;
  dispose?(): Promise<void> | void;
};

export type RegisteredAgentHarness = {
  harness: AgentHarness;
  ownerPluginId?: string;
};

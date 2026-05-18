import {
  DEFAULT_AGENT_ID,
  parseThreadSessionSuffix,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { getRuntimeConfig } from "../io.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { normalizeSessionRowKey } from "./store-entry.js";
import { getSessionEntry } from "./store.js";
import { resolveAgentSessionDatabaseTargetsSync } from "./targets.js";
import type { SessionEntry } from "./types.js";

type ExtractedDeliveryContext = {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string;
};

export type ParsedSessionThreadInfo = {
  baseSessionKey: string | undefined;
  threadId: string | undefined;
};

function hasRoutableDeliveryContext(context: DeliveryContext | undefined): boolean {
  return Boolean(context?.channel && context?.to);
}

function normalizeThreadId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toExtractedDeliveryContext(
  entry: SessionEntry | undefined,
): ExtractedDeliveryContext | undefined {
  const context = deliveryContextFromSession(entry);
  if (!hasRoutableDeliveryContext(context)) {
    return undefined;
  }
  return {
    channel: context?.channel,
    to: context?.to,
    accountId: context?.accountId,
    threadId: normalizeThreadId(context?.threadId),
  };
}

function resolveAgentId(sessionKey: string): string {
  return resolveAgentIdFromSessionKey(sessionKey) ?? DEFAULT_AGENT_ID;
}

type DeliveryInfoLookupOptions = {
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
};

function readDeliverySessionEntry(
  sessionKey: string,
  options: DeliveryInfoLookupOptions = {},
): SessionEntry | undefined {
  const agentId = resolveAgentId(sessionKey);
  const normalizedKey = normalizeSessionRowKey(sessionKey);
  const targets: Array<{ agentId: string; databasePath?: string }> = options.cfg
    ? resolveAgentSessionDatabaseTargetsSync(options.cfg, agentId, { env: options.env })
    : [{ agentId }];
  for (const target of targets) {
    const entry = getSessionEntry({
      agentId: target.agentId,
      env: options.env,
      path: target.databasePath,
      sessionKey: normalizedKey,
    });
    if (entry) {
      return entry;
    }
  }
  return undefined;
}

export function parseSessionThreadInfo(sessionKey: string | undefined): ParsedSessionThreadInfo {
  return parseThreadSessionSuffix(sessionKey);
}

export function extractDeliveryInfo(
  sessionKey: string | undefined,
  options: DeliveryInfoLookupOptions = {},
): {
  deliveryContext: ExtractedDeliveryContext | undefined;
  threadId: string | undefined;
} {
  if (!sessionKey) {
    return { deliveryContext: undefined, threadId: undefined };
  }

  const { baseSessionKey, threadId } = parseSessionThreadInfo(sessionKey);
  const lookupKey = baseSessionKey ?? sessionKey;
  try {
    const lookupOptions = {
      ...options,
      cfg: options.cfg ?? getRuntimeConfig(),
    };
    const entry =
      readDeliverySessionEntry(lookupKey, lookupOptions) ??
      (lookupKey === sessionKey ? undefined : readDeliverySessionEntry(sessionKey, lookupOptions));
    const deliveryContext = toExtractedDeliveryContext(entry);
    return {
      deliveryContext,
      threadId: deliveryContext?.threadId ?? threadId,
    };
  } catch {
    return { deliveryContext: undefined, threadId };
  }
}

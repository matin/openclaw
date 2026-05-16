import {
  mergeDeliveryContext,
  normalizeDeliveryContext,
  normalizeSessionDeliveryFields,
} from "../../utils/delivery-context.shared.js";
import { normalizeSessionRuntimeModelFields, type SessionEntry } from "./types.js";

type LegacySessionOrigin = {
  provider?: unknown;
  to?: unknown;
  accountId?: unknown;
  chatType?: unknown;
  threadId?: unknown;
};

type LegacySessionShadows = {
  origin?: unknown;
  lastChannel?: unknown;
  lastTo?: unknown;
  lastAccountId?: unknown;
  lastThreadId?: unknown;
};

function legacyOriginDeliveryContext(origin: unknown): SessionEntry["deliveryContext"] {
  if (!origin || typeof origin !== "object" || Array.isArray(origin)) {
    return undefined;
  }
  const legacy = origin as LegacySessionOrigin;
  return normalizeDeliveryContext({
    channel: typeof legacy.provider === "string" ? legacy.provider : undefined,
    to: typeof legacy.to === "string" ? legacy.to : undefined,
    accountId: typeof legacy.accountId === "string" ? legacy.accountId : undefined,
    chatType:
      legacy.chatType === "direct" || legacy.chatType === "group" || legacy.chatType === "channel"
        ? legacy.chatType
        : undefined,
    threadId:
      typeof legacy.threadId === "string" || typeof legacy.threadId === "number"
        ? legacy.threadId
        : undefined,
  });
}

function normalizeSessionEntryDelivery(entry: SessionEntry): SessionEntry {
  const legacyEntry = entry as SessionEntry & LegacySessionShadows;
  const originDeliveryContext = legacyOriginDeliveryContext(legacyEntry.origin);
  const normalized = normalizeSessionDeliveryFields({
    channel: entry.channel,
    deliveryContext: mergeDeliveryContext(entry.deliveryContext, originDeliveryContext),
    lastChannel: legacyEntry.lastChannel,
    lastTo: legacyEntry.lastTo,
    lastAccountId:
      legacyEntry.lastAccountId ??
      (typeof originDeliveryContext?.accountId === "string"
        ? originDeliveryContext.accountId
        : undefined),
    lastThreadId: legacyEntry.lastThreadId ?? originDeliveryContext?.threadId,
  });
  const nextDelivery = normalized.deliveryContext;
  const nextChatType = entry.chatType ?? originDeliveryContext?.chatType;
  const sameDelivery =
    (entry.deliveryContext?.channel ?? undefined) === nextDelivery?.channel &&
    (entry.deliveryContext?.to ?? undefined) === nextDelivery?.to &&
    (entry.deliveryContext?.accountId ?? undefined) === nextDelivery?.accountId &&
    (entry.deliveryContext?.chatType ?? undefined) === nextDelivery?.chatType &&
    (entry.deliveryContext?.threadId ?? undefined) === nextDelivery?.threadId;
  const hasLegacyShadows =
    legacyEntry.lastChannel !== undefined ||
    legacyEntry.lastTo !== undefined ||
    legacyEntry.lastAccountId !== undefined ||
    legacyEntry.lastThreadId !== undefined;
  if (sameDelivery && entry.chatType === nextChatType && !hasLegacyShadows) {
    return entry;
  }
  const {
    lastChannel: _lastChannel,
    lastTo: _lastTo,
    lastAccountId: _lastAccountId,
    lastThreadId: _lastThreadId,
    ...rest
  } = legacyEntry;
  return {
    ...rest,
    chatType: nextChatType,
    deliveryContext: nextDelivery,
  };
}

// resolvedSkills carries the full parsed Skill[] (including each SKILL.md body)
// and is only used as an in-turn cache by the runtime — see
// src/agents/pi-embedded-runner/skills-runtime.ts. Persisting it bloats session
// rows by orders of magnitude when many sessions are active.
function stripPersistedSkillsCache(entry: SessionEntry): SessionEntry {
  const snapshot = entry.skillsSnapshot;
  if (!snapshot || snapshot.resolvedSkills === undefined) {
    return entry;
  }
  const { resolvedSkills: _drop, ...rest } = snapshot;
  return { ...entry, skillsSnapshot: rest };
}

function stripPersistedShadows(entry: SessionEntry & LegacySessionShadows): SessionEntry {
  if (entry.origin === undefined) {
    return entry;
  }
  const { origin: _drop, ...rest } = entry;
  return rest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeOptionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeOptionalAttemptCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function normalizeOptionalStringOrNull(value: unknown): string | null | undefined {
  if (value === null || typeof value === "string") {
    return value;
  }
  return undefined;
}

function normalizeOptionalDeliveryContext(
  value: unknown,
): SessionEntry["pendingFinalDeliveryContext"] {
  if (!isRecord(value)) {
    return undefined;
  }
  const normalized = normalizeDeliveryContext({
    channel: typeof value.channel === "string" ? value.channel : undefined,
    to: typeof value.to === "string" ? value.to : undefined,
    accountId: typeof value.accountId === "string" ? value.accountId : undefined,
    threadId:
      typeof value.threadId === "string" || typeof value.threadId === "number"
        ? value.threadId
        : undefined,
  });
  return normalized?.channel && normalized.to ? normalized : undefined;
}

function sameDeliveryContext(
  left: SessionEntry["pendingFinalDeliveryContext"],
  right: SessionEntry["pendingFinalDeliveryContext"],
): boolean {
  return (
    (left?.channel ?? undefined) === (right?.channel ?? undefined) &&
    (left?.to ?? undefined) === (right?.to ?? undefined) &&
    (left?.accountId ?? undefined) === (right?.accountId ?? undefined) &&
    (left?.threadId ?? undefined) === (right?.threadId ?? undefined)
  );
}

function normalizePendingFinalDeliveryFields(entry: SessionEntry): SessionEntry {
  let next = entry;

  const assign = <K extends keyof SessionEntry>(key: K, value: SessionEntry[K] | undefined) => {
    if (entry[key] === value) {
      return;
    }
    if (next === entry) {
      next = { ...entry };
    }
    if (value === undefined) {
      delete next[key];
    } else {
      next[key] = value;
    }
  };

  assign("pendingFinalDelivery", entry.pendingFinalDelivery === true ? true : undefined);
  assign("pendingFinalDeliveryText", normalizeOptionalStringOrNull(entry.pendingFinalDeliveryText));
  assign(
    "pendingFinalDeliveryCreatedAt",
    normalizeOptionalFiniteNumber(entry.pendingFinalDeliveryCreatedAt),
  );
  assign(
    "pendingFinalDeliveryLastAttemptAt",
    normalizeOptionalFiniteNumber(entry.pendingFinalDeliveryLastAttemptAt),
  );
  assign(
    "pendingFinalDeliveryAttemptCount",
    normalizeOptionalAttemptCount(entry.pendingFinalDeliveryAttemptCount),
  );
  assign(
    "pendingFinalDeliveryLastError",
    normalizeOptionalStringOrNull(entry.pendingFinalDeliveryLastError),
  );
  const pendingFinalDeliveryContext = normalizeOptionalDeliveryContext(
    entry.pendingFinalDeliveryContext,
  );
  if (!sameDeliveryContext(entry.pendingFinalDeliveryContext, pendingFinalDeliveryContext)) {
    assign("pendingFinalDeliveryContext", pendingFinalDeliveryContext);
  }
  assign(
    "pendingFinalDeliveryIntentId",
    normalizeOptionalStringOrNull(entry.pendingFinalDeliveryIntentId),
  );

  return next;
}

export function normalizeSessionEntries(entries: Record<string, SessionEntry>): boolean {
  let changed = false;
  for (const [key, entry] of Object.entries(entries)) {
    if (!entry) {
      continue;
    }
    const normalized = stripPersistedShadows(
      normalizePendingFinalDeliveryFields(
        stripPersistedSkillsCache(
          normalizeSessionEntryDelivery(normalizeSessionRuntimeModelFields(entry)),
        ),
      ),
    );
    if (normalized !== entry) {
      entries[key] = normalized;
      changed = true;
    }
  }
  return changed;
}

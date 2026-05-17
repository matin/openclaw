import { normalizeSessionKeyPreservingOpaquePeerIds } from "../../sessions/session-key-utils.js";
import type { SessionEntry } from "./types.js";

export function normalizeSessionRowKey(sessionKey: string): string {
  return normalizeSessionKeyPreservingOpaquePeerIds(sessionKey);
}

export function resolveSessionRowEntry(params: {
  entries: Record<string, SessionEntry>;
  sessionKey: string;
}): {
  normalizedKey: string;
  existing: SessionEntry | undefined;
} {
  const trimmedKey = params.sessionKey.trim();
  const normalizedKey = normalizeSessionRowKey(trimmedKey);
  return {
    normalizedKey,
    existing: params.entries[normalizedKey],
  };
}

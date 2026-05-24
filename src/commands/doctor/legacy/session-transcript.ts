import { createHash } from "node:crypto";
import { CURRENT_SESSION_VERSION } from "../../../agents/transcript/session-transcript-format.js";
import type {
  CompactionEntry,
  SessionHeader,
  TranscriptEntry,
} from "../../../agents/transcript/session-transcript-types.js";

const MAX_LEGACY_JSONL_TRANSCRIPT_VERSION = 3;

function generateSessionEntryId(ids: Set<string>, entry: TranscriptEntry, index: number): string {
  const source = JSON.stringify({ index, entry });
  const digest = createHash("sha256")
    .update("openclaw-transcript-v1\n")
    .update(source)
    .digest("hex");
  for (let offset = 0; offset < digest.length - 8; offset += 8) {
    const id = digest.slice(offset, offset + 8);
    if (!ids.has(id)) {
      ids.add(id);
      return id;
    }
  }
  const id = digest;
  ids.add(id);
  return id;
}

function migrateV1ToV2(entries: TranscriptEntry[]): void {
  const ids = new Set<string>();
  let previousId: string | null = null;
  for (const [index, entry] of entries.entries()) {
    if (entry.type === "session") {
      entry.version = 2;
      continue;
    }
    entry.id = generateSessionEntryId(ids, entry, index);
    entry.parentId = previousId;
    previousId = entry.id;

    if (entry.type === "compaction") {
      const legacy = entry as CompactionEntry & { firstKeptEntryIndex?: number };
      if (typeof legacy.firstKeptEntryIndex === "number") {
        const targetEntry = entries[legacy.firstKeptEntryIndex];
        if (targetEntry?.type !== "session") {
          legacy.firstKeptEntryId = targetEntry.id;
        }
        delete legacy.firstKeptEntryIndex;
      }
    }
  }
}

function migrateV2ToV3(entries: TranscriptEntry[]): void {
  for (const entry of entries) {
    if (entry.type === "session") {
      entry.version = 3;
      continue;
    }
    if (
      entry.type === "message" &&
      entry.message &&
      (entry.message as { role?: string }).role === "hookMessage"
    ) {
      (entry.message as { role?: string }).role = "custom";
    }
  }
}

export function migrateLegacyTranscriptEntries(entries: TranscriptEntry[]): void {
  const header = entries.find((entry): entry is SessionHeader => entry.type === "session");
  const version = header?.version ?? 1;
  if (version >= MAX_LEGACY_JSONL_TRANSCRIPT_VERSION) {
    if (header) {
      header.version = CURRENT_SESSION_VERSION;
    }
    return;
  }
  if (version < 2) {
    migrateV1ToV2(entries);
  }
  if (version < 3) {
    migrateV2ToV3(entries);
  }
  if (header) {
    header.version = CURRENT_SESSION_VERSION;
  }
}

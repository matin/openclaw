import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  appendSqliteSessionTranscriptEvent,
  appendSqliteSessionTranscriptMessage,
  countSqliteSessionTranscriptDisplayMessages,
  deleteSqliteSessionTranscript,
  listSqliteSessionTranscripts,
  loadSqliteSessionTranscriptBoundedEvents,
  loadSqliteSessionTranscriptEvents,
  loadSqliteSessionTranscriptTailEvents,
  mergeSqliteSessionTranscriptEvents,
  recordSqliteSessionTranscriptSnapshot,
  replaceSqliteSessionTranscriptEvents,
} from "./transcript-store.sqlite.js";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-transcript-"));
}

type TranscriptStoreTestDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "sessions" | "transcript_event_identities" | "transcript_events" | "transcript_snapshots"
>;

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("SQLite session transcript store", () => {
  it("appends transcript events with stable per-session sequence numbers", () => {
    const stateDir = createTempDir();

    expect(
      appendSqliteSessionTranscriptEvent({
        env: { OPENCLAW_STATE_DIR: stateDir },
        agentId: "Main",
        sessionId: "session-1",
        event: { type: "session", id: "session-1" },
        now: () => 100,
      }),
    ).toEqual({ seq: 0 });
    expect(
      appendSqliteSessionTranscriptEvent({
        env: { OPENCLAW_STATE_DIR: stateDir },
        agentId: "Main",
        sessionId: "session-1",
        event: { type: "message", id: "m1", message: { role: "assistant", content: "ok" } },
        now: () => 200,
      }),
    ).toEqual({ seq: 1 });

    expect(
      loadSqliteSessionTranscriptEvents({
        env: { OPENCLAW_STATE_DIR: stateDir },
        agentId: "main",
        sessionId: "session-1",
      }),
    ).toEqual([
      { seq: 0, createdAt: 100, event: { type: "session", id: "session-1" } },
      {
        seq: 1,
        createdAt: 200,
        event: { type: "message", id: "m1", message: { role: "assistant", content: "ok" } },
      },
    ]);
  });

  it("reads transcript events from an explicit agent database path", () => {
    const stateDir = createTempDir();
    const customPath = path.join(stateDir, "custom-agent.sqlite");
    const options = {
      path: customPath,
      env: { OPENCLAW_STATE_DIR: stateDir },
      agentId: "main",
      sessionId: "session-1",
    };

    appendSqliteSessionTranscriptEvent({
      ...options,
      event: { type: "session", id: "session-1" },
      now: () => 100,
    });

    expect(loadSqliteSessionTranscriptEvents(options)).toEqual([
      { seq: 0, createdAt: 100, event: { type: "session", id: "session-1" } },
    ]);
    expect(
      loadSqliteSessionTranscriptEvents({
        env: { OPENCLAW_STATE_DIR: stateDir },
        agentId: "main",
        sessionId: "session-1",
      }),
    ).toEqual([]);
  });

  it("dedupes message appends by SQLite idempotency identity", () => {
    const stateDir = createTempDir();
    const options = {
      env: { OPENCLAW_STATE_DIR: stateDir },
      agentId: "main",
      sessionId: "session-1",
      sessionVersion: 1,
      message: { role: "user", content: "hi", idempotencyKey: "idem-1" },
      now: () => 100,
    };

    const first = appendSqliteSessionTranscriptMessage(options);
    const second = appendSqliteSessionTranscriptMessage(options);

    expect(second.messageId).toBe(first.messageId);
    expect(
      loadSqliteSessionTranscriptEvents({
        env: { OPENCLAW_STATE_DIR: stateDir },
        agentId: "main",
        sessionId: "session-1",
      }).map((entry) => entry.event),
    ).toEqual([
      expect.objectContaining({ type: "session", id: "session-1" }),
      expect.objectContaining({
        type: "message",
        id: first.messageId,
        parentId: null,
        message: { role: "user", content: "hi", idempotencyKey: "idem-1" },
      }),
    ]);

    const database = openOpenClawAgentDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
      agentId: "main",
    });
    const db = getNodeSqliteKysely<TranscriptStoreTestDatabase>(database.db);
    const identityRows = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("transcript_event_identities")
        .select("message_idempotency_key")
        .where("session_id", "=", "session-1")
        .where("message_idempotency_key", "is not", null),
    ).rows;
    expect(identityRows).toEqual([{ message_idempotency_key: "idem-1" }]);
  });

  it("dedupes delivery mirrors against the latest assistant inside the append transaction", () => {
    const stateDir = createTempDir();
    const scope = {
      env: { OPENCLAW_STATE_DIR: stateDir },
      agentId: "main",
      sessionId: "session-1",
      sessionVersion: 1,
    };
    const first = appendSqliteSessionTranscriptMessage({
      ...scope,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Already delivered" }],
      },
      now: () => 100,
    });

    const duplicate = appendSqliteSessionTranscriptMessage({
      ...scope,
      dedupeLatestAssistantText: "Already delivered",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Already delivered" }],
      },
      now: () => 200,
    });

    expect(duplicate.messageId).toBe(first.messageId);
    const events = loadSqliteSessionTranscriptEvents({
      env: { OPENCLAW_STATE_DIR: stateDir },
      agentId: "main",
      sessionId: "session-1",
    }).map((entry) => entry.event);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      type: "message",
      id: first.messageId,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Already delivered" }],
      },
    });
  });

  it("does not dedupe delivery mirrors across newer non-text transcript events", () => {
    const stateDir = createTempDir();
    const scope = {
      env: { OPENCLAW_STATE_DIR: stateDir },
      agentId: "main",
      sessionId: "session-1",
      sessionVersion: 1,
    };
    const first = appendSqliteSessionTranscriptMessage({
      ...scope,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Already delivered" }],
      },
      now: () => 100,
    });
    appendSqliteSessionTranscriptMessage({
      ...scope,
      message: { role: "user", content: "new turn" },
      now: () => 150,
    });

    const mirror = appendSqliteSessionTranscriptMessage({
      ...scope,
      dedupeLatestAssistantText: "Already delivered",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Already delivered" }],
      },
      now: () => 200,
    });

    expect(mirror.messageId).not.toBe(first.messageId);
    const events = loadSqliteSessionTranscriptEvents({
      env: { OPENCLAW_STATE_DIR: stateDir },
      agentId: "main",
      sessionId: "session-1",
    }).map((entry) => entry.event);
    expect(events).toHaveLength(4);
    expect(events[3]).toMatchObject({
      type: "message",
      id: mirror.messageId,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Already delivered" }],
      },
    });
  });

  it("links transcript message parents inside the SQLite append transaction", () => {
    const stateDir = createTempDir();
    const first = appendSqliteSessionTranscriptMessage({
      env: { OPENCLAW_STATE_DIR: stateDir },
      agentId: "main",
      sessionId: "session-1",
      sessionVersion: 1,
      message: { role: "user", content: "one", idempotencyKey: "idem-1" },
      now: () => 100,
    });
    const second = appendSqliteSessionTranscriptMessage({
      env: { OPENCLAW_STATE_DIR: stateDir },
      agentId: "main",
      sessionId: "session-1",
      sessionVersion: 1,
      message: { role: "assistant", content: "two", idempotencyKey: "idem-2" },
      now: () => 200,
    });

    const events = loadSqliteSessionTranscriptEvents({
      env: { OPENCLAW_STATE_DIR: stateDir },
      agentId: "main",
      sessionId: "session-1",
    }).map((entry) => entry.event as { id?: string; parentId?: string | null });

    expect(events).toEqual([
      expect.objectContaining({ id: "session-1" }),
      expect.objectContaining({ id: first.messageId, parentId: null }),
      expect.objectContaining({ id: second.messageId, parentId: first.messageId }),
    ]);
  });

  it("links untyped transcript events when appending against the database tail", () => {
    const stateDir = createTempDir();
    const scope = {
      env: { OPENCLAW_STATE_DIR: stateDir },
      agentId: "main",
      sessionId: "session-1",
    };
    appendSqliteSessionTranscriptEvent({
      ...scope,
      event: { id: "first", parentId: null },
      parentMode: "database-tail",
      now: () => 100,
    });
    appendSqliteSessionTranscriptEvent({
      ...scope,
      event: { id: "second", parentId: null },
      parentMode: "database-tail",
      now: () => 200,
    });

    expect(
      loadSqliteSessionTranscriptEvents(scope).map(
        (entry) => entry.event as { id?: string; parentId?: string | null },
      ),
    ).toEqual([
      { id: "first", parentId: null },
      { id: "second", parentId: "first" },
    ]);
    expect(countSqliteSessionTranscriptDisplayMessages(scope)).toBe(0);
  });

  it("does not fingerprint-dedupe distinct nested tool call ids", () => {
    const stateDir = createTempDir();
    const scope = {
      env: { OPENCLAW_STATE_DIR: stateDir },
      agentId: "main",
      sessionId: "session-1",
    };

    expect(
      mergeSqliteSessionTranscriptEvents({
        ...scope,
        events: [
          { type: "session", id: "session-1" },
          {
            type: "message",
            id: "assistant-1",
            parentId: null,
            message: {
              role: "assistant",
              content: [{ type: "toolCall", id: "tool-call-1", name: "read" }],
            },
          },
        ],
      }),
    ).toEqual({ merged: 2, skipped: 0 });

    expect(
      mergeSqliteSessionTranscriptEvents({
        ...scope,
        events: [
          {
            type: "message",
            id: "assistant-2",
            parentId: "assistant-1",
            message: {
              role: "assistant",
              content: [{ type: "toolCall", id: "tool-call-2", name: "read" }],
            },
          },
        ],
      }),
    ).toEqual({ merged: 1, skipped: 0 });

    const messageIds = loadSqliteSessionTranscriptEvents(scope)
      .map((entry) => entry.event as { id?: string })
      .map((event) => event.id);
    expect(messageIds).toEqual(["session-1", "assistant-1", "assistant-2"]);
  });

  it("dedupes merge imports by existing message idempotency keys", () => {
    const stateDir = createTempDir();
    const scope = {
      env: { OPENCLAW_STATE_DIR: stateDir },
      agentId: "main",
      sessionId: "session-1",
    };
    replaceSqliteSessionTranscriptEvents({
      ...scope,
      events: [
        { type: "session", id: "session-1" },
        {
          type: "message",
          id: "existing-message",
          parentId: null,
          timestamp: "2026-04-25T00:00:01Z",
          message: {
            role: "user",
            content: "hello",
            idempotencyKey: "message-key-1",
          },
        },
      ],
    });

    expect(
      mergeSqliteSessionTranscriptEvents({
        ...scope,
        events: [
          {
            type: "message",
            id: "replayed-message",
            parentId: null,
            timestamp: "2026-04-25T00:00:02Z",
            message: {
              role: "user",
              content: "hello",
              idempotencyKey: "message-key-1",
            },
          },
        ],
      }),
    ).toEqual({ merged: 0, skipped: 1 });

    const messageIds = loadSqliteSessionTranscriptEvents(scope)
      .map((entry) => entry.event as { id?: string })
      .map((event) => event.id);
    expect(messageIds).toEqual(["session-1", "existing-message"]);
  });

  it("keeps repeated same-payload events from the same merge import", () => {
    const stateDir = createTempDir();
    const scope = {
      env: { OPENCLAW_STATE_DIR: stateDir },
      agentId: "main",
      sessionId: "session-1",
    };

    expect(
      mergeSqliteSessionTranscriptEvents({
        ...scope,
        events: [
          { type: "session", id: "session-1" },
          {
            type: "message",
            id: "same-1",
            parentId: null,
            message: { role: "user", content: "same" },
          },
          {
            type: "message",
            id: "same-2",
            parentId: "same-1",
            message: { role: "user", content: "same" },
          },
        ],
      }),
    ).toEqual({ merged: 3, skipped: 0 });

    const messageIds = loadSqliteSessionTranscriptEvents(scope)
      .map((entry) => entry.event as { id?: string })
      .map((event) => event.id);
    expect(messageIds).toEqual(["session-1", "same-1", "same-2"]);
  });

  it("keeps repeated same-payload replay events after an id match", () => {
    const stateDir = createTempDir();
    const scope = {
      env: { OPENCLAW_STATE_DIR: stateDir },
      agentId: "main",
      sessionId: "session-1",
    };
    replaceSqliteSessionTranscriptEvents({
      ...scope,
      events: [
        { type: "session", id: "session-1" },
        {
          type: "message",
          id: "same-1",
          parentId: null,
          message: { role: "user", content: "same" },
        },
      ],
    });

    expect(
      mergeSqliteSessionTranscriptEvents({
        ...scope,
        events: [
          {
            type: "message",
            id: "same-1",
            parentId: null,
            message: { role: "user", content: "same" },
          },
          {
            type: "message",
            id: "same-2",
            parentId: "same-1",
            message: { role: "user", content: "same" },
          },
        ],
      }),
    ).toEqual({ merged: 1, skipped: 1 });

    const messageIds = loadSqliteSessionTranscriptEvents(scope)
      .map((entry) => entry.event as { id?: string })
      .map((event) => event.id);
    expect(messageIds).toEqual(["session-1", "same-1", "same-2"]);
  });

  it("does not move session roots backwards during stale merge imports", () => {
    const stateDir = createTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const scope = { env, agentId: "main", sessionId: "session-1" };
    appendSqliteSessionTranscriptEvent({
      ...scope,
      event: { type: "session", id: "session-1" },
      now: () => 200,
    });

    expect(
      mergeSqliteSessionTranscriptEvents({
        ...scope,
        events: [
          {
            type: "message",
            id: "legacy",
            timestamp: "1970-01-01T00:00:00.100Z",
            message: { role: "user", content: "old" },
          },
        ],
      }),
    ).toEqual({ merged: 0, skipped: 1 });

    const agentDatabase = openOpenClawAgentDatabase({ env, agentId: "main" });
    const db = getNodeSqliteKysely<TranscriptStoreTestDatabase>(agentDatabase.db);
    expect(
      executeSqliteQueryTakeFirstSync(
        agentDatabase.db,
        db.selectFrom("sessions").select(["updated_at"]).where("session_id", "=", "session-1"),
      ),
    ).toEqual({ updated_at: 200 });
  });

  it("skips new stale merge events to preserve the existing transcript tail", () => {
    const stateDir = createTempDir();
    const scope = {
      env: { OPENCLAW_STATE_DIR: stateDir },
      agentId: "main",
      sessionId: "session-1",
    };
    appendSqliteSessionTranscriptEvent({
      ...scope,
      event: { type: "session", id: "session-1" },
      now: () => 100,
    });
    appendSqliteSessionTranscriptEvent({
      ...scope,
      event: {
        type: "message",
        id: "live-tail",
        parentId: null,
        message: { role: "assistant", content: "live" },
      },
      now: () => 200,
    });

    expect(
      mergeSqliteSessionTranscriptEvents({
        ...scope,
        events: [
          {
            type: "message",
            id: "stale-branch",
            timestamp: "1970-01-01T00:00:00.050Z",
            message: { role: "user", content: "old" },
          },
        ],
      }),
    ).toEqual({ merged: 0, skipped: 1 });

    const ids = loadSqliteSessionTranscriptEvents(scope)
      .map((entry) => entry.event as { id?: string })
      .map((event) => event.id);
    expect(ids).toEqual(["session-1", "live-tail"]);
  });

  it("counts only displayable entries on parent-linked transcript branches", () => {
    const stateDir = createTempDir();
    const scope = {
      env: { OPENCLAW_STATE_DIR: stateDir },
      agentId: "main",
      sessionId: "session-1",
    };
    replaceSqliteSessionTranscriptEvents({
      ...scope,
      events: [
        { type: "session", id: "session-1" },
        {
          type: "message",
          id: "m1",
          parentId: null,
          message: { role: "user", content: "one" },
        },
        {
          type: "thinking_level_change",
          id: "thinking",
          parentId: "m1",
          thinkingLevel: "high",
        },
        {
          type: "model_change",
          id: "model",
          parentId: "thinking",
          provider: "openai",
          modelId: "gpt-5.5",
        },
        {
          type: "compaction",
          id: "compact",
          parentId: "model",
          summary: "summary",
          firstKeptEntryId: "m1",
          tokensBefore: 123,
        },
        {
          type: "session_info",
          id: "name",
          parentId: "compact",
          name: "Session",
        },
        {
          type: "message",
          id: "m2",
          parentId: "name",
          message: { role: "assistant", content: "two" },
        },
      ],
      now: () => 100,
    });

    expect(countSqliteSessionTranscriptDisplayMessages(scope)).toBe(3);
  });

  it("keeps transcript events isolated by agent id", () => {
    const stateDir = createTempDir();

    appendSqliteSessionTranscriptEvent({
      env: { OPENCLAW_STATE_DIR: stateDir },
      agentId: "main",
      sessionId: "shared-session",
      event: { type: "message", id: "main" },
    });
    appendSqliteSessionTranscriptEvent({
      env: { OPENCLAW_STATE_DIR: stateDir },
      agentId: "ops",
      sessionId: "shared-session",
      event: { type: "message", id: "ops" },
    });

    expect(
      loadSqliteSessionTranscriptEvents({
        env: { OPENCLAW_STATE_DIR: stateDir },
        agentId: "main",
        sessionId: "shared-session",
      }).map((entry) => entry.event),
    ).toEqual([{ type: "message", id: "main" }]);
  });

  it("reads bounded transcript tails without materializing older rows", () => {
    const stateDir = createTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    replaceSqliteSessionTranscriptEvents({
      env,
      agentId: "main",
      sessionId: "session-1",
      events: [
        { type: "session", id: "session-1" },
        ...Array.from({ length: 8 }, (_, index) => ({
          type: "message",
          id: `m${index}`,
          parentId: index === 0 ? null : `m${index - 1}`,
          message: { role: "user", content: `message ${index}` },
        })),
      ],
      now: () => 100,
    });

    expect(
      loadSqliteSessionTranscriptTailEvents({
        env,
        agentId: "main",
        sessionId: "session-1",
        maxEvents: 3,
      }).map((entry) => (entry.event as { id?: string }).id),
    ).toEqual(["m5", "m6", "m7"]);
    expect(
      countSqliteSessionTranscriptDisplayMessages({
        env,
        agentId: "main",
        sessionId: "session-1",
      }),
    ).toBe(8);
  });

  it("reads bounded transcript heads without materializing rows beyond caps", () => {
    const stateDir = createTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    replaceSqliteSessionTranscriptEvents({
      env,
      agentId: "main",
      sessionId: "session-1",
      events: [
        { type: "session", id: "session-1" },
        { type: "message", id: "m1", message: { role: "assistant", content: "short" } },
        {
          type: "message",
          id: "m2",
          message: { role: "assistant", content: "this row should not be parsed" },
        },
      ],
      now: () => 100,
    });

    expect(
      loadSqliteSessionTranscriptBoundedEvents({
        env,
        agentId: "main",
        sessionId: "session-1",
        maxEvents: 2,
        maxBytes: 120,
      }).map((entry) => (entry.event as { id?: string }).id),
    ).toEqual(["session-1", "m1"]);
    expect(
      loadSqliteSessionTranscriptBoundedEvents({
        env,
        agentId: "main",
        sessionId: "session-1",
        maxEvents: 3,
        maxBytes: 8,
      }),
    ).toEqual([]);
  });

  it("preserves event timestamps when replacing transcript rows", () => {
    const stateDir = createTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const sessionStartedAt = Date.parse("2026-02-05T10:00:00.000Z");
    const lastMessageAt = Date.parse("2026-02-05T10:05:00.000Z");

    replaceSqliteSessionTranscriptEvents({
      env,
      agentId: "main",
      sessionId: "session-1",
      events: [
        {
          type: "session",
          id: "session-1",
        },
        {
          type: "message",
          id: "m1",
          timestamp: "2026-02-05T10:00:00.000Z",
          message: { role: "user", content: "hi" },
        },
        {
          type: "message",
          id: "m2",
          timestamp: "2026-02-05T10:05:00.000Z",
          message: { role: "assistant", content: "ok" },
        },
      ],
      now: () => Date.parse("2026-02-10T00:00:00.000Z"),
    });

    expect(
      loadSqliteSessionTranscriptEvents({
        env,
        agentId: "main",
        sessionId: "session-1",
      }).map((entry) => entry.createdAt),
    ).toEqual([sessionStartedAt, sessionStartedAt, lastMessageAt]);
    expect(listSqliteSessionTranscripts({ env, agentId: "main" })[0]?.updatedAt).toBe(
      lastMessageAt,
    );
  });

  it("lists SQLite transcript scopes", () => {
    const stateDir = createTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };

    appendSqliteSessionTranscriptEvent({
      env,
      agentId: "main",
      sessionId: "session-1",
      event: { type: "message", id: "older" },
      now: () => 100,
    });
    appendSqliteSessionTranscriptEvent({
      env,
      agentId: "main",
      sessionId: "session-1",
      event: { type: "message", id: "newer" },
      now: () => 200,
    });

    expect(listSqliteSessionTranscripts({ env, agentId: "main" })).toEqual([
      {
        agentId: "main",
        sessionId: "session-1",
        updatedAt: 200,
        eventCount: 2,
      },
    ]);
  });

  it("lists registered transcript scopes with their source database path", () => {
    const stateDir = createTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const customPath = path.join(stateDir, "custom-agent.sqlite");

    appendSqliteSessionTranscriptEvent({
      env,
      path: customPath,
      agentId: "worker-1",
      sessionId: "session-1",
      event: { type: "message", id: "m1" },
      now: () => 100,
    });

    expect(listSqliteSessionTranscripts({ env })).toEqual([
      {
        agentId: "worker-1",
        path: customPath,
        sessionId: "session-1",
        updatedAt: 100,
        eventCount: 1,
      },
    ]);
  });

  it("preserves an explicit transcript database path when listing by agent", () => {
    const stateDir = createTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const customPath = path.join(stateDir, "custom-agent.sqlite");

    appendSqliteSessionTranscriptEvent({
      env,
      path: customPath,
      agentId: "worker-1",
      sessionId: "session-1",
      event: { type: "message", id: "m1" },
      now: () => 100,
    });

    const [scope] = listSqliteSessionTranscripts({
      env,
      path: customPath,
      agentId: "worker-1",
    });

    expect(scope).toEqual({
      agentId: "worker-1",
      path: customPath,
      sessionId: "session-1",
      updatedAt: 100,
      eventCount: 1,
    });
    expect(
      scope ? loadSqliteSessionTranscriptEvents(scope).map((entry) => entry.event) : [],
    ).toEqual([{ type: "message", id: "m1" }]);
  });

  it("includes registered custom transcript paths when listing by agent", () => {
    const stateDir = createTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const customPath = path.join(stateDir, "custom-agent.sqlite");
    const otherPath = path.join(stateDir, "other-agent.sqlite");

    appendSqliteSessionTranscriptEvent({
      env,
      agentId: "worker-1",
      sessionId: "default-session",
      event: { type: "message", id: "default" },
      now: () => 100,
    });
    appendSqliteSessionTranscriptEvent({
      env,
      path: customPath,
      agentId: "worker-1",
      sessionId: "custom-session",
      event: { type: "message", id: "custom" },
      now: () => 200,
    });
    appendSqliteSessionTranscriptEvent({
      env,
      path: otherPath,
      agentId: "worker-2",
      sessionId: "other-session",
      event: { type: "message", id: "other" },
      now: () => 300,
    });

    expect(listSqliteSessionTranscripts({ env, agentId: "worker-1" })).toEqual([
      {
        agentId: "worker-1",
        path: customPath,
        sessionId: "custom-session",
        updatedAt: 200,
        eventCount: 1,
      },
      {
        agentId: "worker-1",
        sessionId: "default-session",
        updatedAt: 100,
        eventCount: 1,
      },
    ]);
  });

  it("deletes transcript snapshots with the transcript", () => {
    const stateDir = createTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };

    appendSqliteSessionTranscriptEvent({
      env,
      agentId: "main",
      sessionId: "session-1",
      event: { type: "session", id: "session-1" },
    });
    recordSqliteSessionTranscriptSnapshot({
      env,
      agentId: "main",
      sessionId: "session-1",
      snapshotId: "snapshot-1",
      reason: "compaction",
      eventCount: 1,
    });

    expect(deleteSqliteSessionTranscript({ env, agentId: "main", sessionId: "session-1" })).toBe(
      true,
    );

    const agentDatabase = openOpenClawAgentDatabase({ env, agentId: "main" });
    const db = getNodeSqliteKysely<TranscriptStoreTestDatabase>(agentDatabase.db);
    expect(
      executeSqliteQueryTakeFirstSync(
        agentDatabase.db,
        db.selectFrom("transcript_snapshots").select((eb) => eb.fn.countAll<number>().as("count")),
      ),
    ).toEqual({ count: 0 });
  });

  it("anchors transcript rows to the canonical session root", () => {
    const stateDir = createTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };

    appendSqliteSessionTranscriptEvent({
      env,
      agentId: "main",
      sessionId: "session-1",
      event: { type: "session", id: "session-1" },
      now: () => 100,
    });
    recordSqliteSessionTranscriptSnapshot({
      env,
      agentId: "main",
      sessionId: "session-1",
      snapshotId: "snapshot-1",
      reason: "compaction",
      eventCount: 1,
      createdAt: 200,
    });

    const agentDatabase = openOpenClawAgentDatabase({ env, agentId: "main" });
    const db = getNodeSqliteKysely<TranscriptStoreTestDatabase>(agentDatabase.db);
    expect(
      executeSqliteQuerySync(
        agentDatabase.db,
        db.selectFrom("sessions").select(["session_id", "updated_at"]),
      ).rows,
    ).toEqual([{ session_id: "session-1", updated_at: 200 }]);

    executeSqliteQuerySync(
      agentDatabase.db,
      db.deleteFrom("sessions").where("session_id", "=", "session-1"),
    );

    expect(
      executeSqliteQueryTakeFirstSync(
        agentDatabase.db,
        db.selectFrom("transcript_events").select((eb) => eb.fn.countAll<number>().as("count")),
      ),
    ).toEqual({ count: 0 });
    expect(
      executeSqliteQueryTakeFirstSync(
        agentDatabase.db,
        db.selectFrom("transcript_snapshots").select((eb) => eb.fn.countAll<number>().as("count")),
      ),
    ).toEqual({ count: 0 });
  });
});

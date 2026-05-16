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
  loadSqliteSessionTranscriptEvents,
  loadSqliteSessionTranscriptTailEvents,
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

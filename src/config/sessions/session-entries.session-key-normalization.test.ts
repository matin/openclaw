import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MsgContext } from "../../auto-reply/templating.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import { recordSessionMetaFromInbound, updateLastRoute } from "../sessions.js";
import { listSessionEntries, patchSessionEntry, upsertSessionEntry } from "./store.js";
import type { SessionEntry } from "./types.js";

const CANONICAL_KEY = "agent:main:webchat:dm:mixed-user";
const MIXED_CASE_KEY = "Agent:Main:WebChat:DM:MiXeD-User";
const SIGNAL_GROUP_KEY = "agent:main:signal:group:AbC123Opaque";
type SessionEntriesTestDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "session_entries" | "session_routes" | "sessions"
>;

function createInboundContext(): MsgContext {
  return {
    Provider: "webchat",
    Surface: "webchat",
    ChatType: "direct",
    From: "WebChat:User-1",
    To: "webchat:agent",
    SessionKey: MIXED_CASE_KEY,
    OriginatingTo: "webchat:user-1",
  };
}

describe("SQLite session row key normalization", () => {
  const suiteRootTracker = createSuiteTempRootTracker({
    prefix: "openclaw-session-key-normalize-",
  });
  let tempDir = "";
  let previousStateDir: string | undefined;

  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  beforeEach(async () => {
    tempDir = await suiteRootTracker.make("case");
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tempDir;
  });

  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  });

  afterAll(async () => {
    await suiteRootTracker.cleanup();
  });

  function readMainSessionRows(): Record<string, SessionEntry> {
    return Object.fromEntries(
      listSessionEntries({ agentId: "main" }).map(({ sessionKey, entry }) => [sessionKey, entry]),
    );
  }

  function seedRawSessionEntry(sessionKey: string, entry: SessionEntry): void {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const db = getNodeSqliteKysely<SessionEntriesTestDatabase>(database.db);
    const updatedAt = entry.updatedAt ?? Date.now();
    executeSqliteQuerySync(
      database.db,
      db
        .insertInto("sessions")
        .values({
          session_id: entry.sessionId,
          session_key: sessionKey,
          created_at: updatedAt,
          updated_at: updatedAt,
        })
        .onConflict((conflict) =>
          conflict.column("session_id").doUpdateSet({
            session_key: (eb) => eb.ref("excluded.session_key"),
            updated_at: (eb) => eb.ref("excluded.updated_at"),
          }),
        ),
    );
    executeSqliteQuerySync(
      database.db,
      db.insertInto("session_entries").values({
        session_key: sessionKey,
        session_id: entry.sessionId,
        entry_json: JSON.stringify(entry),
        updated_at: updatedAt,
      }),
    );
    executeSqliteQuerySync(
      database.db,
      db.insertInto("session_routes").values({
        session_key: sessionKey,
        session_id: entry.sessionId,
        updated_at: updatedAt,
      }),
    );
  }

  it("records inbound metadata under a canonical lowercase key", async () => {
    await recordSessionMetaFromInbound({
      agentId: "main",
      sessionKey: MIXED_CASE_KEY,
      ctx: createInboundContext(),
    });

    const store = readMainSessionRows();
    expect(Object.keys(store)).toEqual([CANONICAL_KEY]);
    expect(store[CANONICAL_KEY]).toMatchObject({
      channel: "webchat",
      chatType: "direct",
    });
  });

  it("does not create a duplicate mixed-case key when route metadata is updated", async () => {
    await recordSessionMetaFromInbound({
      agentId: "main",
      sessionKey: CANONICAL_KEY,
      ctx: createInboundContext(),
    });

    await updateLastRoute({
      agentId: "main",
      sessionKey: MIXED_CASE_KEY,
      channel: "webchat",
      to: "webchat:user-1",
    });

    const store = readMainSessionRows();
    expect(Object.keys(store)).toEqual([CANONICAL_KEY]);
    expect(store[CANONICAL_KEY]?.channel).toBe("webchat");
    expect(store[CANONICAL_KEY]?.deliveryContext).toMatchObject({
      channel: "webchat",
      to: "webchat:user-1",
    });
  });

  it("patches canonical rows when callers pass accepted mixed-case keys", async () => {
    upsertSessionEntry({
      agentId: "main",
      sessionKey: CANONICAL_KEY,
      entry: {
        sessionId: "existing-session",
        updatedAt: 100,
        chatType: "direct",
        channel: "webchat",
      },
    });

    await patchSessionEntry({
      agentId: "main",
      sessionKey: MIXED_CASE_KEY,
      update: () => ({ updatedAt: 200, modelOverride: "gpt-5.5" }),
    });

    const store = readMainSessionRows();
    expect(Object.keys(store)).toEqual([CANONICAL_KEY]);
    expect(store[CANONICAL_KEY]).toMatchObject({
      sessionId: "existing-session",
      modelOverride: "gpt-5.5",
    });
    expect(store[CANONICAL_KEY]?.updatedAt).toBeGreaterThan(100);
  });

  it("patches and migrates legacy direct mixed-case rows", async () => {
    seedRawSessionEntry(MIXED_CASE_KEY, {
      sessionId: "legacy-session",
      updatedAt: 1,
      chatType: "direct",
      channel: "webchat",
    });

    await patchSessionEntry({
      agentId: "main",
      sessionKey: MIXED_CASE_KEY,
      update: () => ({ updatedAt: 200, modelOverride: "gpt-5.5" }),
    });

    const store = readMainSessionRows();
    expect(Object.keys(store)).toEqual([CANONICAL_KEY]);
    expect(store[CANONICAL_KEY]).toMatchObject({
      sessionId: "legacy-session",
      modelOverride: "gpt-5.5",
    });
  });

  it("preserves case-sensitive Signal group IDs while patching rows", async () => {
    upsertSessionEntry({
      agentId: "main",
      sessionKey: SIGNAL_GROUP_KEY,
      entry: {
        sessionId: "signal-group-session",
        updatedAt: 100,
        chatType: "group",
        channel: "signal",
        deliveryContext: {
          channel: "signal",
          to: "AbC123Opaque",
          chatType: "group",
        },
      },
    });

    await patchSessionEntry({
      agentId: "main",
      sessionKey: "Agent:MAIN:Signal:Group:AbC123Opaque",
      update: () => ({ updatedAt: 200, modelOverride: "gpt-5.5" }),
    });

    const store = readMainSessionRows();
    expect(Object.keys(store)).toEqual([SIGNAL_GROUP_KEY]);
    expect(store[SIGNAL_GROUP_KEY]).toMatchObject({
      sessionId: "signal-group-session",
      modelOverride: "gpt-5.5",
      deliveryContext: {
        channel: "signal",
        to: "AbC123Opaque",
      },
    });
  });

  it("does not migrate legacy mixed-case entries during runtime updates", async () => {
    seedRawSessionEntry(MIXED_CASE_KEY, {
      sessionId: "legacy-session",
      updatedAt: 1,
      chatType: "direct",
      channel: "webchat",
    });

    await updateLastRoute({
      agentId: "main",
      sessionKey: CANONICAL_KEY,
      channel: "webchat",
      to: "webchat:user-2",
    });

    const store = readMainSessionRows();
    expect(store[CANONICAL_KEY]?.sessionId).not.toBe("legacy-session");
    expect(store[MIXED_CASE_KEY]?.sessionId).toBe("legacy-session");
  });

  it("preserves updatedAt when recording inbound metadata for an existing session", async () => {
    const existingUpdatedAt = Date.now();
    upsertSessionEntry({
      agentId: "main",
      sessionKey: CANONICAL_KEY,
      entry: {
        sessionId: "existing-session",
        updatedAt: existingUpdatedAt,
        chatType: "direct",
        channel: "webchat",
      },
    });

    await recordSessionMetaFromInbound({
      agentId: "main",
      sessionKey: CANONICAL_KEY,
      ctx: createInboundContext(),
    });

    const store = readMainSessionRows();
    expect(store[CANONICAL_KEY]?.sessionId).toBe("existing-session");
    expect(store[CANONICAL_KEY]?.updatedAt).toBe(existingUpdatedAt);
    expect(store[CANONICAL_KEY]).toMatchObject({
      channel: "webchat",
      chatType: "direct",
    });
  });
});

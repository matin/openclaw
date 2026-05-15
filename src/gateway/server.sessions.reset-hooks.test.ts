import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { getSessionEntry, upsertSessionEntry } from "../config/sessions.js";
import { replaceSqliteSessionTranscriptEvents } from "../config/sessions/transcript-store.sqlite.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { embeddedRunMock, seedGatewaySessionEntries, testState } from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  bootstrapCacheMocks,
  sessionHookMocks,
  beforeResetHookMocks,
  sessionLifecycleHookMocks,
  beforeResetHookState,
  browserSessionTabMocks,
  seedSqliteSessionTranscript,
  sessionStoreEntry,
  expectActiveRunCleanup,
  directSessionReq,
} from "./test/server-sessions.test-helpers.js";

const { seedActiveMainSession } = setupGatewaySessionsTestHarness();
const legacySessionFileProperty = ["session", "File"].join("");

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

type HookEventRecord = Record<string, unknown> & {
  context?: Record<string, unknown> & {
    previousSessionEntry?: { sessionId?: string };
  };
  messages?: Array<{ role?: string; content?: unknown }>;
};

function expectMainHookContext(context: HookEventRecord, sessionId: string) {
  expect(context.agentId).toBe("main");
  expect(context.sessionKey).toBe("agent:main:main");
  expect(context.sessionId).toBe(sessionId);
}

test("sessions.reset emits internal command hook with reason", async () => {
  await seedSqliteSessionTranscript("sess-main", "hello");

  await seedGatewaySessionEntries({
    entries: {
      main: sessionStoreEntry("sess-main"),
    },
  });

  const reset = await directSessionReq<{ ok: true; key: string }>("sessions.reset", {
    key: "main",
    reason: "new",
  });
  expect(reset.ok).toBe(true);
  const resetHookEvents = (
    sessionHookMocks.triggerInternalHook.mock.calls as unknown as Array<[unknown]>
  )
    .map((call) => call[0])
    .filter(
      (
        event,
      ): event is {
        type: string;
        action: string;
        context?: { previousSessionEntry?: unknown };
      } =>
        Boolean(event) &&
        typeof event === "object" &&
        (event as { type?: unknown }).type === "command" &&
        (event as { action?: unknown }).action === "new",
    );
  expect(resetHookEvents).toHaveLength(1);
  const event = resetHookEvents[0];
  if (!event) {
    throw new Error("expected session hook event");
  }
  expect(event).toMatchObject({
    type: "command",
    action: "new",
    sessionKey: "agent:main:main",
    context: {
      commandSource: "gateway:sessions.reset",
    },
  });
  expect(event.context?.previousSessionEntry).toMatchObject({ sessionId: "sess-main" });
});

test("sessions.reset emits before_reset hook with transcript context", async () => {
  replaceSqliteSessionTranscriptEvents({
    agentId: "main",
    sessionId: "sess-main",
    events: [
      {
        type: "message",
        id: "m1",
        message: { role: "user", content: "hello from transcript" },
      },
    ],
  });

  await seedGatewaySessionEntries({
    entries: {
      main: {
        sessionId: "sess-main",
        updatedAt: Date.now(),
      },
    },
  });

  beforeResetHookState.hasBeforeResetHook = true;

  const reset = await directSessionReq<{ ok: true; key: string }>("sessions.reset", {
    key: "main",
    reason: "new",
  });
  expect(reset.ok).toBe(true);
  expect(beforeResetHookMocks.runBeforeReset).toHaveBeenCalledTimes(1);
  const [event, context] = (
    beforeResetHookMocks.runBeforeReset.mock.calls as unknown as Array<[unknown, unknown]>
  )[0] ?? [undefined, undefined];
  expect(event).toMatchObject({
    reason: "new",
    messages: [
      {
        role: "user",
        content: "hello from transcript",
      },
    ],
  });
  expect(context).toMatchObject({
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: "sess-main",
  });
});

test("sessions.reset writes relocated registered session databases", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reset-db-"));
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  try {
    process.env.OPENCLAW_STATE_DIR = path.join(root, "state");
    const databasePath = path.join(root, "relocated", "work.sqlite");
    openOpenClawAgentDatabase({ agentId: "work", path: databasePath });
    setRuntimeConfigSnapshot({
      agents: {
        list: [{ id: "work", default: true }],
      },
      session: { mainKey: "main" },
    });
    upsertSessionEntry({
      agentId: "work",
      path: databasePath,
      sessionKey: "agent:work:task",
      entry: {
        sessionId: "sess-old",
        updatedAt: Date.now(),
        modelProvider: "openai",
        model: "gpt-5.5",
      },
    });

    const { performGatewaySessionReset } = await import("./session-reset-service.js");
    const reset = await performGatewaySessionReset({
      key: "agent:work:task",
      reason: "new",
      commandSource: "gateway:sessions.reset",
    });

    expect(reset.ok).toBe(true);
    const relocatedEntry = getSessionEntry({
      agentId: "work",
      path: databasePath,
      sessionKey: "agent:work:task",
    });
    expect(relocatedEntry?.sessionId).toBe(reset.ok ? reset.entry.sessionId : undefined);
    expect(relocatedEntry?.sessionId).not.toBe("sess-old");
    expect(
      getSessionEntry({
        agentId: "work",
        sessionKey: "agent:work:task",
      }),
    ).toBeUndefined();
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sessions.reset emits before_reset hook with scoped SQLite transcript context", async () => {
  replaceSqliteSessionTranscriptEvents({
    agentId: "main",
    sessionId: "sess-main-sqlite",
    events: [
      {
        type: "message",
        id: "m1",
        message: { role: "user", content: "hello from sqlite transcript" },
      },
    ],
  });

  await seedGatewaySessionEntries({
    entries: {
      main: {
        sessionId: "sess-main-sqlite",
        updatedAt: Date.now(),
      },
    },
  });

  beforeResetHookState.hasBeforeResetHook = true;

  const reset = await directSessionReq<{ ok: true; key: string }>("sessions.reset", {
    key: "main",
    reason: "new",
  });
  expect(reset.ok).toBe(true);
  expect(beforeResetHookMocks.runBeforeReset).toHaveBeenCalledTimes(1);
  const [event, context] = (
    beforeResetHookMocks.runBeforeReset.mock.calls as unknown as Array<[unknown, unknown]>
  )[0] ?? [undefined, undefined];
  expect(event).toMatchObject({
    reason: "new",
    messages: [
      {
        role: "user",
        content: "hello from sqlite transcript",
      },
    ],
  });
  expect(context).toMatchObject({
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: "sess-main-sqlite",
  });
});

test("sessions.reset emits enriched session_end and session_start hooks", async () => {
  replaceSqliteSessionTranscriptEvents({
    agentId: "main",
    sessionId: "sess-main",
    events: [
      {
        type: "message",
        id: "m1",
        message: { role: "user", content: "hello from transcript" },
      },
    ],
  });

  await seedGatewaySessionEntries({
    entries: {
      main: {
        sessionId: "sess-main",
        updatedAt: Date.now(),
      },
    },
  });

  const reset = await directSessionReq<{ ok: true; key: string }>("sessions.reset", {
    key: "main",
    reason: "new",
  });
  expect(reset.ok).toBe(true);
  expect(sessionLifecycleHookMocks.runSessionEnd).toHaveBeenCalledTimes(1);
  expect(sessionLifecycleHookMocks.runSessionStart).toHaveBeenCalledTimes(1);

  const [endEvent, endContext] = (
    sessionLifecycleHookMocks.runSessionEnd.mock.calls as unknown as Array<
      [HookEventRecord, HookEventRecord]
    >
  )[0] ?? [{}, {}];
  const [startEvent, startContext] = (
    sessionLifecycleHookMocks.runSessionStart.mock.calls as unknown as Array<
      [HookEventRecord, HookEventRecord]
    >
  )[0] ?? [{}, {}];

  expect(endEvent.sessionId).toBe("sess-main");
  expect(endEvent.sessionKey).toBe("agent:main:main");
  expect(endEvent.reason).toBe("new");
  expect(endEvent).not.toHaveProperty(legacySessionFileProperty);
  expect(endEvent).not.toHaveProperty("transcriptArchived");
  expect(endEvent.nextSessionId).toBe(startEvent.sessionId);
  expectMainHookContext(endContext, "sess-main");
  expect(startEvent.sessionKey).toBe("agent:main:main");
  expect(startEvent.resumedFrom).toBe("sess-main");
  expect(startContext.sessionId).toBe(startEvent.sessionId);
  expect(startContext.sessionKey).toBe("agent:main:main");
  expect(startContext.agentId).toBe("main");
});

test("sessions.reset returns unavailable when active run does not stop", async () => {
  await seedActiveMainSession();
  const waitCallCountAtSnapshotClear: number[] = [];
  bootstrapCacheMocks.clearBootstrapSnapshot.mockImplementation(() => {
    waitCallCountAtSnapshotClear.push(embeddedRunMock.waitCalls.length);
  });

  beforeResetHookState.hasBeforeResetHook = true;
  embeddedRunMock.activeIds.add("sess-main");
  embeddedRunMock.waitResults.set("sess-main", false);

  const reset = await directSessionReq("sessions.reset", {
    key: "main",
  });
  expect(reset.ok).toBe(false);
  expect(reset.error?.code).toBe("UNAVAILABLE");
  expect(reset.error?.message ?? "").toMatch(/still active/i);
  expectActiveRunCleanup("agent:main:main", ["agent:main:main", "sess-main"], "sess-main");
  expect(beforeResetHookMocks.runBeforeReset).not.toHaveBeenCalled();
  expect(waitCallCountAtSnapshotClear).toEqual([1]);
  expect(browserSessionTabMocks.closeTrackedBrowserTabsForSessions).not.toHaveBeenCalled();

  expect(getSessionEntry({ agentId: "main", sessionKey: "agent:main:main" })?.sessionId).toBe(
    "sess-main",
  );
});

test("sessions.reset emits before_reset for the entry actually reset in the SQLite patch", async () => {
  replaceSqliteSessionTranscriptEvents({
    agentId: "main",
    sessionId: "sess-old",
    events: [
      {
        type: "message",
        id: "m-old",
        message: { role: "user", content: "old transcript" },
      },
    ],
  });
  replaceSqliteSessionTranscriptEvents({
    agentId: "main",
    sessionId: "sess-new",
    events: [
      {
        type: "message",
        id: "m-new",
        message: { role: "user", content: "new transcript" },
      },
    ],
  });

  await seedGatewaySessionEntries({
    entries: {
      main: {
        sessionId: "sess-old",
        updatedAt: Date.now(),
      },
    },
  });

  beforeResetHookState.hasBeforeResetHook = true;
  const { performGatewaySessionReset } = await import("./session-reset-service.js");
  upsertSessionEntry({
    agentId: "main",
    sessionKey: "agent:main:main",
    entry: sessionStoreEntry("sess-new", {}),
  });

  const reset = await performGatewaySessionReset({
    key: "main",
    reason: "new",
    commandSource: "gateway:sessions.reset",
  });
  expect(reset.ok).toBe(true);
  const internalEvent = (
    sessionHookMocks.triggerInternalHook.mock.calls as unknown as Array<[unknown]>
  )[0]?.[0] as { context?: { previousSessionEntry?: { sessionId?: string } } } | undefined;
  expect(internalEvent?.context?.previousSessionEntry?.sessionId).toBe("sess-new");
  expect(beforeResetHookMocks.runBeforeReset).toHaveBeenCalledTimes(1);
  const [event, context] = (
    beforeResetHookMocks.runBeforeReset.mock.calls as unknown as Array<[unknown, unknown]>
  )[0] ?? [undefined, undefined];
  expect(event).toMatchObject({
    reason: "new",
    messages: [
      {
        role: "user",
        content: "new transcript",
      },
    ],
  });
  expect(context).toMatchObject({
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: "sess-new",
  });
});

test("sessions.create with emitCommandHooks=true fires command:new hook against parent (#76957)", async () => {
  await seedSqliteSessionTranscript("sess-parent", "hello from parent");

  await seedGatewaySessionEntries({
    entries: {
      main: sessionStoreEntry("sess-parent"),
    },
  });

  const result = await directSessionReq<{ ok: boolean; key: string }>("sessions.create", {
    parentSessionKey: "main",
    emitCommandHooks: true,
  });
  expect(result.ok).toBe(true);

  const commandNewEvents = (
    sessionHookMocks.triggerInternalHook.mock.calls as unknown as Array<[unknown]>
  )
    .map((call) => call[0])
    .filter(
      (event): event is { type: string; action: string; context?: { commandSource?: string } } =>
        Boolean(event) &&
        typeof event === "object" &&
        (event as { type?: unknown }).type === "command" &&
        (event as { action?: unknown }).action === "new",
    );
  expect(commandNewEvents).toHaveLength(1);
  expect(commandNewEvents[0]).toMatchObject({
    type: "command",
    action: "new",
    context: { commandSource: "webchat" },
  });
});

test("sessions.create with emitCommandHooks=true emits reset lifecycle hooks against parent (#76957)", async () => {
  replaceSqliteSessionTranscriptEvents({
    agentId: "main",
    sessionId: "sess-parent-hooks",
    events: [
      {
        type: "message",
        id: "m1",
        message: { role: "user", content: "remember this before new" },
      },
    ],
  });

  await seedGatewaySessionEntries({
    entries: {
      main: {
        sessionId: "sess-parent-hooks",
        updatedAt: Date.now(),
      },
    },
  });

  beforeResetHookState.hasBeforeResetHook = true;

  const result = await directSessionReq<{ ok: boolean; key: string }>("sessions.create", {
    parentSessionKey: "main",
    emitCommandHooks: true,
  });
  expect(result.ok).toBe(true);

  expect(beforeResetHookMocks.runBeforeReset).toHaveBeenCalledTimes(1);
  const [beforeResetEvent, beforeResetContext] = (
    beforeResetHookMocks.runBeforeReset.mock.calls as unknown as Array<[unknown, unknown]>
  )[0] ?? [undefined, undefined];
  expect(beforeResetEvent).toMatchObject({
    reason: "new",
    messages: [
      {
        role: "user",
        content: "remember this before new",
      },
    ],
  });
  expect(beforeResetContext).toMatchObject({
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: "sess-parent-hooks",
  });

  expect(sessionLifecycleHookMocks.runSessionEnd).toHaveBeenCalledTimes(1);
  expect(sessionLifecycleHookMocks.runSessionStart).toHaveBeenCalledTimes(1);
  const [endEvent] = (
    sessionLifecycleHookMocks.runSessionEnd.mock.calls as unknown as Array<[unknown, unknown]>
  )[0] ?? [undefined, undefined];
  const [startEvent] = (
    sessionLifecycleHookMocks.runSessionStart.mock.calls as unknown as Array<[unknown, unknown]>
  )[0] ?? [undefined, undefined];
  expect(endEvent).toMatchObject({
    sessionId: "sess-parent-hooks",
    sessionKey: "agent:main:main",
    reason: "new",
    nextSessionId: (startEvent as { sessionId?: string } | undefined)?.sessionId,
    nextSessionKey: (startEvent as { sessionKey?: string } | undefined)?.sessionKey,
  });
  expect(startEvent).toMatchObject({
    resumedFrom: "sess-parent-hooks",
  });
  expect((startEvent as { sessionId?: string } | undefined)?.sessionId).toBeTypeOf("string");
  expect((startEvent as { sessionId?: string } | undefined)?.sessionId).not.toBe("");
  expect((startEvent as { sessionKey?: string } | undefined)?.sessionKey).toMatch(
    /^agent:main:dashboard:/,
  );
});

test("sessions.create with emitCommandHooks=true resets parent in place when session.dmScope is 'main' (#77434)", async () => {
  replaceSqliteSessionTranscriptEvents({
    agentId: "main",
    sessionId: "sess-parent-dms",
    events: [
      {
        type: "message",
        id: "m1",
        message: { role: "user", content: "hello before /new" },
      },
    ],
  });

  testState.sessionConfig = { dmScope: "main" };
  try {
    await seedGatewaySessionEntries({
      entries: {
        main: {
          sessionId: "sess-parent-dms",
          updatedAt: Date.now(),
        },
      },
    });

    const result = await directSessionReq<{
      ok: boolean;
      key: string;
      sessionId: string;
      runStarted: boolean;
    }>("sessions.create", {
      parentSessionKey: "main",
      emitCommandHooks: true,
    });
    expect(result.ok).toBe(true);
    // Reset-in-place: response key matches the parent main key, NOT a dashboard child.
    expect(result.payload?.key).toBe("agent:main:main");
    expect(result.payload?.runStarted).toBe(false);
    expect(result.payload?.sessionId).not.toBe("sess-parent-dms");

    expect(sessionLifecycleHookMocks.runSessionEnd).toHaveBeenCalledTimes(1);
    expect(sessionLifecycleHookMocks.runSessionStart).toHaveBeenCalledTimes(1);
    const [endEvent] = (
      sessionLifecycleHookMocks.runSessionEnd.mock.calls as unknown as Array<[unknown, unknown]>
    )[0] ?? [undefined, undefined];
    const [startEvent] = (
      sessionLifecycleHookMocks.runSessionStart.mock.calls as unknown as Array<[unknown, unknown]>
    )[0] ?? [undefined, undefined];
    expect(endEvent).toMatchObject({
      sessionId: "sess-parent-dms",
      sessionKey: "agent:main:main",
      reason: "new",
    });
    expect(startEvent).toMatchObject({
      sessionKey: "agent:main:main",
      resumedFrom: "sess-parent-dms",
    });
  } finally {
    testState.sessionConfig = undefined;
  }
});

test("sessions.create without emitCommandHooks does not fire command:new hook (#76957)", async () => {
  await seedSqliteSessionTranscript("sess-parent2", "hello from parent 2");

  await seedGatewaySessionEntries({
    entries: {
      main: sessionStoreEntry("sess-parent2"),
    },
  });

  const result = await directSessionReq<{ ok: boolean; key: string }>("sessions.create", {
    parentSessionKey: "main",
  });
  expect(result.ok).toBe(true);

  const commandNewEvents = (
    sessionHookMocks.triggerInternalHook.mock.calls as unknown as Array<[unknown]>
  )
    .map((call) => call[0])
    .filter(
      (event): event is { type: string; action: string } =>
        Boolean(event) &&
        typeof event === "object" &&
        (event as { type?: unknown }).type === "command" &&
        (event as { action?: unknown }).action === "new",
    );
  expect(commandNewEvents).toHaveLength(0);
  expect(beforeResetHookMocks.runBeforeReset).not.toHaveBeenCalled();
  expect(sessionLifecycleHookMocks.runSessionEnd).not.toHaveBeenCalled();
  expect(sessionLifecycleHookMocks.runSessionStart).not.toHaveBeenCalled();
});

test("sessions.reset drops cli session bindings so the next turn does not --resume the old claude-cli session", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-with-binding", "hello");

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-with-binding", {
        claudeCliSessionId: "claude-cli-old-session",
        cliSessionBindings: {
          "claude-cli": { sessionId: "claude-cli-old-session" },
        },
        cliSessionIds: { "claude-cli": "claude-cli-old-session" },
      }),
    },
  });

  const [{ getRuntimeConfig }, { resolveGatewaySessionStoreTarget }, { loadSessionStore }] =
    await Promise.all([
      import("../config/config.js"),
      import("./session-utils.js"),
      import("../config/sessions.js"),
    ]);
  const gatewayStorePath = resolveGatewaySessionStoreTarget({
    cfg: getRuntimeConfig(),
    key: "main",
  }).storePath;

  const reset = await directSessionReq<{ ok: true; key: string }>("sessions.reset", {
    key: "main",
    reason: "new",
  });
  expect(reset.ok).toBe(true);

  const store = loadSessionStore(gatewayStorePath, { skipCache: true });
  const nextEntry = store["agent:main:main"];
  expect(nextEntry).toBeDefined();
  expect(nextEntry?.sessionId).not.toBe("sess-with-binding");
  expect(nextEntry?.claudeCliSessionId).toBeUndefined();
  expect(nextEntry?.cliSessionBindings).toBeUndefined();
  expect(nextEntry?.cliSessionIds).toBeUndefined();
});

test("sessions.reset clears cli session bindings for parent-linked non-subagent sessions (e.g. dashboard children)", async () => {
  const { dir } = await createSessionStoreDir();
  const dashboardTranscript = path.join(dir, "sess-dashboard-child.jsonl");
  await fs.writeFile(
    dashboardTranscript,
    `${JSON.stringify({
      type: "message",
      id: "m-dashboard",
      message: { role: "user", content: "hello from dashboard child" },
    })}\n`,
    "utf-8",
  );

  await writeSessionStore({
    entries: {
      "dashboard:child:42": sessionStoreEntry("sess-dashboard-child", {
        sessionFile: dashboardTranscript,
        // parentSessionKey is set but the session key carries no `:subagent:`
        // marker, so this is a user-facing parent-linked session, not a
        // spawned subagent. The tighter predicate should still clear the
        // CLI binding here so /reset matches user intuition.
        parentSessionKey: "agent:main:main",
        claudeCliSessionId: "claude-cli-dashboard-session",
        cliSessionBindings: {
          "claude-cli": { sessionId: "claude-cli-dashboard-session" },
        },
        cliSessionIds: { "claude-cli": "claude-cli-dashboard-session" },
      }),
    },
  });

  const [{ getRuntimeConfig }, { resolveGatewaySessionStoreTarget }, { loadSessionStore }] =
    await Promise.all([
      import("../config/config.js"),
      import("./session-utils.js"),
      import("../config/sessions.js"),
    ]);
  const gatewayStorePath = resolveGatewaySessionStoreTarget({
    cfg: getRuntimeConfig(),
    key: "dashboard:child:42",
  }).storePath;

  const reset = await directSessionReq<{ ok: true; key: string }>("sessions.reset", {
    key: "dashboard:child:42",
    reason: "new",
  });
  expect(reset.ok).toBe(true);

  const store = loadSessionStore(gatewayStorePath, { skipCache: true });
  const nextEntry = store["agent:main:dashboard:child:42"];
  expect(nextEntry).toBeDefined();
  expect(nextEntry?.sessionId).not.toBe("sess-dashboard-child");
  expect(nextEntry?.claudeCliSessionId).toBeUndefined();
  expect(nextEntry?.cliSessionBindings).toBeUndefined();
  expect(nextEntry?.cliSessionIds).toBeUndefined();
});

test("sessions.reset preserves cli session bindings for spawned subagents (Tak Hoffman's fa56682b3ced contract)", async () => {
  const { dir } = await createSessionStoreDir();
  const childTranscript = path.join(dir, "sess-spawned-child.jsonl");
  await fs.writeFile(
    childTranscript,
    `${JSON.stringify({
      type: "message",
      id: "m-child",
      message: { role: "user", content: "hello from spawned child" },
    })}\n`,
    "utf-8",
  );

  await writeSessionStore({
    entries: {
      "subagent:child": sessionStoreEntry("sess-spawned-child", {
        sessionFile: childTranscript,
        parentSessionKey: "agent:main:main",
        spawnedBy: "agent:main:main",
        subagentRole: "orchestrator",
        claudeCliSessionId: "claude-cli-child-session",
        cliSessionBindings: {
          "claude-cli": { sessionId: "claude-cli-child-session" },
        },
        cliSessionIds: { "claude-cli": "claude-cli-child-session" },
      }),
    },
  });

  const [{ getRuntimeConfig }, { resolveGatewaySessionStoreTarget }, { loadSessionStore }] =
    await Promise.all([
      import("../config/config.js"),
      import("./session-utils.js"),
      import("../config/sessions.js"),
    ]);
  const gatewayStorePath = resolveGatewaySessionStoreTarget({
    cfg: getRuntimeConfig(),
    key: "subagent:child",
  }).storePath;

  const reset = await directSessionReq<{ ok: true; key: string }>("sessions.reset", {
    key: "subagent:child",
    reason: "new",
  });
  expect(reset.ok).toBe(true);

  const store = loadSessionStore(gatewayStorePath, { skipCache: true });
  const nextEntry = store["agent:main:subagent:child"];
  expect(nextEntry).toBeDefined();
  expect(nextEntry?.sessionId).not.toBe("sess-spawned-child");
  expect(nextEntry?.claudeCliSessionId).toBe("claude-cli-child-session");
  expect(nextEntry?.cliSessionBindings).toEqual({
    "claude-cli": { sessionId: "claude-cli-child-session" },
  });
  expect(nextEntry?.cliSessionIds).toEqual({ "claude-cli": "claude-cli-child-session" });
});

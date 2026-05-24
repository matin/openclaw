import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const note = vi.hoisted(() => vi.fn());

vi.mock("../../../terminal/note.js", () => ({
  note,
}));

import {
  appendSqliteSessionTranscriptEvent,
  loadSqliteSessionTranscriptEvents,
  replaceSqliteSessionTranscriptEvents,
} from "../../../config/sessions/transcript-store.sqlite.js";
import { createPluginStateSyncKeyedStore } from "../../../plugin-state/plugin-state-store.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../../state/openclaw-state-db.js";
import { noteSessionTranscriptHealth } from "./session-transcript-health.js";

const CODEX_APP_SERVER_BINDING_PLUGIN_ID = "codex";
const CODEX_APP_SERVER_BINDING_NAMESPACE = "app-server-thread-bindings";
const CODEX_APP_SERVER_BINDING_MAX_ENTRIES = 10_000;

function countNonEmptyLines(value: string): number {
  let count = 0;
  for (const line of value.split(/\r?\n/)) {
    if (line) {
      count += 1;
    }
  }
  return count;
}

function requireFirstMockCall<T>(mock: { mock: { calls: T[][] } }, label: string): T[] {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

describe("doctor session transcript repair", () => {
  let root: string;

  beforeEach(async () => {
    note.mockClear();
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-transcripts-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
  });

  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function writeTranscriptFile(fileName: string, entries: unknown[]): Promise<string> {
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const filePath = path.join(sessionsDir, fileName);
    await fs.writeFile(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    return filePath;
  }

  async function writeTranscript(entries: unknown[]): Promise<string> {
    return writeTranscriptFile("session.jsonl", entries);
  }

  it("imports affected prompt-rewrite branches as active SQLite transcript rows", async () => {
    const filePath = await writeTranscript([
      { type: "session", version: 3, id: "session-1", timestamp: "2026-04-25T00:00:00Z" },
      {
        type: "message",
        id: "parent",
        parentId: null,
        message: { role: "assistant", content: "previous" },
      },
      {
        type: "message",
        id: "runtime-user",
        parentId: "parent",
        message: {
          role: "user",
          content: [
            "visible ask",
            "",
            "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
            "secret",
            "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
          ].join("\n"),
        },
      },
      {
        type: "message",
        id: "runtime-assistant",
        parentId: "runtime-user",
        message: { role: "assistant", content: "stale" },
      },
      {
        type: "message",
        id: "plain-user",
        parentId: "parent",
        message: { role: "user", content: "visible ask" },
      },
      {
        type: "message",
        id: "plain-assistant",
        parentId: "plain-user",
        message: { role: "assistant", content: "answer" },
      },
    ]);
    const sessionsDir = path.dirname(filePath);

    await noteSessionTranscriptHealth({ shouldRepair: true, sessionDirs: [sessionsDir] });

    await expect(fs.access(filePath)).rejects.toThrow();
    expect(
      loadSqliteSessionTranscriptEvents({
        agentId: "main",
        sessionId: "session-1",
      })
        .map((entry) => entry.event as { type?: string; id?: string })
        .filter((entry) => entry.type !== "session")
        .map((entry) => entry.id),
    ).toEqual(["parent", "plain-user", "plain-assistant"]);
  });

  it("reports affected transcripts without rewriting outside repair mode", async () => {
    const filePath = await writeTranscript([
      { type: "session", version: 3, id: "session-1", timestamp: "2026-04-25T00:00:00Z" },
      {
        type: "message",
        id: "runtime-user",
        parentId: null,
        message: {
          role: "user",
          content:
            "visible ask\n\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nsecret\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        },
      },
      {
        type: "message",
        id: "plain-user",
        parentId: null,
        message: { role: "user", content: "visible ask" },
      },
    ]);
    const sessionsDir = path.dirname(filePath);

    await noteSessionTranscriptHealth({ shouldRepair: false, sessionDirs: [sessionsDir] });

    expect(note).toHaveBeenCalledTimes(1);
    const [message, title] = requireFirstMockCall(note, "doctor note") as [string, string];
    expect(title).toBe("Session transcripts");
    expect(message).toContain("legacy transcript JSONL");
    expect(message).toContain('Run "openclaw doctor --fix"');
    expect(countNonEmptyLines(await fs.readFile(filePath, "utf-8"))).toBe(3);
  });

  it("imports legacy transcript files into SQLite during repair mode", async () => {
    const filePath = await writeTranscript([
      {
        type: "session",
        version: 3,
        id: "session-1",
        timestamp: "2026-04-25T00:00:00Z",
        cwd: root,
      },
      {
        type: "message",
        id: "user-1",
        parentId: null,
        message: { role: "user", content: "hello" },
      },
    ]);
    const sessionsDir = path.dirname(filePath);

    await noteSessionTranscriptHealth({ shouldRepair: true, sessionDirs: [sessionsDir] });

    await expect(fs.access(filePath)).rejects.toThrow();
    expect(
      loadSqliteSessionTranscriptEvents({
        agentId: "main",
        sessionId: "session-1",
      }).map((entry) => entry.event),
    ).toMatchObject([
      { type: "session", version: 1, id: "session-1" },
      { type: "message", id: "user-1" },
    ]);
    const [message, title] = note.mock.calls[0] as [string, string];
    expect(title).toBe("Session transcripts");
    expect(message).toContain("Imported 1 transcript file into SQLite");
  });

  it("preserves post-migration transcript events when a legacy JSONL reappears", async () => {
    const legacyEvents = [
      {
        type: "session",
        version: 3,
        id: "session-1",
        timestamp: "2026-04-25T00:00:00Z",
        cwd: root,
      },
      {
        type: "message",
        id: "legacy-1",
        parentId: null,
        message: { role: "user", content: "hello legacy" },
      },
    ];
    const filePath = await writeTranscript(legacyEvents);
    const sessionsDir = path.dirname(filePath);

    await noteSessionTranscriptHealth({ shouldRepair: true, sessionDirs: [sessionsDir] });
    await expect(fs.access(filePath)).rejects.toThrow();

    appendSqliteSessionTranscriptEvent({
      agentId: "main",
      sessionId: "session-1",
      event: {
        type: "message",
        id: "post-migration-marker",
        parentId: "legacy-1",
        message: { role: "assistant", content: "POST_MIGRATION_MARKER" },
      },
    });

    await writeTranscript(legacyEvents);
    await noteSessionTranscriptHealth({ shouldRepair: true, sessionDirs: [sessionsDir] });

    const eventIds = loadSqliteSessionTranscriptEvents({
      agentId: "main",
      sessionId: "session-1",
    }).map((entry) => (entry.event as { id?: string }).id);
    expect(eventIds).toContain("post-migration-marker");
  });

  it("does not duplicate v1 legacy transcript rows when a JSONL reappears", async () => {
    const legacyEvents = [
      {
        type: "session",
        id: "session-1",
        timestamp: "2026-04-25T00:00:00Z",
        cwd: root,
      },
      {
        type: "message",
        timestamp: "2026-04-25T00:00:01Z",
        message: { role: "user", content: "legacy v1" },
      },
    ];
    const filePath = await writeTranscript(legacyEvents);
    const sessionsDir = path.dirname(filePath);

    await noteSessionTranscriptHealth({ shouldRepair: true, sessionDirs: [sessionsDir] });
    await writeTranscript(legacyEvents);
    await noteSessionTranscriptHealth({ shouldRepair: true, sessionDirs: [sessionsDir] });

    expect(
      loadSqliteSessionTranscriptEvents({
        agentId: "main",
        sessionId: "session-1",
      }),
    ).toHaveLength(2);
  });

  it("does not duplicate v1 rows previously imported with generated ids", async () => {
    replaceSqliteSessionTranscriptEvents({
      agentId: "main",
      sessionId: "session-1",
      events: [
        {
          type: "session",
          version: 1,
          id: "session-1",
          timestamp: "2026-04-25T00:00:00Z",
          cwd: root,
        },
        {
          type: "message",
          id: "old-generated-id",
          parentId: null,
          timestamp: "2026-04-25T00:00:01Z",
          message: { role: "user", content: "legacy v1" },
        },
      ],
    });
    const filePath = await writeTranscript([
      {
        type: "session",
        id: "session-1",
        timestamp: "2026-04-25T00:00:00Z",
        cwd: root,
      },
      {
        type: "message",
        timestamp: "2026-04-25T00:00:01Z",
        message: { role: "user", content: "legacy v1" },
      },
    ]);
    const sessionsDir = path.dirname(filePath);

    await noteSessionTranscriptHealth({ shouldRepair: true, sessionDirs: [sessionsDir] });

    const events = loadSqliteSessionTranscriptEvents({
      agentId: "main",
      sessionId: "session-1",
    }).map((entry) => entry.event as { id?: string });
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.id)).toContain("old-generated-id");
  });

  it("remaps v1 tail parents when a prefix was previously imported with generated ids", async () => {
    replaceSqliteSessionTranscriptEvents({
      agentId: "main",
      sessionId: "session-1",
      events: [
        {
          type: "session",
          version: 1,
          id: "session-1",
          timestamp: "2026-04-25T00:00:00Z",
          cwd: root,
        },
        {
          type: "message",
          id: "old-generated-parent",
          parentId: null,
          timestamp: "2026-04-25T00:00:01Z",
          message: { role: "user", content: "legacy prefix" },
        },
      ],
    });
    const filePath = await writeTranscript([
      {
        type: "session",
        id: "session-1",
        timestamp: "2026-04-25T00:00:00Z",
        cwd: root,
      },
      {
        type: "message",
        timestamp: "2026-04-25T00:00:01Z",
        message: { role: "user", content: "legacy prefix" },
      },
      {
        type: "message",
        timestamp: "2026-04-25T00:00:02Z",
        message: { role: "assistant", content: "new tail" },
      },
    ]);
    const sessionsDir = path.dirname(filePath);

    await noteSessionTranscriptHealth({ shouldRepair: true, sessionDirs: [sessionsDir] });

    const tail = loadSqliteSessionTranscriptEvents({
      agentId: "main",
      sessionId: "session-1",
    })
      .map((entry) => entry.event as { parentId?: string; message?: { content?: string } })
      .find((event) => event.message?.content === "new tail");
    expect(tail?.parentId).toBe("old-generated-parent");
  });

  it("merges events across multiple legacy JSONL files for the same session", async () => {
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    await writeTranscriptFile("session-1.jsonl", [
      {
        type: "session",
        version: 3,
        id: "session-1",
        timestamp: "2026-04-25T00:00:00Z",
      },
      {
        type: "message",
        id: "msg-main-a",
        parentId: null,
        message: { role: "user", content: "from main file" },
      },
      {
        type: "message",
        id: "msg-main-b",
        parentId: "msg-main-a",
        message: { role: "assistant", content: "main reply" },
      },
    ]);
    await writeTranscriptFile("session-1.checkpoint.cp-alpha.jsonl", [
      {
        type: "session",
        version: 3,
        id: "session-1",
        timestamp: "2026-04-25T00:00:00Z",
      },
      {
        type: "message",
        id: "msg-cp-a",
        parentId: null,
        message: { role: "user", content: "from checkpoint" },
      },
      {
        type: "message",
        id: "msg-cp-b",
        parentId: "msg-cp-a",
        message: { role: "assistant", content: "checkpoint reply" },
      },
    ]);

    await noteSessionTranscriptHealth({ shouldRepair: true, sessionDirs: [sessionsDir] });

    const eventIds = loadSqliteSessionTranscriptEvents({
      agentId: "main",
      sessionId: "session-1",
    })
      .map((entry) => (entry.event as { id?: string }).id)
      .filter((id): id is string => Boolean(id));
    expect(eventIds).toEqual(
      expect.arrayContaining(["msg-main-a", "msg-main-b", "msg-cp-a", "msg-cp-b"]),
    );
  });

  it("does not fingerprint-dedupe repeated v3 events across legacy files", async () => {
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    await writeTranscriptFile("session-1.jsonl", [
      {
        type: "session",
        version: 3,
        id: "session-1",
        timestamp: "2026-04-25T00:00:00Z",
      },
      {
        type: "message",
        id: "repeat-main",
        parentId: null,
        message: { role: "user", content: "same prompt" },
      },
    ]);
    await writeTranscriptFile("session-1.checkpoint.cp-alpha.jsonl", [
      {
        type: "session",
        version: 3,
        id: "session-1",
        timestamp: "2026-04-25T00:00:00Z",
      },
      {
        type: "message",
        id: "repeat-checkpoint",
        parentId: null,
        message: { role: "user", content: "same prompt" },
      },
    ]);

    await noteSessionTranscriptHealth({ shouldRepair: true, sessionDirs: [sessionsDir] });

    const eventIds = loadSqliteSessionTranscriptEvents({
      agentId: "main",
      sessionId: "session-1",
    })
      .map((entry) => (entry.event as { id?: string }).id)
      .filter((id): id is string => Boolean(id));
    expect(eventIds).toEqual(expect.arrayContaining(["repeat-main", "repeat-checkpoint"]));
  });

  it("does not re-warn about trajectory-class files on every doctor run", async () => {
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    const trajectoryPath = await writeTranscriptFile("session-1.trajectory.jsonl", [
      {
        type: "trajectory_event",
        phase: "start",
        at: "2026-04-25T00:00:00Z",
        id: "traj-1",
      },
      {
        type: "trajectory_event",
        phase: "tool_call",
        at: "2026-04-25T00:00:01Z",
        id: "traj-2",
      },
    ]);

    await noteSessionTranscriptHealth({ shouldRepair: true, sessionDirs: [sessionsDir] });
    note.mockClear();

    await noteSessionTranscriptHealth({ shouldRepair: true, sessionDirs: [sessionsDir] });

    await expect(fs.access(trajectoryPath)).rejects.toThrow();
    expect(note).not.toHaveBeenCalled();
  });

  it("does not delete or import .jsonl.bak-* legacy backup files", async () => {
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    const bakPath = path.join(sessionsDir, "session-1.jsonl.bak-329946-1777315232286");
    await writeTranscriptFile("session-1.jsonl", [
      {
        type: "session",
        version: 3,
        id: "session-1",
        timestamp: "2026-04-25T00:00:00Z",
      },
      {
        type: "message",
        id: "msg-1",
        parentId: null,
        message: { role: "user", content: "hi" },
      },
    ]);
    await fs.writeFile(
      bakPath,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "session-1",
        timestamp: "2026-04-24T00:00:00Z",
      })}\n${JSON.stringify({
        type: "message",
        id: "stale-bak-event",
        parentId: null,
        message: { role: "user", content: "stale" },
      })}\n`,
    );

    await noteSessionTranscriptHealth({ shouldRepair: true, sessionDirs: [sessionsDir] });

    await expect(fs.access(bakPath)).resolves.toBeUndefined();
    const eventIds = loadSqliteSessionTranscriptEvents({
      agentId: "main",
      sessionId: "session-1",
    })
      .map((entry) => (entry.event as { id?: string }).id)
      .filter((id): id is string => Boolean(id));
    expect(eventIds).not.toContain("stale-bak-event");
  });

  it("imports legacy Codex app-server binding sidecars during repair mode", async () => {
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const legacyTranscriptPath = path.join(sessionsDir, "session.jsonl");
    await fs.writeFile(
      legacyTranscriptPath,
      `${JSON.stringify({ type: "session", version: 3, id: "session-1", cwd: root })}\n`,
    );
    const sidecarPath = `${legacyTranscriptPath}.codex-app-server.json`;
    await fs.writeFile(
      sidecarPath,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-123",
        cwd: root,
        model: "gpt-5.5",
        userMcpServersFingerprint: "user-mcp-v1",
        mcpServersFingerprint: "mcp-v1",
        pluginAppsFingerprint: "plugin-apps-v1",
        pluginAppsInputFingerprint: "plugin-app-input-v1",
        pluginAppPolicyContext: {
          fingerprint: "policy-v1",
          apps: {},
          pluginAppIds: {},
        },
        contextEngine: {
          schemaVersion: 1,
          engineId: "context-engine",
          policyFingerprint: "context-policy-v1",
        },
      }),
    );

    await noteSessionTranscriptHealth({ shouldRepair: true, sessionDirs: [sessionsDir] });

    await expect(fs.access(sidecarPath)).rejects.toThrow();
    expect(
      createPluginStateSyncKeyedStore<Record<string, unknown>>(CODEX_APP_SERVER_BINDING_PLUGIN_ID, {
        namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
        maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
      }).lookup("session-1"),
    ).toMatchObject({
      schemaVersion: 1,
      threadId: "thread-123",
      sessionId: "session-1",
      cwd: root,
      model: "gpt-5.5",
      userMcpServersFingerprint: "user-mcp-v1",
      mcpServersFingerprint: "mcp-v1",
      pluginAppsFingerprint: "plugin-apps-v1",
      pluginAppsInputFingerprint: "plugin-app-input-v1",
      pluginAppPolicyContext: {
        fingerprint: "policy-v1",
        apps: {},
        pluginAppIds: {},
      },
      contextEngine: {
        schemaVersion: 1,
        engineId: "context-engine",
        policyFingerprint: "context-policy-v1",
      },
    });
    const [message, title] = note.mock.calls[0] as [string, string];
    expect(title).toBe("Session transcripts");
    expect(message).toContain("Imported 1 Codex app-server binding sidecar into SQLite");
  });

  it("ignores ordinary branch history without internal runtime context", async () => {
    const filePath = await writeTranscript([
      { type: "session", version: 3, id: "session-1", timestamp: "2026-04-25T00:00:00Z" },
      {
        type: "message",
        id: "branch-a",
        parentId: null,
        message: { role: "user", content: "draft A" },
      },
      {
        type: "message",
        id: "branch-b",
        parentId: null,
        message: { role: "user", content: "draft B" },
      },
    ]);

    await noteSessionTranscriptHealth({
      shouldRepair: true,
      sessionDirs: [path.dirname(filePath)],
    });

    await expect(fs.access(filePath)).rejects.toThrow();
    expect(
      loadSqliteSessionTranscriptEvents({
        agentId: "main",
        sessionId: "session-1",
      }).map((entry) => entry.event),
    ).toHaveLength(3);
  });
});

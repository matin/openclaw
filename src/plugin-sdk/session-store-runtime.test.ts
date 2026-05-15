import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  getSessionEntry,
  loadSessionStore,
  readSessionUpdatedAt,
  saveSessionStore,
  updateSessionStore,
  upsertSessionEntry,
} from "./session-store-runtime.js";

describe("session-store-runtime compatibility", () => {
  function canonicalStorePath(stateDir: string): string {
    return path.join(stateDir, "agents", "main", "sessions", "sessions.json");
  }

  function testEnv(stateDir: string): NodeJS.ProcessEnv {
    return { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  }

  it("rejects custom store paths instead of falling back to the default agent", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-session-store-compat-",
        scenario: "minimal",
      },
      async (state) => {
        const customStorePath = path.join(state.path("custom"), "sessions.json");
        await fs.mkdir(path.dirname(customStorePath), { recursive: true });

        upsertSessionEntry({
          agentId: "default",
          env: { ...process.env, OPENCLAW_STATE_DIR: state.stateDir },
          sessionKey: "discord:default:user:1",
          entry: {
            sessionId: "default-session",
            updatedAt: 123,
            sessionStartedAt: 123,
          },
        });

        expect(() => loadSessionStore(customStorePath)).toThrow(/Custom sessions\.json paths/);
        expect(
          readSessionUpdatedAt({
            agentId: "default",
            sessionKey: "discord:default:user:1",
            storePath: customStorePath,
          }),
        ).toBe(123);
      },
    );
  });

  it("does not delete rows created after a compatibility snapshot was loaded", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-session-store-compat-",
        scenario: "minimal",
      },
      async (state) => {
        const env = testEnv(state.stateDir);
        const storePath = canonicalStorePath(state.stateDir);
        const staleSnapshot = loadSessionStore(storePath);

        upsertSessionEntry({
          agentId: "main",
          env,
          sessionKey: "agent:main:concurrent",
          entry: {
            sessionId: "concurrent-session",
            updatedAt: 200,
            sessionStartedAt: 200,
          },
        });

        staleSnapshot["agent:main:legacy"] = {
          sessionId: "legacy-session",
          updatedAt: 100,
          sessionStartedAt: 100,
        };
        await saveSessionStore(storePath, staleSnapshot);

        expect(
          getSessionEntry({ agentId: "main", env, sessionKey: "agent:main:concurrent" })?.sessionId,
        ).toBe("concurrent-session");
        expect(
          getSessionEntry({ agentId: "main", env, sessionKey: "agent:main:legacy" })?.sessionId,
        ).toBe("legacy-session");
      },
    );
  });

  it("keeps updateSessionStore deletes scoped to rows visible before mutation", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-session-store-compat-",
        scenario: "minimal",
      },
      async (state) => {
        const env = testEnv(state.stateDir);
        const storePath = canonicalStorePath(state.stateDir);
        upsertSessionEntry({
          agentId: "main",
          env,
          sessionKey: "agent:main:old",
          entry: {
            sessionId: "old-session",
            updatedAt: 100,
            sessionStartedAt: 100,
          },
        });

        await updateSessionStore(storePath, (store) => {
          delete store["agent:main:old"];
          upsertSessionEntry({
            agentId: "main",
            env,
            sessionKey: "agent:main:concurrent",
            entry: {
              sessionId: "concurrent-session",
              updatedAt: 200,
              sessionStartedAt: 200,
            },
          });
          store["agent:main:new"] = {
            sessionId: "new-session",
            updatedAt: 300,
            sessionStartedAt: 300,
          };
        });

        expect(
          getSessionEntry({ agentId: "main", env, sessionKey: "agent:main:old" }),
        ).toBeUndefined();
        expect(
          getSessionEntry({ agentId: "main", env, sessionKey: "agent:main:concurrent" })?.sessionId,
        ).toBe("concurrent-session");
        expect(
          getSessionEntry({ agentId: "main", env, sessionKey: "agent:main:new" })?.sessionId,
        ).toBe("new-session");
      },
    );
  });
});

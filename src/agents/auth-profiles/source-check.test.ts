import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { hasAnyAuthProfileStoreSource } from "./source-check.js";

describe("hasAnyAuthProfileStoreSource", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  function withTempAgentDir<T>(prefix: string, run: (agentDir: string) => T): T {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    try {
      return run(agentDir);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  }

  it("recognizes legacy auth profile files before SQLite migration", () => {
    withTempAgentDir("openclaw-auth-source-legacy-", (agentDir) => {
      fs.writeFileSync(
        path.join(agentDir, "auth-profiles.json"),
        JSON.stringify({
          openai: {
            type: "api_key",
            provider: "openai",
            key: "sk-legacy",
          },
        }),
        "utf8",
      );

      expect(hasAnyAuthProfileStoreSource(agentDir)).toBe(true);
    });
  });

  it("recognizes main legacy auth when resolving an agent-specific store", () => {
    withTempAgentDir("openclaw-auth-source-main-", (mainAgentDir) => {
      withTempAgentDir("openclaw-auth-source-child-", (childAgentDir) => {
        const previousStateDir = process.env.OPENCLAW_STATE_DIR;
        try {
          const stateDir = path.join(mainAgentDir, "state");
          const defaultAgentDir = path.join(stateDir, "agents", "main", "agent");
          fs.mkdirSync(defaultAgentDir, { recursive: true });
          process.env.OPENCLAW_STATE_DIR = stateDir;
          fs.writeFileSync(
            path.join(defaultAgentDir, "auth.json"),
            JSON.stringify({
              openai: {
                type: "api_key",
                provider: "openai",
                key: "sk-main-legacy",
              },
            }),
            "utf8",
          );

          expect(hasAnyAuthProfileStoreSource(childAgentDir)).toBe(true);
        } finally {
          if (previousStateDir === undefined) {
            delete process.env.OPENCLAW_STATE_DIR;
          } else {
            process.env.OPENCLAW_STATE_DIR = previousStateDir;
          }
        }
      });
    });
  });

  it("does not create SQLite state while probing an empty auth source", () => {
    withTempAgentDir("openclaw-auth-source-empty-", (agentDir) => {
      const previousStateDir = process.env.OPENCLAW_STATE_DIR;
      try {
        const stateDir = path.join(agentDir, "state");
        process.env.OPENCLAW_STATE_DIR = stateDir;
        const sqlitePath = path.join(stateDir, "state", "openclaw.sqlite");

        expect(hasAnyAuthProfileStoreSource(agentDir)).toBe(false);
        expect(fs.existsSync(sqlitePath)).toBe(false);
      } finally {
        if (previousStateDir === undefined) {
          delete process.env.OPENCLAW_STATE_DIR;
        } else {
          process.env.OPENCLAW_STATE_DIR = previousStateDir;
        }
      }
    });
  });
});

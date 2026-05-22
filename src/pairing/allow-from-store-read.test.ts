import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../channels/plugins/pairing.js", () => ({
  getPairingAdapter: () => null,
}));

import {
  clearAllowFromStoreReadCacheForTest,
  readChannelAllowFromStoreEntriesSync,
} from "./allow-from-store-read.js";
import { resolveAllowFromAccountId } from "./pairing-store-keys.js";
import { writeChannelPairingStateSnapshot } from "./pairing-store.js";

let fixtureRoot = "";
let caseId = 0;
const sqliteAllowFromByCase = new Map<string, Record<string, string[]>>();

function makeEnv(homeDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: homeDir,
    OPENCLAW_STATE_DIR: path.join(homeDir, ".openclaw"),
  };
}

function makeHomeDir(): string {
  const dir = path.join(fixtureRoot, `case-${caseId++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeAllowFromStore(params: {
  channel: "telegram";
  env: NodeJS.ProcessEnv;
  accountId?: string;
  allowFrom: string[];
}): void {
  const stateKey = `${params.env.OPENCLAW_STATE_DIR ?? ""}\0${params.channel}`;
  const allowFrom = {
    ...sqliteAllowFromByCase.get(stateKey),
    [resolveAllowFromAccountId(params.accountId)]: params.allowFrom,
  };
  sqliteAllowFromByCase.set(stateKey, allowFrom);
  writeChannelPairingStateSnapshot(
    params.channel,
    { version: 1, requests: [], allowFrom },
    params.env,
  );
}

function writeLegacyAllowFromStore(params: {
  env: NodeJS.ProcessEnv;
  channel: "telegram";
  accountId?: string;
  allowFrom: string[];
}): void {
  const stateDir = params.env.OPENCLAW_STATE_DIR ?? path.join(params.env.HOME ?? "", ".openclaw");
  const credentialsDir = path.join(stateDir, "credentials");
  fs.mkdirSync(credentialsDir, { recursive: true });
  const suffix = params.accountId ? `-${params.accountId}` : "";
  fs.writeFileSync(
    path.join(credentialsDir, `${params.channel}${suffix}-allowFrom.json`),
    `${JSON.stringify({ version: 1, allowFrom: params.allowFrom })}\n`,
    "utf8",
  );
}

beforeAll(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-allow-from-read-"));
});

afterAll(() => {
  if (fixtureRoot) {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

afterEach(() => {
  clearAllowFromStoreReadCacheForTest();
  sqliteAllowFromByCase.clear();
});

describe("allow-from-store-read", () => {
  it("reads default account entries from SQLite", async () => {
    const env = makeEnv(makeHomeDir());
    writeAllowFromStore({
      channel: "telegram",
      env,
      accountId: "default",
      allowFrom: [" scoped-a ", "scoped-a", "legacy-b"],
    });

    expect(readChannelAllowFromStoreEntriesSync("telegram", env)).toEqual(["scoped-a", "legacy-b"]);
  });

  it("keeps non-default account reads scoped", async () => {
    const env = makeEnv(makeHomeDir());
    writeAllowFromStore({
      channel: "telegram",
      env,
      allowFrom: ["default-a"],
    });
    writeAllowFromStore({
      channel: "telegram",
      env,
      accountId: "work",
      allowFrom: [" work-a ", "work-b"],
    });

    expect(readChannelAllowFromStoreEntriesSync("telegram", env, "work")).toEqual([
      "work-a",
      "work-b",
    ]);
  });

  it("preserves legacy default allowFrom entries before doctor migration", () => {
    const env = makeEnv(makeHomeDir());
    writeLegacyAllowFromStore({
      channel: "telegram",
      env,
      allowFrom: [" legacy-a ", "legacy-a", "legacy-b"],
    });
    writeLegacyAllowFromStore({
      channel: "telegram",
      env,
      accountId: "default",
      allowFrom: ["scoped-default"],
    });

    expect(readChannelAllowFromStoreEntriesSync("telegram", env)).toEqual([
      "scoped-default",
      "legacy-a",
      "legacy-b",
    ]);
  });

  it("preserves scoped legacy allowFrom without leaking default entries", () => {
    const env = makeEnv(makeHomeDir());
    writeLegacyAllowFromStore({
      channel: "telegram",
      env,
      allowFrom: ["default-a"],
    });
    writeLegacyAllowFromStore({
      channel: "telegram",
      env,
      accountId: "work",
      allowFrom: ["work-a"],
    });

    expect(readChannelAllowFromStoreEntriesSync("telegram", env, "work")).toEqual(["work-a"]);
  });
});

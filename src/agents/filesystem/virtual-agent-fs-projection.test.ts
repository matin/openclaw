import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createVirtualAgentFsProjection } from "./virtual-agent-fs-projection.js";
import { createSqliteVirtualAgentFs } from "./virtual-agent-fs.sqlite.js";

function createTempDbPath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-vfs-projection-"));
  return path.join(root, "state", "openclaw.sqlite");
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("createVirtualAgentFsProjection", () => {
  it("projects VFS files to disk and syncs command-side changes back", async () => {
    const scratch = createSqliteVirtualAgentFs({
      agentId: "main",
      namespace: "scratch",
      path: createTempDbPath(),
      now: () => 1000,
    });
    scratch.writeFile("/keep.txt", "keep");
    scratch.writeFile("/remove.txt", "remove");
    scratch.writeFile("/nested/existing.txt", "old");

    const projection = await createVirtualAgentFsProjection(scratch);
    try {
      await expect(fsp.readFile(path.join(projection.root, "keep.txt"), "utf8")).resolves.toBe(
        "keep",
      );
      await fsp.writeFile(path.join(projection.root, "keep.txt"), "updated");
      await fsp.rm(path.join(projection.root, "remove.txt"));
      await fsp.mkdir(path.join(projection.root, "nested"), { recursive: true });
      await fsp.writeFile(path.join(projection.root, "nested", "created.txt"), "new");

      await projection.syncBack();
    } finally {
      await projection.cleanup();
    }

    expect(scratch.readFile("/keep.txt").toString("utf8")).toBe("updated");
    expect(scratch.stat("/remove.txt")).toBeNull();
    expect(scratch.readFile("/nested/existing.txt").toString("utf8")).toBe("old");
    expect(scratch.readFile("/nested/created.txt").toString("utf8")).toBe("new");
  });

  it("maps VFS workdirs into the projected temp root", async () => {
    const scratch = createSqliteVirtualAgentFs({
      agentId: "main",
      namespace: "scratch",
      path: createTempDbPath(),
      now: () => 1000,
    });
    const projection = await createVirtualAgentFsProjection(scratch);
    try {
      const workdir = await projection.resolveWorkdir("nested/work");
      expect(workdir.startsWith(projection.root)).toBe(true);
      await fsp.writeFile(path.join(workdir, "out.txt"), "from command");
      await projection.syncBack();
    } finally {
      await projection.cleanup();
    }

    expect(scratch.readFile("/nested/work/out.txt").toString("utf8")).toBe("from command");
  });

  it("syncs directory-to-file replacements back", async () => {
    const scratch = createSqliteVirtualAgentFs({
      agentId: "main",
      namespace: "scratch",
      path: createTempDbPath(),
      now: () => 1000,
    });
    scratch.writeFile("/target/old.txt", "old");

    const projection = await createVirtualAgentFsProjection(scratch);
    try {
      await fsp.rm(path.join(projection.root, "target"), { recursive: true, force: true });
      await fsp.writeFile(path.join(projection.root, "target"), "replacement");
      await projection.syncBack();
    } finally {
      await projection.cleanup();
    }

    expect(scratch.stat("/target")?.kind).toBe("file");
    expect(scratch.readFile("/target").toString("utf8")).toBe("replacement");
    expect(scratch.stat("/target/old.txt")).toBeNull();
  });

  it("syncs file-to-directory replacements back", async () => {
    const scratch = createSqliteVirtualAgentFs({
      agentId: "main",
      namespace: "scratch",
      path: createTempDbPath(),
      now: () => 1000,
    });
    scratch.writeFile("/target", "old");

    const projection = await createVirtualAgentFsProjection(scratch);
    try {
      await fsp.rm(path.join(projection.root, "target"), { force: true });
      await fsp.mkdir(path.join(projection.root, "target"));
      await fsp.writeFile(path.join(projection.root, "target", "new.txt"), "new");
      await projection.syncBack();
    } finally {
      await projection.cleanup();
    }

    expect(scratch.stat("/target")?.kind).toBe("directory");
    expect(scratch.readFile("/target/new.txt").toString("utf8")).toBe("new");
  });
});

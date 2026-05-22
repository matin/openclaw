import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import type { RuntimeEnv } from "../runtime.js";
import { backupRestoreCommand } from "./backup-restore.js";

let tempDir: string;

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  } satisfies RuntimeEnv;
}

async function createSqliteDb(dbPath: string, value: string): Promise<void> {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(dbPath);
  try {
    db.exec("CREATE TABLE sample (value TEXT NOT NULL);");
    db.prepare("INSERT INTO sample (value) VALUES (?)").run(value);
  } finally {
    db.close();
  }
}

function readSqliteValue(dbPath: string): string | undefined {
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM sample").get() as { value?: string } | undefined;
    return row?.value;
  } finally {
    db.close();
  }
}

async function createBackupArchive(params: {
  archivePath: string;
  sourceStateDir: string;
  restoredStateDir: string;
}): Promise<void> {
  const archiveRoot = "2026-03-09T00-00-00-000Z-openclaw-backup";
  const assetArchivePath = `${archiveRoot}/payload/posix${params.sourceStateDir}`;
  const snapshotArchivePath = `${assetArchivePath}/state/openclaw.sqlite`;
  const archiveBuildDir = path.join(tempDir, "archive-build");
  const payloadPath = path.join(archiveBuildDir, ...assetArchivePath.split("/"));
  await fs.cp(params.restoredStateDir, payloadPath, { recursive: true });
  await fs.writeFile(
    path.join(archiveBuildDir, archiveRoot, "manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        createdAt: "2026-03-09T00:00:00.000Z",
        archiveRoot,
        runtimeVersion: "test",
        platform: process.platform,
        nodeVersion: process.version,
        assets: [
          {
            kind: "state",
            sourcePath: params.sourceStateDir,
            archivePath: assetArchivePath,
          },
        ],
        databaseSnapshots: [
          {
            sourcePath: path.join(params.sourceStateDir, "state", "openclaw.sqlite"),
            archivePath: snapshotArchivePath,
            integrity: "ok",
          },
        ],
        skipped: [],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await tar.c({ cwd: archiveBuildDir, file: params.archivePath, gzip: true }, [archiveRoot]);
}

async function createWorkspaceBackupArchive(params: {
  archivePath: string;
  sourceWorkspaceDir: string;
  restoredWorkspaceDir: string;
}): Promise<void> {
  const archiveRoot = "2026-03-09T00-00-00-000Z-openclaw-backup";
  const assetArchivePath = `${archiveRoot}/payload/posix${params.sourceWorkspaceDir}`;
  const archiveBuildDir = path.join(tempDir, "workspace-archive-build");
  const payloadPath = path.join(archiveBuildDir, ...assetArchivePath.split("/"));
  await fs.cp(params.restoredWorkspaceDir, payloadPath, { recursive: true });
  await fs.writeFile(
    path.join(archiveBuildDir, archiveRoot, "manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        createdAt: "2026-03-09T00:00:00.000Z",
        archiveRoot,
        runtimeVersion: "test",
        platform: process.platform,
        nodeVersion: process.version,
        options: { includeWorkspace: true },
        paths: { workspaceDirs: [params.sourceWorkspaceDir] },
        assets: [
          {
            kind: "workspace",
            sourcePath: params.sourceWorkspaceDir,
            archivePath: assetArchivePath,
          },
        ],
        databaseSnapshots: [],
        skipped: [],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await tar.c({ cwd: archiveBuildDir, file: params.archivePath, gzip: true }, [archiveRoot]);
}

async function createBackupArchiveWithSeparateDatabaseSnapshot(params: {
  archivePath: string;
  sourceStateDir: string;
  restoredStateDir: string;
}): Promise<void> {
  const archiveRoot = "2026-03-09T00-00-00-000Z-openclaw-backup";
  const assetArchivePath = `${archiveRoot}/payload/posix${params.sourceStateDir}`;
  const snapshotArchivePath = `${archiveRoot}/payload/database/state/openclaw.sqlite`;
  const archiveBuildDir = path.join(tempDir, "archive-build-separate-db");
  const payloadPath = path.join(archiveBuildDir, ...assetArchivePath.split("/"));
  const snapshotPath = path.join(archiveBuildDir, ...snapshotArchivePath.split("/"));
  await fs.mkdir(payloadPath, { recursive: true });
  await fs.copyFile(
    path.join(params.restoredStateDir, "state.txt"),
    path.join(payloadPath, "state.txt"),
  );
  await createSqliteDb(snapshotPath, "restored");
  await fs.writeFile(
    path.join(archiveBuildDir, archiveRoot, "manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        createdAt: "2026-03-09T00:00:00.000Z",
        archiveRoot,
        runtimeVersion: "test",
        platform: process.platform,
        nodeVersion: process.version,
        assets: [
          {
            kind: "state",
            sourcePath: params.sourceStateDir,
            archivePath: assetArchivePath,
          },
        ],
        databaseSnapshots: [
          {
            sourcePath: path.join(params.sourceStateDir, "state", "openclaw.sqlite"),
            archivePath: snapshotArchivePath,
            integrity: "ok",
          },
        ],
        skipped: [],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await tar.c({ cwd: archiveBuildDir, file: params.archivePath, gzip: true }, [archiveRoot]);
}

describe("backupRestoreCommand", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-restore-test-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("requires --yes unless dry-run is used", async () => {
    const runtime = createRuntime();
    const result = await backupRestoreCommand(runtime, {
      archive: path.join(tempDir, "missing.tar.gz"),
    });

    expect(result).toBeUndefined();
    expect(runtime.error).toHaveBeenCalledWith(
      "Backup restore requires --yes. Preview first with --dry-run.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("previews restore paths without changing files", async () => {
    const sourceStateDir = path.join(tempDir, "state");
    const restoredStateDir = path.join(tempDir, "snapshot-state");
    const archivePath = path.join(tempDir, "backup.tar.gz");
    await fs.mkdir(sourceStateDir, { recursive: true });
    await fs.writeFile(path.join(sourceStateDir, "state.txt"), "current\n");
    await fs.mkdir(restoredStateDir, { recursive: true });
    await fs.writeFile(path.join(restoredStateDir, "state.txt"), "restored\n");
    await createSqliteDb(path.join(restoredStateDir, "state", "openclaw.sqlite"), "restored");
    await createBackupArchive({ archivePath, sourceStateDir, restoredStateDir });
    vi.stubEnv("OPENCLAW_STATE_DIR", sourceStateDir);

    const runtime = createRuntime();
    const result = await backupRestoreCommand(runtime, { archive: archivePath, dryRun: true });

    expect(result?.dryRun).toBe(true);
    expect(result?.databaseSnapshotCount).toBe(1);
    expect(result?.restoredAssets).toEqual([
      expect.objectContaining({ kind: "state", sourcePath: sourceStateDir, status: "planned" }),
    ]);
    expect(await fs.readFile(path.join(sourceStateDir, "state.txt"), "utf8")).toBe("current\n");
  });

  it("restores verified SQLite snapshots to the current state path", async () => {
    const sourceStateDir = path.join(tempDir, "state");
    const restoredStateDir = path.join(tempDir, "snapshot-state");
    const archivePath = path.join(tempDir, "backup.tar.gz");
    await fs.mkdir(sourceStateDir, { recursive: true });
    await fs.writeFile(path.join(sourceStateDir, "state.txt"), "current\n");
    await createSqliteDb(path.join(sourceStateDir, "state", "openclaw.sqlite"), "current");
    await fs.mkdir(restoredStateDir, { recursive: true });
    await fs.writeFile(path.join(restoredStateDir, "state.txt"), "restored\n");
    await createSqliteDb(path.join(restoredStateDir, "state", "openclaw.sqlite"), "restored");
    await createBackupArchive({ archivePath, sourceStateDir, restoredStateDir });
    vi.stubEnv("OPENCLAW_STATE_DIR", sourceStateDir);

    const runtime = createRuntime();
    const result = await backupRestoreCommand(runtime, { archive: archivePath, yes: true });

    expect(result?.dryRun).toBe(false);
    expect(result?.restoredAssets).toEqual([
      expect.objectContaining({ kind: "state", sourcePath: sourceStateDir, status: "restored" }),
    ]);
    expect(await fs.readFile(path.join(sourceStateDir, "state.txt"), "utf8")).toBe("restored\n");
    expect(readSqliteValue(path.join(sourceStateDir, "state", "openclaw.sqlite"))).toBe("restored");
  });

  it("restores SQLite snapshots stored outside the asset tree", async () => {
    const sourceStateDir = path.join(tempDir, "state");
    const restoredStateDir = path.join(tempDir, "snapshot-state");
    const archivePath = path.join(tempDir, "backup-separate-db.tar.gz");
    await fs.mkdir(sourceStateDir, { recursive: true });
    await fs.writeFile(path.join(sourceStateDir, "state.txt"), "current\n");
    await createSqliteDb(path.join(sourceStateDir, "state", "openclaw.sqlite"), "current");
    await fs.mkdir(restoredStateDir, { recursive: true });
    await fs.writeFile(path.join(restoredStateDir, "state.txt"), "restored\n");
    await createBackupArchiveWithSeparateDatabaseSnapshot({
      archivePath,
      sourceStateDir,
      restoredStateDir,
    });
    vi.stubEnv("OPENCLAW_STATE_DIR", sourceStateDir);

    const runtime = createRuntime();
    const result = await backupRestoreCommand(runtime, { archive: archivePath, yes: true });

    expect(result?.databaseSnapshotCount).toBe(1);
    expect(await fs.readFile(path.join(sourceStateDir, "state.txt"), "utf8")).toBe("restored\n");
    expect(readSqliteValue(path.join(sourceStateDir, "state", "openclaw.sqlite"))).toBe("restored");
  });

  it("does not replace live state when database snapshot staging fails", async () => {
    const sourceStateDir = path.join(tempDir, "state");
    const restoredStateDir = path.join(tempDir, "snapshot-state");
    const archivePath = path.join(tempDir, "backup-separate-db-fail.tar.gz");
    await fs.mkdir(sourceStateDir, { recursive: true });
    await fs.writeFile(path.join(sourceStateDir, "state.txt"), "current\n");
    await createSqliteDb(path.join(sourceStateDir, "state", "openclaw.sqlite"), "current");
    await fs.mkdir(restoredStateDir, { recursive: true });
    await fs.writeFile(path.join(restoredStateDir, "state.txt"), "restored\n");
    await createBackupArchiveWithSeparateDatabaseSnapshot({
      archivePath,
      sourceStateDir,
      restoredStateDir,
    });
    vi.stubEnv("OPENCLAW_STATE_DIR", sourceStateDir);
    const realCopyFile = fs.copyFile.bind(fs);
    vi.spyOn(fs, "copyFile").mockImplementation(async (from, to) => {
      if (String(from).includes("/payload/database/") && String(to).endsWith("openclaw.sqlite")) {
        throw new Error("copy failed");
      }
      return await realCopyFile(from, to);
    });

    const runtime = createRuntime();
    await expect(
      backupRestoreCommand(runtime, { archive: archivePath, yes: true }),
    ).rejects.toThrow("copy failed");

    expect(await fs.readFile(path.join(sourceStateDir, "state.txt"), "utf8")).toBe("current\n");
    expect(readSqliteValue(path.join(sourceStateDir, "state", "openclaw.sqlite"))).toBe("current");
  });

  it("does not trust archived source paths as restore destinations", async () => {
    const currentStateDir = path.join(tempDir, "current-state");
    const archivedSourceStateDir = path.join(tempDir, "archived-machine-state");
    const restoredStateDir = path.join(tempDir, "snapshot-state");
    const archivePath = path.join(tempDir, "backup.tar.gz");
    await fs.mkdir(currentStateDir, { recursive: true });
    await fs.writeFile(path.join(currentStateDir, "state.txt"), "current\n");
    await createSqliteDb(path.join(currentStateDir, "state", "openclaw.sqlite"), "current");
    await fs.mkdir(archivedSourceStateDir, { recursive: true });
    await fs.writeFile(path.join(archivedSourceStateDir, "state.txt"), "archived-machine\n");
    await fs.mkdir(restoredStateDir, { recursive: true });
    await fs.writeFile(path.join(restoredStateDir, "state.txt"), "restored\n");
    await createSqliteDb(path.join(restoredStateDir, "state", "openclaw.sqlite"), "restored");
    await createBackupArchive({
      archivePath,
      sourceStateDir: archivedSourceStateDir,
      restoredStateDir,
    });
    vi.stubEnv("OPENCLAW_STATE_DIR", currentStateDir);

    const runtime = createRuntime();
    const result = await backupRestoreCommand(runtime, { archive: archivePath, yes: true });

    expect(result?.restoredAssets).toEqual([
      expect.objectContaining({
        kind: "state",
        originalSourcePath: archivedSourceStateDir,
        sourcePath: currentStateDir,
        status: "restored",
      }),
    ]);
    expect(await fs.readFile(path.join(currentStateDir, "state.txt"), "utf8")).toBe("restored\n");
    expect(readSqliteValue(path.join(currentStateDir, "state", "openclaw.sqlite"))).toBe(
      "restored",
    );
    expect(await fs.readFile(path.join(archivedSourceStateDir, "state.txt"), "utf8")).toBe(
      "archived-machine\n",
    );
  });

  it("restores workspace assets even when the current config is unreadable", async () => {
    const currentWorkspaceDir = path.join(tempDir, "workspace");
    const restoredWorkspaceDir = path.join(tempDir, "snapshot-workspace");
    const archivePath = path.join(tempDir, "workspace-backup.tar.gz");
    const configPath = path.join(tempDir, "openclaw.json");
    await fs.mkdir(currentWorkspaceDir, { recursive: true });
    await fs.writeFile(path.join(currentWorkspaceDir, "project.txt"), "current\n");
    await fs.mkdir(restoredWorkspaceDir, { recursive: true });
    await fs.writeFile(path.join(restoredWorkspaceDir, "project.txt"), "restored\n");
    await fs.writeFile(configPath, "{", "utf8");
    await createWorkspaceBackupArchive({
      archivePath,
      sourceWorkspaceDir: currentWorkspaceDir,
      restoredWorkspaceDir,
    });
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    vi.spyOn(process, "cwd").mockReturnValue(currentWorkspaceDir);

    const runtime = createRuntime();
    const result = await backupRestoreCommand(runtime, { archive: archivePath, yes: true });

    expect(result?.restoredAssets).toEqual([
      expect.objectContaining({
        kind: "workspace",
        sourcePath: currentWorkspaceDir,
        status: "restored",
      }),
    ]);
    expect(await fs.readFile(path.join(currentWorkspaceDir, "project.txt"), "utf8")).toBe(
      "restored\n",
    );
  });

  it("rejects workspace restores outside the current workspace", async () => {
    const currentWorkspaceDir = path.join(tempDir, "workspace");
    const archivedWorkspaceDir = path.join(tempDir, "other-workspace");
    const restoredWorkspaceDir = path.join(tempDir, "snapshot-workspace");
    const archivePath = path.join(tempDir, "workspace-backup.tar.gz");
    await fs.mkdir(currentWorkspaceDir, { recursive: true });
    await fs.mkdir(archivedWorkspaceDir, { recursive: true });
    await fs.writeFile(path.join(archivedWorkspaceDir, "project.txt"), "current\n");
    await fs.mkdir(restoredWorkspaceDir, { recursive: true });
    await fs.writeFile(path.join(restoredWorkspaceDir, "project.txt"), "restored\n");
    await createWorkspaceBackupArchive({
      archivePath,
      sourceWorkspaceDir: archivedWorkspaceDir,
      restoredWorkspaceDir,
    });
    vi.spyOn(process, "cwd").mockReturnValue(currentWorkspaceDir);

    const runtime = createRuntime();
    await expect(
      backupRestoreCommand(runtime, { archive: archivePath, yes: true }),
    ).rejects.toThrow("Refusing to restore workspace asset");
    expect(await fs.readFile(path.join(archivedWorkspaceDir, "project.txt"), "utf8")).toBe(
      "current\n",
    );
  });
});

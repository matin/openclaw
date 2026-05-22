import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { resolveConfigPath, resolveOAuthDir, resolveStateDir } from "../config/config.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { shortenHomePath, resolveUserPath } from "../utils.js";
import { type BackupAssetKind } from "./backup-shared.js";
import { verifyBackupArchive } from "./backup-verify.js";

export type BackupRestoreOptions = {
  archive: string;
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
};

export type BackupRestoreResult = {
  archivePath: string;
  archiveRoot: string;
  dryRun: boolean;
  verified: true;
  restoredAssets: Array<{
    kind: string;
    originalSourcePath: string;
    sourcePath: string;
    archivePath: string;
    status: "planned" | "restored";
  }>;
  databaseSnapshotCount: number;
};

function extractedArchivePath(tempDir: string, archivePath: string): string {
  return path.join(tempDir, ...archivePath.split("/"));
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

async function replacePathFromExtracted(params: {
  extractedPath: string;
  targetPath: string;
}): Promise<void> {
  const targetPath = path.resolve(params.targetPath);
  const parentDir = path.dirname(targetPath);
  await fs.mkdir(parentDir, { recursive: true });
  const stagingPath = path.join(parentDir, `.${path.basename(targetPath)}.${randomUUID()}.restore`);
  const oldPath = `${stagingPath}.old`;
  await fs.rm(stagingPath, { recursive: true, force: true });
  await fs.cp(params.extractedPath, stagingPath, {
    recursive: true,
    verbatimSymlinks: true,
  });
  const hadExisting = await pathExists(targetPath);
  try {
    if (hadExisting) {
      await fs.rename(targetPath, oldPath);
    }
    await fs.rename(stagingPath, targetPath);
    if (hadExisting) {
      await fs.rm(oldPath, { recursive: true, force: true });
    }
  } catch (err) {
    await fs.rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
    if (hadExisting && !(await pathExists(targetPath)) && (await pathExists(oldPath))) {
      await fs.rename(oldPath, targetPath).catch(() => undefined);
    }
    throw err;
  }
}

function normalizeRestoreAssetKind(kind: string): BackupAssetKind {
  switch (kind) {
    case "state":
    case "config":
    case "credentials":
    case "workspace":
      return kind;
    default:
      throw new Error(`Backup restore does not support asset kind: ${kind}`);
  }
}

function isSamePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

function isPathWithin(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function resolveCurrentWorkingDirectory(): string {
  try {
    return process.cwd();
  } catch {
    return ".";
  }
}

function resolveAllowedWorkspaceRestoreTargets(): string[] {
  return [
    path.resolve(resolveCurrentWorkingDirectory()),
    path.resolve(resolveStateDir(), "workspace"),
  ];
}

function assertAllowedWorkspaceRestoreTarget(targetPath: string): void {
  const target = path.resolve(targetPath);
  const allowedTargets = resolveAllowedWorkspaceRestoreTargets();
  if (allowedTargets.some((allowedTarget) => isSamePath(target, allowedTarget))) {
    return;
  }
  throw new Error(
    `Refusing to restore workspace asset to ${shortenHomePath(
      target,
    )}. Run restore from that workspace directory or restore the workspace manually from the verified archive.`,
  );
}

function resolveBackupRestoreTarget(params: { kind: string; sourcePath: string }): string {
  const kind = normalizeRestoreAssetKind(params.kind);
  switch (kind) {
    case "state":
      return path.resolve(resolveStateDir());
    case "config":
      return path.resolve(resolveConfigPath());
    case "credentials":
      return path.resolve(resolveOAuthDir());
    case "workspace": {
      const targetPath = path.resolve(params.sourcePath);
      assertAllowedWorkspaceRestoreTarget(targetPath);
      return targetPath;
    }
  }
  throw new Error("Backup restore does not support the requested asset kind.");
}

async function resolveBackupRestoreAssets(
  assets: Array<{ kind: string; sourcePath: string; archivePath: string }>,
): Promise<BackupRestoreResult["restoredAssets"]> {
  const seenTargets = new Set<string>();
  const restoredAssets: BackupRestoreResult["restoredAssets"] = [];
  for (const asset of assets) {
    const sourcePath = resolveBackupRestoreTarget({
      kind: asset.kind,
      sourcePath: asset.sourcePath,
    });
    const targetKey = path.resolve(sourcePath);
    if (seenTargets.has(targetKey)) {
      throw new Error(`Backup restore contains duplicate target path: ${sourcePath}`);
    }
    seenTargets.add(targetKey);
    restoredAssets.push({
      kind: asset.kind,
      originalSourcePath: asset.sourcePath,
      sourcePath,
      archivePath: asset.archivePath,
      status: "planned",
    });
  }
  return restoredAssets;
}

function resolveDatabaseSnapshotStageTarget(
  tempDir: string,
  snapshot: { sourcePath: string },
  restoredAssets: BackupRestoreResult["restoredAssets"],
): string {
  const sourcePath = path.resolve(snapshot.sourcePath);
  const owner = restoredAssets.find((asset) => isPathWithin(sourcePath, asset.originalSourcePath));
  if (!owner) {
    throw new Error(`Backup database snapshot is outside restored assets: ${snapshot.sourcePath}`);
  }
  const extractedAssetPath = extractedArchivePath(tempDir, owner.archivePath);
  return path.join(
    extractedAssetPath,
    path.relative(path.resolve(owner.originalSourcePath), sourcePath),
  );
}

async function stageDatabaseSnapshots(params: {
  tempDir: string;
  snapshots: NonNullable<
    Awaited<ReturnType<typeof verifyBackupArchive>>["manifest"]["databaseSnapshots"]
  >;
  restoredAssets: BackupRestoreResult["restoredAssets"];
  dryRun: boolean;
}): Promise<void> {
  for (const snapshot of params.snapshots) {
    const extractedPath = extractedArchivePath(params.tempDir, snapshot.archivePath);
    await fs.access(extractedPath);
    if (params.dryRun) {
      continue;
    }
    const targetPath = resolveDatabaseSnapshotStageTarget(
      params.tempDir,
      snapshot,
      params.restoredAssets,
    );
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(extractedPath, targetPath);
  }
}

function formatBackupRestoreSummary(result: BackupRestoreResult): string[] {
  const lines = [
    `Backup archive: ${result.archivePath}`,
    `Archive root: ${result.archiveRoot}`,
    `Database snapshots: ${result.databaseSnapshotCount}`,
  ];
  lines.push(
    `${result.dryRun ? "Would restore" : "Restored"} ${result.restoredAssets.length} path${
      result.restoredAssets.length === 1 ? "" : "s"
    }:`,
  );
  for (const asset of result.restoredAssets) {
    lines.push(`- ${asset.kind}: ${shortenHomePath(asset.sourcePath)}`);
  }
  if (result.dryRun) {
    lines.push("Dry run only; no files were changed.");
  }
  return lines;
}

export async function backupRestoreCommand(
  runtime: RuntimeEnv,
  opts: BackupRestoreOptions,
): Promise<BackupRestoreResult | undefined> {
  const archivePath = resolveUserPath(opts.archive);
  const dryRun = Boolean(opts.dryRun);
  if (!dryRun && !opts.yes) {
    runtime.error("Backup restore requires --yes. Preview first with --dry-run.");
    runtime.exit(1);
    return undefined;
  }

  const verified = await verifyBackupArchive({ archive: archivePath });

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-restore-"));
  try {
    await tar.x({
      file: archivePath,
      gzip: true,
      cwd: tempDir,
    });
    const { manifest } = verified;
    const restoredAssets = await resolveBackupRestoreAssets(manifest.assets);
    await stageDatabaseSnapshots({
      tempDir,
      snapshots: manifest.databaseSnapshots ?? [],
      restoredAssets,
      dryRun,
    });
    for (const asset of restoredAssets) {
      const extractedPath = extractedArchivePath(tempDir, asset.archivePath);
      await fs.access(extractedPath);
      if (!dryRun) {
        await replacePathFromExtracted({
          extractedPath,
          targetPath: asset.sourcePath,
        });
        asset.status = "restored";
      }
    }

    const result: BackupRestoreResult = {
      archivePath,
      archiveRoot: verified.result.archiveRoot,
      dryRun,
      verified: true,
      restoredAssets,
      databaseSnapshotCount: manifest.databaseSnapshots?.length ?? 0,
    };
    if (opts.json) {
      writeRuntimeJson(runtime, result);
    } else {
      runtime.log(formatBackupRestoreSummary(result).join("\n"));
    }
    return result;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

import fs from "node:fs/promises";
import path from "node:path";
import {
  readConfigFileSnapshot,
  recoverConfigFromJsonRootSuffix,
  recoverConfigFromLastKnownGood,
} from "../config/io.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import type { LegacyConfigIssue } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { note } from "../terminal/note.js";
import { resolveHomeDir } from "../utils.js";
import { noteIncludeConfinementWarning } from "./doctor-config-analysis.js";
import { findDoctorLegacyConfigIssues } from "./doctor/shared/legacy-config-issues.js";

const SKELETAL_CONFIG_TOP_LEVEL_KEYS = new Set(["$schema", "_meta", "meta", "update"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSkeletalOpenClawConfig(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return Object.keys(value).every((key) => SKELETAL_CONFIG_TOP_LEVEL_KEYS.has(key));
}

async function shouldReplaceWithSiblingMoltbotConfig(targetPath: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(targetPath, "utf-8");
    return isSkeletalOpenClawConfig(JSON.parse(raw));
  } catch {
    return false;
  }
}

function legacyConfigBackupPath(targetPath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  return `${targetPath}.pre-moltbot-migration.${stamp}`;
}

function legacyConfigTempPath(targetPath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  return `${targetPath}.moltbot-migration.${stamp}.tmp`;
}

async function copyLegacyConfigIntoPlace(params: {
  backupPath?: string;
  legacyPath: string;
  targetPath: string;
}): Promise<void> {
  const tempPath = legacyConfigTempPath(params.targetPath);
  let backedUp = false;
  await fs.copyFile(params.legacyPath, tempPath);
  await fs.chmod(tempPath, 0o600).catch(() => {});
  try {
    if (params.backupPath) {
      await fs.rename(params.targetPath, params.backupPath);
      backedUp = true;
      await fs.rename(tempPath, params.targetPath);
    } else {
      await fs.copyFile(tempPath, params.targetPath, fs.constants.COPYFILE_EXCL);
      await fs.unlink(tempPath).catch(() => {});
    }
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {});
    if (backedUp && params.backupPath) {
      await fs.rename(params.backupPath, params.targetPath).catch(() => {});
    }
    throw error;
  }
}

async function maybeMigrateLegacyConfig(options: {
  allowSkeletalReplacement: boolean;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const home = resolveHomeDir();
  if (!home) {
    return { changes, warnings };
  }

  const targetDir = path.join(home, ".openclaw");
  const targetPath = path.join(targetDir, "openclaw.json");
  const siblingMoltbotPath = path.join(targetDir, "moltbot.json");
  let targetExists = false;
  try {
    await fs.access(targetPath);
    targetExists = true;
  } catch {
    // missing config
  }

  const targetIsSkeletal =
    targetExists && (await shouldReplaceWithSiblingMoltbotConfig(targetPath));
  if (targetIsSkeletal && !options.allowSkeletalReplacement) {
    try {
      await fs.access(siblingMoltbotPath);
      warnings.push(
        `Found legacy sibling config at ${siblingMoltbotPath}; run openclaw doctor --fix to recover it into ${targetPath}.`,
      );
    } catch {
      // no sibling config to recover
    }
  }

  const legacyCandidates = [
    ...(targetIsSkeletal && options.allowSkeletalReplacement ? [siblingMoltbotPath] : []),
    ...(!targetExists ? [siblingMoltbotPath, path.join(home, ".clawdbot", "clawdbot.json")] : []),
  ];

  let legacyPath: string | null = null;
  for (const candidate of legacyCandidates) {
    try {
      await fs.access(candidate);
      legacyPath = candidate;
      break;
    } catch {
      // continue
    }
  }
  if (!legacyPath) {
    return { changes, warnings };
  }

  await fs.mkdir(targetDir, { recursive: true });
  let backupPath: string | undefined;
  if (targetExists) {
    backupPath = legacyConfigBackupPath(targetPath);
  }
  try {
    await copyLegacyConfigIntoPlace({
      backupPath,
      legacyPath,
      targetPath,
    });
    if (backupPath) {
      changes.push(`Backed up skeletal config: ${targetPath} -> ${backupPath}`);
    }
    changes.push(`Migrated legacy config: ${legacyPath} -> ${targetPath}`);
  } catch {
    if (targetExists) {
      warnings.push(`Skipped legacy config migration after copy failed: ${legacyPath}`);
    }
  }

  return { changes, warnings };
}

export type DoctorConfigPreflightResult = {
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
  baseConfig: OpenClawConfig;
};

function collectDoctorLegacyIssues(
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
): LegacyConfigIssue[] {
  if (!snapshot.exists) {
    return [];
  }
  const resolvedRaw = snapshot.sourceConfig ?? snapshot.config ?? {};
  const sourceRaw = snapshot.parsed ?? resolvedRaw;
  return findDoctorLegacyConfigIssues(resolvedRaw, sourceRaw);
}

function addDoctorLegacyIssues(
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
): Awaited<ReturnType<typeof readConfigFileSnapshot>> {
  const legacyIssues = collectDoctorLegacyIssues(snapshot);
  if (legacyIssues.length === 0) {
    return snapshot;
  }
  return { ...snapshot, legacyIssues };
}

export function shouldSkipPluginValidationForDoctorConfigPreflight(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isTruthyEnvValue(env.OPENCLAW_UPDATE_IN_PROGRESS);
}

export async function runDoctorConfigPreflight(
  options: {
    migrateState?: boolean;
    migrateLegacyConfig?: boolean;
    repairPrefixedConfig?: boolean;
    invalidConfigNote?: string | false;
  } = {},
): Promise<DoctorConfigPreflightResult> {
  if (options.migrateState !== false) {
    const { autoMigrateLegacyStateDir } = await import("./doctor-state-migrations.js");
    const stateDirResult = await autoMigrateLegacyStateDir({ env: process.env });
    if (stateDirResult.changes.length > 0) {
      note(stateDirResult.changes.map((entry) => `- ${entry}`).join("\n"), "Doctor changes");
    }
    if (stateDirResult.warnings.length > 0) {
      note(stateDirResult.warnings.map((entry) => `- ${entry}`).join("\n"), "Doctor warnings");
    }
  }

  if (options.migrateLegacyConfig !== false) {
    const legacyConfigResult = await maybeMigrateLegacyConfig({
      allowSkeletalReplacement: options.repairPrefixedConfig === true,
    });
    if (legacyConfigResult.changes.length > 0) {
      note(legacyConfigResult.changes.map((entry) => `- ${entry}`).join("\n"), "Doctor changes");
    }
    if (legacyConfigResult.warnings.length > 0) {
      note(legacyConfigResult.warnings.map((entry) => `- ${entry}`).join("\n"), "Config warnings");
    }
  }

  const readOptions = {
    skipPluginValidation: shouldSkipPluginValidationForDoctorConfigPreflight(),
  };
  let snapshot = addDoctorLegacyIssues(await readConfigFileSnapshot(readOptions));
  if (options.repairPrefixedConfig === true && snapshot.exists && !snapshot.valid) {
    if (await recoverConfigFromJsonRootSuffix(snapshot)) {
      note("Removed non-JSON prefix from openclaw.json; original saved as .clobbered.*.", "Config");
      snapshot = addDoctorLegacyIssues(await readConfigFileSnapshot(readOptions));
    } else if (
      await recoverConfigFromLastKnownGood({ snapshot, reason: "doctor-invalid-config" })
    ) {
      note(
        "Restored openclaw.json from last-known-good; original saved as .clobbered.*.",
        "Config",
      );
      snapshot = addDoctorLegacyIssues(await readConfigFileSnapshot(readOptions));
    }
  }
  const invalidConfigNote =
    options.invalidConfigNote ?? "Config invalid; doctor will run with best-effort config.";
  if (
    invalidConfigNote &&
    snapshot.exists &&
    !snapshot.valid &&
    snapshot.legacyIssues.length === 0
  ) {
    note(invalidConfigNote, "Config");
    noteIncludeConfinementWarning(snapshot);
  }

  const warnings = snapshot.warnings ?? [];
  if (warnings.length > 0) {
    note(formatConfigIssueLines(warnings, "-").join("\n"), "Config warnings");
  }

  return {
    snapshot,
    baseConfig: snapshot.sourceConfig ?? snapshot.config ?? {},
  };
}

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import type { TranscriptEntry } from "../../agents/transcript/session-transcript-types.js";
import {
  listBundledChannelDoctorSessionMigrationSurfaces,
  listBundledChannelDoctorLegacyStateDetectors,
} from "../../channels/plugins/bundled.js";
import type { ChannelDoctorLegacyStateMigrationPlan } from "../../channels/plugins/types.core.js";
import {
  CONFIG_AUDIT_NAMESPACE,
  CONFIG_AUDIT_OWNER_ID,
  redactConfigAuditArgv,
} from "../../config/io.audit.js";
import {
  normalizeEnvPathOverride,
  resolveLegacyStateDirs,
  resolveNewStateDir,
  resolveOAuthDir,
  resolveStateDir,
} from "../../config/paths.js";
import type { SessionEntry } from "../../config/sessions.js";
import { canonicalizeMainSessionAlias } from "../../config/sessions/main-session.js";
import { mergeSqliteSessionEntries } from "../../config/sessions/session-entries.sqlite.js";
import { mergeSqliteSessionTranscriptEvents } from "../../config/sessions/transcript-store.sqlite.js";
import type { SessionScope } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { CRESTODIAN_AUDIT_NAMESPACE, CRESTODIAN_AUDIT_OWNER_ID } from "../../crestodian/audit.js";
import {
  CRESTODIAN_RESCUE_PENDING_NAMESPACE,
  CRESTODIAN_RESCUE_PENDING_OWNER_ID,
  isRescuePendingOperation,
} from "../../crestodian/rescue-pending-state.js";
import { resolveRequiredHomeDir } from "../../infra/home-dir.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { normalizeConversationRef } from "../../infra/outbound/session-binding-normalization.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding.types.js";
import { isWithinDir } from "../../infra/path-safety.js";
import {
  buildAgentMainSessionKey,
  DEFAULT_AGENT_ID,
  DEFAULT_MAIN_KEY,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../../shared/string-coerce.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  recordOpenClawStateMigrationSource,
  recordOpenClawStateMigrationRun,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { migrateLegacyTranscriptEntries } from "./legacy/session-transcript.js";
import {
  ensureDir,
  existsDir,
  fileExists,
  readSessionStoreJson5,
  type SessionEntryLike,
  safeReadDir,
} from "./state-migrations.fs.js";

export type LegacyStateDetection = {
  targetAgentId: string;
  targetMainKey: string;
  targetScope?: SessionScope;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  oauthDir: string;
  sessions: {
    legacyDir: string;
    legacyStorePath: string;
    agentLegacyDir: string;
    agentLegacyStorePath: string;
    agentLegacyStores: LegacyAgentSessionStoreDetection[];
    hasLegacy: boolean;
    legacyKeys: string[];
  };
  agentDir: {
    legacyDir: string;
    targetDir: string;
    hasLegacy: boolean;
  };
  channelPlans: {
    hasLegacy: boolean;
    plans: ChannelDoctorLegacyStateMigrationPlan[];
  };
  preview: string[];
};

let autoMigrateStateDirChecked = false;

type DoctorSessionMigrationSurface = {
  isLegacyGroupSessionKey?: (key: string) => boolean;
  canonicalizeLegacySessionKey?: (params: {
    key: string;
    agentId: string;
  }) => string | null | undefined;
};

type LegacyAgentSessionStoreDetection = {
  agentId: string;
  legacyDir: string;
  legacyStorePath: string;
  hasLegacyJsonSessionStore: boolean;
  legacyKeys: string[];
};

type MigrationSourceReport = {
  kind: string;
  sourcePath?: string;
  targetPath?: string;
  sourceTable?: string;
  targetTable?: string;
  sizeBytes?: number;
  mtimeMs?: number;
  sha256?: string;
  recordCount?: number;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseJsonlEvents(filePath: string): unknown[] {
  const raw = fs.readFileSync(filePath, "utf-8");
  const events: unknown[] = [];
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) {
      continue;
    }
    try {
      events.push(JSON.parse(line));
    } catch (err) {
      throw new Error(`Invalid JSONL at ${filePath}:${index + 1}`, { cause: err });
    }
  }
  return events;
}

function hashFileSha256(filePath: string): string | undefined {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return undefined;
  }
}

function legacyMigrationSourceKey(source: MigrationSourceReport): string {
  const digest = crypto
    .createHash("sha256")
    .update(
      [
        source.kind,
        source.sourcePath ?? "",
        source.targetPath ?? "",
        source.sourceTable ?? "",
        source.targetTable ?? "",
        source.sha256 ?? "",
        String(source.sizeBytes ?? ""),
        String(source.mtimeMs ?? ""),
        String(source.recordCount ?? ""),
      ].join("\0"),
      "utf8",
    )
    .digest("hex");
  return `legacy-state:${digest}`;
}

function recordLegacyMigrationSources(params: {
  env: NodeJS.ProcessEnv;
  importedAt: number;
  runId: string;
  sources: MigrationSourceReport[];
  status: "completed" | "failed" | "warning";
}): void {
  for (const source of params.sources) {
    if (!source.sourcePath || !source.targetTable) {
      continue;
    }
    const status = resolveLegacyMigrationSourceStatus({
      env: params.env,
      source,
      runStatus: params.status,
    });
    recordOpenClawStateMigrationSource({
      env: params.env,
      runId: params.runId,
      migrationKind: "legacy-state",
      sourceKey: legacyMigrationSourceKey(source),
      sourcePath: source.sourcePath,
      targetTable: source.targetTable,
      status,
      importedAt: params.importedAt,
      removedSource: !fileExists(source.sourcePath),
      sourceSha256: source.sha256,
      sourceSizeBytes: source.sizeBytes,
      sourceRecordCount: source.recordCount,
      report: source as unknown as Record<string, unknown>,
    });
  }
}

function resolveLegacyMigrationSourceStatus(params: {
  env: NodeJS.ProcessEnv;
  source: MigrationSourceReport;
  runStatus: "completed" | "failed" | "warning";
}): "completed" | "failed" | "warning" {
  if (params.runStatus !== "warning") {
    return params.runStatus;
  }
  if (params.source.targetPath && fileExists(params.source.targetPath)) {
    return "completed";
  }
  if (params.source.sourcePath && !fileExists(params.source.sourcePath)) {
    return "completed";
  }
  return "warning";
}

function statFileSource(params: {
  kind: string;
  sourcePath: string;
  targetPath?: string;
  targetTable?: string;
  recordCount?: number;
}): MigrationSourceReport | null {
  try {
    const stat = fs.statSync(params.sourcePath);
    if (!stat.isFile() && !stat.isDirectory()) {
      return null;
    }
    return {
      kind: params.kind,
      sourcePath: params.sourcePath,
      targetPath: params.targetPath,
      targetTable: params.targetTable,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      ...(stat.isFile() ? { sha256: hashFileSha256(params.sourcePath) } : {}),
      ...(params.recordCount !== undefined ? { recordCount: params.recordCount } : {}),
    };
  } catch {
    return null;
  }
}

function countJsonlRecords(filePath: string): number | undefined {
  try {
    return fs
      .readFileSync(filePath, "utf-8")
      .split(/\r?\n/u)
      .filter((line) => line.trim().length > 0).length;
  } catch {
    return undefined;
  }
}

function countSessionStoreRecords(filePath: string): number | undefined {
  const parsed = readSessionStoreJson5(filePath);
  return parsed.ok ? Object.keys(parsed.store).length : undefined;
}

function countLegacyDeliveryQueueRecords(queueDir: string): number {
  let count = 0;
  for (const entry of safeReadDir(queueDir)) {
    if (entry.isFile() && entry.name.endsWith(".json")) {
      count += 1;
    }
  }
  for (const entry of safeReadDir(path.join(queueDir, "failed"))) {
    if (entry.isFile() && entry.name.endsWith(".json")) {
      count += 1;
    }
  }
  return count;
}

function hasLegacyDeliveryQueueArtifacts(queueDir: string): boolean {
  return (
    countLegacyDeliveryQueueRecords(queueDir) > 0 ||
    safeReadDir(queueDir).some((entry) => entry.isFile() && entry.name.endsWith(".delivered"))
  );
}

function resolveSessionIdFromTranscriptEvents(events: unknown[]): string | null {
  for (const event of events) {
    if (
      event &&
      typeof event === "object" &&
      !Array.isArray(event) &&
      (event as { type?: unknown }).type === "session" &&
      typeof (event as { id?: unknown }).id === "string" &&
      (event as { id: string }).id.trim()
    ) {
      return (event as { id: string }).id;
    }
  }
  return null;
}

function importLegacyTranscriptFileToSqlite(params: {
  sourcePath: string;
  agentId: string;
  env?: NodeJS.ProcessEnv;
}): { imported: number; deduped: number; sessionId: string } {
  const events = parseJsonlEvents(params.sourcePath) as TranscriptEntry[];
  const header = events.find((event): event is TranscriptEntry & { version?: unknown } => {
    return event.type === "session";
  });
  const legacyReplayFingerprintDedupe = typeof header?.version !== "number" || header.version < 2;
  migrateLegacyTranscriptEntries(events);
  const sessionId = resolveSessionIdFromTranscriptEvents(events);
  if (!sessionId) {
    try {
      fs.renameSync(params.sourcePath, `${params.sourcePath}.legacy-no-header-${Date.now()}`);
    } catch {
      // Best effort. Leave the warning below if quarantine fails.
    }
    throw new Error(`Transcript missing session header: ${params.sourcePath}`);
  }
  const result = mergeSqliteSessionTranscriptEvents({
    agentId: params.agentId,
    sessionId,
    events,
    env: params.env,
    legacyReplayFingerprintDedupe,
  });
  return { imported: result.merged, deduped: result.skipped, sessionId };
}

function getDoctorSessionMigrationSurfaces(): DoctorSessionMigrationSurface[] {
  // Doctor migrations run on cold doctor/startup paths. Prefer the narrower
  // setup plugin surface here so session-key cleanup does not materialize full
  // bundled channel runtimes.
  return [...listBundledChannelDoctorSessionMigrationSurfaces()];
}

function isSurfaceGroupKey(key: string): boolean {
  return key.includes(":group:") || key.includes(":channel:");
}

function isLegacyGroupKey(key: string): boolean {
  const trimmed = key.trim();
  if (!trimmed) {
    return false;
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  if (lower.startsWith("group:") || lower.startsWith("channel:")) {
    return true;
  }
  for (const surface of getDoctorSessionMigrationSurfaces()) {
    if (surface.isLegacyGroupSessionKey?.(trimmed)) {
      return true;
    }
  }
  return false;
}

function buildLegacyMigrationPreview(plan: ChannelDoctorLegacyStateMigrationPlan): string {
  return plan.targetPath
    ? `- ${plan.label}: ${plan.sourcePath} → ${plan.targetPath}`
    : `- ${plan.label}: ${plan.sourcePath} → SQLite`;
}

async function runLegacyMigrationPlans(
  detected: LegacyStateDetection,
  plans: ChannelDoctorLegacyStateMigrationPlan[],
): Promise<{ changes: string[]; warnings: string[] }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  for (const plan of plans) {
    if (plan.kind !== "custom" && fileExists(plan.targetPath)) {
      continue;
    }
    try {
      if (plan.kind === "custom") {
        const result = await plan.apply({
          cfg: detected.cfg,
          env: detected.env,
          stateDir: detected.stateDir,
          oauthDir: detected.oauthDir,
        });
        changes.push(...result.changes);
        warnings.push(...result.warnings);
        continue;
      }
      ensureDir(path.dirname(plan.targetPath));
      if (plan.kind === "move") {
        fs.renameSync(plan.sourcePath, plan.targetPath);
        changes.push(`Moved ${plan.label} → ${plan.targetPath}`);
      } else {
        fs.copyFileSync(plan.sourcePath, plan.targetPath);
        changes.push(`Copied ${plan.label} → ${plan.targetPath}`);
      }
    } catch (err) {
      warnings.push(`Failed migrating ${plan.label} (${plan.sourcePath}): ${String(err)}`);
    }
  }
  return { changes, warnings };
}

type LegacyDeliveryQueueSpec = {
  label: string;
  queueName: string;
  sourcePath: string;
};

type LegacyDeliveryQueueRow = {
  queue_name: string;
  id: string;
  status: "pending" | "failed";
  entry_kind: string | null;
  session_key: string | null;
  channel: string | null;
  target: string | null;
  account_id: string | null;
  retry_count: number;
  last_attempt_at: number | null;
  last_error: string | null;
  recovery_state: string | null;
  platform_send_started_at: number | null;
  entry_json: string;
  enqueued_at: number;
  updated_at: number;
  failed_at: number | null;
  sourcePath: string;
};

type LegacyCurrentConversationBindingsFile = {
  version?: unknown;
  bindings?: unknown;
};

const CURRENT_CONVERSATION_BINDINGS_ID_PREFIX = "generic:";

function readLegacyQueueRecord(
  filePath: string,
  id: string,
  enqueuedAt: number,
): Record<string, unknown> {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { id, enqueuedAt, retryCount: 0 };
  }
  return {
    id,
    enqueuedAt,
    retryCount: 0,
    ...(parsed as Record<string, unknown>),
  };
}

function legacyQueueText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function legacyQueueNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

function legacyQueueRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function legacyQueueNestedText(
  record: Record<string, unknown>,
  key: string,
  field: string,
): string | null {
  return legacyQueueText(legacyQueueRecord(record[key])[field]);
}

function legacyDeliveryQueueRow(params: {
  spec: LegacyDeliveryQueueSpec;
  filePath: string;
  status: "pending" | "failed";
  enqueuedAt: number;
  failedAt: number | null;
}): LegacyDeliveryQueueRow {
  const id = path.basename(params.filePath, ".json");
  const record = readLegacyQueueRecord(params.filePath, id, params.enqueuedAt);
  const sessionKey =
    legacyQueueText(record.sessionKey) ??
    legacyQueueNestedText(record, "session", "key") ??
    legacyQueueNestedText(record, "mirror", "sessionKey");
  const channel =
    legacyQueueText(record.channel) ??
    legacyQueueNestedText(record, "route", "channel") ??
    legacyQueueNestedText(record, "deliveryContext", "channel");
  const target =
    legacyQueueText(record.to) ??
    legacyQueueNestedText(record, "route", "to") ??
    legacyQueueNestedText(record, "deliveryContext", "to");
  const accountId =
    legacyQueueText(record.accountId) ??
    legacyQueueNestedText(record, "session", "requesterAccountId") ??
    legacyQueueNestedText(record, "route", "accountId") ??
    legacyQueueNestedText(record, "deliveryContext", "accountId");
  return {
    queue_name: params.spec.queueName,
    id,
    status: params.status,
    entry_kind:
      legacyQueueText(record.kind) ??
      (params.spec.queueName === "outbound-delivery" ? "outbound" : null),
    session_key: sessionKey,
    channel,
    target,
    account_id: accountId,
    retry_count: legacyQueueNumber(record.retryCount) ?? 0,
    last_attempt_at: legacyQueueNumber(record.lastAttemptAt),
    last_error: legacyQueueText(record.lastError),
    recovery_state: legacyQueueText(record.recoveryState),
    platform_send_started_at: legacyQueueNumber(record.platformSendStartedAt),
    entry_json: JSON.stringify(record),
    enqueued_at: params.enqueuedAt,
    updated_at: Date.now(),
    failed_at: params.failedAt,
    sourcePath: params.filePath,
  };
}

function listLegacyQueueFiles(queueDir: string): {
  pending: string[];
  failed: string[];
  delivered: string[];
} {
  const pending = safeReadDir(queueDir)
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(queueDir, entry.name));
  const delivered = safeReadDir(queueDir)
    .filter((entry) => entry.isFile() && entry.name.endsWith(".delivered"))
    .map((entry) => path.join(queueDir, entry.name));
  const failedDir = path.join(queueDir, "failed");
  const failed = safeReadDir(failedDir)
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(failedDir, entry.name));
  return { pending, failed, delivered };
}

function importLegacyDeliveryQueueToSqlite(
  spec: LegacyDeliveryQueueSpec,
  env: NodeJS.ProcessEnv,
): { imported: number; removedDelivered: number } {
  const files = listLegacyQueueFiles(spec.sourcePath);
  let imported = 0;
  const rows = [
    ...files.pending.map((filePath) => ({ filePath, status: "pending" as const })),
    ...files.failed.map((filePath) => ({ filePath, status: "failed" as const })),
  ].flatMap(({ filePath, status }) => {
    try {
      const stat = fs.statSync(filePath);
      const enqueuedAt = stat.mtimeMs > 0 ? Math.trunc(stat.mtimeMs) : Date.now();
      const failedAt = status === "failed" ? enqueuedAt : null;
      return [legacyDeliveryQueueRow({ spec, filePath, status, enqueuedAt, failedAt })];
    } catch {
      return [];
    }
  });

  if (rows.length > 0) {
    const stateDatabase = openOpenClawStateDatabase({ env });
    const db = getNodeSqliteKysely<DeliveryQueueMigrationDatabase>(stateDatabase.db);
    for (const row of rows) {
      executeSqliteQuerySync(
        stateDatabase.db,
        db
          .insertInto("delivery_queue_entries")
          .values({
            queue_name: row.queue_name,
            id: row.id,
            status: row.status,
            entry_kind: row.entry_kind,
            session_key: row.session_key,
            channel: row.channel,
            target: row.target,
            account_id: row.account_id,
            retry_count: row.retry_count,
            last_attempt_at: row.last_attempt_at,
            last_error: row.last_error,
            recovery_state: row.recovery_state,
            platform_send_started_at: row.platform_send_started_at,
            entry_json: row.entry_json,
            enqueued_at: row.enqueued_at,
            updated_at: row.updated_at,
            failed_at: row.failed_at,
          })
          .onConflict((conflict) =>
            conflict.columns(["queue_name", "id"]).doUpdateSet({
              status: row.status,
              entry_kind: row.entry_kind,
              session_key: row.session_key,
              channel: row.channel,
              target: row.target,
              account_id: row.account_id,
              retry_count: row.retry_count,
              last_attempt_at: row.last_attempt_at,
              last_error: row.last_error,
              recovery_state: row.recovery_state,
              platform_send_started_at: row.platform_send_started_at,
              entry_json: row.entry_json,
              enqueued_at: row.enqueued_at,
              updated_at: row.updated_at,
              failed_at: row.failed_at,
            }),
          ),
      );
      fs.rmSync(row.sourcePath, { force: true });
      imported += 1;
    }
  }

  let removedDelivered = 0;
  for (const filePath of files.delivered) {
    fs.rmSync(filePath, { force: true });
    removedDelivered += 1;
  }
  removeDirIfEmpty(path.join(spec.sourcePath, "failed"));
  removeDirIfEmpty(spec.sourcePath);
  return { imported, removedDelivered };
}

function importLegacyAcpxGatewayInstanceIdToSqlite(
  filePath: string,
  env: NodeJS.ProcessEnv,
): { imported: number; warnings: string[] } {
  const value = fs.readFileSync(filePath, "utf8").trim();
  if (!value) {
    fs.rmSync(filePath, { force: true });
    return { imported: 0, warnings: [`Removed empty ACPX gateway instance id file: ${filePath}`] };
  }
  const stat = fs.statSync(filePath);
  const createdAt = stat.mtimeMs > 0 ? Math.trunc(stat.mtimeMs) : Date.now();
  runOpenClawStateWriteTransaction(
    (stateDatabase) => {
      const db = getNodeSqliteKysely<PluginStateMigrationDatabase>(stateDatabase.db);
      executeSqliteQuerySync(
        stateDatabase.db,
        db
          .insertInto("plugin_state_entries")
          .values({
            plugin_id: "acpx",
            namespace: "gateway-instance",
            entry_key: "current",
            value_json: JSON.stringify({ version: 1, id: value, createdAt }),
            created_at: createdAt,
            expires_at: null,
          })
          .onConflict((conflict) =>
            conflict.columns(["plugin_id", "namespace", "entry_key"]).doUpdateSet({
              value_json: (eb) => eb.ref("excluded.value_json"),
              created_at: (eb) => eb.ref("excluded.created_at"),
              expires_at: (eb) => eb.ref("excluded.expires_at"),
            }),
          ),
      );
    },
    { env },
  );
  fs.rmSync(filePath, { force: true });
  return { imported: 1, warnings: [] };
}

function legacyFileTransferAuditKey(lineNumber: number, rawLine: string): string {
  const digest = crypto.createHash("sha256").update(rawLine, "utf8").digest("hex").slice(0, 16);
  return `legacy:${lineNumber}:${digest}`;
}

function importLegacyFileTransferAuditToSqlite(
  filePath: string,
  env: NodeJS.ProcessEnv,
): { imported: number; warnings: string[] } {
  const raw = fs.readFileSync(filePath, "utf8");
  const records: Array<{
    key: string;
    valueJson: string;
    createdAt: number;
  }> = [];
  const warnings: string[] = [];
  for (const [index, line] of raw.split(/\r?\n/u).entries()) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        warnings.push(`Skipped non-object file-transfer audit record at ${filePath}:${index + 1}`);
        continue;
      }
      const timestamp =
        typeof (parsed as { timestamp?: unknown }).timestamp === "string"
          ? Date.parse((parsed as { timestamp: string }).timestamp)
          : Number.NaN;
      records.push({
        key: legacyFileTransferAuditKey(index + 1, trimmed),
        valueJson: JSON.stringify(parsed),
        createdAt: Number.isFinite(timestamp) ? timestamp : Date.now(),
      });
    } catch (err) {
      warnings.push(
        `Failed reading file-transfer audit record at ${filePath}:${index + 1}: ${String(err)}`,
      );
    }
  }

  if (records.length > 0) {
    runOpenClawStateWriteTransaction(
      (stateDatabase) => {
        const db = getNodeSqliteKysely<PluginStateMigrationDatabase>(stateDatabase.db);
        for (const record of records) {
          executeSqliteQuerySync(
            stateDatabase.db,
            db
              .insertInto("plugin_state_entries")
              .values({
                plugin_id: "file-transfer",
                namespace: "audit",
                entry_key: record.key,
                value_json: record.valueJson,
                created_at: record.createdAt,
                expires_at: null,
              })
              .onConflict((conflict) =>
                conflict.columns(["plugin_id", "namespace", "entry_key"]).doUpdateSet({
                  value_json: (eb) => eb.ref("excluded.value_json"),
                  created_at: (eb) => eb.ref("excluded.created_at"),
                  expires_at: (eb) => eb.ref("excluded.expires_at"),
                }),
              ),
          );
        }
      },
      { env },
    );
  }

  if (warnings.length === 0) {
    fs.rmSync(filePath, { force: true });
    removeDirIfEmpty(path.dirname(filePath));
  }
  return { imported: records.length, warnings };
}

function legacyCrestodianAuditKey(lineNumber: number, rawLine: string): string {
  const digest = crypto.createHash("sha256").update(rawLine, "utf8").digest("hex").slice(0, 16);
  return `legacy:${lineNumber}:${digest}`;
}

function legacyConfigAuditKey(lineNumber: number, rawLine: string): string {
  const digest = crypto.createHash("sha256").update(rawLine, "utf8").digest("hex").slice(0, 16);
  return `legacy:${lineNumber}:${digest}`;
}

function redactLegacyConfigAuditRecord(record: Record<string, unknown>): Record<string, unknown> {
  const redacted = { ...record };
  for (const key of ["argv", "execArgv"] as const) {
    const value = redacted[key];
    if (
      Array.isArray(value) &&
      value.every((entry): entry is string => typeof entry === "string")
    ) {
      redacted[key] = redactConfigAuditArgv(value);
    }
  }
  return redacted;
}

function importLegacyConfigAuditToSqlite(
  filePath: string,
  env: NodeJS.ProcessEnv,
): { imported: number; warnings: string[] } {
  const raw = fs.readFileSync(filePath, "utf8");
  const records: Array<{
    key: string;
    valueJson: string;
    createdAt: number;
  }> = [];
  const warnings: string[] = [];
  for (const [index, line] of raw.split(/\r?\n/u).entries()) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        warnings.push(`Skipped non-object config audit record at ${filePath}:${index + 1}`);
        continue;
      }
      const timestamp =
        typeof (parsed as { ts?: unknown }).ts === "string"
          ? Date.parse((parsed as { ts: string }).ts)
          : Number.NaN;
      const redacted = redactLegacyConfigAuditRecord(parsed as Record<string, unknown>);
      records.push({
        key: legacyConfigAuditKey(index + 1, trimmed),
        valueJson: JSON.stringify(redacted),
        createdAt: Number.isFinite(timestamp) ? timestamp : Date.now(),
      });
    } catch (err) {
      warnings.push(
        `Failed reading config audit record at ${filePath}:${index + 1}: ${String(err)}`,
      );
    }
  }

  if (records.length > 0) {
    runOpenClawStateWriteTransaction(
      (stateDatabase) => {
        const db = getNodeSqliteKysely<PluginStateMigrationDatabase>(stateDatabase.db);
        for (const record of records) {
          executeSqliteQuerySync(
            stateDatabase.db,
            db
              .insertInto("plugin_state_entries")
              .values({
                plugin_id: CONFIG_AUDIT_OWNER_ID,
                namespace: CONFIG_AUDIT_NAMESPACE,
                entry_key: record.key,
                value_json: record.valueJson,
                created_at: record.createdAt,
                expires_at: null,
              })
              .onConflict((conflict) =>
                conflict.columns(["plugin_id", "namespace", "entry_key"]).doUpdateSet({
                  value_json: (eb) => eb.ref("excluded.value_json"),
                  created_at: (eb) => eb.ref("excluded.created_at"),
                  expires_at: (eb) => eb.ref("excluded.expires_at"),
                }),
              ),
          );
        }
      },
      { env },
    );
  }

  if (warnings.length === 0) {
    fs.rmSync(filePath, { force: true });
    removeDirIfEmpty(path.dirname(filePath));
  }
  return { imported: records.length, warnings };
}

function importLegacyCrestodianAuditToSqlite(
  filePath: string,
  env: NodeJS.ProcessEnv,
): { imported: number; warnings: string[] } {
  const raw = fs.readFileSync(filePath, "utf8");
  const records: Array<{
    key: string;
    valueJson: string;
    createdAt: number;
  }> = [];
  const warnings: string[] = [];
  for (const [index, line] of raw.split(/\r?\n/u).entries()) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        warnings.push(`Skipped non-object Crestodian audit record at ${filePath}:${index + 1}`);
        continue;
      }
      const timestamp =
        typeof (parsed as { timestamp?: unknown }).timestamp === "string"
          ? Date.parse((parsed as { timestamp: string }).timestamp)
          : Number.NaN;
      records.push({
        key: legacyCrestodianAuditKey(index + 1, trimmed),
        valueJson: JSON.stringify(parsed),
        createdAt: Number.isFinite(timestamp) ? timestamp : Date.now(),
      });
    } catch (err) {
      warnings.push(
        `Failed reading Crestodian audit record at ${filePath}:${index + 1}: ${String(err)}`,
      );
    }
  }

  if (records.length > 0) {
    runOpenClawStateWriteTransaction(
      (stateDatabase) => {
        const db = getNodeSqliteKysely<PluginStateMigrationDatabase>(stateDatabase.db);
        for (const record of records) {
          executeSqliteQuerySync(
            stateDatabase.db,
            db
              .insertInto("plugin_state_entries")
              .values({
                plugin_id: CRESTODIAN_AUDIT_OWNER_ID,
                namespace: CRESTODIAN_AUDIT_NAMESPACE,
                entry_key: record.key,
                value_json: record.valueJson,
                created_at: record.createdAt,
                expires_at: null,
              })
              .onConflict((conflict) =>
                conflict.columns(["plugin_id", "namespace", "entry_key"]).doUpdateSet({
                  value_json: (eb) => eb.ref("excluded.value_json"),
                  created_at: (eb) => eb.ref("excluded.created_at"),
                  expires_at: (eb) => eb.ref("excluded.expires_at"),
                }),
              ),
          );
        }
      },
      { env },
    );
  }

  if (warnings.length === 0) {
    fs.rmSync(filePath, { force: true });
    removeDirIfEmpty(path.dirname(filePath));
  }
  return { imported: records.length, warnings };
}

function isLegacyPhoneControlArmState(parsed: unknown): parsed is Record<string, unknown> {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1 && record.version !== 2) {
    return false;
  }
  if (typeof record.armedAtMs !== "number") {
    return false;
  }
  if (!(record.expiresAtMs === null || typeof record.expiresAtMs === "number")) {
    return false;
  }
  if (record.version === 1) {
    return (
      Array.isArray(record.removedFromDeny) &&
      record.removedFromDeny.every((value) => typeof value === "string")
    );
  }
  const group = typeof record.group === "string" ? record.group : "";
  return (
    (group === "camera" || group === "screen" || group === "writes" || group === "all") &&
    Array.isArray(record.armedCommands) &&
    record.armedCommands.every((value) => typeof value === "string") &&
    Array.isArray(record.addedToAllow) &&
    record.addedToAllow.every((value) => typeof value === "string") &&
    Array.isArray(record.removedFromDeny) &&
    record.removedFromDeny.every((value) => typeof value === "string")
  );
}

function importLegacyPhoneControlArmStateToSqlite(
  filePath: string,
  env: NodeJS.ProcessEnv,
): { imported: number; warnings: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch (err) {
    return {
      imported: 0,
      warnings: [`Failed reading phone-control arm state ${filePath}: ${String(err)}`],
    };
  }
  if (!isLegacyPhoneControlArmState(parsed)) {
    return {
      imported: 0,
      warnings: [`Skipped invalid phone-control arm state: ${filePath}`],
    };
  }
  const stat = fs.statSync(filePath);
  const createdAt = stat.mtimeMs > 0 ? Math.trunc(stat.mtimeMs) : Date.now();
  runOpenClawStateWriteTransaction(
    (stateDatabase) => {
      const db = getNodeSqliteKysely<PluginStateMigrationDatabase>(stateDatabase.db);
      executeSqliteQuerySync(
        stateDatabase.db,
        db
          .insertInto("plugin_state_entries")
          .values({
            plugin_id: "phone-control",
            namespace: "arm-state",
            entry_key: "current",
            value_json: JSON.stringify(parsed),
            created_at: createdAt,
            expires_at: null,
          })
          .onConflict((conflict) =>
            conflict.columns(["plugin_id", "namespace", "entry_key"]).doUpdateSet({
              value_json: (eb) => eb.ref("excluded.value_json"),
              created_at: (eb) => eb.ref("excluded.created_at"),
              expires_at: (eb) => eb.ref("excluded.expires_at"),
            }),
          ),
      );
    },
    { env },
  );
  fs.rmSync(filePath, { force: true });
  removeDirIfEmpty(path.dirname(filePath));
  return { imported: 1, warnings: [] };
}

function importLegacyCrestodianRescuePendingToSqlite(
  dirPath: string,
  env: NodeJS.ProcessEnv,
): { imported: number; warnings: string[] } {
  const files = safeReadDir(dirPath)
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(dirPath, entry.name));
  const records: Array<{
    key: string;
    valueJson: string;
    createdAt: number;
    sourcePath: string;
  }> = [];
  const warnings: string[] = [];
  for (const filePath of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
      if (!isRescuePendingOperation(parsed)) {
        warnings.push(`Skipped invalid Crestodian rescue pending state: ${filePath}`);
        continue;
      }
      const createdAt = Date.parse(parsed.createdAt);
      records.push({
        key: path.basename(filePath, ".json"),
        valueJson: JSON.stringify(parsed),
        createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
        sourcePath: filePath,
      });
    } catch (err) {
      warnings.push(`Failed reading Crestodian rescue pending state ${filePath}: ${String(err)}`);
    }
  }

  if (records.length > 0) {
    runOpenClawStateWriteTransaction(
      (stateDatabase) => {
        const db = getNodeSqliteKysely<PluginStateMigrationDatabase>(stateDatabase.db);
        for (const record of records) {
          executeSqliteQuerySync(
            stateDatabase.db,
            db
              .insertInto("plugin_state_entries")
              .values({
                plugin_id: CRESTODIAN_RESCUE_PENDING_OWNER_ID,
                namespace: CRESTODIAN_RESCUE_PENDING_NAMESPACE,
                entry_key: record.key,
                value_json: record.valueJson,
                created_at: record.createdAt,
                expires_at: null,
              })
              .onConflict((conflict) =>
                conflict.columns(["plugin_id", "namespace", "entry_key"]).doUpdateSet({
                  value_json: (eb) => eb.ref("excluded.value_json"),
                  created_at: (eb) => eb.ref("excluded.created_at"),
                  expires_at: (eb) => eb.ref("excluded.expires_at"),
                }),
              ),
          );
        }
      },
      { env },
    );
  }

  if (warnings.length === 0) {
    for (const record of records) {
      fs.rmSync(record.sourcePath, { force: true });
    }
    removeDirIfEmpty(dirPath);
    removeDirIfEmpty(path.dirname(dirPath));
  }
  return { imported: records.length, warnings };
}

function buildCurrentConversationKey(record: SessionBindingRecord): string | null {
  if (!record?.conversation?.conversationId) {
    return null;
  }
  const conversation = normalizeConversationRef(record.conversation);
  const targetSessionKey = record.targetSessionKey?.trim() ?? "";
  if (!conversation.channel || !conversation.conversationId || !targetSessionKey) {
    return null;
  }
  return [
    conversation.channel,
    conversation.accountId,
    conversation.parentConversationId ?? "",
    conversation.conversationId,
  ].join("\u241f");
}

function normalizeCurrentConversationKind(value: unknown): "channel" | "direct" | "group" {
  return value === "channel" || value === "group" || value === "direct" ? value : "direct";
}

function metadataTextValue(
  record: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function importLegacyCurrentConversationBindingsToSqlite(
  filePath: string,
  env: NodeJS.ProcessEnv,
): { imported: number; warnings: string[] } {
  let parsed: LegacyCurrentConversationBindingsFile | undefined;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as LegacyCurrentConversationBindingsFile;
  } catch (err) {
    return {
      imported: 0,
      warnings: [`Failed reading current conversation bindings ${filePath}: ${String(err)}`],
    };
  }
  const bindings = parsed?.version === 1 && Array.isArray(parsed.bindings) ? parsed.bindings : [];
  const stat = fs.statSync(filePath);
  const updatedAt = stat.mtimeMs > 0 ? Math.trunc(stat.mtimeMs) : Date.now();
  let imported = 0;
  runOpenClawStateWriteTransaction(
    (stateDatabase) => {
      const db = getNodeSqliteKysely<CurrentConversationBindingsMigrationDatabase>(
        stateDatabase.db,
      );
      for (const candidate of bindings) {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
          continue;
        }
        const record = candidate as SessionBindingRecord;
        const key = buildCurrentConversationKey(record);
        if (!key) {
          continue;
        }
        const conversation = normalizeConversationRef(record.conversation);
        const normalized: SessionBindingRecord = {
          ...record,
          bindingId: `${CURRENT_CONVERSATION_BINDINGS_ID_PREFIX}${key}`,
          targetSessionKey: record.targetSessionKey.trim(),
          conversation,
        };
        executeSqliteQuerySync(
          stateDatabase.db,
          db
            .insertInto("current_conversation_bindings")
            .values({
              binding_key: key,
              binding_id: normalized.bindingId,
              target_agent_id: resolveAgentIdFromSessionKey(normalized.targetSessionKey),
              target_session_id: metadataTextValue(normalized.metadata, "targetSessionId"),
              target_session_key: normalized.targetSessionKey,
              channel: normalized.conversation.channel,
              account_id: normalized.conversation.accountId,
              conversation_kind: normalizeCurrentConversationKind(
                normalized.conversation.conversationKind,
              ),
              parent_conversation_id: normalized.conversation.parentConversationId ?? null,
              conversation_id: normalized.conversation.conversationId,
              target_kind: normalized.targetKind,
              status: normalized.status,
              bound_at: normalized.boundAt,
              expires_at: normalized.expiresAt ?? null,
              metadata_json:
                normalized.metadata == null ? null : JSON.stringify(normalized.metadata),
              record_json: JSON.stringify(normalized),
              updated_at: updatedAt,
            })
            .onConflict((conflict) =>
              conflict.column("binding_key").doUpdateSet({
                binding_id: (eb) => eb.ref("excluded.binding_id"),
                target_agent_id: (eb) => eb.ref("excluded.target_agent_id"),
                target_session_id: (eb) => eb.ref("excluded.target_session_id"),
                target_session_key: (eb) => eb.ref("excluded.target_session_key"),
                channel: (eb) => eb.ref("excluded.channel"),
                account_id: (eb) => eb.ref("excluded.account_id"),
                conversation_kind: (eb) => eb.ref("excluded.conversation_kind"),
                parent_conversation_id: (eb) => eb.ref("excluded.parent_conversation_id"),
                conversation_id: (eb) => eb.ref("excluded.conversation_id"),
                target_kind: (eb) => eb.ref("excluded.target_kind"),
                status: (eb) => eb.ref("excluded.status"),
                bound_at: (eb) => eb.ref("excluded.bound_at"),
                expires_at: (eb) => eb.ref("excluded.expires_at"),
                metadata_json: (eb) => eb.ref("excluded.metadata_json"),
                record_json: (eb) => eb.ref("excluded.record_json"),
                updated_at: (eb) => eb.ref("excluded.updated_at"),
              }),
            ),
        );
        imported += 1;
      }
    },
    { env },
  );
  fs.rmSync(filePath, { force: true });
  return { imported, warnings: [] };
}

type LegacyClawHubSkillOrigin = {
  version: 1;
  registry: string;
  slug: string;
  installedVersion: string;
  installedAt: number;
};

type LegacyClawHubSkillRecord = LegacyClawHubSkillOrigin & {
  workspaceDir: string;
  targetDir: string;
  updatedAt: number;
};

function normalizeLegacyClawHubSlug(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const slug = raw.trim();
  if (!slug || slug.includes("/") || slug.includes("\\") || slug.includes("..")) {
    return null;
  }
  return slug;
}

function isLegacyClawHubSkillOrigin(parsed: unknown): parsed is LegacyClawHubSkillOrigin {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  const record = parsed as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.registry === "string" &&
    normalizeLegacyClawHubSlug(record.slug) !== null &&
    typeof record.installedVersion === "string" &&
    typeof record.installedAt === "number"
  );
}

function clawHubWorkspaceKey(workspaceDir: string): string {
  return crypto.createHash("sha256").update(path.resolve(workspaceDir)).digest("hex").slice(0, 24);
}

function clawHubSkillInstallKey(workspaceDir: string, slug: string): string {
  return `${clawHubWorkspaceKey(workspaceDir)}:${slug}`;
}

function resolveConfiguredClawHubWorkspaceDirs(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): string[] {
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const agentId of listAgentIds(cfg)) {
    const workspaceDir = path.resolve(resolveAgentWorkspaceDir(cfg, agentId, env));
    if (seen.has(workspaceDir)) {
      continue;
    }
    seen.add(workspaceDir);
    dirs.push(workspaceDir);
  }
  return dirs;
}

function collectLegacyClawHubSourceFiles(workspaceDir: string): string[] {
  const files: string[] = [];
  for (const dotDir of [".clawhub", ".clawdhub"]) {
    const lockPath = path.join(workspaceDir, dotDir, "lock.json");
    if (fileExists(lockPath)) {
      files.push(lockPath);
    }
  }
  const skillsDir = path.join(workspaceDir, "skills");
  for (const entry of safeReadDir(skillsDir)) {
    if (!entry.isDirectory()) {
      continue;
    }
    for (const dotDir of [".clawhub", ".clawdhub"]) {
      const originPath = path.join(skillsDir, entry.name, dotDir, "origin.json");
      if (fileExists(originPath)) {
        files.push(originPath);
      }
    }
  }
  return files.toSorted();
}

function mergeLegacyClawHubRecord(
  records: Map<string, LegacyClawHubSkillRecord>,
  record: LegacyClawHubSkillRecord,
): void {
  const existing = records.get(record.slug);
  records.set(record.slug, {
    ...existing,
    ...record,
    registry: record.registry || existing?.registry || DEFAULT_CLAWHUB_URL,
    installedVersion: record.installedVersion || existing?.installedVersion || "",
    installedAt: record.installedAt || existing?.installedAt || record.updatedAt,
    workspaceDir: path.resolve(record.workspaceDir),
    targetDir: path.resolve(record.targetDir),
    updatedAt: Math.max(record.updatedAt, existing?.updatedAt ?? 0),
  });
}

function importLegacyClawHubSkillTrackingToSqlite(
  workspaceDir: string,
  env: NodeJS.ProcessEnv,
): { imported: number; warnings: string[]; sourceFiles: string[] } {
  const sourceFiles = collectLegacyClawHubSourceFiles(workspaceDir);
  const warnings: string[] = [];
  const records = new Map<string, LegacyClawHubSkillRecord>();
  const resolvedWorkspaceDir = path.resolve(workspaceDir);

  for (const lockPath of [
    path.join(workspaceDir, ".clawhub", "lock.json"),
    path.join(workspaceDir, ".clawdhub", "lock.json"),
  ]) {
    if (!fileExists(lockPath)) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as unknown;
    } catch (err) {
      warnings.push(`Failed reading ClawHub skill lock ${lockPath}: ${String(err)}`);
      continue;
    }
    const lock = parsed as { version?: unknown; skills?: unknown };
    if (lock?.version !== 1 || !lock.skills || typeof lock.skills !== "object") {
      warnings.push(`Skipped invalid ClawHub skill lock: ${lockPath}`);
      continue;
    }
    const stat = fs.statSync(lockPath);
    const updatedAt = stat.mtimeMs > 0 ? Math.trunc(stat.mtimeMs) : Date.now();
    for (const [rawSlug, value] of Object.entries(lock.skills as Record<string, unknown>)) {
      const slug = normalizeLegacyClawHubSlug(rawSlug);
      const entry = value as { version?: unknown; installedAt?: unknown };
      if (!slug || typeof entry.version !== "string" || typeof entry.installedAt !== "number") {
        warnings.push(`Skipped invalid ClawHub skill lock entry ${rawSlug} in ${lockPath}`);
        continue;
      }
      mergeLegacyClawHubRecord(records, {
        version: 1,
        registry: DEFAULT_CLAWHUB_URL,
        slug,
        installedVersion: entry.version,
        installedAt: entry.installedAt,
        workspaceDir: resolvedWorkspaceDir,
        targetDir: path.join(resolvedWorkspaceDir, "skills", slug),
        updatedAt,
      });
    }
  }

  for (const entry of safeReadDir(path.join(workspaceDir, "skills"))) {
    if (!entry.isDirectory()) {
      continue;
    }
    const skillDir = path.join(workspaceDir, "skills", entry.name);
    for (const dotDir of [".clawhub", ".clawdhub"]) {
      const originPath = path.join(skillDir, dotDir, "origin.json");
      if (!fileExists(originPath)) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(originPath, "utf8")) as unknown;
      } catch (err) {
        warnings.push(`Failed reading ClawHub skill origin ${originPath}: ${String(err)}`);
        continue;
      }
      if (!isLegacyClawHubSkillOrigin(parsed)) {
        warnings.push(`Skipped invalid ClawHub skill origin: ${originPath}`);
        continue;
      }
      const stat = fs.statSync(originPath);
      mergeLegacyClawHubRecord(records, {
        ...parsed,
        workspaceDir: resolvedWorkspaceDir,
        targetDir: skillDir,
        updatedAt: stat.mtimeMs > 0 ? Math.trunc(stat.mtimeMs) : Date.now(),
      });
    }
  }

  if (records.size > 0) {
    runOpenClawStateWriteTransaction(
      (stateDatabase) => {
        const db = getNodeSqliteKysely<PluginStateMigrationDatabase>(stateDatabase.db);
        for (const record of records.values()) {
          executeSqliteQuerySync(
            stateDatabase.db,
            db
              .insertInto("plugin_state_entries")
              .values({
                plugin_id: CLAWHUB_SKILL_STATE_OWNER_ID,
                namespace: CLAWHUB_SKILL_STATE_NAMESPACE,
                entry_key: clawHubSkillInstallKey(record.workspaceDir, record.slug),
                value_json: JSON.stringify(record),
                created_at: record.installedAt,
                expires_at: null,
              })
              .onConflict((conflict) =>
                conflict.columns(["plugin_id", "namespace", "entry_key"]).doUpdateSet({
                  value_json: (eb) => eb.ref("excluded.value_json"),
                  created_at: (eb) => eb.ref("excluded.created_at"),
                  expires_at: (eb) => eb.ref("excluded.expires_at"),
                }),
              ),
          );
        }
      },
      { env },
    );
  }

  if (warnings.length === 0) {
    for (const sourcePath of sourceFiles) {
      fs.rmSync(sourcePath, { force: true });
      removeDirIfEmpty(path.dirname(sourcePath));
    }
    removeDirIfEmpty(path.join(workspaceDir, ".clawhub"));
    removeDirIfEmpty(path.join(workspaceDir, ".clawdhub"));
  }

  return { imported: records.size, warnings, sourceFiles };
}

function collectCoreLegacyStateMigrationPlans(params: {
  stateDir: string;
  env: NodeJS.ProcessEnv;
  cfg: OpenClawConfig;
}): ChannelDoctorLegacyStateMigrationPlan[] {
  const specs: LegacyDeliveryQueueSpec[] = [
    {
      label: "Outbound delivery queue",
      queueName: "outbound-delivery",
      sourcePath: path.join(params.stateDir, "delivery-queue"),
    },
    {
      label: "Session delivery queue",
      queueName: "session-delivery",
      sourcePath: path.join(params.stateDir, "session-delivery-queue"),
    },
  ];
  const plans: ChannelDoctorLegacyStateMigrationPlan[] = specs.flatMap((spec) => {
    if (!hasLegacyDeliveryQueueArtifacts(spec.sourcePath)) {
      return [];
    }
    return [
      {
        kind: "custom" as const,
        label: spec.label,
        sourcePath: spec.sourcePath,
        targetTable: "delivery_queue_entries",
        recordCount: countLegacyDeliveryQueueRecords(spec.sourcePath),
        apply: () => {
          const result = importLegacyDeliveryQueueToSqlite(spec, params.env);
          const changes: string[] = [];
          if (result.imported > 0) {
            changes.push(
              `Imported ${result.imported} ${spec.label.toLowerCase()} row(s) into SQLite`,
            );
          }
          if (result.removedDelivered > 0) {
            changes.push(
              `Removed ${result.removedDelivered} delivered ${spec.label.toLowerCase()} marker(s)`,
            );
          }
          return { changes, warnings: [] as string[] };
        },
      },
    ];
  });
  const pluginStateSqlitePath = resolveLegacyPluginStateSqlitePath(params.stateDir);
  if (fileExists(pluginStateSqlitePath)) {
    plans.push({
      kind: "custom",
      label: "Plugin state sidecar SQLite",
      sourcePath: pluginStateSqlitePath,
      targetTable: "plugin_state_entries",
      recordCount: countLegacyPluginStateSqliteRecords(pluginStateSqlitePath),
      apply: () => {
        const result = importLegacyPluginStateSqliteToUnified(pluginStateSqlitePath, params.env);
        return {
          changes:
            result.imported > 0
              ? [`Imported ${result.imported} legacy plugin-state row(s) into SQLite plugin state`]
              : [],
          warnings: result.warnings,
        };
      },
    });
  }
  const activeMemorySessionTogglesPath = resolveLegacyActiveMemorySessionTogglesPath(
    params.stateDir,
  );
  if (fileExists(activeMemorySessionTogglesPath)) {
    plans.push({
      kind: "custom",
      label: "Active Memory session toggles",
      sourcePath: activeMemorySessionTogglesPath,
      targetTable: "plugin_state_entries",
      recordCount: countLegacyActiveMemorySessionToggleRecords(activeMemorySessionTogglesPath),
      apply: () => {
        const result = importLegacyActiveMemorySessionTogglesToSqlite(
          activeMemorySessionTogglesPath,
          params.env,
        );
        return {
          changes:
            result.imported > 0
              ? [
                  `Imported ${result.imported} Active Memory session toggle(s) into SQLite plugin state`,
                ]
              : [],
          warnings: result.warnings,
        };
      },
    });
  }
  const acpxGatewayInstancePath = path.join(params.stateDir, "gateway-instance-id");
  if (fileExists(acpxGatewayInstancePath)) {
    plans.push({
      kind: "custom",
      label: "ACPX gateway instance id",
      sourcePath: acpxGatewayInstancePath,
      targetTable: "plugin_state_entries",
      recordCount: 1,
      apply: () => {
        const result = importLegacyAcpxGatewayInstanceIdToSqlite(
          acpxGatewayInstancePath,
          params.env,
        );
        return {
          changes:
            result.imported > 0
              ? ["Imported ACPX gateway instance id into SQLite plugin state"]
              : [],
          warnings: result.warnings,
        };
      },
    });
  }
  const configAuditPath = path.join(params.stateDir, "logs", "config-audit.jsonl");
  if (fileExists(configAuditPath)) {
    plans.push({
      kind: "custom",
      label: "Config audit log",
      sourcePath: configAuditPath,
      targetTable: "plugin_state_entries",
      recordCount: countJsonlRecords(configAuditPath),
      apply: () => {
        const result = importLegacyConfigAuditToSqlite(configAuditPath, params.env);
        return {
          changes:
            result.imported > 0
              ? [`Imported ${result.imported} config audit record(s) into SQLite plugin state`]
              : [],
          warnings: result.warnings,
        };
      },
    });
  }
  const fileTransferAuditPath = path.join(params.stateDir, "audit", "file-transfer.jsonl");
  if (fileExists(fileTransferAuditPath)) {
    plans.push({
      kind: "custom",
      label: "File transfer audit log",
      sourcePath: fileTransferAuditPath,
      targetTable: "plugin_state_entries",
      recordCount: countJsonlRecords(fileTransferAuditPath),
      apply: () => {
        const result = importLegacyFileTransferAuditToSqlite(fileTransferAuditPath, params.env);
        return {
          changes:
            result.imported > 0
              ? [
                  `Imported ${result.imported} file-transfer audit record(s) into SQLite plugin state`,
                ]
              : [],
          warnings: result.warnings,
        };
      },
    });
  }
  const crestodianAuditPath = path.join(params.stateDir, "audit", "crestodian.jsonl");
  if (fileExists(crestodianAuditPath)) {
    plans.push({
      kind: "custom",
      label: "Crestodian audit log",
      sourcePath: crestodianAuditPath,
      targetTable: "plugin_state_entries",
      recordCount: countJsonlRecords(crestodianAuditPath),
      apply: () => {
        const result = importLegacyCrestodianAuditToSqlite(crestodianAuditPath, params.env);
        return {
          changes:
            result.imported > 0
              ? [`Imported ${result.imported} Crestodian audit record(s) into SQLite plugin state`]
              : [],
          warnings: result.warnings,
        };
      },
    });
  }
  const phoneControlArmStatePath = path.join(
    params.stateDir,
    "plugins",
    "phone-control",
    "armed.json",
  );
  if (fileExists(phoneControlArmStatePath)) {
    plans.push({
      kind: "custom",
      label: "Phone Control arm state",
      sourcePath: phoneControlArmStatePath,
      targetTable: "plugin_state_entries",
      recordCount: 1,
      apply: () => {
        const result = importLegacyPhoneControlArmStateToSqlite(
          phoneControlArmStatePath,
          params.env,
        );
        return {
          changes:
            result.imported > 0
              ? ["Imported Phone Control arm state into SQLite plugin state"]
              : [],
          warnings: result.warnings,
        };
      },
    });
  }
  const crestodianRescuePendingDir = path.join(params.stateDir, "crestodian", "rescue-pending");
  const crestodianRescuePendingCount = safeReadDir(crestodianRescuePendingDir).filter(
    (entry) => entry.isFile() && entry.name.endsWith(".json"),
  ).length;
  if (crestodianRescuePendingCount > 0) {
    plans.push({
      kind: "custom",
      label: "Crestodian rescue pending approvals",
      sourcePath: crestodianRescuePendingDir,
      targetTable: "plugin_state_entries",
      recordCount: crestodianRescuePendingCount,
      apply: () => {
        const result = importLegacyCrestodianRescuePendingToSqlite(
          crestodianRescuePendingDir,
          params.env,
        );
        return {
          changes:
            result.imported > 0
              ? [
                  `Imported ${result.imported} Crestodian rescue pending approval(s) into SQLite plugin state`,
                ]
              : [],
          warnings: result.warnings,
        };
      },
    });
  }
  const currentConversationBindingsPath = path.join(
    params.stateDir,
    "bindings",
    "current-conversations.json",
  );
  if (fileExists(currentConversationBindingsPath)) {
    plans.push({
      kind: "custom",
      label: "Current conversation bindings",
      sourcePath: currentConversationBindingsPath,
      targetTable: "current_conversation_bindings",
      recordCount: 1,
      apply: () => {
        const result = importLegacyCurrentConversationBindingsToSqlite(
          currentConversationBindingsPath,
          params.env,
        );
        return {
          changes:
            result.imported > 0
              ? [`Imported ${result.imported} current conversation binding(s) into SQLite state`]
              : [],
          warnings: result.warnings,
        };
      },
    });
  }
  for (const workspaceDir of resolveConfiguredClawHubWorkspaceDirs(params.cfg, params.env)) {
    const sourceFiles = collectLegacyClawHubSourceFiles(workspaceDir);
    if (sourceFiles.length === 0) {
      continue;
    }
    plans.push({
      kind: "custom",
      label: "ClawHub skill install tracking",
      sourcePath: workspaceDir,
      targetTable: "plugin_state_entries",
      recordCount: sourceFiles.length,
      apply: () => {
        const result = importLegacyClawHubSkillTrackingToSqlite(workspaceDir, params.env);
        return {
          changes:
            result.imported > 0
              ? [
                  `Imported ${result.imported} ClawHub skill install record(s) into SQLite plugin state`,
                ]
              : [],
          warnings: result.warnings,
        };
      },
    });
  }
  return plans;
}

function canonicalizeSessionKeyForAgent(params: {
  key: string;
  agentId: string;
  mainKey: string;
  scope?: SessionScope;
  skipCrossAgentRemap?: boolean;
}): string {
  const agentId = normalizeAgentId(params.agentId);
  const raw = params.key.trim();
  if (!raw) {
    return raw;
  }
  const rawLower = normalizeLowercaseStringOrEmpty(raw);
  if (rawLower === "global" || rawLower === "unknown") {
    return rawLower;
  }

  // When shared-store guard is active, do not remap keys that belong to a
  // different agent — they are legitimate records for that agent, not orphans.
  // Legacy cross-agent main aliases are handled only by the explicit doctor
  // remap below.
  if (params.skipCrossAgentRemap) {
    const parsed = parseAgentSessionKey(raw);
    if (parsed && normalizeAgentId(parsed.agentId) !== agentId) {
      return rawLower;
    }
    if (
      agentId !== DEFAULT_AGENT_ID &&
      (rawLower === DEFAULT_MAIN_KEY || rawLower === params.mainKey)
    ) {
      return rawLower;
    }
  }

  const canonicalMain = canonicalizeMainSessionAlias({
    cfg: { session: { scope: params.scope, mainKey: params.mainKey } },
    agentId,
    sessionKey: raw,
  });
  if (canonicalMain !== raw) {
    return normalizeLowercaseStringOrEmpty(canonicalMain);
  }

  // Handle cross-agent orphaned main-session keys: "agent:main:main" or
  // "agent:main:<mainKey>" in a store belonging to a different agent (e.g.
  // "ops"). Only remap provable orphan aliases — other agent:main:* keys
  // (hooks, subagents, cron, per-sender) may be intentional cross-agent
  // references and must not be touched (#29683).
  const defaultPrefix = `agent:${DEFAULT_AGENT_ID}:`;
  if (
    rawLower.startsWith(defaultPrefix) &&
    agentId !== DEFAULT_AGENT_ID &&
    !params.skipCrossAgentRemap
  ) {
    const rest = rawLower.slice(defaultPrefix.length);
    const isOrphanAlias = rest === DEFAULT_MAIN_KEY || rest === params.mainKey;
    if (isOrphanAlias) {
      const remapped = `agent:${agentId}:${rest}`;
      const canonicalized = canonicalizeMainSessionAlias({
        cfg: { session: { scope: params.scope, mainKey: params.mainKey } },
        agentId,
        sessionKey: remapped,
      });
      return normalizeLowercaseStringOrEmpty(canonicalized);
    }
  }

  if (rawLower.startsWith("agent:")) {
    return rawLower;
  }
  if (rawLower.startsWith("subagent:")) {
    const rest = raw.slice("subagent:".length);
    return normalizeLowercaseStringOrEmpty(`agent:${agentId}:subagent:${rest}`);
  }
  // Channel-owned legacy shapes must win before the generic group/channel
  // fallback so plugin-specific legacy group keys can canonicalize to their
  // owning channel instead of the generic `...:unknown:group:...` bucket.
  for (const surface of getDoctorSessionMigrationSurfaces()) {
    const canonicalized = surface.canonicalizeLegacySessionKey?.({
      key: raw,
      agentId,
    });
    const normalizedCanonicalized = normalizeOptionalLowercaseString(canonicalized);
    if (normalizedCanonicalized) {
      return normalizedCanonicalized;
    }
  }
  if (rawLower.startsWith("group:") || rawLower.startsWith("channel:")) {
    return normalizeLowercaseStringOrEmpty(`agent:${agentId}:unknown:${raw}`);
  }
  if (isSurfaceGroupKey(raw)) {
    return normalizeLowercaseStringOrEmpty(`agent:${agentId}:${raw}`);
  }
  return normalizeLowercaseStringOrEmpty(`agent:${agentId}:${raw}`);
}

function pickLatestLegacyDirectEntry(
  store: Record<string, SessionEntryLike>,
): SessionEntryLike | null {
  let best: SessionEntryLike | null = null;
  let bestUpdated = -1;
  for (const [key, entry] of Object.entries(store)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const normalized = key.trim();
    if (!normalized) {
      continue;
    }
    if (normalized === "global") {
      continue;
    }
    if (normalized.startsWith("agent:")) {
      continue;
    }
    if (normalizeLowercaseStringOrEmpty(normalized).startsWith("subagent:")) {
      continue;
    }
    if (isLegacyGroupKey(normalized) || isSurfaceGroupKey(normalized)) {
      continue;
    }
    const updatedAt = typeof entry.updatedAt === "number" ? entry.updatedAt : 0;
    if (updatedAt > bestUpdated) {
      bestUpdated = updatedAt;
      best = entry;
    }
  }
  return best;
}

function normalizeSessionEntry(entry: SessionEntryLike): SessionEntry | null {
  const sessionId = typeof entry.sessionId === "string" ? entry.sessionId : null;
  if (!sessionId) {
    return null;
  }
  const updatedAt =
    typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)
      ? entry.updatedAt
      : Date.now();
  const normalized = { ...(entry as unknown as SessionEntry), sessionId, updatedAt };
  const rec = normalized as unknown as Record<string, unknown>;
  if (typeof rec.groupChannel !== "string" && typeof rec.room === "string") {
    rec.groupChannel = rec.room;
  }
  delete rec.room;
  return normalized;
}

function resolveUpdatedAt(entry: SessionEntryLike): number {
  return typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)
    ? entry.updatedAt
    : 0;
}

function mergeSessionEntry(params: {
  existing: SessionEntryLike | undefined;
  incoming: SessionEntryLike;
  preferIncomingOnTie?: boolean;
}): SessionEntryLike {
  if (!params.existing) {
    return params.incoming;
  }
  const existingUpdated = resolveUpdatedAt(params.existing);
  const incomingUpdated = resolveUpdatedAt(params.incoming);
  if (incomingUpdated > existingUpdated) {
    return params.incoming;
  }
  if (incomingUpdated < existingUpdated) {
    return params.existing;
  }
  return params.preferIncomingOnTie ? params.incoming : params.existing;
}

function canonicalizeSessionStore(params: {
  store: Record<string, SessionEntryLike>;
  agentId: string;
  mainKey: string;
  scope?: SessionScope;
  skipCrossAgentRemap?: boolean;
}): { store: Record<string, SessionEntryLike>; legacyKeys: string[] } {
  const canonical: Record<string, SessionEntryLike> = {};
  const meta = new Map<string, { isCanonical: boolean; updatedAt: number }>();
  const legacyKeys: string[] = [];

  for (const [key, entry] of Object.entries(params.store)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const canonicalKey = canonicalizeSessionKeyForAgent({
      key,
      agentId: params.agentId,
      mainKey: params.mainKey,
      scope: params.scope,
      skipCrossAgentRemap: params.skipCrossAgentRemap,
    });
    const isCanonical = canonicalKey === key;
    if (!isCanonical) {
      legacyKeys.push(key);
    }
    const existing = canonical[canonicalKey];
    if (!existing) {
      canonical[canonicalKey] = entry;
      meta.set(canonicalKey, { isCanonical, updatedAt: resolveUpdatedAt(entry) });
      continue;
    }

    const existingMeta = meta.get(canonicalKey);
    const incomingUpdated = resolveUpdatedAt(entry);
    const existingUpdated = existingMeta?.updatedAt ?? resolveUpdatedAt(existing);
    if (incomingUpdated > existingUpdated) {
      canonical[canonicalKey] = entry;
      meta.set(canonicalKey, { isCanonical, updatedAt: incomingUpdated });
      continue;
    }
    if (incomingUpdated < existingUpdated) {
      continue;
    }
    if (existingMeta?.isCanonical && !isCanonical) {
      continue;
    }
    if (!existingMeta?.isCanonical && isCanonical) {
      canonical[canonicalKey] = entry;
      meta.set(canonicalKey, { isCanonical, updatedAt: incomingUpdated });
      continue;
    }
  }

  return { store: canonical, legacyKeys };
}

function listLegacySessionKeys(params: {
  store: Record<string, SessionEntryLike>;
  agentId: string;
  mainKey: string;
  scope?: SessionScope;
}): string[] {
  const legacy: string[] = [];
  for (const key of Object.keys(params.store)) {
    const canonical = canonicalizeSessionKeyForAgent({
      key,
      agentId: params.agentId,
      mainKey: params.mainKey,
      scope: params.scope,
    });
    if (canonical !== key) {
      legacy.push(key);
    }
  }
  return legacy;
}

function listLegacySessionMigrationAgentIds(cfg: OpenClawConfig, targetAgentId: string): string[] {
  return Array.from(new Set([targetAgentId, ...listAgentIds(cfg)].map(normalizeAgentId)));
}

function detectAgentLegacySessionStores(params: {
  cfg: OpenClawConfig;
  includeSessions: boolean;
  stateDir: string;
  targetAgentId: string;
  targetMainKey: string;
  targetScope?: SessionScope;
}): LegacyAgentSessionStoreDetection[] {
  return listLegacySessionMigrationAgentIds(params.cfg, params.targetAgentId).map((agentId) => {
    const legacyDir = path.join(params.stateDir, "agents", agentId, "sessions");
    const legacyStorePath = path.join(legacyDir, "sessions.json");
    const hasLegacyJsonSessionStore = params.includeSessions && fileExists(legacyStorePath);
    const parsed = hasLegacyJsonSessionStore
      ? readSessionStoreJson5(legacyStorePath)
      : { store: {}, ok: true };
    const legacyKeys =
      params.includeSessions && parsed.ok
        ? listLegacySessionKeys({
            store: parsed.store,
            agentId,
            mainKey: params.targetMainKey,
            scope: params.targetScope,
          })
        : [];
    return {
      agentId,
      legacyDir,
      legacyStorePath,
      hasLegacyJsonSessionStore,
      legacyKeys,
    };
  });
}

function emptyDirOrMissing(dir: string): boolean {
  if (!existsDir(dir)) {
    return true;
  }
  return safeReadDir(dir).length === 0;
}

function removeDirIfEmpty(dir: string) {
  if (!existsDir(dir)) {
    return;
  }
  if (!emptyDirOrMissing(dir)) {
    return;
  }
  try {
    fs.rmdirSync(dir);
  } catch {
    // ignore
  }
}

type DeliveryQueueMigrationDatabase = Pick<OpenClawStateKyselyDatabase, "delivery_queue_entries">;
type CurrentConversationBindingsMigrationDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "current_conversation_bindings"
>;
type PluginStateMigrationDatabase = Pick<OpenClawStateKyselyDatabase, "plugin_state_entries">;
type PluginStateMigrationRow = Selectable<OpenClawStateKyselyDatabase["plugin_state_entries"]>;

const CLAWHUB_SKILL_STATE_OWNER_ID = "core:clawhub-skills";
const CLAWHUB_SKILL_STATE_NAMESPACE = "skill-installs";
const DEFAULT_CLAWHUB_URL = "https://clawhub.ai";
const LEGACY_PLUGIN_STATE_SIDECAR_SUFFIXES = ["", "-shm", "-wal"] as const;
const ACTIVE_MEMORY_PLUGIN_STATE_OWNER_ID = "active-memory";
const ACTIVE_MEMORY_SESSION_TOGGLES_NAMESPACE = "session-toggles";
const LEGACY_ACTIVE_MEMORY_SESSION_TOGGLES_FILE = "session-toggles.json";

function resolveLegacyPluginStateSqlitePath(stateDir: string): string {
  return path.join(stateDir, "plugin-state", "state.sqlite");
}

function resolveLegacyActiveMemorySessionTogglesPath(stateDir: string): string {
  return path.join(
    stateDir,
    "plugins",
    ACTIVE_MEMORY_PLUGIN_STATE_OWNER_ID,
    LEGACY_ACTIVE_MEMORY_SESSION_TOGGLES_FILE,
  );
}

function readLegacyPluginStateSqliteRows(sourcePath: string): {
  rows: PluginStateMigrationRow[];
  warnings: string[];
} {
  let sourceDb: DatabaseSync | undefined;
  try {
    const sqlite = requireNodeSqlite();
    sourceDb = new sqlite.DatabaseSync(sourcePath, { readOnly: true });
    const db = getNodeSqliteKysely<PluginStateMigrationDatabase>(sourceDb);
    const rows = executeSqliteQuerySync(
      sourceDb,
      db
        .selectFrom("plugin_state_entries")
        .select(["plugin_id", "namespace", "entry_key", "value_json", "created_at", "expires_at"])
        .orderBy("plugin_id", "asc")
        .orderBy("namespace", "asc")
        .orderBy("entry_key", "asc"),
    ).rows;
    return { rows, warnings: [] };
  } catch (error) {
    return {
      rows: [],
      warnings: [`Failed reading legacy plugin-state SQLite (${sourcePath}): ${String(error)}`],
    };
  } finally {
    sourceDb?.close();
  }
}

function countLegacyPluginStateSqliteRecords(sourcePath: string): number | undefined {
  const result = readLegacyPluginStateSqliteRows(sourcePath);
  return result.warnings.length === 0 ? result.rows.length : undefined;
}

function removeLegacyPluginStateSqliteFiles(sourcePath: string): void {
  for (const suffix of LEGACY_PLUGIN_STATE_SIDECAR_SUFFIXES) {
    fs.rmSync(`${sourcePath}${suffix}`, { force: true });
  }
  removeDirIfEmpty(path.dirname(sourcePath));
}

function importLegacyPluginStateSqliteToUnified(
  sourcePath: string,
  env: NodeJS.ProcessEnv,
): { imported: number; warnings: string[] } {
  const result = readLegacyPluginStateSqliteRows(sourcePath);
  if (result.warnings.length > 0) {
    return { imported: 0, warnings: result.warnings };
  }

  if (result.rows.length > 0) {
    runOpenClawStateWriteTransaction(
      (stateDatabase) => {
        const db = getNodeSqliteKysely<PluginStateMigrationDatabase>(stateDatabase.db);
        for (const row of result.rows) {
          executeSqliteQuerySync(
            stateDatabase.db,
            db
              .insertInto("plugin_state_entries")
              .values(row)
              .onConflict((conflict) =>
                conflict.columns(["plugin_id", "namespace", "entry_key"]).doUpdateSet({
                  value_json: (eb) => eb.ref("excluded.value_json"),
                  created_at: (eb) => eb.ref("excluded.created_at"),
                  expires_at: (eb) => eb.ref("excluded.expires_at"),
                }),
              ),
          );
        }
      },
      { env },
    );
  }

  removeLegacyPluginStateSqliteFiles(sourcePath);
  return { imported: result.rows.length, warnings: [] };
}

function readLegacyActiveMemorySessionToggleRows(sourcePath: string): {
  rows: PluginStateMigrationRow[];
  warnings: string[];
} {
  let fallbackUpdatedAt = 0;
  try {
    fallbackUpdatedAt = Math.trunc(fs.statSync(sourcePath).mtimeMs);
  } catch {
    // keep deterministic zero fallback when stat fails
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(sourcePath, "utf8")) as unknown;
  } catch (error) {
    return {
      rows: [],
      warnings: [`Failed reading legacy Active Memory toggles (${sourcePath}): ${String(error)}`],
    };
  }

  const sessions = asRecord(parsed)?.sessions;
  if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) {
    return { rows: [], warnings: [] };
  }

  const rows: PluginStateMigrationRow[] = [];
  for (const [rawSessionKey, rawValue] of Object.entries(sessions)) {
    const sessionKey = rawSessionKey.trim();
    const value = asRecord(rawValue);
    if (!sessionKey || value?.disabled !== true) {
      continue;
    }
    const updatedAt =
      typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)
        ? Math.trunc(value.updatedAt)
        : fallbackUpdatedAt;
    rows.push({
      plugin_id: ACTIVE_MEMORY_PLUGIN_STATE_OWNER_ID,
      namespace: ACTIVE_MEMORY_SESSION_TOGGLES_NAMESPACE,
      entry_key: sessionKey,
      value_json: JSON.stringify({
        version: 1,
        disabled: true,
        updatedAt,
      }),
      created_at: updatedAt,
      expires_at: null,
    });
  }
  return { rows, warnings: [] };
}

function countLegacyActiveMemorySessionToggleRecords(sourcePath: string): number | undefined {
  const result = readLegacyActiveMemorySessionToggleRows(sourcePath);
  return result.warnings.length === 0 ? result.rows.length : undefined;
}

function importLegacyActiveMemorySessionTogglesToSqlite(
  sourcePath: string,
  env: NodeJS.ProcessEnv,
): { imported: number; warnings: string[] } {
  const result = readLegacyActiveMemorySessionToggleRows(sourcePath);
  if (result.warnings.length > 0) {
    return { imported: 0, warnings: result.warnings };
  }

  if (result.rows.length > 0) {
    runOpenClawStateWriteTransaction(
      (stateDatabase) => {
        const db = getNodeSqliteKysely<PluginStateMigrationDatabase>(stateDatabase.db);
        for (const row of result.rows) {
          executeSqliteQuerySync(
            stateDatabase.db,
            db
              .insertInto("plugin_state_entries")
              .values(row)
              .onConflict((conflict) =>
                conflict.columns(["plugin_id", "namespace", "entry_key"]).doUpdateSet({
                  value_json: (eb) => eb.ref("excluded.value_json"),
                  created_at: (eb) => eb.ref("excluded.created_at"),
                  expires_at: (eb) => eb.ref("excluded.expires_at"),
                }),
              ),
          );
        }
      },
      { env },
    );
  }

  fs.rmSync(sourcePath, { force: true });
  removeDirIfEmpty(path.dirname(sourcePath));
  return { imported: result.rows.length, warnings: [] };
}

function collectLegacyMigrationSources(detected: LegacyStateDetection): MigrationSourceReport[] {
  const sources: MigrationSourceReport[] = [];
  const add = (source: MigrationSourceReport | null | undefined) => {
    if (source) {
      sources.push(source);
    }
  };

  add(
    statFileSource({
      kind: "session-index",
      sourcePath: detected.sessions.legacyStorePath,
      targetTable: "agent.session_entries",
      recordCount: fileExists(detected.sessions.legacyStorePath)
        ? countSessionStoreRecords(detected.sessions.legacyStorePath)
        : undefined,
    }),
  );
  for (const agentStore of detected.sessions.agentLegacyStores) {
    add(
      statFileSource({
        kind: "session-index",
        sourcePath: agentStore.legacyStorePath,
        targetTable: "agent.session_entries",
        recordCount: fileExists(agentStore.legacyStorePath)
          ? countSessionStoreRecords(agentStore.legacyStorePath)
          : undefined,
      }),
    );
  }

  for (const dir of [
    detected.sessions.legacyDir,
    ...detected.sessions.agentLegacyStores.map((store) => store.legacyDir),
  ]) {
    for (const entry of safeReadDir(dir)) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      const sourcePath = path.join(dir, entry.name);
      add(
        statFileSource({
          kind: "transcript-jsonl",
          sourcePath,
          targetTable: "agent.transcript_events",
          recordCount: countJsonlRecords(sourcePath),
        }),
      );
    }
  }

  for (const entry of safeReadDir(detected.agentDir.legacyDir)) {
    if (!entry.isFile()) {
      continue;
    }
    const sourcePath = path.join(detected.agentDir.legacyDir, entry.name);
    add(
      statFileSource({
        kind: "agent-file",
        sourcePath,
        targetPath: path.join(detected.agentDir.targetDir, entry.name),
        recordCount: 1,
      }),
    );
  }

  for (const plan of detected.channelPlans.plans) {
    add(
      statFileSource({
        kind: `channel-${plan.kind}`,
        sourcePath: plan.sourcePath,
        targetPath: plan.targetPath,
        targetTable: plan.kind === "custom" ? plan.targetTable : undefined,
        recordCount: plan.kind === "custom" ? plan.recordCount : 1,
      }),
    );
  }

  return sources.toSorted((a, b) =>
    `${a.kind}:${a.sourcePath ?? ""}:${a.sourceTable ?? ""}`.localeCompare(
      `${b.kind}:${b.sourcePath ?? ""}:${b.sourceTable ?? ""}`,
    ),
  );
}

export function resetAutoMigrateLegacyStateDirForTest() {
  autoMigrateStateDirChecked = false;
}

type StateDirMigrationResult = {
  migrated: boolean;
  skipped: boolean;
  changes: string[];
  warnings: string[];
};

function resolveSymlinkTarget(linkPath: string): string | null {
  try {
    const target = fs.readlinkSync(linkPath);
    return path.resolve(path.dirname(linkPath), target);
  } catch {
    return null;
  }
}

function formatStateDirMigration(legacyDir: string, targetDir: string): string {
  return `State dir: ${legacyDir} → ${targetDir} (legacy path now symlinked)`;
}

function isDirPath(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function isLegacyTreeSymlinkMirror(currentDir: string, realTargetDir: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return false;
  }
  if (entries.length === 0) {
    return false;
  }

  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(entryPath);
    } catch {
      return false;
    }
    if (stat.isSymbolicLink()) {
      const resolvedTarget = resolveSymlinkTarget(entryPath);
      if (!resolvedTarget) {
        return false;
      }
      let resolvedRealTarget: string;
      try {
        resolvedRealTarget = fs.realpathSync(resolvedTarget);
      } catch {
        return false;
      }
      if (!isWithinDir(realTargetDir, resolvedRealTarget)) {
        return false;
      }
      continue;
    }
    if (stat.isDirectory()) {
      if (!isLegacyTreeSymlinkMirror(entryPath, realTargetDir)) {
        return false;
      }
      continue;
    }
    return false;
  }

  return true;
}

function isLegacyDirSymlinkMirror(legacyDir: string, targetDir: string): boolean {
  let realTargetDir: string;
  try {
    realTargetDir = fs.realpathSync(targetDir);
  } catch {
    return false;
  }
  return isLegacyTreeSymlinkMirror(legacyDir, realTargetDir);
}

export async function autoMigrateLegacyStateDir(params: {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
}): Promise<StateDirMigrationResult> {
  if (autoMigrateStateDirChecked) {
    return { migrated: false, skipped: true, changes: [], warnings: [] };
  }
  autoMigrateStateDirChecked = true;

  const env = params.env ?? process.env;
  if (normalizeEnvPathOverride(env.OPENCLAW_STATE_DIR)) {
    return { migrated: false, skipped: true, changes: [], warnings: [] };
  }

  const rawHomedir = params.homedir ?? os.homedir;
  const effectiveHomedir = () => resolveRequiredHomeDir(env, rawHomedir);
  const targetDir = resolveNewStateDir(effectiveHomedir);
  const legacyDirs = resolveLegacyStateDirs(effectiveHomedir);
  let legacyDir = legacyDirs.find((dir) => {
    try {
      return fs.existsSync(dir);
    } catch {
      return false;
    }
  });
  const warnings: string[] = [];
  const changes: string[] = [];

  let legacyStat: fs.Stats | null = null;
  try {
    legacyStat = legacyDir ? fs.lstatSync(legacyDir) : null;
  } catch {
    legacyStat = null;
  }
  if (!legacyStat) {
    return { migrated: false, skipped: false, changes, warnings };
  }
  if (!legacyStat.isDirectory() && !legacyStat.isSymbolicLink()) {
    warnings.push(`Legacy state path is not a directory: ${legacyDir}`);
    return { migrated: false, skipped: false, changes, warnings };
  }

  let symlinkDepth = 0;
  while (legacyStat.isSymbolicLink()) {
    const legacyTarget = legacyDir ? resolveSymlinkTarget(legacyDir) : null;
    if (!legacyTarget) {
      warnings.push(
        `Legacy state dir is a symlink (${legacyDir ?? "unknown"}); could not resolve target.`,
      );
      return { migrated: false, skipped: false, changes, warnings };
    }
    if (path.resolve(legacyTarget) === path.resolve(targetDir)) {
      return { migrated: false, skipped: false, changes, warnings };
    }
    if (legacyDirs.some((dir) => path.resolve(dir) === path.resolve(legacyTarget))) {
      legacyDir = legacyTarget;
      try {
        legacyStat = fs.lstatSync(legacyDir);
      } catch {
        legacyStat = null;
      }
      if (!legacyStat) {
        warnings.push(`Legacy state dir missing after symlink resolution: ${legacyDir}`);
        return { migrated: false, skipped: false, changes, warnings };
      }
      if (!legacyStat.isDirectory() && !legacyStat.isSymbolicLink()) {
        warnings.push(`Legacy state path is not a directory: ${legacyDir}`);
        return { migrated: false, skipped: false, changes, warnings };
      }
      symlinkDepth += 1;
      if (symlinkDepth > 2) {
        warnings.push(`Legacy state dir symlink chain too deep: ${legacyDir}`);
        return { migrated: false, skipped: false, changes, warnings };
      }
      continue;
    }
    warnings.push(
      `Legacy state dir is a symlink (${legacyDir ?? "unknown"} → ${legacyTarget}); skipping auto-migration.`,
    );
    return { migrated: false, skipped: false, changes, warnings };
  }

  if (isDirPath(targetDir)) {
    if (legacyDir && isLegacyDirSymlinkMirror(legacyDir, targetDir)) {
      return { migrated: false, skipped: false, changes, warnings };
    }
    warnings.push(
      `State dir migration skipped: target already exists (${targetDir}). Remove or merge manually.`,
    );
    return { migrated: false, skipped: false, changes, warnings };
  }

  try {
    if (!legacyDir) {
      throw new Error("Legacy state dir not found");
    }
    fs.renameSync(legacyDir, targetDir);
  } catch (err) {
    warnings.push(
      `Failed to move legacy state dir (${legacyDir ?? "unknown"} → ${targetDir}): ${String(err)}`,
    );
    return { migrated: false, skipped: false, changes, warnings };
  }

  try {
    if (!legacyDir) {
      throw new Error("Legacy state dir not found");
    }
    fs.symlinkSync(targetDir, legacyDir, "dir");
    changes.push(formatStateDirMigration(legacyDir, targetDir));
  } catch (err) {
    try {
      if (process.platform === "win32") {
        if (!legacyDir) {
          throw new Error("Legacy state dir not found", { cause: err });
        }
        fs.symlinkSync(targetDir, legacyDir, "junction");
        changes.push(formatStateDirMigration(legacyDir, targetDir));
      } else {
        throw err;
      }
    } catch (fallbackErr) {
      try {
        if (!legacyDir) {
          throw new Error("Legacy state dir not found", { cause: fallbackErr });
        }
        fs.renameSync(targetDir, legacyDir);
        warnings.push(
          `State dir migration rolled back (failed to link legacy path): ${String(fallbackErr)}`,
        );
        return { migrated: false, skipped: false, changes: [], warnings };
      } catch (rollbackErr) {
        warnings.push(
          `State dir moved but failed to link legacy path (${legacyDir ?? "unknown"} → ${targetDir}): ${String(fallbackErr)}`,
        );
        warnings.push(
          `Rollback failed; set OPENCLAW_STATE_DIR=${targetDir} to avoid split state: ${String(rollbackErr)}`,
        );
        changes.push(`State dir: ${legacyDir ?? "unknown"} → ${targetDir}`);
      }
    }
  }

  return { migrated: changes.length > 0, skipped: false, changes, warnings };
}

async function collectChannelDoctorLegacyStateMigrationPlans(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  oauthDir: string;
}): Promise<ChannelDoctorLegacyStateMigrationPlan[]> {
  const plans: ChannelDoctorLegacyStateMigrationPlan[] = collectCoreLegacyStateMigrationPlans({
    stateDir: params.stateDir,
    env: params.env,
    cfg: params.cfg,
  });
  // Legacy state detection belongs on a narrow setup-entry surface so doctor
  // does not cold-load unrelated runtime channel code.
  const detectors = listBundledChannelDoctorLegacyStateDetectors({ config: params.cfg });
  for (const detectLegacyStateMigrations of detectors) {
    const detected = await detectLegacyStateMigrations({
      cfg: params.cfg,
      env: params.env,
      stateDir: params.stateDir,
      oauthDir: params.oauthDir,
    });
    if (detected?.length) {
      plans.push(...detected);
    }
  }
  return plans;
}

export async function detectLegacyStateMigrations(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  includeSessions?: boolean;
  includeChannelPlans?: boolean;
}): Promise<LegacyStateDetection> {
  const env = params.env ?? process.env;
  const homedir = params.homedir ?? os.homedir;
  const includeSessions = params.includeSessions ?? true;
  const includeChannelPlans = params.includeChannelPlans ?? true;
  const stateDir = resolveStateDir(env, homedir);
  const oauthDir = resolveOAuthDir(env, stateDir);

  const targetAgentId = normalizeAgentId(resolveDefaultAgentId(params.cfg));
  const rawMainKey = params.cfg.session?.mainKey;
  const targetMainKey =
    typeof rawMainKey === "string" && rawMainKey.trim().length > 0
      ? rawMainKey.trim()
      : DEFAULT_MAIN_KEY;
  const targetScope = params.cfg.session?.scope;

  const sessionsLegacyDir = path.join(stateDir, "sessions");
  const sessionsLegacyStorePath = path.join(sessionsLegacyDir, "sessions.json");
  const legacySessionEntries = includeSessions ? safeReadDir(sessionsLegacyDir) : [];
  const hasLegacySessions =
    (includeSessions && fileExists(sessionsLegacyStorePath)) ||
    legacySessionEntries.some((e) => e.isFile() && e.name.endsWith(".jsonl"));
  const agentLegacyStores = detectAgentLegacySessionStores({
    cfg: params.cfg,
    includeSessions,
    stateDir,
    targetAgentId,
    targetMainKey,
    targetScope,
  });
  const targetAgentLegacyStore =
    agentLegacyStores.find((store) => store.agentId === targetAgentId) ?? agentLegacyStores[0];
  const sessionsAgentLegacyDir =
    targetAgentLegacyStore?.legacyDir ?? path.join(stateDir, "agents", targetAgentId, "sessions");
  const sessionsAgentLegacyStorePath =
    targetAgentLegacyStore?.legacyStorePath ?? path.join(sessionsAgentLegacyDir, "sessions.json");
  const legacyKeys = agentLegacyStores.flatMap((store) => store.legacyKeys);
  const hasAgentLegacyJsonSessionStore = agentLegacyStores.some(
    (store) => store.hasLegacyJsonSessionStore,
  );
  const hasAgentLegacyJsonlSessions = agentLegacyStores.some((store) =>
    safeReadDir(store.legacyDir).some((entry) => entry.isFile() && entry.name.endsWith(".jsonl")),
  );

  const legacyAgentDir = path.join(stateDir, "agent");
  const targetAgentDir = path.join(stateDir, "agents", targetAgentId, "agent");
  const hasLegacyAgentDir = existsDir(legacyAgentDir);
  const channelPlans = includeChannelPlans
    ? await collectChannelDoctorLegacyStateMigrationPlans({
        cfg: params.cfg,
        env,
        stateDir,
        oauthDir,
      })
    : [];

  const preview: string[] = [];
  if (hasLegacySessions) {
    preview.push(`- Sessions: import ${sessionsLegacyDir} into SQLite`);
  }
  if (legacyKeys.length > 0) {
    for (const store of agentLegacyStores.filter((store) => store.legacyKeys.length > 0)) {
      preview.push(`- Sessions: canonicalize legacy keys in ${store.legacyStorePath}`);
    }
  }
  if (hasAgentLegacyJsonSessionStore) {
    for (const store of agentLegacyStores.filter((store) => store.hasLegacyJsonSessionStore)) {
      preview.push(`- Sessions: import ${store.legacyStorePath} into SQLite`);
    }
  }
  if (hasLegacyAgentDir) {
    preview.push(`- Agent dir: ${legacyAgentDir} → ${targetAgentDir}`);
  }
  if (channelPlans.length > 0) {
    preview.push(...channelPlans.map(buildLegacyMigrationPreview));
  }

  return {
    targetAgentId,
    targetMainKey,
    targetScope,
    cfg: params.cfg,
    env,
    stateDir,
    oauthDir,
    sessions: {
      legacyDir: sessionsLegacyDir,
      legacyStorePath: sessionsLegacyStorePath,
      agentLegacyDir: sessionsAgentLegacyDir,
      agentLegacyStorePath: sessionsAgentLegacyStorePath,
      agentLegacyStores,
      hasLegacy:
        hasLegacySessions ||
        legacyKeys.length > 0 ||
        hasAgentLegacyJsonSessionStore ||
        hasAgentLegacyJsonlSessions,
      legacyKeys,
    },
    agentDir: {
      legacyDir: legacyAgentDir,
      targetDir: targetAgentDir,
      hasLegacy: hasLegacyAgentDir,
    },
    channelPlans: {
      hasLegacy: channelPlans.length > 0,
      plans: channelPlans,
    },
    preview,
  };
}

async function migrateLegacySessions(
  detected: LegacyStateDetection,
): Promise<{ changes: string[]; warnings: string[] }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  if (!detected.sessions.hasLegacy) {
    return { changes, warnings };
  }

  const legacyParsed = fileExists(detected.sessions.legacyStorePath)
    ? readSessionStoreJson5(detected.sessions.legacyStorePath)
    : { store: {}, ok: true };
  const legacyStore = legacyParsed.store;
  const canonicalizedLegacy = canonicalizeSessionStore({
    store: legacyStore,
    agentId: detected.targetAgentId,
    mainKey: detected.targetMainKey,
    scope: detected.targetScope,
  });

  if (!legacyParsed.ok) {
    warnings.push(
      `Legacy sessions store unreadable; left in place at ${detected.sessions.legacyStorePath}`,
    );
  }

  for (const agentStore of detected.sessions.agentLegacyStores) {
    const agentLegacyParsed = fileExists(agentStore.legacyStorePath)
      ? readSessionStoreJson5(agentStore.legacyStorePath)
      : { store: {}, ok: true };
    const agentLegacyStore = agentLegacyParsed.store;
    const canonicalizedAgentLegacy = canonicalizeSessionStore({
      store: agentLegacyStore,
      agentId: agentStore.agentId,
      mainKey: detected.targetMainKey,
      scope: detected.targetScope,
    });
    const merged: Record<string, SessionEntryLike> = { ...canonicalizedAgentLegacy.store };
    if (agentStore.agentId === detected.targetAgentId) {
      for (const [key, entry] of Object.entries(canonicalizedLegacy.store)) {
        merged[key] = mergeSessionEntry({
          existing: merged[key],
          incoming: entry,
          preferIncomingOnTie: false,
        });
      }

      const mainKey = buildAgentMainSessionKey({
        agentId: detected.targetAgentId,
        mainKey: detected.targetMainKey,
      });
      if (!merged[mainKey]) {
        const latest = pickLatestLegacyDirectEntry(legacyStore);
        if (latest?.sessionId) {
          merged[mainKey] = latest;
          changes.push(`Migrated latest direct-chat session → ${mainKey}`);
        }
      }
    }

    if (!agentLegacyParsed.ok) {
      warnings.push(
        `Legacy sessions store unreadable; left in place at ${agentStore.legacyStorePath}`,
      );
    }

    const hasRootLegacyForTarget =
      agentStore.agentId === detected.targetAgentId && Object.keys(legacyStore).length > 0;
    const hasAgentLegacyRows =
      Object.keys(agentLegacyStore).length > 0 ||
      (agentStore.hasLegacyJsonSessionStore && agentLegacyParsed.ok);
    if (!hasRootLegacyForTarget && !hasAgentLegacyRows) {
      continue;
    }
    if (
      agentStore.agentId === detected.targetAgentId &&
      !legacyParsed.ok &&
      !agentLegacyParsed.ok
    ) {
      continue;
    }
    if (agentStore.agentId !== detected.targetAgentId && !agentLegacyParsed.ok) {
      continue;
    }

    const normalized: Record<string, SessionEntry> = {};
    for (const [key, entry] of Object.entries(merged)) {
      const normalizedEntry = normalizeSessionEntry(entry);
      if (!normalizedEntry) {
        continue;
      }
      normalized[key] = normalizedEntry;
    }
    const imported = mergeSqliteSessionEntries(
      {
        agentId: agentStore.agentId,
        env: detected.env,
      },
      normalized,
    );
    changes.push(
      `Imported ${imported.imported} session index row(s) into SQLite for agent ${agentStore.agentId}`,
    );
    if (agentLegacyParsed.ok && fileExists(agentStore.legacyStorePath)) {
      try {
        fs.rmSync(agentStore.legacyStorePath, { force: true });
      } catch {
        // ignore
      }
    }
    if (canonicalizedAgentLegacy.legacyKeys.length > 0) {
      changes.push(
        `Canonicalized ${canonicalizedAgentLegacy.legacyKeys.length} legacy session key(s)`,
      );
    }
  }

  const entries = safeReadDir(detected.sessions.legacyDir);
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    if (entry.name === "sessions.json") {
      continue;
    }
    if (!entry.name.endsWith(".jsonl")) {
      continue;
    }
    const from = path.join(detected.sessions.legacyDir, entry.name);
    try {
      const imported = importLegacyTranscriptFileToSqlite({
        sourcePath: from,
        agentId: detected.targetAgentId,
        env: detected.env,
      });
      fs.rmSync(from, { force: true });
      const detail =
        imported.deduped > 0
          ? `(${imported.imported} new + ${imported.deduped} already-present)`
          : `(${imported.imported} event(s))`;
      changes.push(
        `Imported ${entry.name} transcript ${detail} into SQLite for agent ${detected.targetAgentId}`,
      );
    } catch (err) {
      warnings.push(`Failed importing transcript ${from}: ${String(err)}`);
    }
  }

  for (const agentStore of detected.sessions.agentLegacyStores) {
    const agentLegacyEntries = safeReadDir(agentStore.legacyDir);
    for (const entry of agentLegacyEntries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      const transcriptPath = path.join(agentStore.legacyDir, entry.name);
      try {
        const imported = importLegacyTranscriptFileToSqlite({
          sourcePath: transcriptPath,
          agentId: agentStore.agentId,
          env: detected.env,
        });
        fs.rmSync(transcriptPath, { force: true });
        const detail =
          imported.deduped > 0
            ? `(${imported.imported} new + ${imported.deduped} already-present)`
            : `(${imported.imported} event(s))`;
        changes.push(
          `Imported canonical ${entry.name} transcript ${detail} into SQLite for agent ${agentStore.agentId}`,
        );
      } catch (err) {
        warnings.push(`Failed importing transcript ${transcriptPath}: ${String(err)}`);
      }
    }
  }

  if (legacyParsed.ok) {
    try {
      if (fileExists(detected.sessions.legacyStorePath)) {
        fs.rmSync(detected.sessions.legacyStorePath, { force: true });
      }
    } catch {
      // ignore
    }
  }

  removeDirIfEmpty(detected.sessions.legacyDir);
  for (const agentStore of detected.sessions.agentLegacyStores) {
    removeDirIfEmpty(agentStore.legacyDir);
  }
  const legacyLeft = safeReadDir(detected.sessions.legacyDir).filter((e) => e.isFile());
  if (legacyLeft.length > 0) {
    warnings.push(
      `Left legacy sessions in place at ${detected.sessions.legacyDir}: ${legacyLeft
        .map((entry) => entry.name)
        .join(", ")}`,
    );
  }
  for (const agentStore of detected.sessions.agentLegacyStores) {
    const agentLegacyLeft = safeReadDir(agentStore.legacyDir).filter((e) => e.isFile());
    if (agentLegacyLeft.length > 0) {
      warnings.push(
        `Left legacy sessions in place at ${agentStore.legacyDir}: ${agentLegacyLeft
          .map((entry) => entry.name)
          .join(", ")}`,
      );
    }
  }

  return { changes, warnings };
}

export async function migrateLegacyAgentDir(
  detected: LegacyStateDetection,
  now: () => number,
): Promise<{ changes: string[]; warnings: string[] }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  if (!detected.agentDir.hasLegacy) {
    return { changes, warnings };
  }

  ensureDir(detected.agentDir.targetDir);

  const entries = safeReadDir(detected.agentDir.legacyDir);
  for (const entry of entries) {
    const from = path.join(detected.agentDir.legacyDir, entry.name);
    const to = path.join(detected.agentDir.targetDir, entry.name);
    if (fs.existsSync(to)) {
      continue;
    }
    try {
      fs.renameSync(from, to);
      changes.push(`Moved agent file ${entry.name} → agents/${detected.targetAgentId}/agent`);
    } catch (err) {
      warnings.push(`Failed moving ${from}: ${String(err)}`);
    }
  }

  removeDirIfEmpty(detected.agentDir.legacyDir);
  if (!emptyDirOrMissing(detected.agentDir.legacyDir)) {
    const backupDir = path.join(
      detected.stateDir,
      "agents",
      detected.targetAgentId,
      `agent.legacy-${now()}`,
    );
    try {
      fs.renameSync(detected.agentDir.legacyDir, backupDir);
      warnings.push(`Left legacy agent dir at ${backupDir}`);
    } catch (err) {
      warnings.push(`Failed relocating legacy agent dir: ${String(err)}`);
    }
  }

  return { changes, warnings };
}

async function migrateChannelLegacyStatePlans(
  detected: LegacyStateDetection,
): Promise<{ changes: string[]; warnings: string[] }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  if (!detected.channelPlans.hasLegacy) {
    return { changes, warnings };
  }
  return await runLegacyMigrationPlans(detected, detected.channelPlans.plans);
}

export async function runLegacyStateMigrations(params: {
  detected: LegacyStateDetection;
  now?: () => number;
  backupPath?: string;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const now = params.now ?? (() => Date.now());
  const detected = params.detected;
  const startedAt = now();
  const sources = collectLegacyMigrationSources(detected);
  try {
    const sessions = await migrateLegacySessions(detected);
    const agentDir = await migrateLegacyAgentDir(detected, now);
    const channelPlans = await migrateChannelLegacyStatePlans(detected);
    const result = {
      changes: [...sessions.changes, ...agentDir.changes, ...channelPlans.changes],
      warnings: [...sessions.warnings, ...agentDir.warnings, ...channelPlans.warnings],
    };
    const finishedAt = now();
    const status = result.warnings.length > 0 ? "warning" : "completed";
    const runId = recordOpenClawStateMigrationRun({
      env: detected.env,
      startedAt,
      finishedAt,
      status,
      report: {
        kind: "legacy-state",
        targetAgentId: detected.targetAgentId,
        stateDir: detected.stateDir,
        backupPath: params.backupPath,
        sources,
        changes: result.changes,
        warnings: result.warnings,
      },
    });
    recordLegacyMigrationSources({
      env: detected.env,
      importedAt: finishedAt,
      runId,
      sources,
      status,
    });
    return result;
  } catch (error) {
    const finishedAt = now();
    const runId = recordOpenClawStateMigrationRun({
      env: detected.env,
      startedAt,
      finishedAt,
      status: "failed",
      report: {
        kind: "legacy-state",
        targetAgentId: detected.targetAgentId,
        stateDir: detected.stateDir,
        sources,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    recordLegacyMigrationSources({
      env: detected.env,
      importedAt: finishedAt,
      runId,
      sources,
      status: "failed",
    });
    throw error;
  }
}

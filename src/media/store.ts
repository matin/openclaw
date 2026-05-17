import "../infra/fs-safe-defaults.js";
import crypto from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Insertable } from "kysely";
import { sanitizeUntrustedFileName } from "../infra/fs-safe-advanced.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { retainSafeHeadersForCrossOriginRedirect } from "../infra/net/redirect-headers.js";
import { resolvePinnedHostname } from "../infra/net/ssrf.js";
import { writeSiblingTempFile } from "../infra/sibling-temp-file.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { resolveConfigDir } from "../utils.js";
import { basenameFromAnyPath, extnameFromAnyPath, nameFromAnyPath } from "./file-name.js";
import { detectMime, extensionForMime } from "./mime.js";
import { isFsSafeError, readLocalFileSafely, type FsSafeLikeError } from "./store.runtime.js";

const resolveMediaMaterializationRoot = () => path.join(resolvePreferredOpenClawTmpDir(), "media");
export const MEDIA_MAX_BYTES = 5 * 1024 * 1024; // 5MB default
const MAX_BYTES = MEDIA_MAX_BYTES;
const DEFAULT_TTL_MS = 2 * 60 * 1000; // 2 minutes
// Temp materializations are intentionally readable by non-owner UIDs so Docker sandbox containers
// can access inbound media. SQLite remains the canonical store.
const MEDIA_FILE_MODE = 0o644;
type CleanOldMediaOptions = {
  recursive?: boolean;
  pruneEmptyDirs?: boolean;
};
type RequestImpl = typeof httpRequest;
type ResolvePinnedHostnameImpl = typeof resolvePinnedHostname;
type MediaKyselyDatabase = Pick<OpenClawStateKyselyDatabase, "media_blobs">;
type MediaBlobRow = {
  id: string;
  subdir: string;
  content_type: string | null;
  size_bytes: number;
  blob: Uint8Array;
  created_at: number;
  updated_at: number;
};
export type LegacyMediaImportResult = {
  files: number;
  imported: number;
  removed: number;
  skipped: number;
};

const defaultHttpRequestImpl: RequestImpl = httpRequest;
const defaultHttpsRequestImpl: RequestImpl = httpsRequest;
const defaultResolvePinnedHostnameImpl: ResolvePinnedHostnameImpl = resolvePinnedHostname;

function formatMediaLimitMb(maxBytes: number): string {
  return `${(maxBytes / (1024 * 1024)).toFixed(0)}MB`;
}

function resolveMediaSubdir(subdir: string, caller: string): string {
  if (typeof subdir !== "string") {
    throw new Error(`${caller}: unsafe media subdir: ${JSON.stringify(subdir)}`);
  }
  if (!subdir || subdir === ".") {
    return "";
  }
  if (
    subdir.includes("\0") ||
    path.isAbsolute(subdir) ||
    path.posix.isAbsolute(subdir) ||
    path.win32.isAbsolute(subdir)
  ) {
    throw new Error(`${caller}: unsafe media subdir: ${JSON.stringify(subdir)}`);
  }
  const segments = subdir.split(/[\\/]+/u);
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${caller}: unsafe media subdir: ${JSON.stringify(subdir)}`);
  }
  return path.join(...segments);
}

function resolveMediaScopedDir(subdir: string, caller: string): string {
  const mediaDir = resolveMediaMaterializationRoot();
  const safeSubdir = resolveMediaSubdir(subdir, caller);
  const dir = safeSubdir ? path.join(mediaDir, safeSubdir) : mediaDir;
  return dir;
}

function resolveLegacyMediaDir(env: NodeJS.ProcessEnv): string {
  return path.join(resolveConfigDir(env), "media");
}

function resolveMediaRelativePath(id: string, subdir: string, caller: string): string {
  if (!id || id.includes("/") || id.includes("\\") || id.includes("\0") || id === "..") {
    throw new Error(`${caller}: unsafe media ID: ${JSON.stringify(id)}`);
  }
  const safeSubdir = resolveMediaSubdir(subdir, caller);
  return safeSubdir ? path.join(safeSubdir, id) : id;
}

let httpRequestImpl: RequestImpl = defaultHttpRequestImpl;
let httpsRequestImpl: RequestImpl = defaultHttpsRequestImpl;
let resolvePinnedHostnameImpl: ResolvePinnedHostnameImpl = defaultResolvePinnedHostnameImpl;

function getMediaKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<MediaKyselyDatabase>(db);
}

function getMediaBlobRow(params: {
  subdir: string;
  id: string;
  state?: OpenClawStateDatabaseOptions;
}): MediaBlobRow | undefined {
  const database = openOpenClawStateDatabase(params.state);
  return executeSqliteQueryTakeFirstSync(
    database.db,
    getMediaKysely(database.db)
      .selectFrom("media_blobs")
      .selectAll()
      .where("subdir", "=", params.subdir)
      .where("id", "=", params.id),
  );
}

async function legacyMediaFileCandidates(
  root: string,
): Promise<Array<{ path: string; subdir: string; id: string }>> {
  const candidates: Array<{ path: string; subdir: string; id: string }> = [];
  async function visit(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isMissingPathError(error)) {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const relativeDir = path.relative(root, dir);
      const posixRelativeDir = relativeDir.split(path.sep).join("/");
      if (
        posixRelativeDir === "outgoing/records" ||
        posixRelativeDir.startsWith("outgoing/records/")
      ) {
        continue;
      }
      const subdir = relativeDir === "" ? "" : relativeDir;
      candidates.push({ path: entryPath, subdir, id: entry.name });
    }
  }
  await visit(root);
  return candidates;
}

async function pruneEmptyMediaDirs(dir: string, root: string): Promise<void> {
  if (dir === root || !dir.startsWith(root + path.sep)) {
    return;
  }
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  if (entries.length > 0) {
    return;
  }
  await fs.rmdir(dir).catch(() => {});
  await pruneEmptyMediaDirs(path.dirname(dir), root);
}

async function collectExpiredMaterializedMediaFiles(params: {
  dir: string;
  cutoff: number;
  recursive: boolean;
}): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(params.dir, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }
    throw error;
  }
  const expired: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(params.dir, entry.name);
    if (entry.isDirectory()) {
      if (params.recursive) {
        expired.push(
          ...(await collectExpiredMaterializedMediaFiles({
            dir: entryPath,
            cutoff: params.cutoff,
            recursive: params.recursive,
          })),
        );
      }
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const stat = await fs.stat(entryPath).catch(() => null);
    if (stat?.isFile() && stat.mtimeMs < params.cutoff) {
      expired.push(entryPath);
    }
  }
  return expired;
}

function upsertMediaBlob(params: {
  subdir: string;
  id: string;
  buffer: Buffer;
  contentType?: string;
  state?: OpenClawStateDatabaseOptions;
}): void {
  const now = Date.now();
  runOpenClawStateWriteTransaction((database) => {
    const row: Insertable<MediaKyselyDatabase["media_blobs"]> = {
      subdir: params.subdir,
      id: params.id,
      content_type: params.contentType ?? null,
      size_bytes: params.buffer.byteLength,
      blob: params.buffer,
      created_at: now,
      updated_at: now,
    };
    executeSqliteQuerySync(
      database.db,
      getMediaKysely(database.db)
        .insertInto("media_blobs")
        .values(row)
        .onConflict((conflict) =>
          conflict.columns(["subdir", "id"]).doUpdateSet({
            content_type: (eb) => eb.ref("excluded.content_type"),
            size_bytes: (eb) => eb.ref("excluded.size_bytes"),
            blob: (eb) => eb.ref("excluded.blob"),
            created_at: (eb) => eb.ref("excluded.created_at"),
            updated_at: (eb) => eb.ref("excluded.updated_at"),
          }),
        ),
    );
  }, params.state);
}

function deleteExpiredMediaBlobs(params: { cutoff: number; recursive: boolean }): void {
  runOpenClawStateWriteTransaction((database) => {
    const baseQuery = getMediaKysely(database.db)
      .deleteFrom("media_blobs")
      .where("updated_at", "<", params.cutoff);
    const query = params.recursive ? baseQuery : baseQuery.where("subdir", "=", "");
    executeSqliteQuerySync(database.db, query);
  });
}

export function setMediaStoreNetworkDepsForTest(deps?: {
  httpRequest?: RequestImpl;
  httpsRequest?: RequestImpl;
  resolvePinnedHostname?: ResolvePinnedHostnameImpl;
}): void {
  httpRequestImpl = deps?.httpRequest ?? defaultHttpRequestImpl;
  httpsRequestImpl = deps?.httpsRequest ?? defaultHttpsRequestImpl;
  resolvePinnedHostnameImpl = deps?.resolvePinnedHostname ?? defaultResolvePinnedHostnameImpl;
}

/**
 * Sanitize a filename for cross-platform safety.
 * Removes chars unsafe on Windows/SharePoint/all platforms.
 * Keeps: alphanumeric, dots, hyphens, underscores, Unicode letters/numbers.
 */
function sanitizeFilename(name: string): string {
  const base = sanitizeUntrustedFileName(name, "");
  if (!base) {
    return "";
  }
  const sanitized = base.replace(/[^\p{L}\p{N}._-]+/gu, "_");
  // Collapse multiple underscores, trim leading/trailing, limit length
  return sanitized.replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 60);
}

/**
 * Extract original filename from path if it matches the embedded format.
 * Pattern: {original}---{uuid}.{ext} → returns "{original}.{ext}"
 * Falls back to basename if no pattern match, or "file.bin" if empty.
 */
export function extractOriginalFilename(filePath: string): string {
  const basename = basenameFromAnyPath(filePath);
  if (!basename) {
    return "file.bin";
  } // Fallback for empty input

  const ext = extnameFromAnyPath(basename);
  const nameWithoutExt = path.basename(basename, ext);

  // Check for ---{uuid} pattern (36 chars: 8-4-4-4-12 with hyphens)
  const match = nameWithoutExt.match(
    /^(.+)---[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,
  );
  if (match?.[1]) {
    return `${match[1]}${ext}`;
  }

  return basename; // Fallback: use as-is
}

export function getMediaMaterializationDir() {
  return resolveMediaMaterializationRoot();
}

/** @deprecated Use getMediaMaterializationDir. */
export function getMediaDir() {
  return getMediaMaterializationDir();
}

export async function ensureMediaDir() {
  const mediaDir = resolveMediaMaterializationRoot();
  await fs.mkdir(mediaDir, { recursive: true, mode: 0o700 });
  return mediaDir;
}

export async function legacyMediaFilesExist(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const root = resolveLegacyMediaDir(env);
  const candidates = await legacyMediaFileCandidates(root);
  return candidates.length > 0;
}

export async function importLegacyMediaFilesToSqlite(
  env: NodeJS.ProcessEnv = process.env,
): Promise<LegacyMediaImportResult> {
  const root = resolveLegacyMediaDir(env);
  const candidates = await legacyMediaFileCandidates(root);
  const result: LegacyMediaImportResult = {
    files: candidates.length,
    imported: 0,
    removed: 0,
    skipped: 0,
  };

  for (const candidate of candidates) {
    try {
      const safeSubdir = resolveMediaSubdir(candidate.subdir, "importLegacyMediaFilesToSqlite");
      resolveMediaRelativePath(candidate.id, safeSubdir, "importLegacyMediaFilesToSqlite");
      const { buffer } = await readLocalFileSafely({
        filePath: candidate.path,
        maxBytes: MAX_BYTES,
      });
      const contentType = await detectMime({ buffer, filePath: candidate.path });
      upsertMediaBlob({
        subdir: safeSubdir,
        id: candidate.id,
        buffer,
        contentType,
        state: { env },
      });
      result.imported += 1;
      await fs.rm(candidate.path, { force: true });
      result.removed += 1;
      await pruneEmptyMediaDirs(path.dirname(candidate.path), root);
    } catch {
      result.skipped += 1;
    }
  }

  return result;
}

function findErrorWithCode(err: unknown, code: string): NodeJS.ErrnoException | undefined {
  if (!(err instanceof Error)) {
    return undefined;
  }
  if ("code" in err && err.code === code) {
    return err as NodeJS.ErrnoException;
  }
  return findErrorWithCode(err.cause, code);
}

function isMissingPathError(err: unknown): boolean {
  return findErrorWithCode(err, "ENOENT") !== undefined;
}

async function retryAfterRecreatingDir<T>(dir: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const noSpaceError = findErrorWithCode(err, "ENOSPC");
    if (noSpaceError) {
      throw noSpaceError;
    }
    if (!isMissingPathError(err)) {
      throw err;
    }
    // Recursive cleanup can prune an empty directory between mkdir and the later
    // file open/write. Recreate once and retry the media write path.
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    return await run();
  }
}

export async function cleanOldMedia(ttlMs = DEFAULT_TTL_MS, options: CleanOldMediaOptions = {}) {
  const cutoff = Date.now() - ttlMs;
  const materializationRoot = resolveMediaMaterializationRoot();
  const recursive = options.recursive ?? true;
  deleteExpiredMediaBlobs({ cutoff, recursive });
  const removedDirs = new Set<string>();
  const expiredMaterializedFiles = await collectExpiredMaterializedMediaFiles({
    dir: materializationRoot,
    cutoff,
    recursive,
  });
  for (const filePath of expiredMaterializedFiles) {
    await fs.rm(filePath, { force: true }).catch(() => {});
    removedDirs.add(path.dirname(filePath));
  }
  if (options.pruneEmptyDirs || recursive) {
    for (const dir of removedDirs) {
      await pruneEmptyMediaDirs(dir, materializationRoot);
    }
  }
}

function looksLikeUrl(src: string) {
  return /^https?:\/\//i.test(src);
}

/**
 * Download media into memory while capturing the first few KB for mime sniffing.
 */
async function downloadToBuffer(
  url: string,
  headers?: Record<string, string>,
  maxRedirects = 5,
  maxBytes = MAX_BYTES,
): Promise<{ headerMime?: string; sniffBuffer: Buffer; buffer: Buffer; size: number }> {
  return await new Promise((resolve, reject) => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      reject(new Error("Invalid URL"));
      return;
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      reject(new Error(`Invalid URL protocol: ${parsedUrl.protocol}. Only HTTP/HTTPS allowed.`));
      return;
    }
    const requestImpl = parsedUrl.protocol === "https:" ? httpsRequestImpl : httpRequestImpl;
    resolvePinnedHostnameImpl(parsedUrl.hostname)
      .then((pinned) => {
        const req = requestImpl(parsedUrl, { headers, lookup: pinned.lookup }, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
            const location = res.headers.location;
            if (!location || maxRedirects <= 0) {
              reject(new Error(`Redirect loop or missing Location header`));
              return;
            }
            let redirectUrl: URL;
            try {
              redirectUrl = new URL(location, url);
            } catch {
              reject(new Error("Invalid redirect Location header"));
              return;
            }
            const redirectHeaders =
              redirectUrl.origin === parsedUrl.origin
                ? headers
                : retainSafeHeadersForCrossOriginRedirect(headers);
            resolve(
              downloadToBuffer(redirectUrl.toString(), redirectHeaders, maxRedirects - 1, maxBytes),
            );
            return;
          }
          if (!res.statusCode || res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode ?? "?"} downloading media`));
            return;
          }
          let total = 0;
          const chunks: Buffer[] = [];
          const sniffChunks: Buffer[] = [];
          let sniffLen = 0;
          res.on("data", (chunk) => {
            total += chunk.length;
            chunks.push(chunk);
            if (sniffLen < 16384) {
              sniffChunks.push(chunk);
              sniffLen += chunk.length;
            }
            if (total > maxBytes) {
              req.destroy(new Error(`Media exceeds ${formatMediaLimitMb(maxBytes)} limit`));
            }
          });
          res.on("end", () => {
            try {
              const sniffBuffer = Buffer.concat(sniffChunks, Math.min(sniffLen, 16384));
              const rawHeader = res.headers["content-type"];
              const headerMime = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
              const buffer = Buffer.concat(chunks, total);
              resolve({
                headerMime,
                sniffBuffer,
                buffer,
                size: total,
              });
            } catch (err) {
              reject(err);
            }
          });
          res.on("error", reject);
        });
        req.on("error", reject);
        req.end();
      })
      .catch(reject);
  });
}

export type SavedMedia = {
  id: string;
  path: string;
  size: number;
  contentType?: string;
};

function buildSavedMediaId(params: {
  baseId: string;
  ext: string;
  originalFilename?: string;
}): string {
  if (!params.originalFilename) {
    return params.ext ? `${params.baseId}${params.ext}` : params.baseId;
  }

  const base = nameFromAnyPath(params.originalFilename);
  const sanitized = sanitizeFilename(base);
  return sanitized
    ? `${sanitized}---${params.baseId}${params.ext}`
    : `${params.baseId}${params.ext}`;
}

function safeOriginalFilenameExtension(originalFilename?: string): string | undefined {
  if (!originalFilename) {
    return undefined;
  }
  const ext = extnameFromAnyPath(originalFilename).toLowerCase();
  return /^\.[a-z0-9]{1,16}$/.test(ext) ? ext : undefined;
}

function extensionForAuthoritativeHeaderMime(contentType?: string): string | undefined {
  const mime = normalizeOptionalString(contentType?.split(";")[0]);
  if (!mime || mime === "application/octet-stream" || mime === "binary/octet-stream") {
    return undefined;
  }
  if (mime === "application/zip") {
    return undefined;
  }
  return extensionForMime(mime);
}

function isGenericContainerMime(mime?: string): boolean {
  return mime === "application/zip" || mime === "application/octet-stream";
}

function isImageHeaderMime(contentType?: string): boolean {
  return normalizeOptionalString(contentType?.split(";")[0])?.startsWith("image/") === true;
}

function resolveSavedMediaExtension(params: {
  detectedMime?: string;
  headerExt?: string;
  contentType?: string;
  originalFilename?: string;
}): string {
  const trustedHeaderExt =
    params.headerExt &&
    isGenericContainerMime(params.detectedMime) &&
    isImageHeaderMime(params.contentType)
      ? undefined
      : params.headerExt;
  return (
    trustedHeaderExt ??
    extensionForMime(params.detectedMime) ??
    safeOriginalFilenameExtension(params.originalFilename) ??
    ""
  );
}

function buildSavedMediaResult(params: {
  dir: string;
  id: string;
  size: number;
  contentType?: string;
  path?: string;
}): SavedMedia {
  return {
    id: params.id,
    path: params.path ?? path.join(params.dir, params.id),
    size: params.size,
    contentType: params.contentType,
  };
}

async function writeSavedMediaBuffer(params: {
  subdir: string;
  id: string;
  buffer: Buffer;
  contentType?: string;
  state?: OpenClawStateDatabaseOptions;
}): Promise<string> {
  const safeSubdir = resolveMediaSubdir(params.subdir, "writeSavedMediaBuffer");
  resolveMediaRelativePath(params.id, params.subdir, "writeSavedMediaBuffer");
  upsertMediaBlob({
    subdir: safeSubdir,
    id: params.id,
    buffer: params.buffer,
    contentType: params.contentType,
    state: params.state,
  });
  return await materializeMediaBufferPath({
    subdir: safeSubdir,
    id: params.id,
    buffer: params.buffer,
  });
}

async function materializeMediaBufferPath(params: {
  subdir: string;
  id: string;
  buffer: Buffer;
}): Promise<string> {
  const dir = resolveMediaScopedDir(params.subdir, "materializeMediaBufferPath");
  return await retryAfterRecreatingDir(dir, async () => {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const written = await writeSiblingTempFile({
      dir,
      mode: MEDIA_FILE_MODE,
      tempPrefix: `.${params.id}`,
      writeTemp: async (tempPath) => {
        await fs.writeFile(tempPath, params.buffer, { mode: MEDIA_FILE_MODE });
        return undefined;
      },
      resolveFinalPath: () => path.join(dir, params.id),
    });
    return written.filePath;
  });
}

async function writeMediaStreamToFile(params: {
  stream: AsyncIterable<unknown>;
  tempPath: string;
  maxBytes: number;
}): Promise<{ sniffBuffer: Buffer; size: number }> {
  const handle = await fs.open(params.tempPath, "wx", MEDIA_FILE_MODE);
  const sniffChunks: Buffer[] = [];
  let sniffLen = 0;
  let total = 0;
  try {
    for await (const chunk of params.stream) {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : typeof chunk === "string"
          ? Buffer.from(chunk)
          : chunk instanceof ArrayBuffer
            ? Buffer.from(chunk)
            : ArrayBuffer.isView(chunk)
              ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
              : undefined;
      if (!buffer) {
        throw new TypeError(`Unsupported media stream chunk: ${typeof chunk}`);
      }
      if (buffer.byteLength === 0) {
        continue;
      }
      total += buffer.byteLength;
      if (total > params.maxBytes) {
        throw new Error(`Media exceeds ${formatMediaLimitMb(params.maxBytes)} limit`);
      }
      if (sniffLen < 16384) {
        const remaining = 16384 - sniffLen;
        sniffChunks.push(buffer.byteLength > remaining ? buffer.subarray(0, remaining) : buffer);
        sniffLen += Math.min(buffer.byteLength, remaining);
      }
      await handle.write(buffer);
    }
    return {
      sniffBuffer: Buffer.concat(sniffChunks, sniffLen),
      size: total,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export type SaveMediaSourceErrorCode =
  | "invalid-path"
  | "not-found"
  | "not-file"
  | "path-mismatch"
  | "too-large";

export class SaveMediaSourceError extends Error {
  code: SaveMediaSourceErrorCode;

  constructor(code: SaveMediaSourceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "SaveMediaSourceError";
  }
}

function toSaveMediaSourceError(err: FsSafeLikeError, maxBytes = MAX_BYTES): SaveMediaSourceError {
  switch (err.code) {
    case "symlink":
      return new SaveMediaSourceError("invalid-path", "Media path must not be a symlink", {
        cause: err,
      });
    case "not-file":
      return new SaveMediaSourceError("not-file", "Media path is not a file", { cause: err });
    case "path-mismatch":
      return new SaveMediaSourceError("path-mismatch", "Media path changed during read", {
        cause: err,
      });
    case "too-large":
      return new SaveMediaSourceError(
        "too-large",
        `Media exceeds ${formatMediaLimitMb(maxBytes)} limit`,
        { cause: err },
      );
    case "not-found":
      return new SaveMediaSourceError("not-found", "Media path does not exist", { cause: err });
    case "outside-workspace":
      return new SaveMediaSourceError("invalid-path", "Media path is outside workspace root", {
        cause: err,
      });
    case "invalid-path":
    default:
      return new SaveMediaSourceError("invalid-path", "Media path is not safe to read", {
        cause: err,
      });
  }
}

export async function saveMediaSource(
  source: string,
  headers?: Record<string, string>,
  subdir = "",
  maxBytes = MAX_BYTES,
  state?: OpenClawStateDatabaseOptions,
): Promise<SavedMedia> {
  const dir = resolveMediaScopedDir(subdir, "saveMediaSource");
  await cleanOldMedia(DEFAULT_TTL_MS, { recursive: false });
  const baseId = crypto.randomUUID();
  if (looksLikeUrl(source)) {
    const { headerMime, sniffBuffer, buffer, size } = await downloadToBuffer(
      source,
      headers,
      5,
      maxBytes,
    );
    const mime = await detectMime({
      buffer: sniffBuffer,
      headerMime,
      filePath: source,
    });
    const ext = extensionForMime(mime) ?? path.extname(new URL(source).pathname);
    const id = buildSavedMediaId({ baseId, ext });
    const materializedPath = await retryAfterRecreatingDir(dir, () =>
      writeSavedMediaBuffer({ subdir, id, buffer, contentType: mime, state }),
    );
    return buildSavedMediaResult({
      dir,
      id,
      size,
      contentType: mime,
      path: materializedPath,
    });
  }
  try {
    const { buffer, stat } = await readLocalFileSafely({ filePath: source, maxBytes });
    const mime = await detectMime({ buffer, filePath: source });
    const ext = extensionForMime(mime) ?? path.extname(source);
    const id = buildSavedMediaId({ baseId, ext });
    const materializedPath = await writeSavedMediaBuffer({
      subdir,
      id,
      buffer,
      contentType: mime,
      state,
    });
    return buildSavedMediaResult({
      dir,
      id,
      size: stat.size,
      contentType: mime,
      path: materializedPath,
    });
  } catch (err) {
    if (isFsSafeError(err)) {
      throw toSaveMediaSourceError(err, maxBytes);
    }
    throw err;
  }
}

export async function saveMediaBuffer(
  buffer: Buffer,
  contentType?: string,
  subdir = "inbound",
  maxBytes = MAX_BYTES,
  originalFilename?: string,
  detectionFilePathHint?: string,
  state?: OpenClawStateDatabaseOptions,
): Promise<SavedMedia> {
  if (buffer.byteLength > maxBytes) {
    throw new Error(`Media exceeds ${formatMediaLimitMb(maxBytes)} limit`);
  }
  const dir = resolveMediaScopedDir(subdir, "saveMediaBuffer");
  const uuid = crypto.randomUUID();
  const headerExt = extensionForAuthoritativeHeaderMime(contentType);
  const mime = await detectMime({
    buffer,
    headerMime: contentType,
    filePath: originalFilename ?? detectionFilePathHint,
  });
  const ext = resolveSavedMediaExtension({
    detectedMime: mime,
    headerExt,
    contentType,
    originalFilename,
  });
  const id = buildSavedMediaId({ baseId: uuid, ext, originalFilename });
  const materializedPath = await writeSavedMediaBuffer({
    subdir,
    id,
    buffer,
    contentType: mime,
    state,
  });
  return buildSavedMediaResult({
    dir,
    id,
    size: buffer.byteLength,
    contentType: mime,
    path: materializedPath,
  });
}

export async function saveMediaBufferWithId(params: {
  subdir: string;
  id: string;
  buffer: Buffer;
  contentType?: string;
  maxBytes?: number;
  state?: OpenClawStateDatabaseOptions;
}): Promise<SavedMedia> {
  const maxBytes = params.maxBytes ?? MAX_BYTES;
  if (params.buffer.byteLength > maxBytes) {
    throw new Error(`Media exceeds ${formatMediaLimitMb(maxBytes)} limit`);
  }
  const safeSubdir = resolveMediaSubdir(params.subdir, "saveMediaBufferWithId");
  resolveMediaRelativePath(params.id, safeSubdir, "saveMediaBufferWithId");
  const dir = resolveMediaScopedDir(safeSubdir, "saveMediaBufferWithId");
  const mime = await detectMime({ buffer: params.buffer, headerMime: params.contentType });
  const materializedPath = await writeSavedMediaBuffer({
    subdir: safeSubdir,
    id: params.id,
    buffer: params.buffer,
    contentType: mime,
    state: params.state,
  });
  return buildSavedMediaResult({
    dir,
    id: params.id,
    size: params.buffer.byteLength,
    contentType: mime,
    path: materializedPath,
  });
}

export async function saveMediaStream(
  stream: AsyncIterable<unknown>,
  contentType?: string,
  subdir = "inbound",
  maxBytes = MAX_BYTES,
  originalFilename?: string,
  detectionFilePathHint?: string,
): Promise<SavedMedia> {
  const dir = resolveMediaScopedDir(subdir, "saveMediaStream");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const baseId = crypto.randomUUID();
  const headerExt = extensionForAuthoritativeHeaderMime(contentType);
  const saved = await retryAfterRecreatingDir(dir, () =>
    writeSiblingTempFile<{ id: string; size: number; contentType?: string }>({
      dir,
      mode: MEDIA_FILE_MODE,
      tempPrefix: `.${baseId}`,
      writeTemp: async (tempPath) => {
        const { sniffBuffer, size } = await writeMediaStreamToFile({
          stream,
          tempPath,
          maxBytes,
        });
        const mime = await detectMime({
          buffer: sniffBuffer,
          headerMime: contentType,
          filePath: originalFilename ?? detectionFilePathHint,
        });
        const ext = resolveSavedMediaExtension({
          detectedMime: mime,
          headerExt,
          contentType,
          originalFilename,
        });
        const id = buildSavedMediaId({ baseId, ext, originalFilename });
        return { id, size, contentType: mime };
      },
      resolveFinalPath: (result) => path.join(dir, result.id),
    }),
  );
  const buffer = await fs.readFile(saved.filePath);
  upsertMediaBlob({
    subdir: resolveMediaSubdir(subdir, "saveMediaStream"),
    id: saved.result.id,
    buffer,
    contentType: saved.result.contentType,
  });
  return buildSavedMediaResult({
    dir,
    id: saved.result.id,
    size: saved.result.size,
    contentType: saved.result.contentType,
  });
}

/**
 * Resolves a media ID saved by saveMediaBuffer to its absolute physical path.
 *
 * This is the read-side counterpart to saveMediaBuffer and is used by the
 * agent runner to hydrate opaque `media://inbound/<id>` URIs written by the
 * Gateway's claim-check offload path.
 *
 * Security:
 * - Rejects IDs and subdirs containing path traversal, absolute paths, empty
 *   segments, or null bytes to prevent path injection outside the media root.
 * - Verifies the resolved path is a regular file (not a symlink or directory)
 *   before returning it, matching the write-side MEDIA_FILE_MODE policy.
 *
 * @param id      The media ID as returned by SavedMedia.id (may include
 *                extension and original-filename prefix,
 *                e.g. "photo---<uuid>.png" or "图片---<uuid>.png").
 * @param subdir  The subdirectory the file was saved into (default "inbound").
 * @returns       Absolute path to the file on disk.
 * @throws        If the ID is unsafe, the file does not exist, or is not a
 *                regular file.
 *
 * Prefer readMediaBuffer when the caller needs the bytes; this path-returning
 * helper is for channel surfaces that need a stable local attachment path.
 */
export async function resolveMediaBufferPath(
  id: string,
  subdir = "inbound",
  state?: OpenClawStateDatabaseOptions,
): Promise<string> {
  const safeSubdir = resolveMediaSubdir(subdir, "resolveMediaBufferPath");
  resolveMediaRelativePath(id, subdir, "resolveMediaBufferPath");
  const row = getMediaBlobRow({ subdir: safeSubdir, id, state });
  if (!row) {
    throw new Error(
      `resolveMediaBufferPath: media ID does not resolve to a file: ${JSON.stringify(id)}`,
    );
  }
  return await materializeMediaBufferPath({
    subdir: safeSubdir,
    id,
    buffer: Buffer.from(row.blob),
  });
}

export type ReadMediaBufferResult = {
  id: string;
  path: string;
  buffer: Buffer;
  size: number;
};

export async function readMediaBuffer(
  id: string,
  subdir: string = "inbound",
  maxBytes = MAX_BYTES,
  state?: OpenClawStateDatabaseOptions,
): Promise<ReadMediaBufferResult> {
  const safeSubdir = resolveMediaSubdir(subdir, "readMediaBuffer");
  resolveMediaRelativePath(id, subdir, "readMediaBuffer");
  const row = getMediaBlobRow({ subdir: safeSubdir, id, state });
  if (!row) {
    throw new Error(`readMediaBuffer: media ID does not resolve to a file: ${JSON.stringify(id)}`);
  }
  if (row.size_bytes > maxBytes) {
    throw new Error(
      `readMediaBuffer: media ID ${JSON.stringify(id)} is ${row.size_bytes} bytes; maximum is ${maxBytes} bytes`,
    );
  }
  const buffer = Buffer.from(row.blob);
  if (buffer.byteLength > maxBytes) {
    throw new Error(
      `readMediaBuffer: media ID ${JSON.stringify(id)} read ${buffer.byteLength} bytes; maximum is ${maxBytes} bytes`,
    );
  }
  const materializedPath = await materializeMediaBufferPath({ subdir: safeSubdir, id, buffer });
  return { id, path: materializedPath, buffer, size: buffer.byteLength };
}

/**
 * Deletes a file previously saved by saveMediaBuffer.
 *
 * This is used by parseMessageWithAttachments to clean up files that were
 * successfully offloaded earlier in the same request when a later attachment
 * fails validation and the entire parse is aborted, preventing orphaned files
 * from accumulating on disk ahead of the periodic TTL sweep.
 *
 * Uses a media-root handle to apply the same path-safety guards as the read
 * path while removing the file under the pinned media root.
 *
 * Errors are intentionally not suppressed — callers that want best-effort
 * cleanup should catch and discard exceptions themselves (e.g. via
 * Promise.allSettled).
 *
 * @param id     The media ID as returned by SavedMedia.id.
 * @param subdir The subdirectory the file was saved into (default "inbound").
 */
export async function deleteMediaBuffer(
  id: string,
  subdir = "inbound",
  state?: OpenClawStateDatabaseOptions,
): Promise<void> {
  const safeSubdir = resolveMediaSubdir(subdir, "deleteMediaBuffer");
  resolveMediaRelativePath(id, subdir, "deleteMediaBuffer");
  runOpenClawStateWriteTransaction((database) => {
    executeSqliteQuerySync(
      database.db,
      getMediaKysely(database.db)
        .deleteFrom("media_blobs")
        .where("subdir", "=", safeSubdir)
        .where("id", "=", id),
    );
  }, state);
  await fs.rm(path.join(resolveMediaScopedDir(subdir, "deleteMediaBuffer"), id), {
    force: true,
  });
}

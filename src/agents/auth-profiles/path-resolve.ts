import { createHash } from "node:crypto";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { resolveUserPath } from "../../utils.js";
import { resolveDefaultAgentDir } from "../agent-scope-config.js";

const LEGACY_AUTH_PROFILE_FILENAME = "auth-profiles.json";
const LEGACY_AUTH_STATE_FILENAME = "auth-state.json";
const LEGACY_AUTH_FILENAME = "auth.json";

export function resolveAuthProfileStoreAgentDir(agentDir?: string): string {
  return resolveUserPath(agentDir ?? resolveDefaultAgentDir({}));
}

export function resolveAuthProfileStoreKey(agentDir?: string): string {
  return resolveAuthProfileStoreAgentDir(agentDir);
}

export function resolveAuthStorePath(agentDir?: string): string {
  return path.join(resolveAuthProfileStoreAgentDir(agentDir), LEGACY_AUTH_PROFILE_FILENAME);
}

export function resolveLegacyAuthStorePath(agentDir?: string): string {
  return path.join(resolveAuthProfileStoreAgentDir(agentDir), LEGACY_AUTH_FILENAME);
}

export function resolveAuthStatePath(agentDir?: string): string {
  return path.join(resolveAuthProfileStoreAgentDir(agentDir), LEGACY_AUTH_STATE_FILENAME);
}

export function resolveAuthStorePathForDisplay(agentDir?: string): string {
  const pathname = resolveAuthStorePath(agentDir);
  return pathname.startsWith("~") ? pathname : resolveUserPath(pathname);
}

export function resolveAuthStatePathForDisplay(agentDir?: string): string {
  const pathname = resolveAuthStatePath(agentDir);
  return pathname.startsWith("~") ? pathname : resolveUserPath(pathname);
}

export function resolveAuthProfileStoreLocationForDisplay(
  agentDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return `${resolveOpenClawStateSqlitePath(env)}#table/auth_profile_stores/${resolveAuthProfileStoreKey(agentDir)}`;
}

export const OAUTH_REFRESH_LOCK_SCOPE = "auth.oauth-refresh";

function buildOAuthRefreshLockHash(provider: string, profileId: string): string {
  const hash = createHash("sha256");
  // This hashes provider/profile identifiers into a path-safe lock name; it is
  // not password storage or credential verification.
  // codeql[js/insufficient-password-hash]
  hash.update(provider, "utf8");
  hash.update("\u0000", "utf8"); // NUL separator: unambiguous boundary.
  hash.update(profileId, "utf8");
  return `sha256-${hash.digest("hex")}`;
}

/**
 * Resolve the SQLite state-lock key for a cross-agent, per-profile OAuth
 * refresh. The hash input is `provider\0profileId`, which is unambiguous,
 * filesystem-independent, and bounded for arbitrary profile ids.
 */
export function resolveOAuthRefreshLockKey(provider: string, profileId: string): string {
  return buildOAuthRefreshLockHash(provider, profileId);
}

export function resolveOAuthRefreshLockPath(provider: string, profileId: string): string {
  return path.join(
    resolveStateDir(),
    "locks",
    "oauth-refresh",
    buildOAuthRefreshLockHash(provider, profileId),
  );
}

import fs from "node:fs";
import { saveJsonFile } from "../../infra/json-file.js";
import { AUTH_STORE_VERSION } from "./constants.js";
import type { AuthProfileSecretsStore } from "./types.js";

export {
  resolveAuthStatePath,
  resolveAuthStatePathForDisplay,
  resolveAuthProfileStoreAgentDir,
  resolveAuthProfileStoreKey,
  resolveAuthProfileStoreLocationForDisplay,
  resolveAuthStorePath,
  resolveAuthStorePathForDisplay,
  resolveLegacyAuthStorePath,
  resolveOAuthRefreshLockPath,
  resolveOAuthRefreshLockKey,
  OAUTH_REFRESH_LOCK_SCOPE,
} from "./path-resolve.js";

export function ensureAuthStoreFile(pathname: string) {
  if (fs.existsSync(pathname)) {
    return;
  }
  const payload: AuthProfileSecretsStore = {
    version: AUTH_STORE_VERSION,
    profiles: {},
  };
  saveJsonFile(pathname, payload);
}

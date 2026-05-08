// Shared filesystem paths.
//
// Two forms: module-level consts (KLURA_DIR / SKILLS_DIR / STORAGE_DIR) resolve
// KLURA_HOME once at import time — safe because workers set the env var before
// Node starts. Call sites that re-read the env mid-process (e.g.
// `loadConfig()`, cached secret/device resolvers) use `getKluraHome()` for late
// binding.

import path from 'path';
import os from 'os';

export function getKluraHome(): string {
  return process.env.KLURA_HOME || path.join(os.homedir(), '.klura');
}

export const KLURA_DIR = getKluraHome();
export const SKILLS_DIR = path.join(KLURA_DIR, 'skills');
export const WORKDIR_DIR = path.join(KLURA_DIR, 'workdir');
export const STORAGE_DIR = path.join(KLURA_DIR, 'storage-state');

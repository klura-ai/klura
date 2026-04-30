// Path helpers for the platform working dir.
//
// Layout (keyed off KLURA_HOME):
//   ~/.klura/workdir/<platform>/
//     ├── logbook.json                      # platform summary
//     ├── sessions/<session_id>/*.json      # per-session archive
//     ├── bundles/<sha256>.js               # content-addressable JS archive
//     └── derived/*.json                    # cross-session computed signals
//
// Kept separate from `~/.klura/skills/<platform>/` so the skills dir stays a
// clean, copy-pasteable / publishable artifact — session captures, storage
// state, and per-capability discovery scratch can contain PII and never ship
// with a lifted skill.
//
// Pure path math — no I/O. Callers open/create files themselves.

import fs from 'fs';
import path from 'path';
import { getKluraHome } from '../paths';

function platformRoot(platform: string): string {
  return path.join(getKluraHome(), 'workdir', platform);
}

export function logbookPath(platform: string): string {
  return path.join(platformRoot(platform), 'logbook.json');
}

export function healthPath(platform: string): string {
  return path.join(platformRoot(platform), 'health.json');
}

export function artifactsDir(platform: string): string {
  return path.join(platformRoot(platform), 'artifacts');
}

function sessionsRoot(platform: string): string {
  return path.join(platformRoot(platform), 'sessions');
}

function sessionDir(platform: string, sessionId: string): string {
  return path.join(sessionsRoot(platform), sessionId);
}

export function sessionArchivePath(
  platform: string,
  sessionId: string,
  slice: 'archive' | 'storage_state',
): string {
  const dir = sessionDir(platform, sessionId);
  if (slice === 'storage_state') return path.join(dir, 'storage-state.json');
  return path.join(dir, 'archive.json');
}

export function bundlesRoot(platform: string): string {
  return path.join(platformRoot(platform), 'bundles');
}

export function bundlePath(platform: string, sha256: string): string {
  // Shard by first two hex chars to avoid one giant flat dir on sites that
  // serve many bundles. Cheap durability / shell-browsability win.
  return path.join(bundlesRoot(platform), sha256.slice(0, 2), `${sha256}.js`);
}

function derivedRoot(platform: string): string {
  return path.join(platformRoot(platform), 'derived');
}

export function derivedPath(
  platform: string,
  name: 'field-stability' | 'bundle-history' | 'signer-history' | 'known-modules',
): string {
  return path.join(derivedRoot(platform), `${name}.json`);
}

/**
 * Ensure every dir in the working-dir layout exists for a platform. Safe to
 * call repeatedly; no-op when dirs already exist.
 */
export function ensurePlatformDirs(platform: string): void {
  fs.mkdirSync(platformRoot(platform), { recursive: true });
  fs.mkdirSync(sessionsRoot(platform), { recursive: true });
  fs.mkdirSync(bundlesRoot(platform), { recursive: true });
  fs.mkdirSync(derivedRoot(platform), { recursive: true });
}

export function ensureSessionDir(platform: string, sessionId: string): void {
  fs.mkdirSync(sessionDir(platform, sessionId), { recursive: true });
}

/**
 * List session IDs under a platform's working dir. Returns an empty array when
 * the dir doesn't exist yet (fresh platform).
 */
export function listSessions(platform: string): string[] {
  try {
    return fs.readdirSync(sessionsRoot(platform));
  } catch {
    return [];
  }
}

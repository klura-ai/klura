// Content-addressable JS bundle archive.
//
// Every BundleSeenPayload with `bytes` gets stored at
// ~/.klura/workdir/<platform>/bundles/<sha256>.js (sharded by first 2 hex
// chars). Multiple sessions hitting the same bundle reuse the existing file —
// one copy per SHA per platform. Downstream: - bundle-history.ts compares URL →
// SHA mapping over time to detect drift (e.g. site shipped a new minified
// bundle at the same URL). - signer-history.ts walks stored bundle sources to
// re-check for signer function names without needing a live browser.
//
// Pure function over bytes — no fetching. The adapter at the agent-session
// boundary reads the browser's loaded-script cache and hands the bytes in.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { bundlePath, bundlesRoot } from './layout';

export function sha256(bytes: string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * Write bundle bytes to the content-addressable archive. Idempotent: if the
 * file already exists (same SHA from a prior session), skips the write. Returns
 * the absolute path the bytes live at.
 */
export function archiveBundle(platform: string, sha: string, bytes: string): string {
  const dest = bundlePath(platform, sha);
  if (fs.existsSync(dest)) return dest;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, bytes, 'utf8');
  fs.renameSync(tmp, dest);
  return dest;
}

/**
 * Read a previously-archived bundle by SHA. Returns null when the SHA isn't in
 * the archive (common early in a platform's life, or when the agent never
 * archived the bundle source).
 */
export function readArchivedBundle(platform: string, sha: string): string | null {
  const p = bundlePath(platform, sha);
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Enumerate every archived bundle SHA for a platform. Used by bundle-history to
 * reconcile URL → SHA mappings over time.
 */
export function listArchivedBundles(platform: string): string[] {
  const root = bundlesRoot(platform);
  const out: string[] = [];
  let shards: string[];
  try {
    shards = fs.readdirSync(root);
  } catch {
    return out;
  }
  for (const shard of shards) {
    let entries: string[];
    try {
      entries = fs.readdirSync(path.join(root, shard));
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.endsWith('.js')) {
        out.push(name.slice(0, -3));
      }
    }
  }
  return out;
}

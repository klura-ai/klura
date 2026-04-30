// Remote viewer signing secret resolution.
//
// Resolution order:
//   1. process.env.KLURA_REMOTE_SECRET  (Cloud / multi-tenant path)
//   2. ~/.klura/remote-secret.key       (self-hosted path)
//   3. Auto-generate: write 32 random bytes hex-encoded to the file above
//      with mode 0600 and return it.
//
// Result is cached in module scope keyed by (env, resolved path) so repeat
// calls are free. KLURA_HOME is resolved on each call so tests can point at a
// temp dir just-in-time (top-of-module const would cache at require time and
// couldn't be changed mid-run).

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getKluraHome } from '../paths';

interface CacheEntry {
  envValue: string | undefined;
  resolvedPath: string;
  secret: string;
}

let _cached: CacheEntry | null = null;

function resolveSecretPath(): string {
  return path.join(getKluraHome(), 'remote-secret.key');
}

export function getRemoteSecret(): string {
  const envValue = process.env.KLURA_REMOTE_SECRET;
  const resolvedPath = resolveSecretPath();

  if (_cached && _cached.envValue === envValue && _cached.resolvedPath === resolvedPath) {
    return _cached.secret;
  }

  let secret: string;
  if (envValue && envValue.length > 0) {
    secret = envValue;
  } else if (fs.existsSync(resolvedPath)) {
    secret = fs.readFileSync(resolvedPath, 'utf8').trim();
    if (secret.length === 0) {
      // Empty file — treat as missing and regenerate.
      secret = generateAndWrite(resolvedPath);
    }
  } else {
    secret = generateAndWrite(resolvedPath);
  }

  _cached = { envValue, resolvedPath, secret };
  return secret;
}

function generateAndWrite(filePath: string): string {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(filePath, secret, { mode: 0o600 });
  return secret;
}

/** Test-only: clear the module-scope cache so a test can rotate secrets. */
export function _resetRemoteSecretCacheForTests(): void {
  _cached = null;
}

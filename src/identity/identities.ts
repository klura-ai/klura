import fs from 'fs';
import path from 'path';
import {
  asPlatformSlug,
  asNonEmptyBoundedString,
  asObject,
  asIdentifierSlug,
  assertNoReservedKeys,
  ValidationError,
} from '../validators';
import { KLURA_DIR } from '../paths';

const IDENTITIES_PATH = path.join(KLURA_DIR, 'identities.json');

type IdentityStore = Record<string, Record<string, string>>;

// Default-identity sentinel — same constant as `storage-state.ts`. Mirrored
// here to avoid an upward import (storage-state would otherwise pull in
// validators via skills.ts → cycle through identity).
const DEFAULT_IDENTITY = 'default';

function isDefaultIdentity(identity?: string): boolean {
  return !identity || identity === DEFAULT_IDENTITY;
}

/**
 * Compose the per-(platform, identity) profile key. Default identity reads
 * the bare `<platform>` slot — the historical key — so single-account
 * profiles aren't disturbed. Named identities read `<platform>--<identity>`,
 * sharing the slug separator with the storage-state path scheme. See
 * klura://reference#identities.
 */
function profileKey(platform: string, identity?: string): string {
  if (isDefaultIdentity(identity)) return platform;
  return `${platform}--${identity}`;
}

// One-shot stderr warning per (platform, identity) when a named identity
// has no scoped profile entry and the runtime falls back to the platform-
// default profile. Bounded set; never cleared (process-lifetime). The
// warning surfaces ONCE so the user knows to populate the scoped profile.
const profileFallbackWarned = new Set<string>();

// Identity keys we explicitly REJECT — these would either expose secrets
// (passwords, tokens) or be useless (very long blobs). Keep this list short and
// explicit; the LLM can only set genuinely non-secret profile fields like email
// and username.
const FORBIDDEN_IDENTITY_KEYS = new Set([
  'password',
  'pass',
  'pwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'access_token',
  'refresh_token',
  'session',
  'cookie',
  'auth',
  'authorization',
  'bearer',
  'private_key',
  'privatekey',
]);

const IDENTITY_KEY_RE = /^\w+$/;

function rethrow(prefix: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    if (e instanceof ValidationError) {
      throw new Error(`invalid_${prefix}: ${e.message}`, { cause: e });
    }
    throw e;
  }
}

function validateIdentityKey(key: string, field: string): void {
  if (!IDENTITY_KEY_RE.test(key)) {
    throw new ValidationError(
      field,
      `= ${JSON.stringify(key)} must match /^[a-zA-Z0-9_]+$/ (alphanumeric + underscore only)`,
    );
  }
  if (FORBIDDEN_IDENTITY_KEYS.has(key.toLowerCase())) {
    throw new ValidationError(
      field,
      `= ${JSON.stringify(key)} is forbidden — identities are for non-secret profile fields only ` +
        `(email, username, phone). Use the secret resolver (\`klura secret add\`) for credentials, ` +
        `or rely on browser cookies persisted via close_session for sessions.`,
    );
  }
}

function load(): IdentityStore {
  try {
    return JSON.parse(fs.readFileSync(IDENTITIES_PATH, 'utf-8')) as IdentityStore;
  } catch {
    return {};
  }
}

function save(data: IdentityStore): void {
  fs.mkdirSync(KLURA_DIR, { recursive: true });
  fs.writeFileSync(IDENTITIES_PATH, JSON.stringify(data, null, 2));
}

/**
 * Get identity fields for a `(platform, identity)` tuple. Returns an empty
 * object when no profile is set. When `identity` is omitted (or `"default"`),
 * reads the platform-default slot — historical behavior. Named identities
 * read the `<platform>--<identity>` slot; if that slot is empty the runtime
 * FALLS BACK to the platform-default profile (callers like
 * credential-autofill prefer "wrong name in autofill" over "no autofill") and
 * surfaces a one-shot stderr warning so the user knows to populate the
 * scoped slot. See klura://reference#identities.
 */
export function getIdentity(platform: string, identity?: string): Record<string, string> {
  rethrow('identity', () => {
    asPlatformSlug(platform, 'platform');
    if (!isDefaultIdentity(identity)) {
      asIdentifierSlug(identity, 'identity');
    }
  });
  const data = load();
  if (isDefaultIdentity(identity)) return data[platform] ?? {};
  const scoped = data[profileKey(platform, identity)];
  if (scoped) return scoped;
  const warnKey = `${platform}::${identity}`;
  if (!profileFallbackWarned.has(warnKey)) {
    profileFallbackWarned.add(warnKey);
    console.warn(
      `[klura] identity ${JSON.stringify(identity)} for platform ${JSON.stringify(platform)} ` +
        `has no scoped profile fields; falling back to the platform-default profile. ` +
        `Set scoped fields by editing identities.json (key ` +
        `"${profileKey(platform, identity)}") or call setIdentity with the identity arg.`,
    );
  }
  return data[platform] ?? {};
}

/** Set a single identity field for a platform. */
export function setIdentity(platform: string, key: string, value: string): void {
  rethrow('identity', () => {
    asPlatformSlug(platform, 'platform');
    validateIdentityKey(key, 'key');
    asNonEmptyBoundedString(value, `value (${key})`, 1000);
  });
  const data = load();
  if (!data[platform]) data[platform] = {};
  data[platform][key] = value;
  save(data);
}

/** Set multiple identity fields for a platform (merges with existing). */
export function setIdentityFields(platform: string, fields: Record<string, string>): void {
  rethrow('identity', () => {
    asPlatformSlug(platform, 'platform');
    const obj = asObject(fields, 'fields');
    assertNoReservedKeys(obj, 'fields');
    for (const [k, v] of Object.entries(obj)) {
      validateIdentityKey(k, `fields.${k}`);
      asNonEmptyBoundedString(v, `fields.${k}`, 1000);
    }
  });
  const data = load();
  data[platform] = { ...(data[platform] ?? {}), ...fields };
  save(data);
}

/** List all identities. */
export function listIdentities(): IdentityStore {
  return load();
}

/** Clear all identity fields for a platform. */
export function clearIdentity(platform: string): void {
  rethrow('identity', () => {
    asPlatformSlug(platform, 'platform');
  });
  const data = load();
  const filtered: IdentityStore = {};
  for (const [k, v] of Object.entries(data)) {
    if (k !== platform) filtered[k] = v;
  }
  save(filtered);
}

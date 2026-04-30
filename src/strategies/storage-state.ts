// Playwright-compatible storage-state I/O and cookie jar semantics.
//
// Separated from skills.ts because cookies aren't really "skills" — they're the
// session state that lets a fetch-tier strategy replay with the same auth
// posture the browser was using. Save/load/read/write all live here so
// skills.ts stays focused on strategy persistence.

import fs from 'fs';
import path from 'path';
import { STORAGE_DIR } from '../paths';

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The default-identity sentinel. When a caller omits `identity` or passes
 * `'default'`, we fall back to the historical platform-only path —
 * `<platform>.json` — so single-account use keeps working unchanged. Named
 * identities (`'work'`, `'personal'`, ...) get a `--<identity>` suffix so
 * they live alongside the default jar without collision. See
 * klura://reference#identities.
 */
export const DEFAULT_IDENTITY = 'default';

function isDefaultIdentity(identity?: string): boolean {
  return !identity || identity === DEFAULT_IDENTITY;
}

export function storageStatePath(platform: string, identity?: string): string {
  if (isDefaultIdentity(identity)) {
    return path.join(STORAGE_DIR, `${platform}.json`);
  }
  return path.join(STORAGE_DIR, `${platform}--${identity}.json`);
}

export function saveStorageState(
  platform: string,
  data: string | object,
  identity?: string,
): string {
  ensureDir(STORAGE_DIR);
  const filePath = storageStatePath(platform, identity);
  if (typeof data === 'string') {
    fs.writeFileSync(filePath, data);
  } else {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  }
  return filePath;
}

export function loadStorageStatePath(platform: string, identity?: string): string | null {
  const p = storageStatePath(platform, identity);
  return fs.existsSync(p) ? p : null;
}

// Playwright-compatible cookie entry shape (matches the storage-state JSON
// Playwright reads and writes). We only touch fields relevant to building a
// Cookie request header; extra fields are preserved on write.
export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  [key: string]: unknown;
}

// On-disk storage-state shape. `cookies` is typed as `unknown[]` because the
// file is user-editable JSON and may be malformed or out-of-sync with the
// current StoredCookie shape — runtime consumers are responsible for narrowing
// each element before use. This is the only place the loose type survives;
// every caller downstream sees a narrowed StoredCookie once the per-element
// shape check passes.
interface StoredStorageState {
  cookies?: unknown[];
  origins?: unknown[];
  [key: string]: unknown;
}

function readStorageStateRaw(platform: string, identity?: string): StoredStorageState {
  const p = storageStatePath(platform, identity);
  if (!fs.existsSync(p)) return { cookies: [], origins: [] };
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    if (!raw.trim()) return { cookies: [], origins: [] };
    const parsed = JSON.parse(raw) as StoredStorageState;
    if (!isPlainObject(parsed)) return { cookies: [], origins: [] };
    return parsed;
  } catch {
    // Malformed / empty / not JSON — treat as empty jar. The next write will
    // overwrite with a valid file.
    return { cookies: [], origins: [] };
  }
}

// Cookie domain match, matching browser semantics: a cookie with
// domain="example.com" applies to example.com AND any subdomain
// (api.example.com, www.example.com). A cookie with domain=".example.com"
// (leading dot) is treated the same way. A cookie with domain="example.com"
// explicitly only applies when the request host suffix-matches.
function cookieDomainMatches(cookieDomain: string, requestHost: string): boolean {
  const d = cookieDomain.startsWith('.') ? cookieDomain.slice(1) : cookieDomain;
  if (requestHost === d) return true;
  if (requestHost.endsWith('.' + d)) return true;
  return false;
}

function cookiePathMatches(cookiePath: string, requestPath: string): boolean {
  if (!cookiePath) return true;
  if (requestPath === cookiePath) return true;
  if (requestPath.startsWith(cookiePath)) {
    // RFC 6265 §5.1.4: cookie-path must be a prefix that either exactly equals
    // the request path OR ends with "/" OR the next character in the request
    // path is "/".
    if (cookiePath.endsWith('/')) return true;
    if (requestPath.charAt(cookiePath.length) === '/') return true;
  }
  return false;
}

/**
 * Read the cookie jar for a platform and build a `Cookie` header filtered to
 * the request URL's host + path + scheme + expiry. Returns the header value
 * (ready to drop into `headers.Cookie`) and the raw matched entries so the
 * Set-Cookie merger can reuse them without re-reading the file.
 *
 * Returns `header: null` when no cookies match — callers should omit the Cookie
 * header entirely in that case rather than sending an empty string, which some
 * servers treat as malformed.
 */
export function readStorageStateCookies(
  platform: string,
  url: string,
  identity?: string,
): { header: string | null; cookies: StoredCookie[] } {
  const state = readStorageStateRaw(platform, identity);
  const jar: unknown[] = Array.isArray(state.cookies) ? state.cookies : [];
  if (jar.length === 0) return { header: null, cookies: [] };

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { header: null, cookies: [] };
  }

  const now = Math.floor(Date.now() / 1000);
  const isHttps = target.protocol === 'https:';
  const host = target.hostname;
  const reqPath = target.pathname || '/';

  // Narrow each unknown entry into a StoredCookie by checking every field the
  // runtime depends on. Entries that don't shape-match are dropped silently —
  // matching what Playwright's own storage-state loader does with malformed
  // cookies on disk.
  const matched: StoredCookie[] = [];
  for (const raw of jar) {
    if (!isPlainObject(raw)) continue;
    if (typeof raw.name !== 'string' || typeof raw.value !== 'string') continue;
    if (typeof raw.domain !== 'string' || !cookieDomainMatches(raw.domain, host)) continue;
    if (typeof raw.path === 'string' && !cookiePathMatches(raw.path, reqPath)) continue;
    if (raw.secure && !isHttps) continue;
    if (typeof raw.expires === 'number' && raw.expires > 0 && raw.expires < now) continue;
    matched.push(raw as unknown as StoredCookie);
  }

  if (matched.length === 0) return { header: null, cookies: [] };
  const header = matched.map((c) => `${c.name}=${c.value}`).join('; ');
  return { header, cookies: matched };
}

/**
 * Parse one or many Set-Cookie header values returned from a fetch response and
 * merge them into the platform's storage-state jar. The request URL is required
 * so we can default the `domain` and `path` attributes when the Set-Cookie
 * doesn't declare them (mirrors RFC 6265 §5.3).
 *
 * `setCookieValues` accepts either the result of
 * `response.headers.getSetCookie()` (Node 20+ built-in) — an array of
 * individual Set-Cookie header values — or a single joined string (older Node
 * fallback). Empty array is a no-op.
 */
export function writeStorageStateCookies(
  platform: string,
  setCookieValues: string[] | string | null | undefined,
  requestUrl: string,
  identity?: string,
): void {
  if (!setCookieValues) return;
  const values = Array.isArray(setCookieValues)
    ? setCookieValues
    : splitSetCookieHeader(setCookieValues);
  if (values.length === 0) return;

  let target: URL;
  try {
    target = new URL(requestUrl);
  } catch {
    return;
  }

  const state = readStorageStateRaw(platform, identity);
  const jar: StoredCookie[] = [];
  if (Array.isArray(state.cookies)) {
    for (const raw of state.cookies) {
      if (!isPlainObject(raw)) continue;
      if (typeof raw.name !== 'string' || typeof raw.value !== 'string') continue;
      if (typeof raw.domain !== 'string') continue;
      jar.push(raw as unknown as StoredCookie);
    }
  }

  for (const value of values) {
    const parsed = parseSetCookie(value, target);
    if (!parsed) continue;
    // Replace any existing entry with the same (name, domain, path) tuple —
    // matching browser behavior. Additions append.
    const existingIdx = jar.findIndex(
      (c) => c.name === parsed.name && c.domain === parsed.domain && c.path === parsed.path,
    );
    if (existingIdx >= 0) {
      jar[existingIdx] = parsed;
    } else {
      jar.push(parsed);
    }
  }

  state.cookies = jar;
  if (!Array.isArray(state.origins)) state.origins = [];
  ensureDir(STORAGE_DIR);
  fs.writeFileSync(storageStatePath(platform, identity), JSON.stringify(state, null, 2));
}

// Older Node fallback — splits a joined Set-Cookie header on commas that are
// not inside `expires=` attribute values. Preferred path is the array form from
// `response.headers.getSetCookie()` which avoids this entirely.
function splitSetCookieHeader(joined: string): string[] {
  const out: string[] = [];
  let current = '';
  const parts = joined.split(',');
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? '';
    // `expires=Sun, 12-Jan-2025 ...` — if the next part starts with a
    // weekday-day shape, the comma was inside the expires attribute.
    if (current && /^\s*\d{1,2}[-\s]/.test(part)) {
      current += ',' + part;
    } else {
      if (current) out.push(current);
      current = part;
    }
  }
  if (current) out.push(current);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

function parseSetCookie(value: string, requestUrl: URL): StoredCookie | null {
  const parts = value.split(';').map((p) => p.trim());
  const first = parts.shift();
  if (!first) return null;
  const eq = first.indexOf('=');
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  const rawValue = first.slice(eq + 1).trim();
  if (!name) return null;

  const cookie: StoredCookie = {
    name,
    value: rawValue,
    domain: requestUrl.hostname,
    path: '/',
  };

  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    const key = (eqIdx === -1 ? part : part.slice(0, eqIdx)).trim().toLowerCase();
    const val = eqIdx === -1 ? '' : part.slice(eqIdx + 1).trim();
    if (key === 'domain' && val) {
      cookie.domain = val.startsWith('.') ? val.slice(1) : val;
    } else if (key === 'path' && val) {
      cookie.path = val;
    } else if (key === 'expires' && val) {
      const ts = Date.parse(val);
      if (!Number.isNaN(ts)) cookie.expires = Math.floor(ts / 1000);
    } else if (key === 'max-age' && val) {
      const seconds = parseInt(val, 10);
      if (!Number.isNaN(seconds)) {
        cookie.expires = Math.floor(Date.now() / 1000) + seconds;
      }
    } else if (key === 'secure') {
      cookie.secure = true;
    } else if (key === 'httponly') {
      cookie.httpOnly = true;
    } else if (key === 'samesite' && val) {
      const normalized = val.charAt(0).toUpperCase() + val.slice(1).toLowerCase();
      if (normalized === 'Strict' || normalized === 'Lax' || normalized === 'None') {
        cookie.sameSite = normalized;
      }
    }
  }

  return cookie;
}

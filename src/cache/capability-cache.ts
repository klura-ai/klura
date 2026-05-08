// Capability return-value cache. Memoizes successful execute() results
// per (platform, identity, capability, args) tuple for the TTL declared on
// the strategy body's `cache: {ttl: ...}` hint. Lets the agent invoke
// stable lookups (search_contact, list_channels, whoami) repeatedly within
// a session without re-running the strategy each time.
//
// In-memory per daemon — survives across `execute` calls in one process,
// dies on restart. No disk persistence in v1; the cache re-populates on
// the first miss after restart.
//
// What gets cached and what doesn't:
//   - 2xx status + no error / needs_generation / blocker / healable on
//     the body → store.
//   - Anything else → never cached. Errors must run fresh next time so the
//     agent's retry isn't masked by a stale failure.
//
// See klura://reference#capability-cache for the agent-facing surface.

import crypto from 'crypto';

// Lifecycle trace; same shape as the local-pool tracer. Off by default;
// set KLURA_VERBOSE=1 to surface cache hits/stores/expirations.
const trace = (...args: unknown[]): void => {
  if (process.env.KLURA_VERBOSE === '1') console.log(...args);
};

const TTL_REGEX = /^(\d+)([smh])$/;
const SWEEP_INTERVAL_MS = 60_000;

/**
 * Parse a `cache.ttl` literal — `"30s"` / `"5m"` / `"1h"` — into a
 * milliseconds number. Throws on anything else: bare numbers, missing
 * units, units like `"ms"` / `"d"` / `"w"`, empty string, non-string.
 *
 * The deliberately-narrow grammar matches what's reasonable for a
 * single-session capability cache. > 1h is almost always wrong (cookies
 * rotate, data drifts, agent should re-execute); < 1s is meaningless
 * given the per-call latency floor.
 */
export function parseTtl(value: unknown): number {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `cache.ttl must be a string like "30s", "5m", "1h" (got ${typeof value === 'string' ? JSON.stringify(value) : typeof value})`,
    );
  }
  const m = TTL_REGEX.exec(value);
  if (!m) {
    throw new Error(
      `cache.ttl = ${JSON.stringify(value)} must be like "30s", "5m", "1h" — \`<positive integer><s|m|h>\`. ` +
        `No "ms" / "d" / "w" / unitless numbers.`,
    );
  }
  const n = parseInt(m[1] ?? '0', 10);
  if (n <= 0) {
    throw new Error(`cache.ttl = ${JSON.stringify(value)} must be a positive duration`);
  }
  const unit = m[2];
  switch (unit) {
    case 's':
      return n * 1000;
    case 'm':
      return n * 60_000;
    case 'h':
      return n * 3_600_000;
    default:
      throw new Error(`cache.ttl unit ${JSON.stringify(unit)} unsupported (allowed: s, m, h)`);
  }
}

/**
 * Stable hash of the args map. JSON.stringify with sorted keys + SHA-1
 * gives a deterministic short string per arg shape — `{a:1,b:2}` and
 * `{b:2,a:1}` collapse to the same hash so callers don't have to canonicalize.
 *
 * SHA-1 is fine here: the cache is per-process, the keyspace is small, and
 * we only need pre-image freedom from accidental collisions, not adversarial
 * resistance.
 */
function stableArgsHash(args: Record<string, unknown> | undefined): string {
  if (!args || Object.keys(args).length === 0) return 'noargs';
  const sortedJson = JSON.stringify(
    args,
    Object.keys(args).sort((a, b) => a.localeCompare(b)),
  );
  return crypto.createHash('sha256').update(sortedJson).digest('hex').slice(0, 16);
}

function cacheKey(
  platform: string,
  identity: string | undefined,
  capability: string,
  args: Record<string, unknown> | undefined,
): string {
  return `${platform}::${identity || 'default'}::${capability}::${stableArgsHash(args)}`;
}

export interface CachedExecuteResult {
  /** The verbatim execute() result body the runtime returned the first
   *  time. Re-emitted on hit. */
  body: unknown;
  /** HTTP-style status code from the cached call. Cached entries are
   *  always 2xx — the cache rejects non-2xx stores by policy. */
  status: number;
  /** Wall-clock ms when this entry was stored. The cache derives
   *  `_cache_age_ms` from `Date.now() - ts` on hit. */
  ts: number;
  /** TTL in ms; expired entries are evicted on read. */
  ttlMs: number;
}

/**
 * Decision shape on whether to store a fresh execute() result. We refuse
 * to cache anything the agent must act on next call — errors, generators
 * needed, healable blockers — so a transient failure doesn't poison the
 * cache and mask the next call's chance to succeed.
 */
function isCacheable(status: number, body: unknown): boolean {
  if (status < 200 || status >= 300) return false;
  if (!body || typeof body !== 'object') return true; // primitive/null body — fine
  const rec = body as Record<string, unknown>;
  if (rec.error !== undefined && rec.error !== null) return false;
  if (rec.needs_generation === true) return false;
  if (rec.blocker !== undefined && rec.blocker !== null) return false;
  if (rec.healable === true) return false;
  return true;
}

export class CapabilityCache {
  private readonly _store = new Map<string, CachedExecuteResult>();
  private _sweeper: ReturnType<typeof setInterval> | null = null;

  /**
   * Look up a cached result. Returns the entry if fresh, or null on miss
   * (no entry, or entry expired — expired entries are evicted on read).
   */
  get(
    platform: string,
    identity: string | undefined,
    capability: string,
    args: Record<string, unknown> | undefined,
  ): CachedExecuteResult | null {
    const key = cacheKey(platform, identity, capability, args);
    const entry = this._store.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts >= entry.ttlMs) {
      this._store.delete(key);
      trace(`[capability-cache] expired key=${key}`);
      return null;
    }
    return entry;
  }

  /**
   * Store a fresh result if cacheable. Returns true when stored, false when
   * the result was rejected (non-2xx, error body, needs_generation, etc.).
   */
  set(
    platform: string,
    identity: string | undefined,
    capability: string,
    args: Record<string, unknown> | undefined,
    status: number,
    body: unknown,
    ttlMs: number,
  ): boolean {
    if (!isCacheable(status, body)) {
      trace(
        `[capability-cache] not-cacheable platform=${platform} capability=${capability} status=${status}`,
      );
      return false;
    }
    if (ttlMs <= 0) return false;
    const key = cacheKey(platform, identity, capability, args);
    this._store.set(key, { body, status, ts: Date.now(), ttlMs });
    trace(`[capability-cache] stored key=${key} ttlMs=${ttlMs}`);
    return true;
  }

  /** Drop every entry. Used by tests + diagnostics. */
  clearAll(): void {
    this._store.clear();
  }

  /**
   * Drop all cached entries for a single capability across every args shape.
   * Used by the auth-wall lazy-retry path: when a sibling strategy hits 401
   * because a memoized auth prereq returned a stale 2xx, the runtime evicts
   * the prereq capability's cache entries and re-fires the prereq before
   * retrying the main strategy. Entries from sibling capabilities (different
   * slug) and from sibling identities stay put.
   */
  evictForCapability(platform: string, identity: string | undefined, capability: string): number {
    const prefix = `${platform}::${identity || 'default'}::${capability}::`;
    let n = 0;
    for (const key of this._store.keys()) {
      if (key.startsWith(prefix)) {
        this._store.delete(key);
        n += 1;
      }
    }
    if (n > 0) trace(`[capability-cache] evicted ${n} entries for ${prefix}`);
    return n;
  }

  /** Snapshot size — for diagnostics + tests. */
  get size(): number {
    return this._store.size;
  }

  /**
   * Periodic eviction of expired entries. Same shape as the pool warm-
   * sweeper. `unref()` so the timer doesn't keep the Node event loop
   * alive on shutdown.
   */
  start(): void {
    if (this._sweeper) return;
    this._sweeper = setInterval(() => {
      this.sweep();
    }, SWEEP_INTERVAL_MS);
    this._sweeper.unref();
  }

  stop(): void {
    if (this._sweeper) {
      clearInterval(this._sweeper);
      this._sweeper = null;
    }
  }

  /** Force-tick the sweeper. Exposed for tests; production callers go
   *  through the interval. */
  sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this._store) {
      if (now - entry.ts >= entry.ttlMs) {
        this._store.delete(key);
      }
    }
  }
}

// Default daemon-wide singleton. Both the agent-facing tool surface
// (runtime/src/tools/execute.ts) and the prereq-resolution path
// (runtime/src/execution/index.ts:resolveCapabilityPrereq) read from this same
// instance so a `search_contact` result memoized via a direct
// `execute("acme", "search_contact", {name})` call is also seen by a
// later `send_message` call that uses `search_contact` as a capability
// prereq. Lifecycle (start/stop sweeper) is owned by runtime-state.ts
// — this module only declares the singleton so both surfaces can import
// without going through runtime-state (which would cycle into execution).
export const defaultCapabilityCache = new CapabilityCache();

/**
 * Common helper for both read-sites (direct execute + capability prereq).
 * On hit, returns the cached result with `_cache_hit: true` + `_cache_age_ms`
 * folded onto the body. On miss, calls `exec()` and stores on success.
 *
 * Strategies that don't declare `cache: {ttl}` skip the cache entirely
 * (callers pass `ttlMs = 0`). Errors are never cached — see `isCacheable`.
 */
export async function getCachedOrExecute<T extends { status: number; body: unknown }>(
  cache: CapabilityCache,
  platform: string,
  identity: string | undefined,
  capability: string,
  args: Record<string, unknown> | undefined,
  ttlMs: number,
  exec: () => Promise<T>,
): Promise<T & { _cache_hit?: boolean; _cache_age_ms?: number }> {
  if (ttlMs > 0) {
    const hit = cache.get(platform, identity, capability, args);
    if (hit) {
      const age = Date.now() - hit.ts;
      // The cached body may be a plain value (string, number) or an object.
      // Only fold the cache-hit hints onto object bodies — primitives stay
      // unchanged so callers that read body as a value don't see a wrapper.
      let body: unknown = hit.body;
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        body = { ...(body as Record<string, unknown>), _cache_hit: true, _cache_age_ms: age };
      }
      return {
        status: hit.status,
        body,
        _cache_hit: true,
        _cache_age_ms: age,
      } as T & { _cache_hit?: boolean; _cache_age_ms?: number };
    }
  }
  const fresh = await exec();
  if (ttlMs > 0) {
    cache.set(platform, identity, capability, args, fresh.status, fresh.body, ttlMs);
  }
  return fresh;
}

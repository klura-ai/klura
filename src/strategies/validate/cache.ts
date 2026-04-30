// Validator for the optional top-level `cache: {ttl: "<dur>"}` hint on a
// strategy body. Hint is opt-in; absence is fine. When present:
//   - Must be a plain object.
//   - Must declare `ttl` as a string matching `^\d+(s|m|h)$`.
//   - No other keys allowed (closed schema so future fields are explicit).
//
// See klura://reference#capability-cache.

import { isPlainObject } from './helpers';
import { parseTtl } from '../../cache/capability-cache';

const ALLOWED_CACHE_KEYS = new Set(['ttl']);

export function validateCacheShape(data: unknown): void {
  if (!isPlainObject(data)) return;
  const cache = (data as { cache?: unknown }).cache;
  if (cache === undefined || cache === null) return;
  if (!isPlainObject(cache)) {
    throw new Error(
      `invalid_strategy: cache must be a plain object like {"ttl": "5m"} (got ${typeof cache}). ` +
        `See klura://reference#capability-cache.`,
    );
  }
  // Closed schema — reject unknown keys. Future fields (e.g. cache.scope,
  // cache.invalidate_on) need to be added here explicitly so the agent
  // can't accidentally set a typo'd field that silently does nothing.
  for (const key of Object.keys(cache)) {
    if (!ALLOWED_CACHE_KEYS.has(key)) {
      const allowed = [...ALLOWED_CACHE_KEYS].map((k) => `"${k}"`).join(', ');
      throw new Error(
        `invalid_strategy: cache.${key} is not a valid field — allowed keys: ${allowed}. ` +
          `See klura://reference#capability-cache.`,
      );
    }
  }
  if (!('ttl' in cache)) {
    throw new Error(
      `invalid_strategy: cache requires "ttl" — like {"ttl": "5m"}. The hint exists purely to ` +
        `enable caching; an empty cache block has no other meaning. ` +
        `See klura://reference#capability-cache.`,
    );
  }
  // Defer the actual ttl-grammar check to the parser so the error message
  // (acceptable units, examples) lives in one place.
  try {
    parseTtl(cache.ttl);
  } catch (err) {
    throw new Error(
      `invalid_strategy: ${err instanceof Error ? err.message : String(err)}. ` +
        `See klura://reference#capability-cache.`,
      { cause: err },
    );
  }
}

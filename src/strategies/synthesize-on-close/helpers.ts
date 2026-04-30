// Small utilities shared across the synthesize-on-close passes.

import type { Session } from '../../drivers/types/session';

export function stringifyIfPresent(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

export function stringifyOrEmpty(value: unknown): string {
  return stringifyIfPresent(value) ?? '';
}

export function findLastIndex<T>(arr: T[], pred: (t: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    const el = arr[i];
    if (el !== undefined && pred(el)) return i;
  }
  return -1;
}

export type ParsedStrategyBody =
  | { kind: 'json'; obj: Record<string, unknown> }
  | { kind: 'form'; obj: Record<string, unknown> }
  | { kind: 'unparseable' };

/**
 * Parse a captured (already-templated) request body into the {key: value}
 * shape the strategy validator and executor's `resolveBody` both require.
 * JSON object bodies round-trip via JSON.parse; form-urlencoded bodies via
 * URLSearchParams with `contentType:'form'` driving the executor's
 * serializer. Any other shape (binary, plaintext, JSON arrays/scalars,
 * templates that landed in non-string JSON positions) is reported as
 * unparseable so synth_fetch can skip cleanly instead of emitting a
 * strategy the validator will reject.
 */
export function parseBodyForStrategy(body: string, contentTypeHeader: string): ParsedStrategyBody {
  const trimmed = body.trim();
  if (trimmed.length === 0) return { kind: 'unparseable' };

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { kind: 'json', obj: parsed as Record<string, unknown> };
    }
  } catch {
    /* not JSON — fall through */
  }

  if (contentTypeHeader.toLowerCase().includes('application/x-www-form-urlencoded')) {
    try {
      const params = new URLSearchParams(trimmed);
      const obj: Record<string, unknown> = {};
      for (const [k, v] of params) obj[k] = v;
      if (Object.keys(obj).length > 0) {
        return { kind: 'form', obj };
      }
    } catch {
      /* fall through */
    }
  }

  return { kind: 'unparseable' };
}

/**
 * Best-effort pick of the page URL the session was on when the marker-XHR
 * was captured. Stamped on the synthesized strategy's
 * `notes.discovered_from_url` so a later session can try opening the same
 * URL directly instead of re-discovering from the site root. Hash + query
 * are preserved — SPAs route on both.
 *
 * Source of truth is `session.visitedUrls`, the ordered list of top-level
 * navigations the driver has tracked. Returns undefined when no suitable
 * http(s) URL is known; callers must treat it as optional.
 */
export function pickDiscoveredFromUrl(session: Session): string | undefined {
  const visited = session.visitedUrls ?? [];
  for (let i = visited.length - 1; i >= 0; i -= 1) {
    const u = visited[i];
    if (typeof u !== 'string' || !u || u === 'about:blank') continue;
    try {
      const parsed = new URL(u);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
      return u;
    } catch {
      continue;
    }
  }
  return undefined;
}

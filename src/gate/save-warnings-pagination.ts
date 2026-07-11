// Hardcoded-pagination save warning.
//
// A cold agent asked "top three" bakes `size=3` / `hitsPerPage=10` into the
// endpoint query string, freezing the page size at whatever one caller wanted
// at discovery. The capability is "search", not "search for exactly three" — a
// warm caller who wants more can never get it.
//
// This is a structural check, not prose-matching: the query KEY must be in a
// bounded pagination-vocabulary set AND the value must be a bare integer that
// is not already a `{{placeholder}}`. It never reads the user's free-text
// request. Surfaced as an ack-able save_warning (not a reject) — a fixed size
// is occasionally correct (a capability that intentionally returns the single
// top hit), so the agent either parameterizes / drops the param or acks with a
// reason.
//
// Listed in the exceptions table in
// runtime/docs/principles.md#delegate-to-the-llm-but-allow-narrowly-scoped-runtime-heuristics.

import type { Strategy } from '../strategies/skills';
import type { SaveWarning } from './save-warnings';
import { WARNING_KINDS } from '../vocab';

// Query-param keys that denote a page SIZE / result count — "how many results",
// the lever a caller controls. Compared after lowercasing and stripping `_`/`-`,
// so `hitsPerPage`, `hits_per_page`, and `hitsperpage` all match one entry.
//
// Page-POSITION keys (`page`, `offset`, `from`, `start`) are deliberately absent:
// baking a page number is a benign default (you want page 1), not a result-count
// cap. Only the per-page count freezes reusability, so only it is flagged.
const PAGINATION_KEYS = new Set([
  'size',
  'limit',
  'count',
  'perpage',
  'pagesize',
  'hitsperpage',
  'rows',
  'maxresults',
  'numresults',
  'resultsperpage',
  'take',
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

// Pull `key=value` pairs from the endpoint's query string without needing a
// base URL. Templated tokens (`{{q}}`) round-trip fine as opaque values.
function queryPairs(endpoint: string): Array<{ key: string; value: string }> {
  const qIdx = endpoint.indexOf('?');
  if (qIdx < 0) return [];
  const query = endpoint.slice(qIdx + 1);
  const out: Array<{ key: string; value: string }> = [];
  for (const segment of query.split('&')) {
    if (!segment) continue;
    const eq = segment.indexOf('=');
    if (eq < 0) continue;
    out.push({ key: segment.slice(0, eq), value: segment.slice(eq + 1) });
  }
  return out;
}

// A value is a baked page size when it is a bare integer and carries no
// `{{placeholder}}` (a templated size is already caller-driven).
function isBakedInteger(value: string): boolean {
  if (value.includes('{{')) return false;
  return /^\d+$/.test(value.trim());
}

export function detectHardcodedPaginationValue(data: Strategy): SaveWarning[] {
  const endpoint =
    typeof (data as { endpoint?: unknown }).endpoint === 'string'
      ? ((data as { endpoint?: string }).endpoint as string)
      : '';
  if (!endpoint) return [];

  const flagged: string[] = [];
  for (const { key, value } of queryPairs(endpoint)) {
    if (PAGINATION_KEYS.has(normalizeKey(key)) && isBakedInteger(value)) {
      flagged.push(`${key}=${value.trim()}`);
    }
  }
  const firstKey = flagged[0]?.split('=')[0];
  if (!firstKey) return [];

  return [
    {
      kind: WARNING_KINDS.hardcodedPaginationValue,
      message:
        `endpoint bakes a fixed page size: ${flagged.join(', ')}. Result count is a caller ` +
        `concern — freezing it at the discovery value caps every future call.`,
      hint:
        `Expose it as a param (\`&${firstKey}={{count}}\` fed by a notes.params arg), ` +
        `or drop the param and let the server default stand. Ack only if this capability ` +
        `intentionally returns a fixed count.`,
      context: { flagged },
    },
  ];
}

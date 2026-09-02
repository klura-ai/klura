// Pagination save warnings. Two independent concerns over the same domain:
// a page size frozen at the discovery value, and a pagination question the
// strategy left unanswered.
//
// ---------- Hardcoded page size ----------
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
import { paginationCandidateParams } from '../execution/collection-emptiness';
import { WARNING_KINDS, refUrl, REF_LINKS } from '../vocab';

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

// ---------- Unanswered pagination question ----------
//
// `notes.params.<name>.paginates` is what routes a param into check C, the only
// check that can prove a page window advances: a single page-1 call is
// byte-for-byte what a strategy ignoring its page param returns.
//
// Absence of the key is unfalsifiable — "nothing here paginates" and "the
// question was never considered" are the same bytes, so a runtime reading only
// declarations sees full coverage over an empty set. Requiring an explicit
// `true` or `false` on every param the proof could settle makes the two
// distinguishable: silence becomes impossible, and a wrong `true` is caught by
// check C executing the second page.
//
// The candidate set is structural (`paginationCandidateParams` — templated into
// the request, integer example), never a page/offset name list.
export function detectUnansweredPaginationQuestion(data: Strategy): SaveWarning[] {
  const params = (data as { notes?: { params?: Record<string, unknown> } }).notes?.params ?? {};
  const unanswered = paginationCandidateParams(data).filter((name) => {
    const doc = params[name];
    return !(doc && typeof doc === 'object' && 'paginates' in doc);
  });
  if (unanswered.length === 0) return [];

  const named = unanswered.map((name) => `\`${name}\``).join(', ');
  const first = unanswered[0] as string;
  return [
    {
      kind: WARNING_KINDS.unansweredPaginationQuestion,
      message:
        `${named} ${unanswered.length === 1 ? 'is' : 'are'} templated into the request with an ` +
        `integer example, so ${unanswered.length === 1 ? 'it could advance' : 'they could advance'} ` +
        `a page window over the returned rows — and the strategy does not say whether ` +
        `${unanswered.length === 1 ? 'it does' : 'they do'}. Without an answer the second page is ` +
        `never executed, and a strategy that silently ignores its page param returns exactly what ` +
        `a working one returns on page 1.`,
      hint:
        `Answer for each one — e.g. \`notes.params.${first}.paginates\`: \`true\` if it steps through the same ` +
        `collection (post-save verification then executes the next consecutive integer and requires ` +
        `the two row sets to be disjoint), \`false\` if it selects different data or shapes one ` +
        `result set. See ${refUrl(REF_LINKS.capabilityParameters)} §"Declaring a paginating param".`,
      context: { unanswered },
    },
  ];
}

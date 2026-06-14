// Save-warning detector: a recorded-path that INLINES a name→id lookup.
//
// When the agent types a query + clicks a search result to resolve an entity id
// and records that into a capability, the lookup is conflated into the UI walk —
// future capabilities that need the same resolution have to redo the typing +
// clicking. The fix is to factor the lookup out as its own `lookup_<entity>_by_*`
// capability and reference it via a capability prereq.
//
// The lookup is detected by correlating captured `/search`|`/lookup` XHRs to the
// click/type actions that fired them (by timestamp), NOT by scanning the whole
// session's captured-URL set — otherwise an unrelated exploration (a direct
// navigate to `/search` for a DIFFERENT capability earlier in a map session)
// false-flags every recorded-path saved later.

import type { Strategy } from '../strategies/skills';
import type { SaveWarning } from './save-warnings';

/** Actions that can trigger a name→id lookup XHR (you type a query / click a
 *  result). A direct `navigate` does not count — that's exploration. */
const LOOKUP_TRIGGER_ACTIONS = new Set(['click', 'type', 'fill_editor', 'select']);
/** Window after a click/type within which a fired XHR is attributable to it. */
const LOOKUP_CORRELATION_WINDOW_MS = 2500;
const LOOKUP_PATH_RE = /\/(search|lookup)(?:\/|\?|$)/i;

export function detectRecordedPathInlinesLookup(
  data: Strategy,
  intercepted: ReadonlyArray<{ url?: string; timestamp?: number }>,
  actions: ReadonlyArray<{ action: string; at: number }>,
  capability?: string,
): SaveWarning[] {
  if ((data as { strategy?: unknown }).strategy !== 'recorded-path') return [];
  // Suppress when the capability itself IS a lookup (e.g. lookup_*).
  if (typeof capability === 'string') {
    if (/^lookup_/.test(capability)) return [];
    if (/_search$/.test(capability)) return [];
  }
  // Only a lookup XHR CAUSED BY a click/type interaction counts as "inlined".
  const triggerTimes = actions
    .filter((a) => LOOKUP_TRIGGER_ACTIONS.has(a.action) && typeof a.at === 'number')
    .map((a) => a.at);
  if (triggerTimes.length === 0) return [];
  const lookupHits: string[] = [];
  const seenPaths = new Set<string>();
  for (const req of intercepted) {
    if (typeof req.url !== 'string' || typeof req.timestamp !== 'number') continue;
    let canon: string;
    try {
      const u = new URL(req.url);
      canon = `${u.origin}${u.pathname}`;
    } catch {
      continue;
    }
    if (!LOOKUP_PATH_RE.test(canon)) continue;
    const ts = req.timestamp;
    const triggered = triggerTimes.some((t) => ts >= t && ts - t <= LOOKUP_CORRELATION_WINDOW_MS);
    if (!triggered) continue;
    if (seenPaths.has(canon)) continue;
    seenPaths.add(canon);
    lookupHits.push(canon);
  }
  const sample = lookupHits[0];
  if (sample === undefined) return [];
  const capSlug = capability ?? 'this_capability';
  const entityGuess = (() => {
    try {
      const segs = new URL(sample).pathname.split('/').filter((s) => s.length > 0);
      const idx = segs.findIndex((s) => s === 'search' || s === 'lookup');
      if (idx > 0) return (segs[idx - 1] ?? 'entity').replace(/s$/, '') || 'entity';
    } catch {
      /* template-only path */
    }
    return 'entity';
  })();
  return [
    {
      kind: 'recorded_path_inlines_lookup',
      message:
        `recorded-path strategy fired ${lookupHits.length} XHR(s) hitting ${sample} — that's a name→id lookup ` +
        `conflated into ${capSlug}. The clicks that select a search result are the lookup; future capabilities ` +
        `that need the same resolution have to redo your typing+clicking. Save GET ${sample} as its own ` +
        `lookup_${entityGuess}_by_<key> capability (tier=fetch with response.extract pulling the ` +
        `target id), then this capability becomes a fetch / page-script with a ` +
        `{kind: "capability", capability: "lookup_${entityGuess}_by_<key>", vars: {"${entityGuess}_id": "<dot.path>"}} ` +
        `prereq instead of the inline UI walk. See klura://reference#capability-prereq.`,
      hint:
        `Two-step lift: (1) save_strategy("lookup_${entityGuess}_by_<key>", fetch) for the GET ${sample}; ` +
        `(2) re-save this capability as fetch / page-script with a capability prereq pointing at it.`,
    },
  ];
}

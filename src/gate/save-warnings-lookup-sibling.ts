// Detector: capability slug has a lookup-implying segment (`_by_X` /
// `_for_X` / `lookup_X`) AND the platform has a saved sibling capability
// whose slug looks lookup-shaped (`^lookup_*`, `*_search`, `^find_*_by_*`,
// `^get_*_by_*`) AND this strategy declares no
// `prerequisites[{kind: "capability"}]` entry referencing it.
//
// Catches the OMITTED-prereq shape: agent saved the sibling lookup
// capability separately (good!) but forgot to wire it into the new
// `_by_X` strategy. At warm-execute the `{{<id>}}` placeholder it would
// resolve stays unbound; the send fires with a literal placeholder or
// wrong id and silently fails.
//
// Sibling to `detectLookupEmbeddedInPrereq` in save-warnings.ts — that
// one catches the inverse (agent INLINES the lookup as fetch-extract).

import type { Strategy } from '../strategies/skills';
import { findLookupSegments } from './save-audit';
import type { SaveWarning } from './save-warnings';

export function detectLookupSiblingNotReferenced(
  data: Strategy,
  capability: string,
  listSavedCapabilityNames: (() => string[]) | undefined,
): SaveWarning[] {
  if (!listSavedCapabilityNames) return [];
  const lookupSegments = findLookupSegments(capability);
  if (lookupSegments.length === 0) return [];

  const prereqs = (data as Record<string, unknown>).prerequisites;
  const hasCapabilityPrereq =
    Array.isArray(prereqs) &&
    prereqs.some(
      (p) => p && typeof p === 'object' && (p as Record<string, unknown>).kind === 'capability',
    );
  // If a capability prereq exists, defer to detectLookupEmbeddedInPrereq /
  // other audits to judge whether the wiring is correct.
  if (hasCapabilityPrereq) return [];

  const lookupShape = (slug: string): boolean =>
    slug.startsWith('lookup_') ||
    /_search$/.test(slug) ||
    /^find_\w+_by_\w+$/.test(slug) ||
    /^get_\w+_by_\w+$/.test(slug);
  const lookupSiblings = listSavedCapabilityNames().filter(
    (s) => s !== capability && lookupShape(s),
  );
  if (lookupSiblings.length === 0) return [];

  const firstSibling = lookupSiblings[0];
  const siblingsList = lookupSiblings.map((s) => `"${s}"`).join(', ');
  return [
    {
      kind: 'lookup_sibling_not_referenced',
      message:
        `Capability slug "${capability}" has a lookup-implying segment (${lookupSegments.join(', ')}), ` +
        `and the platform has saved sibling capability ${siblingsList} that looks lookup-shaped — but ` +
        `this strategy declares no \`prerequisites[{kind: "capability", capability: "<sibling>", ...}]\` ` +
        `entry to chain through it. At warm-execute time any \`{{<id>}}\` placeholder the lookup would ` +
        `resolve stays unbound; the send fires with a literal placeholder or wrong id and the call ` +
        `silently fails (or routes to the wrong target).`,
      hint:
        `Wire it: append \`{kind: "capability", capability: "${firstSibling}", args: {<recipient-arg>: ` +
        `"{{<caller-arg>}}"}, vars: {<id-binding>: "<response.dot.path>"}}\` to prerequisites[], and ` +
        `reference \`{{<id-binding>}}\` wherever the id appears (endpoint path, body field, etc). ` +
        `Ack only if the caller does the lookup externally and passes the resolved id directly: ` +
        `audit_answers: {lookup_sibling_not_referenced: "<one-sentence reason>"}`,
    },
  ];
}

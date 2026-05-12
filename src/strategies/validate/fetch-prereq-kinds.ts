// Tier-vs-prereq compatibility for fetch strategies. Fetch executes in Node
// only — no browser, no live page. Prereqs of kind "js-eval" or "browser"
// require a live page to mint their values, so a fetch strategy that depends
// on either is a tier misclassification that can never run in Node.
//
// Reject the combo at save time. Steers the agent to page-script up front,
// where js-eval and browser prereqs are first-class and `response.from` works
// identically.

import { isPlainObject } from './helpers';
import { refUrl, REF_LINKS } from '../../vocab';

const BROWSER_BOUND_KINDS = new Set(['js-eval', 'browser']);

export function validateFetchPrereqKinds(data: Record<string, unknown>, tier: string): void {
  if (tier !== 'fetch') return;
  const prereqs = data.prerequisites;
  if (!Array.isArray(prereqs)) return;

  const offenders: Array<{ index: number; name: string; kind: string }> = [];
  prereqs.forEach((p, i) => {
    if (!isPlainObject(p)) return;
    const kind = typeof p.kind === 'string' ? p.kind : null;
    if (kind && BROWSER_BOUND_KINDS.has(kind)) {
      const name = typeof p.name === 'string' ? p.name : `<unnamed[${i}]>`;
      offenders.push({ index: i, name, kind });
    }
  });

  if (offenders.length === 0) return;

  const list = offenders
    .map((o) => `prerequisites[${o.index}] (name: "${o.name}", kind: "${o.kind}")`)
    .join(', ');

  throw new Error(
    `invalid_strategy: fetch tier is Node-only — prereqs of kind "js-eval" or "browser" require a live browser ` +
      `page to mint their values, and a fetch strategy that depends on either can never run in Node. Offenders: ${list}. ` +
      `Reclassify as tier "page-script" — js-eval / browser prereqs are first-class there, and response.from on a ` +
      `js-eval prereq works identically (the strategy returns the prereq's bound value with no real HTTP fire). ` +
      `See ${refUrl(REF_LINKS.pageScriptSchema)}.`,
  );
}

// Tier-vs-prereq compatibility for fetch strategies. Fetch executes in Node
// only — no browser, no live page. Prereqs of kind "js-eval" or "browser"
// require a live page to mint their values, so a fetch strategy that depends
// on either is a tier misclassification that can never run in Node.
//
// Reject the combo at save time. The rejection carries both remedies, because
// only one of them is usually right: a js-eval that merely reads the loaded
// document is redundant next to `response.format: "html"` (a `json` extract
// path parses a <script> payload without a browser), and demoting on account
// of it costs the fetch tier for nothing. Demotion to page-script is the
// answer only when the prereq truly needs a live page.

import { isPlainObject } from './helpers';
import { refUrl, REF_LINKS, type PrereqKind } from '../../vocab';

// Widened to ReadonlySet<string> so `.has()` accepts raw agent-submitted kind
// strings; the initializer stays PrereqKind-typed so membership is vocab-checked.
const BROWSER_BOUND_KINDS: ReadonlySet<string> = new Set<PrereqKind>(['js-eval', 'browser']);

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
      `Two ways out — pick by what the prereq is actually for:\n` +
      `  1. It only reads values out of the already-loaded document (parsing a <script> payload, scraping ` +
      `rendered text). Then it is not needed at all: drop it and read the same values from the response with ` +
      `\`response: {format: "html", extract: {...}}\`. A \`json\` dot-path on an extract entry parses a ` +
      `<script> tag's JSON and returns the raw value, which is what such a prereq was doing by hand — the ` +
      `capability stays on fetch and runs in Node with no browser. See ${refUrl(REF_LINKS.fetchSchema)}.\n` +
      `  2. It genuinely needs the live page (calling the site's signer, reading in-page state that no ` +
      `response carries). Then reclassify as tier "page-script", where js-eval / browser prereqs are ` +
      `first-class and response.from on a js-eval prereq works identically (the strategy returns the ` +
      `prereq's bound value with no real HTTP fire). See ${refUrl(REF_LINKS.pageScriptSchema)}.`,
  );
}

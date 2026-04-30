/**
 * Save-time validation for prereqs that recursively invoke another saved
 * strategy — `{kind: "capability"}` (named slug) and `{kind: "tag"}` (typed
 * edge resolved to a capability via `provides`). Three save-path checks
 * that can only happen once the save knows the CALLER's platform + capability
 * slug:
 *
 * 1. Self-loop: a capability prereq that invokes the strategy being saved (even
 * via a different platform label) would recurse forever at execute time. Reject
 * at save. The tag-prereq variant: the strategy being saved itself advertises
 * the tag it depends on.
 * 2. Target exists (capability): the capability prereq names a strategy slug.
 * If that strategy has never been saved, the sub-execute will fail at warm
 * time. Reject at save.
 * 3. Provider exists (tag): at least one saved capability on the platform must
 * declare `provides: ["<tag>"]`. Reject if zero providers exist.
 *
 * Callers can override target/provider strictness via the `optional: true`
 * flag — an optional prereq that's missing at warm time binds null instead of
 * failing, and save accepts so the agent can author the chain out-of-order.
 */

import type { Strategy } from '../skills';
import { findCapabilitiesProviding, loadStrategy } from '../skills';
import { isPlainObject } from './helpers';

export function validateCapabilityPrereqs(
  data: Strategy,
  callerPlatform: string,
  callerCapability: string,
): void {
  const prereqs = (data as { prerequisites?: unknown }).prerequisites;
  if (!Array.isArray(prereqs)) return;
  const rawProvides = (data as { provides?: unknown }).provides;
  const callerProvides: string[] = Array.isArray(rawProvides)
    ? rawProvides.filter((t): t is string => typeof t === 'string')
    : [];
  const issues: string[] = [];
  prereqs.forEach((p, i) => {
    if (!isPlainObject(p)) return;
    const targetPlatform =
      typeof p.platform === 'string' && p.platform.length > 0 ? p.platform : callerPlatform;
    if (p.kind === 'capability') {
      const targetCap = p.capability;
      if (typeof targetCap !== 'string') return; // shape validation catches this elsewhere
      // Self-loop: same platform + same capability.
      if (targetPlatform === callerPlatform && targetCap === callerCapability) {
        issues.push(
          `prerequisites[${i}] (kind:"capability") invokes the strategy currently being saved ` +
            `(platform="${targetPlatform}", capability="${targetCap}"). That is a self-loop and would recurse infinitely at execute time. ` +
            `If you meant to reference a different capability, adjust the slug.`,
        );
        return;
      }
      if (p.optional === true) return;
      const target = loadStrategy(targetPlatform, targetCap);
      if (!target) {
        issues.push(
          `prerequisites[${i}] (kind:"capability") references ${targetPlatform}/${targetCap} but no strategy ` +
            `with that slug is saved. Save the lookup strategy FIRST (save_strategy("${targetPlatform}", "${targetCap}", ...)) ` +
            `then retry this save. If the target doesn't exist yet and that's acceptable (the caller may provide the ` +
            `bound value another way), mark the prereq with \`optional: true\` — warm execute will bind null when the ` +
            `target isn't saved yet.`,
        );
      }
      return;
    }
    if (p.kind === 'tag') {
      const tag = p.tag;
      if (typeof tag !== 'string') return; // shape validation catches this elsewhere
      // Self-loop: caller advertises the tag it requires on the same platform.
      if (targetPlatform === callerPlatform && callerProvides.includes(tag)) {
        issues.push(
          `prerequisites[${i}] (kind:"tag", tag="${tag}") would resolve to the strategy currently being saved ` +
            `because it declares \`provides: ["${tag}"]\`. That is a self-loop and would recurse infinitely. ` +
            `Either drop "${tag}" from this strategy's \`provides\`, or remove the prereq.`,
        );
        return;
      }
      if (p.optional === true) return;
      const providers = findCapabilitiesProviding(targetPlatform, tag);
      if (providers.length === 0) {
        issues.push(
          `prerequisites[${i}] (kind:"tag", tag="${tag}") on platform "${targetPlatform}" — no saved capability ` +
            `declares \`provides: ["${tag}"]\`. Save such a capability first (e.g. an auth/login flow with ` +
            `\`provides: ["${tag}"]\` declared at the top level), or mark this prereq with \`optional: true\`.`,
        );
      }
    }
  });
  // Every capability-prereq rejection pairs the issue with an inline expected-
  // shape block + pointer to the reference section. The shape shows the fix-now
  // key set; the pointer carries the worked examples for deeper catalog lookup.
  const shape =
    'Expected shape:\n' +
    '  {\n' +
    '    "name": "<unique id>",\n' +
    '    "kind": "capability",\n' +
    '    "capability": "<snake_case slug of the target strategy>",\n' +
    '    "platform"?: "<platform slug, defaults to caller platform>",\n' +
    '    "args"?: { "<arg>": "{{...}}" | "<literal>" },\n' +
    '    "vars"?: { "<bind_name>": "<dot.path.in.response>" },\n' +
    '    "optional"?: boolean  // when true, a missing target binds null\n' +
    '  }';
  const ref = `\n\n${shape}\n\nSee klura://reference#capability-prereq.`;
  if (issues.length === 1) {
    throw new Error(`invalid_strategy: ${issues[0]}${ref}`);
  }
  if (issues.length > 1) {
    throw new Error(
      `invalid_strategy: ${issues.length} capability-prereq issues — fix all before retrying:\n` +
        issues.map((s) => `  - ${s}`).join('\n') +
        ref,
    );
  }
}

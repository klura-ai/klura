// Detector: a strategy field whose whole value is, verbatim, a value the
// caller passed to `start_session` / `declare_capability` for this capability.
// A baked caller value makes the saved strategy correct for exactly one
// caller and silently wrong for every other one — the field should carry a
// `{{<arg>}}` placeholder fed by that arg.
//
// Runs as a Stage-1 Detector rather than a `literal_provenance` validation
// issue: Stage 1 fires BEFORE any classifier token mints, so the agent fixes
// the shape on a token-free rejection and the classifier's hash later binds a
// stable body (see the sequencing rationale in runtime/src/audit/index.ts).
// It also reuses the ack channel for the one legitimate exception — the value
// is genuinely fixed for every caller and merely happens to equal what this
// caller asked for.
//
// Crisp by construction: whole-field exact match against a declared arg value,
// with a minimum length so short generic tokens ("1", "en", "US") can't
// collide their way into a false positive. No substring search, no prose
// matching.

import type { Strategy } from '../strategies/skills';
import type { SaveWarning } from './save-warnings';
import { collectScannedFields } from '../strategies/validate/helpers';
import { parseSecretReference } from '../identity/secret-reference';
import { WARNING_KINDS } from '../vocab';

/** Shortest declared arg value that can be matched. Below this, an exact
 *  match carries no evidence — a 2-char value collides with locale codes,
 *  page numbers, and enum tokens that really are static. */
const MIN_MATCHABLE_VALUE_LENGTH = 3;

/** The declaration shape this detector reads: the caller-supplied args of
 *  every capability declared on the session. */
export interface DeclaredCapabilityArgs {
  args: Record<string, unknown>;
}

/** Map each caller-supplied arg VALUE → its arg name. First declaration wins
 *  so the reported name is the one the caller used earliest. */
function argNameByValue(
  declared: ReadonlyArray<DeclaredCapabilityArgs> | undefined,
): Map<string, string> {
  const byValue = new Map<string, string>();
  for (const d of declared ?? []) {
    for (const [name, val] of Object.entries(d.args)) {
      if (typeof val !== 'string') continue;
      const trimmed = val.trim();
      if (trimmed.length < MIN_MATCHABLE_VALUE_LENGTH) continue;
      if (!byValue.has(trimmed)) byValue.set(trimmed, name);
    }
  }
  return byValue;
}

/**
 * Where a caller value sits inside a URL field, when it is not the whole field.
 *
 * Whole-field equality is the crispest form and stays the first check, but it
 * misses the shape that actually shows up: a value embedded in a longer URL.
 * Observed twice in one evening — a section slug inside a documentation prereq
 * URL, and a search term inside a maps request path — each producing a strategy
 * that templates the argument somewhere harmless while the request keeps
 * answering for the discovery value.
 *
 * Substring matching would flag coincidence, so the rule is structural and
 * matches the one literal provenance already uses: a value counts only when it
 * occupies COMPLETE path segments or an entire query-parameter value. `API`
 * inside `/docs/Web/API` is a segment; `API` inside `/apidocs` is not.
 *
 * Returns a short description of the position, or null when the value is absent
 * or only coincidentally overlapping.
 */
function locateValueInUrl(fieldValue: string, argValue: string): string | null {
  let url: URL;
  try {
    url = new URL(fieldValue, 'https://placeholder.invalid');
  } catch {
    return null;
  }

  for (const [param, value] of url.searchParams.entries()) {
    if (value === argValue) return `the \`${param}\` query value`;
  }

  const segments = url.pathname.split('/').filter(Boolean);
  const wanted = argValue.split('/').filter(Boolean);
  if (wanted.length === 0) return null;
  for (let i = 0; i + wanted.length <= segments.length; i += 1) {
    if (wanted.every((w, j) => segments[i + j] === w)) {
      return wanted.length === 1 ? 'a path segment' : `${wanted.length} consecutive path segments`;
    }
  }
  return null;
}

export function detectCallerArgBaked(
  data: Strategy,
  declared: ReadonlyArray<DeclaredCapabilityArgs> | undefined,
): SaveWarning[] {
  const byValue = argNameByValue(declared);
  if (byValue.size === 0) return [];
  const out: SaveWarning[] = [];
  for (const field of collectScannedFields(data)) {
    // A templated field is already parameterized; a secret reference resolves
    // per caller through the identity layer. Neither bakes anything.
    if (field.value.includes('{{')) continue;
    if (parseSecretReference(field.value)) continue;
    let argName = byValue.get(field.value.trim());
    let position: string | null = null;
    if (argName === undefined && field.path.endsWith('.url')) {
      for (const [value, name] of byValue) {
        const where = locateValueInUrl(field.value, value);
        if (where) {
          argName = name;
          position = where;
          break;
        }
      }
    }
    if (argName === undefined) continue;
    out.push({
      kind: WARNING_KINDS.callerArgBaked,
      message: position
        ? `${field.path} is ${JSON.stringify(field.value)}, which carries this caller's ` +
          `"${argName}" argument as ${position}. Saved as-is, this request keeps addressing the ` +
          `value discovery used no matter what a caller passes — templating "${argName}" ` +
          `elsewhere in the strategy does not change where the request actually points.`
        : `${field.path} is the literal ${JSON.stringify(field.value)}, which is exactly the value ` +
          `this caller passed as the "${argName}" argument. Saved as-is, the strategy answers ` +
          `every future call with this one caller's value.`,
      hint:
        `Template the field as "{{${argName}}}", declare notes.params.${argName}, and classify ` +
        `literal_provenance["${field.path}"] as {caller_input: "${argName}"}. If the value is ` +
        `genuinely fixed for every caller and only coincides with this argument, ack with a ` +
        `one-sentence reason saying what fixes it.`,
      context: { path: field.path, arg: argName, value: field.value },
    });
  }
  return out;
}

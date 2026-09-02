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
    const argName = byValue.get(field.value.trim());
    if (argName === undefined) continue;
    out.push({
      kind: WARNING_KINDS.callerArgBaked,
      message:
        `${field.path} is the literal ${JSON.stringify(field.value)}, which is exactly the value ` +
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

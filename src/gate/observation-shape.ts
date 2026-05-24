// Value-shape predicates over ParamObservation lists. Pure structural checks
// that several save-time gates (`detectUngroundedEnumPlaceholder`,
// `validateCallerInputParamKind`, `collectListingCandidates`, the
// `enum_param_grounded` save-authoring-contract constraint) share. Lives in
// its own file rather than `save-warnings.ts` so the line-cap stays honest.

import { ID_SHAPED_EXAMPLE_PATTERNS } from '../strategies/validate/constants';

/** A caller-typed string is id-shaped (numeric id, ObjectId, UUID, opaque
 *  token) — used by name-vs-id gap detection to skip when the caller is
 *  already handing over an id-shaped string. */
export function valueLooksIdShaped(v: string): boolean {
  return ID_SHAPED_EXAMPLE_PATTERNS.some(({ re }) => re.test(v));
}

/**
 * Observed values that are all bare integers indicate a range-shaped URL
 * param (`?limit=`, `?offset=`, `?page=`) — pagination/depth clicks, not
 * enumerable options. Future callers can pass any integer in the API's
 * range without 4xx, so enum-grounding via `observed_values` doesn't
 * structurally apply. Integer-coded enums (`?type=0|1|2`) are rare and can
 * declare `kind: "enum"` with explicit `observed_values` directly — that
 * path stays validated independently of this skip.
 *
 * Empty input returns `false` — the caller decides what to do when no
 * observations exist; this helper only speaks about shape.
 */
export function observedValuesAreIntegerRange(
  observations: ReadonlyArray<{ value: string }>,
): boolean {
  if (observations.length === 0) return false;
  return observations.every((o) => typeof o.value === 'string' && /^-?\d+$/.test(o.value.trim()));
}

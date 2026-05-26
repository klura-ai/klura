// Ack-shape types + normalizer. Acks come in two forms — a plain string
// (the cheap path: just the one-sentence reason) and a structured object
// `{reason, covered_by?, ...}` (load-bearing when a Detector needs
// structural input it can't extract from prose, e.g. validating cover
// claims against the platform's saved-strategy set without prose-parsing).
//
// Lives in its own module so the Audit class's main file stays under the
// line-count budget — these types are referenced from validateAck signatures
// across detectors but are independent of the audit runner machinery.

/** Acks come in two shapes:
 *   - `string` — the cheap path: the agent's one-sentence reason.
 *   - `{ reason, [structuredField]?, ... }` — used when a Detector needs
 *     structural input it can't extract from prose (e.g. the
 *     observed-capability ack's `covered_by: [<slug>]` slot, validated
 *     against the platform's saved-strategy set without prose-parsing).
 *
 * Internally normalized to `NormalizedAck` before per-detector validateAck
 * sees the ack — so detectors that don't care about structured fields just
 * read `.reason`.
 */
export type AckValue = string | StructuredAck;

export interface StructuredAck {
  reason: string;
  /** Names of platform-saved capabilities the agent claims cover the
   *  deferred slugs. Validated structurally by detectors that opt in
   *  (`observed_capabilities_not_lifted`'s validateAck reads this against
   *  `readPlatformSkillInfo().capabilities[].name`). When absent, the
   *  detector treats the ack as a pure structural-reason deferral. */
  covered_by?: string[];
  /** Open for future per-detector structured fields. */
  [key: string]: unknown;
}

/** What per-detector validateAck sees. Always carries `.reason` plus any
 *  structured fields the caller supplied. */
export interface NormalizedAck {
  reason: string;
  covered_by?: string[];
  [key: string]: unknown;
}

/** Coerce an `AckValue` to a `NormalizedAck`. Returns null when the input
 *  fails the non-empty-reason floor — caller surfaces a uniform "reason
 *  required" rejection. Object inputs may carry `covered_by` and any other
 *  structured fields detectors opt into; strings collapse to `{reason}`. */
export function normalizeAck(raw: unknown): NormalizedAck | null {
  if (typeof raw === 'string') {
    if (raw.trim().length === 0) return null;
    return { reason: raw };
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const reason = obj.reason;
    if (typeof reason !== 'string' || reason.trim().length === 0) return null;
    const out: NormalizedAck = { reason };
    if (Array.isArray(obj.covered_by)) {
      out.covered_by = obj.covered_by.filter((v): v is string => typeof v === 'string');
    }
    for (const [k, v] of Object.entries(obj)) {
      if (k !== 'reason' && k !== 'covered_by') out[k] = v;
    }
    return out;
  }
  return null;
}

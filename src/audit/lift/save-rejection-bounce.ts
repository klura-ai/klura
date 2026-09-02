// Structural-dead-end hard bounce for the save_strategy audit loop.
//
// Bench loops surface agents iterating the SAME save_strategy rejection 5–12×
// with cosmetic edits — chasing a detector false-positive, a schema
// contradiction, or a genuinely unsupported shape — burning rounds that would
// otherwise cover simpler capabilities. The `_budget_warning` prose already
// asks the agent to stop after 3 same-rejection retries; this enforces it
// structurally. After the 3rd same-family rejection for one capability the
// runtime stops echoing the same audit prose and returns a
// `save_strategy_structural_dead_end` whose exit menu leads with the
// underlying rejection's OWN remedy (add-prereq / re-ground / observed-value
// paste) and falls back to defer / tier-switch / abort.
//
// The bounce fires on the REJECTION, never on the attempt: every retry —
// including the one that trips the threshold — is fully evaluated by the
// audit first, so a genuine structural fix on the 3rd attempt commits
// normally and never reaches this module.

import type { AuditRejection, Remedy } from '../index';
import type { Strategy } from '../../strategies/skills';
import type { Session } from '../../drivers/types/session';
import { AUDIT_KINDS, TOOL_NAMES, WARNING_KINDS } from '../../vocab';

/** Same-family rejections allowed before the bounce. The 3rd is the bounce. */
export const DEAD_END_THRESHOLD = 3;

/** Rejection reasons that are audit-flow bookkeeping, not substantive
 *  failures of the strategy's shape: `pending` is the first-call checklist
 *  mint (the agent hasn't answered anything yet) and `payload_changed` means
 *  the agent DID change the shape (the opposite of a cosmetic retry). Neither
 *  counts toward the dead-end budget. */
const NON_SUBSTANTIVE_REASONS: ReadonlySet<AuditRejection['reason']> = new Set([
  'pending',
  'payload_changed',
]);

/** Leading `notes.params.<param>` path of a classifier issue bullet. Enum /
 *  param-kind validation bullets anchor on the strategy's own structural path
 *  rather than the classifier kind; the path token is the stable component. */
const NOTES_PARAMS_PATH_RE = /^notes\.params\.([A-Za-z0-9_-]+)/;

/** Structural shape of an ack issue bullet: `acks["<kind>"] ...` — see the
 *  ack-check loop in `Audit.process` (runtime/src/audit/index.ts). */
const ACK_ISSUE_KIND_RE = /^acks\["([^"]+)"\]/;

/** Component a single classifier-issue bullet contributes to the family key.
 *  Attribution is structural, in priority order:
 *   1. the bullet leads with an active classifier's kind (the bullet
 *      conventions in save-strategy-classifiers / save-audit put the kind or
 *      `kind["path"]` first);
 *   2. the bullet leads with a `notes.params.<param>` strategy path (enum /
 *      param-kind grounding bullets) — the param name scopes the component,
 *      so fixing param A then failing on param B is a fresh family;
 *   3. the constant `classifier_issue` bucket. */
function bulletComponent(bullet: string, candidateKinds: readonly string[]): string {
  for (const kind of candidateKinds) {
    if (!bullet.startsWith(kind)) continue;
    const next = bullet.charAt(kind.length);
    if (
      next === '' ||
      next === ':' ||
      next === '[' ||
      next === ' ' ||
      next === '.' ||
      next === '"'
    ) {
      return kind;
    }
  }
  const param = NOTES_PARAMS_PATH_RE.exec(bullet)?.[1];
  if (param) return `notes.params.${param}`;
  return 'classifier_issue';
}

/** Family components carrying an ACTIVE issue in THIS rejection. Only the
 *  dimensions that actually blocked this call contribute — a classifier that
 *  appears in the `items` checklist but auto-classified / validated clean
 *  this round is excluded, so resolving one dimension while another still
 *  fails doesn't inflate the family with the resolved kind. */
function activeComponents(rejection: AuditRejection): string[] {
  const components = new Set<string>();
  if (rejection.reason === 'unacked_warnings') {
    // `warnings` on this rejection class is exactly the unacked blocking set.
    for (const w of rejection.warnings) components.add(w.kind);
    for (const bullet of rejection.ack_issues ?? []) {
      components.add(ACK_ISSUE_KIND_RE.exec(bullet)?.[1] ?? 'ack_issue');
    }
  } else if (rejection.reason === 'answers_inconsistent') {
    // `warnings` here is the acked-through set (Stage 1 already cleared) —
    // the active issues are the classifier bullets.
    const candidateKinds = Object.keys(rejection.items ?? {}).sort((a, b) => b.length - a.length);
    for (const bullet of rejection.classifier_issues ?? []) {
      components.add(bulletComponent(bullet, candidateKinds));
    }
  }
  return [...components];
}

/**
 * A stable signature for "which rejection is this." Two retries belong to the
 * same family when the same tier was saved AND the same set of ACTIVE issue
 * components fired — cosmetic edits to unrelated fields don't change it, but
 * fixing one dimension and hitting a different one does (a fresh family,
 * fresh budget). The tier is part of the key, so a fetch → recorded-path
 * pivot resets the family even when the overlapping classifiers fire on both
 * tiers. Returns `null` for non-substantive reasons (`pending`,
 * `payload_changed`) — those never enter the counter.
 */
export function rejectionFamilyKey(rejection: AuditRejection, tier: string): string | null {
  if (NON_SUBSTANTIVE_REASONS.has(rejection.reason)) return null;
  if (rejection.reason === 'invalid_shape') return `${tier}::invalid_shape`;
  const components = activeComponents(rejection);
  if (components.length === 0) return `${tier}::${rejection.reason}`;
  const sorted = [...components].sort((a, b) => a.localeCompare(b));
  return `${tier}::${sorted.join('+')}`;
}

/** True when the rejection's active issues are enum-grounding-shaped — the
 *  fix is to re-enter drive and interact with the UI that surfaces the
 *  values so the runtime captures (value, label) bindings. */
function isEnumGroundingShaped(rejection: AuditRejection): boolean {
  if (rejection.warnings.some((w) => w.kind === WARNING_KINDS.ungroundedEnumPlaceholder)) {
    return true;
  }
  return (rejection.classifier_issues ?? []).some((b) => NOTES_PARAMS_PATH_RE.test(b));
}

/** Exit options lifted from the underlying rejection's own remedy surfaces.
 *  These lead the dead-end menu: when the rejection already names a one-edit
 *  fix (add a prerequisite, add an extract, paste the observed enum set), the
 *  bounce must not steer the agent past it into a structural workaround. */
function remedyDerivedExits(rejection: AuditRejection): string[] {
  const exits: string[] = [];
  if (rejection.reason === 'unacked_warnings') {
    // Active warnings carry their remedy in `hint` — the Detector convention
    // (see the Issue interface in runtime/src/audit/index.ts).
    for (const w of rejection.warnings) {
      if (!w.hint) continue;
      exits.push(`APPLY THE FIX THIS REJECTION ALREADY NAMES — [${w.kind}]: ${w.hint}`);
      if (exits.length >= 4) break;
    }
  }
  for (const [kind, remedy] of Object.entries(rejection.classifier_remedies ?? {})) {
    const lifted = liftClassifierRemedy(kind, remedy);
    if (lifted) exits.push(lifted);
  }
  if (isEnumGroundingShaped(rejection)) {
    exits.push(
      `RETURN TO DRIVE TO CAPTURE GROUNDING — the rejection is enum-grounding-shaped: re-enter the ` +
        `flow and click through the UI that surfaces these values so the runtime captures real ` +
        `(value, label) bindings, then re-save. Do not paraphrase labels or invent values.`,
    );
  }
  return exits;
}

/** One exit-option line per structurally liftable classifier remedy. */
function liftClassifierRemedy(kind: string, remedy: Remedy): string | null {
  switch (remedy.kind) {
    case 'capability_alternative':
      return (
        `RESTRUCTURE PER THE "${kind}" REMEDY — use a {kind: "${remedy.suggested_capability_kind}"} ` +
        `prerequisite: ${remedy.reasoning}`
      );
    case 'observed_alternatives':
      if (remedy.observed_values.length === 0) return null;
      return (
        `RE-GROUND FROM THE "${kind}" REMEDY BLOCK below — it lists the ${remedy.observed_values.length} ` +
        `value(s) the runtime actually observed this session; paste from it verbatim instead of editing prose.`
      );
    case 'cross_session_evidence':
      return `FOLLOW THE "${kind}" ADVISORY — ${remedy.advisory}`;
    case 'classification_options':
      return (
        `PICK A VALID "${kind}" OPTION — the remedy block below enumerates the ` +
        `${remedy.options.length} valid choice(s) with rationale.`
      );
    case 'closest_matches':
    case 'no_programmatic_remedy':
      return null;
  }
}

function composeDeadEnd(
  capability: string,
  family: string,
  count: number,
  rejection: AuditRejection,
  normalMessage: string,
): string {
  const exits: string[] = [
    ...remedyDerivedExits(rejection),
    `DEFER — call ${TOOL_NAMES.addDiscoveryNote}(...) to persist what you learned (endpoint, the blocker, the ` +
      `shape you tried) so the next session resumes from here, then ${TOOL_NAMES.endDrive} / move on to other capabilities.`,
    `DIFFERENT TIER — try the other mechanism (fetch ⇄ page-script, or recorded-path). A different ` +
      `tier fires different detectors and may avoid this rejection entirely.`,
    `ABANDON — if this capability genuinely can't be saved (site blocks it, no stable mechanism), ` +
      `call ${TOOL_NAMES.abortSession}(session_id, reason) to exit honestly.`,
  ];
  const menu = exits.map((exit, i) => `  (${String.fromCharCode(97 + i)}) ${exit}`).join('\n');
  return (
    `invalid_strategy: ${AUDIT_KINDS.saveStrategyStructuralDeadEnd}: capability "${capability}" has now been ` +
    `rejected ${count}× with the same rejection family (${family}). This is a structural dead end, not ` +
    `an iteration step — cosmetic edits against the same rejection won't clear it (it's typically a ` +
    `detector false-positive, a schema contradiction, or a shape the runtime genuinely can't save). ` +
    `STOP retrying ${TOOL_NAMES.saveStrategy} with this shape. Pick one:\n` +
    `${menu}\n\n` +
    `A retry that makes a REAL structural change is still evaluated in full — this bounce fires on the ` +
    `rejection, not preemptively on the attempt, so a genuine fix commits normally.\n\n` +
    `The rejection you keep hitting, for reference:\n${normalMessage}`
  );
}

/**
 * Track a save_strategy audit rejection on the session and decide whether to
 * hard-bounce. Increments the per-`(capability, tier, family)` counter;
 * returns the `structural_dead_end` message on the 3rd+ same-family rejection,
 * else `null` (the caller throws the normal rejection message). No-op (returns
 * `null`) for saves with no session, and for the non-substantive `pending` /
 * `payload_changed` rejection reasons.
 */
export function trackRejectionAndMaybeBounce(
  session: Session | null,
  capability: string,
  strategy: Strategy,
  rejection: AuditRejection,
  normalMessage: string,
): string | null {
  if (!session) return null;
  const tierRaw = (strategy as { strategy?: unknown }).strategy;
  const tier = typeof tierRaw === 'string' && tierRaw.length > 0 ? tierRaw : 'unknown';
  const family = rejectionFamilyKey(rejection, tier);
  if (family === null) return null;
  const key = `${capability}::${family}`;
  const counts = (session.saveRejectionFamilyCounts ??= {});
  const next = (counts[key] ?? 0) + 1;
  counts[key] = next;
  if (next < DEAD_END_THRESHOLD) return null;
  return composeDeadEnd(capability, family, next, rejection, normalMessage);
}

/**
 * Clear every dead-end family counter for one capability. Called when a new
 * triage plan generation is accepted for the capability — a revised plan is a
 * deliberate pivot, and its saves get a fresh budget instead of inheriting
 * the pre-pivot rejection counts.
 */
export function resetSaveRejectionFamilies(session: Session, capability: string): void {
  const counts = session.saveRejectionFamilyCounts;
  if (!counts) return;
  const prefix = `${capability}::`;
  session.saveRejectionFamilyCounts = Object.fromEntries(
    Object.entries(counts).filter(([key]) => !key.startsWith(prefix)),
  );
}

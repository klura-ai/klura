// Per-kind `_hint` composer for `ack_checkpoint` responses. Every
// CheckpointKind gets a tailored "what to do next" string the agent reads
// after acknowledging a runtime-emitted handover.
//
// Why this lives in a sibling module:
//   - The CheckpointKind enum is closed; an exhaustive switch here
//     prevents silent misses when a kind is added (TypeScript will flag
//     the missing case at compile time).
//   - Composing the hint is pure (kind + ack args → string).
//
// Budget: each branch keeps the hint under ~300 chars.

import type { CheckpointAckInput } from './gate-glue';
import type { CheckpointKind } from './types';

/**
 * Compose the per-kind hint surfaced on `ack_checkpoint` success. The
 * exhaustive switch over CheckpointKind is load-bearing — adding a new
 * kind without a hint case is a TypeScript build error, not a silent
 * UX gap.
 */
export function composeAckHint(kind: CheckpointKind, _args: CheckpointAckInput): string {
  switch (kind) {
    case 'triage_plan':
      return (
        'Triage acknowledged — entering LIFT. Drive the surface, then save_strategy at the ' +
        'highest tier you can achieve (fetch > page-script > recorded-path). ' +
        'See klura://reference#reverse-engineer-playbook.'
      );
    case 'surface_changed':
      return (
        'Surface changed. Re-triage by calling submit_triage_plan with the new surface_label ' +
        'and updated request_patterns / dom_readiness signals before driving further on this ' +
        'surface.'
      );
    case 'recorded_step_failed':
      return (
        'Inspect the live page (a11y_tree + screenshot from the checkpoint context). Fix via ' +
        'patch_step then resume_execution. Heal the failed step only — do not rewrite the ' +
        'whole strategy. See klura://reference#patch-step.'
      );
    case 'session_expired':
      return (
        'Re-authenticate via the resolver, then re-run execute_strategy with the same ' +
        'capability + args. The strategy on disk is unchanged — only the underlying session ' +
        'needs refresh.'
      );
    case 'post_save_validation_consent':
      return (
        'Consent classification: Tier 1 fires validation now. Tier 2 waits for explicit ' +
        'user OK; if the user declined, call add_discovery_note explaining why and skip ' +
        'validation.'
      );
  }
}

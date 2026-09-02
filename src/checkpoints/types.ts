// Shared types for the checkpoint framework.
//
// A checkpoint is a runtime-detected mid-flow event with a known `kind`
// from a closed enum. The runtime knows what happened; dispatch is direct
// (last-registered plugin claiming that kind wins). No menu, no
// LLM-semantic routing — contrast with `runtime/src/interruptions/`
// (agent-detected ambient state, menu-driven dispatch).
//
// See runtime/docs/checkpoints.md for the architecture overview and
// runtime/docs/principles.md §Checkpoints for when to reach for this
// family vs interruptions vs the gate family.

import type { Session } from '../drivers/types/session';
import type { AbortKind, DefenseSurface } from '../working-dir/schema';
import type { DriftClassification } from '../strategies/page-fingerprint';
import type { TriageAuthoringContract } from '../phases/triage/triage-authoring-contract';

/**
 * Closed union of runtime-emitted checkpoint kinds. Adding a new kind
 * means adding a new emit site AND a default handler that claims it —
 * runtime will throw at dispatch time if no handler claims the kind.
 */
export const CHECKPOINT_KINDS = [
  'triage_plan',
  'surface_changed',
  'recorded_step_failed',
  'session_expired',
  'post_save_validation_consent',
  'abort_session_consent',
] as const;

export type CheckpointKind = (typeof CHECKPOINT_KINDS)[number];

// ---------------------------------------------------------------------------
// Per-kind context payloads
// ---------------------------------------------------------------------------
// One typed context per kind — the event union below discriminates on
// `kind`, so a handler that narrows `event.kind` gets the matching context
// with no casts. Declared as type aliases (not interfaces) so the whole
// context stays assignable to the `Record<string, unknown>` agent-facing
// envelope surface.

/** `submit_triage_plan` committed a per-surface plan; ack before LIFT. */
export type TriagePlanCheckpointContext = {
  capability: string;
  surface_label: string;
  summary_for_user: string;
  expected_tier: string;
  tier_justification: string;
  defense_surface: DefenseSurface;
  /** True when the session re-entered TRIAGE from LIFT (re-plan). */
  is_replan: boolean;
};

/** Navigation landed on a path-distinct URL no triage plan covers. */
export type SurfaceChangedCheckpointContext = {
  new_url: string;
  /** Reset triage budget for the new surface; 0 means no round limit. */
  triage_budget: number;
  triage_authoring_contract: TriageAuthoringContract;
  /** Surface label of the URL the agent navigated away from, when known. */
  prior_surface?: string;
};

/** A recorded-path step threw / timed out mid-execute. */
export type RecordedStepFailedCheckpointContext = {
  failed_step_index: number;
  failed_step_id?: string;
  /** The step object as recorded in the strategy — opaque to this layer. */
  failed_step: unknown;
  error_message: string;
  platform: string;
  capability: string;
  a11y_tree: string;
  a11y_truncated: boolean;
  url: string;
  healable: boolean;
  /** Present when the failure was a pre-step page-drift detection. */
  reason?: 'page_drifted_before_step';
  diff?: DriftClassification['details'];
  drift_fields?: DriftClassification['fields'];
};

/** The site rejected an auto-execute with a session-expired pattern. */
export type SessionExpiredCheckpointContext = {
  platform?: string;
  capability?: string;
  attempted_tier?: string;
  attempted_endpoint?: string;
  status?: number;
};

/** `save_strategy` staged a post-save verification that needs consent. */
export type PostSaveValidationConsentCheckpointContext = {
  capability?: string;
  candidate_id?: string;
  /** What the runtime will do on consent, phrased for the consent prompt. */
  pendingAction?: string;
  contextSummary?: string;
  /** What happens if the user declines, phrased for the consent prompt. */
  declineHandler?: string;
  validation_target?: unknown;
};

/** `abort_session` wants to tear down the session; consent required. */
export type AbortSessionConsentCheckpointContext = {
  /** Free-text agent-supplied abort reason (≥20 chars, tool-validated). */
  reason: string;
  /** The machine-actionable abort classification the agent passed to
   *  `abort_session` — rendered verbatim in the consent prompt. */
  abort_kind: AbortKind;
  capturedActionsCount: number;
  phase_at_abort: string;
};

/** Kind → typed context. The single source the event union derives from. */
export interface CheckpointContextMap {
  triage_plan: TriagePlanCheckpointContext;
  surface_changed: SurfaceChangedCheckpointContext;
  recorded_step_failed: RecordedStepFailedCheckpointContext;
  session_expired: SessionExpiredCheckpointContext;
  post_save_validation_consent: PostSaveValidationConsentCheckpointContext;
  abort_session_consent: AbortSessionConsentCheckpointContext;
}

// ---------------------------------------------------------------------------
// Event union
// ---------------------------------------------------------------------------

/**
 * Discriminated union of checkpoint events. `kind` appears exactly once —
 * as the discriminant on the event — and selects the typed context, so
 * `switch (event.kind)` narrows `event.context` with no casts. Construct
 * events via the `checkpointEvent` per-kind helpers rather than object
 * literals so no call site can restate the kind.
 */
export type CheckpointEvent<K extends CheckpointKind = CheckpointKind> = {
  [P in K]: {
    kind: P;
    session_id: string;
    /** Capability slug relevant to this event, when applicable. */
    capability?: string;
    context: CheckpointContextMap[P];
  };
}[K];

type CheckpointEventFields<K extends CheckpointKind> = Omit<CheckpointEvent<K>, 'kind'>;

function eventBuilder<K extends CheckpointKind>(kind: K) {
  // `kind` is spread last so the stamped discriminant wins even when an
  // untyped JS caller passes a `kind` property inside `fields`.
  return (fields: CheckpointEventFields<K>): CheckpointEvent<K> =>
    ({ ...fields, kind }) as CheckpointEvent<K>;
}

/**
 * Per-kind event constructors — the only place `kind` is stamped onto an
 * event. Each helper takes `{session_id, capability?, context}` with the
 * kind's typed context; a `kind` key inside `context` is an excess-property
 * error at the call site.
 */
export const checkpointEvent = {
  triage_plan: eventBuilder('triage_plan'),
  surface_changed: eventBuilder('surface_changed'),
  recorded_step_failed: eventBuilder('recorded_step_failed'),
  session_expired: eventBuilder('session_expired'),
  post_save_validation_consent: eventBuilder('post_save_validation_consent'),
  abort_session_consent: eventBuilder('abort_session_consent'),
} as const;

/**
 * The handler's answer. Determines what the caller does next:
 *
 * - `resolved` — plugin produced an answer inline. Runtime uses
 *   `value` / `patch` and keeps going. No agent round-trip.
 * - `handover` — human input required. Runtime surfaces a
 *   `_checkpoint` envelope on the tool response with a
 *   `checkpoint_token` the next tool call must echo (enforced via
 *   the gate framework — see `runtime/src/gate/`).
 * - `continue` — no plugin action needed; runtime proceeds silently.
 *   `hint` is optional advisory text the runtime may surface.
 */
export type CheckpointResolution =
  | { status: 'resolved'; value?: unknown; patch?: Record<string, unknown> }
  | {
      status: 'handover';
      target: 'user' | 'viewer';
      prompt: string;
      viewer_url?: string;
    }
  | { status: 'continue'; hint?: string };

export interface CheckpointHandler<K extends CheckpointKind = CheckpointKind> {
  /** Stable id used for unregister + telemetry. Convention:
   *  `<scope>-<what-it-does>`, e.g. `default-ask-user-checkpoint`,
   *  `test-continue-all`, `enterprise-auto-approve-sandbox`. */
  name: string;
  /** Closed-kind claim. Dispatch is direct: `invokeCheckpoint(event, ...)`
   *  picks the LAST-registered handler whose `kinds` array includes
   *  `event.kind`. Defaults register first (module-load); scenario /
   *  enterprise plugins register after to pre-empt them. */
  kinds: readonly K[];
  /** Async resolution. May read page state, call external APIs, etc.
   *  `event` is the union over the claimed kinds — narrowing
   *  `event.kind` types `event.context` per kind. */
  handle(event: CheckpointEvent<K>, session: Session): Promise<CheckpointResolution>;
}

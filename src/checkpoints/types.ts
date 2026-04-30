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
] as const;

export type CheckpointKind = (typeof CHECKPOINT_KINDS)[number];

export interface CheckpointEvent {
  session_id: string;
  /** Free-form kind-specific payload (rounds, failed_step_index,
   *  validation_target, a11y_tree, …). Handlers read this verbatim. */
  context: Record<string, unknown>;
  /** Capability slug relevant to this event, when applicable. */
  capability?: string;
}

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

export interface CheckpointHandler {
  /** Stable id used for unregister + telemetry. Convention:
   *  `<scope>-<what-it-does>`, e.g. `default-ask-user-checkpoint`,
   *  `test-continue-all`, `enterprise-auto-approve-sandbox`. */
  name: string;
  /** Closed-kind claim. Dispatch is direct: `invokeCheckpoint(kind, ...)`
   *  picks the LAST-registered handler whose `kinds` array includes
   *  `kind`. Defaults register first (module-load); scenario / enterprise
   *  plugins register after to pre-empt them. */
  kinds: CheckpointKind[];
  /** Async resolution. May read page state, call external APIs, etc. */
  handle(event: CheckpointEvent, session: Session): Promise<CheckpointResolution>;
}

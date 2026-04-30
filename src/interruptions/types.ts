// Shared types for the interruption-handler framework.
//
// An interruption is a runtime-detected or agent-detected mid-flow event
// that requires a decision before the runtime can continue. Distinct from
// the gate family (pre-commit structural checks, `runtime/src/gate/`) —
// gates fire at save/commit time against payload shape; interruptions fire
// mid-execute against live session state.
//
// Dispatch is menu-driven: runtime surfaces the full handler menu plus an
// event-context payload on the tool response; the agent reads each
// handler's `description` + the context, then invokes one by name via the
// `resolve_interruption` MCP tool. There is no auto-picker, no
// `can_handle` boolean, no kind taxonomy — context is free-form prose,
// the agent resolves "which handler applies" as a semantic-match question.
//
// See runtime/docs/interruptions.md for the architecture overview and
// runtime/docs/principles.md §Interruption handlers for when to reach
// for this family vs the gate family.

import type { Session } from '../drivers/types/session';

export interface InterruptionEvent {
  session_id: string;
  /** Free-form semantic payload describing what happened. Consumers at
   *  emit sites are expected to include a `reason` key that names the
   *  triggering condition in plain English (`"recorded_step_failed"`,
   *  `"post_save_validation_consent"`, …) plus any kind-specific extras
   *  (rounds, failed_step_index, a11y_tree, etc.). Handlers read this
   *  verbatim. */
  context: Record<string, unknown>;
  /** Capability slug relevant to this event, when applicable. */
  capability?: string;
}

/**
 * The handler's answer. Determines what the caller does next:
 *
 * - `resolved` — plugin produced an answer inline. Runtime uses
 *   `value` / `patch` and keeps going. No agent round-trip needed.
 * - `handover` — human input required. Runtime surfaces a unified
 *   `_interruption` envelope on the tool response with an
 *   `interruption_token` the next tool call must echo (enforced via
 *   the gate framework — see `runtime/src/gate/`).
 * - `continue` — no plugin action needed; runtime proceeds silently.
 *   `hint` is optional advisory text the runtime may surface.
 */
export type InterruptionResolution =
  | { status: 'resolved'; value?: unknown; patch?: Record<string, unknown> }
  | {
      status: 'handover';
      target: 'user' | 'viewer';
      prompt: string;
      viewer_url?: string;
    }
  | { status: 'continue'; hint?: string };

export interface InterruptionHandler {
  /** Stable id used for invocation via the `resolve_interruption` tool
   *  and for `unregisterInterruptionHandler`. Convention:
   *  `<scope>-<what-it-does>`, e.g. `test-captcha-static-apple`,
   *  `twilio-2fa-production`, `default-handover-viewer`. */
  name: string;
  /** Free-text description of WHEN this handler should be picked. The
   *  agent reads every registered handler's description + the event
   *  context, then picks the best match. Be explicit: name the
   *  triggering conditions, name the kind of `context.reason` this
   *  matches, mention whether this is a fallback vs specialized, and
   *  (when applicable) mention any precondition (stored credentials
   *  present, plugin pre-registered, etc.). This string is the ONLY
   *  signal the agent uses to route. */
  description: string;
  /** Async resolution. May read page state, call external APIs, etc. */
  handle(event: InterruptionEvent, session: Session): Promise<InterruptionResolution>;
}

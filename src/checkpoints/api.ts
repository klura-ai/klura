// MCP-facing surface for acknowledging a runtime-emitted checkpoint.
//
// Kept in a sibling module (not inside `checkpoints/`) so MCP-layer
// wiring stays symmetric with interruptions (`resolveInterruption` in
// `src/index.ts` dispatches through `tool-helpers.ts`).

import { pool } from '../runtime-state';
import { assertNoPendingCheckpoint } from '../checkpoints';
import { peekPendingCheckpointKind } from '../checkpoints/gate-glue';
import { composeAckHint } from '../checkpoints/ack-hints';
import { stampRuntimeMeta } from '../strategies/skills';
import {
  verifySavedStrategy,
  type VerifySavedStrategyResult,
} from '../strategies/verify-saved-strategy';
import { performAbortTeardown } from '../tools/abort_session';
import type { Session } from '../drivers/types/session';
export { assertNoPendingCheckpoint } from '../checkpoints';

export interface AckCheckpointArgs {
  session_id: string;
  checkpoint_token: string;
  user_response?: string;
  viewer_result?: Record<string, unknown>;
  cancelled?: boolean;
  reason?: string;
}

export interface AckCheckpointResult {
  ok: true;
  _hint: string;
  /** Present only when acking a `post_save_validation_consent` checkpoint with
   *  consent — the outcome of the runtime's post-commit 2xx verification. */
  post_save_validation?: VerifySavedStrategyResult;
}

/**
 * Run the deferred post-save 2xx verification staged on the session by
 * `save_strategy`. Called when a `post_save_validation_consent` checkpoint is
 * acked. Consent (`!cancelled`) → run `verifySavedStrategy`; decline
 * (`cancelled`) → stamp the strategy unverified. Clears the staged payload
 * either way.
 */
async function resolvePostSaveValidation(
  session: Session | null,
  args: AckCheckpointArgs,
): Promise<AckCheckpointResult> {
  const pending = session?.pendingPostSaveValidation;
  if (!session || !pending) {
    return {
      ok: true,
      _hint:
        'post_save_validation_consent acked, but no pending verification was staged for this ' +
        'session — nothing to verify. Continue.',
    };
  }
  session.pendingPostSaveValidation = undefined;

  if (args.cancelled === true) {
    stampRuntimeMeta(pending.platform, pending.capability, { post_save_validation: 'declined' });
    recordAbandonedSaveAttempt(session, pending.capability, 'declined');
    return {
      ok: true,
      _hint:
        `Post-save validation declined — \`${pending.capability}\` stands unverified ` +
        `(runtime_meta.post_save_validation: "declined"). end_drive will refuse close ` +
        `until you re-save this capability with a fix OR explicitly ack the abandonment.`,
    };
  }

  const result = await verifySavedStrategy(
    pending.platform,
    pending.capability,
    pending.args,
    pool,
  );
  if (result.ok) {
    return {
      ok: true,
      _hint:
        `Post-save validation passed — \`${pending.capability}\` returned HTTP ${result.status} ` +
        `end-to-end. Strategy verified.`,
    };
  }
  if (result.archived) recordAbandonedSaveAttempt(session, pending.capability, 'archived');
  const statusLabel = result.status === 0 ? 'a runtime error' : `HTTP ${result.status}`;
  return {
    ok: true,
    _hint:
      `Post-save validation FAILED — \`${pending.capability}\` returned ${statusLabel} ` +
      `and was archived as broken. Fix the strategy and re-save it this session — see ` +
      `post_save_validation.message for the full rejection. end_drive will refuse close ` +
      `until this capability has a successful save OR you explicitly ack the abandonment.`,
    post_save_validation: result,
  };
}

function recordAbandonedSaveAttempt(
  session: Session,
  capability: string,
  kind: 'archived' | 'declined',
): void {
  const list = session.abandonedSaveAttempts ?? [];
  list.push({ capability, kind, at: Date.now() });
  session.abandonedSaveAttempts = list;
}

/**
 * Consume a pending checkpoint handover. Validates the echoed token +
 * payload through `assertNoPendingCheckpoint`; on success clears the
 * per-session pending state so subsequent tool calls proceed. Errors
 * propagate verbatim (`invalid_strategy: pending_checkpoint, …`).
 *
 * Mutating-action consent acks short-circuit before the generic gate path:
 * they're session-local nonces (stored in `session.pendingActionConsents`),
 * not gate-store tokens. On valid ack, `session.mapGateAcked` flips to
 * true and every subsequent mutating action in the session admits without
 * re-prompting (one ack covers session, not per-(action, selector)).
 *
 * The response carries a per-kind `_hint` field telling the agent what
 * to do next. The composer (`composeAckHint`) is exhaustive over
 * CheckpointKind — every kind gets a tailored string.
 */
export async function ackCheckpoint(args: AckCheckpointArgs): Promise<AckCheckpointResult> {
  if (!args.session_id) throw new Error('session_id is required');
  if (typeof args.checkpoint_token !== 'string' || args.checkpoint_token.length === 0) {
    throw new Error(
      'checkpoint_token is required (from the _checkpoint envelope on the prior tool response)',
    );
  }
  // Resolve the session once; reused below for the map-consent fast path,
  // for the kind-peek fallback, and for the hint composer's audit preview.
  let session;
  try {
    session = pool.getSession(args.session_id);
  } catch {
    session = null;
  }
  // Gated-action consent path: short nonce, session-local lookup. If the
  // token matches a pending consent, this branch handles it; otherwise we
  // fall through to the generic gate path (post_save_validation_consent, etc).
  if (session && session.pendingActionConsents) {
    const pending = session.pendingActionConsents.get(args.checkpoint_token);
    if (pending) {
      if (args.cancelled === true) {
        if (typeof args.reason !== 'string' || args.reason.trim().length === 0) {
          throw new Error(
            'cancelled action-consent ack requires a non-empty `reason` explaining why the action was unsafe',
          );
        }
        session.pendingActionConsents.delete(args.checkpoint_token);
        return {
          ok: true,
          _hint:
            'Action declined as unsafe. Continue without retrying the same (action, selector) ' +
            'tuple unless the approach changes.',
        };
      }
      if (typeof args.user_response !== 'string' || args.user_response.trim().length === 0) {
        throw new Error(
          'action-consent ack requires a non-empty `user_response` — one sentence on what you intend to map and why the session is exploratory',
        );
      }
      // Session-wide flip: one ack covers all subsequent mutating actions.
      // The pending nonce is consumed but its (action, selector) is not
      // recorded — the bool is the only state we read at gate-check time.
      session.mapGateAcked = true;
      session.pendingActionConsents.delete(args.checkpoint_token);
      return {
        ok: true,
        _hint:
          'Map session unlocked. All subsequent mutating actions in this session will admit ' +
          'without re-prompting — the consent applies session-wide. End the session via ' +
          'end_drive when done; a fresh start_session({graph: "map"}) requires a new ack.',
      };
    }
  }
  // Snapshot the kind BEFORE the gate consumes the pending entry, so the
  // hint composer can read it after a successful ack.
  const ackedKind = peekPendingCheckpointKind(args.session_id);
  assertNoPendingCheckpoint(args.session_id, {
    checkpoint_token: args.checkpoint_token,
    user_response: args.user_response,
    viewer_result: args.viewer_result,
    cancelled: args.cancelled,
    reason: args.reason,
  });
  if (!ackedKind) {
    // No pending entry observed pre-ack. assertNoPendingCheckpoint succeeded,
    // which means there was nothing to clear — a no-op ack against a session
    // with no live checkpoint. Surface a generic "nothing to do" hint rather
    // than fabricating per-kind guidance.
    return {
      ok: true,
      _hint:
        'No pending checkpoint was outstanding for this session. Continue with whatever ' +
        'tool call you intended — no acknowledgement obligation.',
    };
  }
  // post_save_validation_consent carries a deferred runtime action: on consent
  // the runtime itself re-runs the just-saved strategy and verifies 2xx.
  if (ackedKind === 'post_save_validation_consent') {
    return resolvePostSaveValidation(session, args);
  }
  // abort_session_consent: the actual abort teardown is staged on
  // `session.pendingAbort` and executed here when consent lands. The agent
  // does NOT re-call `abort_session` after the ack — doing so would
  // re-emit a fresh consent token (the checkpoint handler is stateless on
  // its own) and loop forever. By running teardown inline we close the loop.
  if (ackedKind === 'abort_session_consent') {
    return resolveAbortSessionConsent(session, args);
  }
  return { ok: true, _hint: composeAckHint(ackedKind, args) };
}

/**
 * Run the deferred abort teardown staged on the session by
 * `abort_session`. Called when an `abort_session_consent` checkpoint is
 * acked. Consent (`!cancelled`) → run `performAbortTeardown`; decline
 * (`cancelled`) → clear the staged payload and tell the agent to keep
 * trying. Either way the per-session pendingAbort entry is cleared so a
 * future legitimate abort (after more RE attempts) can stage afresh.
 */
async function resolveAbortSessionConsent(
  session: Session | null,
  args: AckCheckpointArgs,
): Promise<AckCheckpointResult> {
  const pending = session?.pendingAbort;
  if (!session || !pending) {
    return {
      ok: true,
      _hint:
        'abort_session_consent acked, but no pending abort was staged for this session — ' +
        'nothing to tear down. Continue.',
    };
  }
  session.pendingAbort = undefined;
  if (args.cancelled === true) {
    return {
      ok: true,
      _hint:
        "Abort cancelled. klura's mission is to figure out HOW, not bail on first friction. " +
        'Keep RE-ing the surface: alternate sub-paths under the same host, wait + re-snap on ' +
        'iframe challenges, js_eval / read_js_function / search_js_source on the gate. ' +
        'Only re-call abort_session after exhausting the cheap RE tools.',
    };
  }
  await performAbortTeardown(session.id, {
    reason: pending.reason,
    kind: pending.kind,
    phase_at_abort: pending.phase_at_abort,
    captured_actions_count: pending.captured_actions_count,
  });
  return {
    ok: true,
    _hint:
      `Session aborted (kind: \`${pending.kind}\`) — browser torn down, ` +
      `platform's abort_events ledger updated. Do NOT call abort_session ` +
      `again on this session_id.`,
  };
}

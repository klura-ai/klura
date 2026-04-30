// MCP-facing surface for acknowledging a runtime-emitted checkpoint.
//
// Kept in a sibling module (not inside `checkpoints/`) so MCP-layer
// wiring stays symmetric with interruptions (`resolveInterruption` in
// `src/index.ts` dispatches through `tool-helpers.ts`).

import { pool } from './runtime-state';
import { assertNoPendingCheckpoint } from './checkpoints';
import { peekPendingCheckpointKind } from './checkpoints/gate-glue';
import { composeAckHint } from './checkpoints/ack-hints';
export { assertNoPendingCheckpoint } from './checkpoints';

export interface AckCheckpointArgs {
  session_id: string;
  checkpoint_token: string;
  user_response?: string;
  viewer_result?: Record<string, unknown>;
  cancelled?: boolean;
  reason?: string;
}

// Match the same canonicalization perform-action.ts uses for sticky-cache
// keys — trim, collapse whitespace, single-quotes → double. Lives here so
// the ack populates the cache with the same shape perform-action consults.
function normalizeGatedSelector(selector: string): string {
  return selector.trim().replace(/\s+/g, ' ').replace(/'/g, '"');
}

/**
 * Consume a pending checkpoint handover. Validates the echoed token +
 * payload through `assertNoPendingCheckpoint`; on success clears the
 * per-session pending state so subsequent tool calls proceed. Errors
 * propagate verbatim (`invalid_strategy: pending_checkpoint, …`).
 *
 * Mutating-action consent acks short-circuit before the generic gate path:
 * they're session-local nonces (stored in `session.pendingActionConsents`),
 * not gate-store tokens. On valid ack, the (action, selector) tuple is
 * added to `session.gatedActionConsentCache` so subsequent identical
 * perform_action calls fire without re-prompting.
 *
 * The response carries a per-kind `_hint` field telling the agent what
 * to do next. The composer (`composeAckHint`) is exhaustive over
 * CheckpointKind — every kind gets a tailored string.
 */
export function ackCheckpoint(args: AckCheckpointArgs): { ok: true; _hint: string } {
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
          'action-consent ack requires a non-empty `user_response` — one sentence on what you expect this action to do and why it is safe',
        );
      }
      if (!session.gatedActionConsentCache) session.gatedActionConsentCache = new Set();
      session.gatedActionConsentCache.add(
        `${pending.action}|${normalizeGatedSelector(pending.selector)}`,
      );
      session.pendingActionConsents.delete(args.checkpoint_token);
      return {
        ok: true,
        _hint:
          'Action approved. The (action, selector) tuple is whitelisted for this session — ' +
          'subsequent identical perform_actions fire without re-prompting.',
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
  return { ok: true, _hint: composeAckHint(ackedKind, args) };
}

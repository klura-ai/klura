import { invokeInterruptionHandler } from './interruptions';
import type { InterruptionEvent, InterruptionResolution } from './interruptions';
import { buildTokenGate } from './gate';
import type { Session } from './drivers/types/session';

/**
 * Unified interruption envelope attached to tool responses when the runtime
 * needs the agent to act on a mid-flow event.
 *
 * `context` is the free-form event payload (typically includes a `reason`
 * string naming what happened). `candidates` is the full registered-handler
 * menu; the agent reads each description plus the context, picks a name,
 * and calls the `resolve_interruption` MCP tool with it. When the chosen
 * handler returns a `handover` resolution, the runtime mints an
 * `interruption_token` bound to the event — the agent's next tool call on
 * this session must echo the token plus an ack (user_response, viewer_result)
 * OR an explicit cancel (`cancelled: true, reason`) before any other tool
 * will run.
 */
export interface InterruptionEnvelope {
  context: Record<string, unknown>;
  candidates: Array<{ name: string; description: string }>;
  /** Present only when a chosen handler returned `handover` — gates the
   *  next tool call on the session until the agent acknowledges. Absent
   *  on a pure menu surface (runtime has not yet invoked a handler). */
  interruption_token?: string;
}

// ---------------------------------------------------------------------------
// Pending-interruption token gate
//
// When a runtime-initiated interruption event resolves to `handover`, the
// runtime mints a server-side token bound to a hash of (session_id, context)
// and stashes it per-session. Every subsequent tool call on that session is
// checked by `assertNoPendingInterruption` — without a matching
// `interruption_token` plus an ack (user_response / viewer_result / cancelled),
// the tool rejects with `invalid_strategy: pending_interruption`.
//
// Reuses the `buildTokenGate` factory from runtime/src/gate so the token-mint
// / hash-bind / TTL / consume mechanics are shared with the save-audit +
// trigger_reference_send gates. One framework, one set of semantics.
// ---------------------------------------------------------------------------

interface PendingInterruption {
  token: string;
  payload: InterruptionGatePayload;
}

interface InterruptionGatePayload {
  session_id: string;
  context: Record<string, unknown>;
}

interface InterruptionAckAnswers {
  user_response?: string;
  viewer_result?: Record<string, unknown>;
  cancelled?: boolean;
  reason?: string;
}

const interruptionGate = buildTokenGate<InterruptionGatePayload, InterruptionAckAnswers>({
  kind: 'interruption_ack',
  buildChecklist: () => ({
    prompt:
      'Echo the interruption_token from the prior response and include either a user_response / viewer_result payload, or cancel explicitly with {cancelled: true, reason}.',
    items: {
      acknowledge:
        'interruption_token + (user_response | viewer_result) — or {cancelled: true, reason}',
    },
  }),
  validateAnswers: (_payload, answers) => {
    const issues: string[] = [];
    const hasAck =
      (typeof answers.user_response === 'string' && answers.user_response.length > 0) ||
      (answers.viewer_result && typeof answers.viewer_result === 'object');
    const cancelled = answers.cancelled === true;
    if (!hasAck && !cancelled) {
      issues.push(
        'interruption acknowledgement must include either user_response / viewer_result OR cancelled:true',
      );
    }
    if (cancelled && (typeof answers.reason !== 'string' || answers.reason.trim().length === 0)) {
      issues.push('cancelled interruption requires a non-empty reason');
    }
    return issues;
  },
});

const pending = new Map<string, PendingInterruption>();

function rememberPending(sessionId: string, payload: InterruptionGatePayload, token: string): void {
  pending.set(sessionId, { token, payload });
}

function clearPending(sessionId: string): void {
  pending.delete(sessionId);
}

/** Mint a pending-interruption token for a handover resolution. Returns
 *  the token the caller should embed on `_interruption.interruption_token`.
 *  The gate holds the hash of the payload so `assertNoPendingInterruption`
 *  can verify the agent's echo on the next tool call. */
export function mintInterruptionToken(sessionId: string, context: Record<string, unknown>): string {
  const payload: InterruptionGatePayload = { session_id: sessionId, context };
  // `process` with no token returns a fresh rejection containing a minted
  // token; we lift the token out and stash it as "pending" for this session.
  const result = interruptionGate.process(payload, {});
  if (result.status !== 'pending' && result.status !== 'rejected') {
    throw new Error(
      `internal: mintInterruptionToken expected pending/rejected, got ${result.status}`,
    );
  }
  const token = result.rejection.token;
  rememberPending(sessionId, payload, token);
  return token;
}

export interface InterruptionAckInput {
  interruption_token?: string;
  user_response?: string;
  viewer_result?: Record<string, unknown>;
  cancelled?: boolean;
  reason?: string;
}

/**
 * Centralized pending-interruption guard. Every MCP tool handler is expected
 * to call this with the session id + its raw args before running its body —
 * without this, an agent could ignore a handover and keep driving the page.
 *
 * No-op when the session has no pending interruption.
 *
 * When a pending interruption exists, the args must carry
 * `interruption_token` matching the stored token AND an ack payload
 * (`user_response` / `viewer_result`) OR `{cancelled: true, reason}`. On a
 * successful ack the token is consumed and pending state cleared; on any
 * mismatch the guard throws `invalid_strategy: pending_interruption …`.
 *
 * Tools that deliberately resolve the pending state (e.g. `resolve_interruption`
 * itself) should skip this guard.
 */
export function assertNoPendingInterruption(sessionId: string, args: InterruptionAckInput): void {
  const entry = pending.get(sessionId);
  if (!entry) return;
  const result = interruptionGate.process(entry.payload, {
    token: args.interruption_token,
    answers: {
      user_response: args.user_response,
      viewer_result: args.viewer_result,
      cancelled: args.cancelled,
      reason: args.reason,
    },
  });
  if (result.status === 'committed') {
    clearPending(sessionId);
    return;
  }
  const rejection = result.rejection;
  const reasonTag = rejection.reason;
  const issues = rejection.issues?.join('; ') ?? '';
  throw new Error(
    `invalid_strategy: pending_interruption, acknowledge before continuing ` +
      `(${reasonTag}${issues ? ': ' + issues : ''}). Echo interruption_token + ` +
      `user_response / viewer_result, or cancel with {cancelled: true, reason}.`,
  );
}

/**
 * Invoke a named interruption handler and, if the resolution is a
 * `handover`, mint the pending-interruption token + stash it per-session.
 * Returns both the resolution (for any inline use) and the token (if any)
 * so the caller can include it on the envelope it surfaces.
 */
export async function invokeAndGateHandover(
  resolver: string,
  event: InterruptionEvent,
  session: Session,
): Promise<{ resolution: InterruptionResolution; interruption_token?: string }> {
  const resolution = await invokeInterruptionHandler(resolver, event, session);
  if (resolution.status === 'handover') {
    const token = mintInterruptionToken(event.session_id, event.context);
    return { resolution, interruption_token: token };
  }
  return { resolution };
}

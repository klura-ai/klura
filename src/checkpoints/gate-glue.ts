// Checkpoint-side token gate + emit-site helpers. Mirrors the
// interruption-side helpers in `tool-helpers.ts` but uses a separate gate
// ("checkpoint_ack") + pending-state map — `assertNoPendingCheckpoint`
// and `assertNoPendingInterruption` name the specific surface that
// blocked (keeps test failures diagnosable).

import { pool } from '../runtime-state';
import { invokeCheckpoint } from './registry';
import type { CheckpointEvent, CheckpointKind, CheckpointResolution } from './types';
import { buildTokenGate } from '../gate';
import { resolveAutoExecuteAlias } from '../auto-execute-alias';

/**
 * Unified checkpoint envelope attached to tool responses when the
 * runtime needs the agent to act on a runtime-emitted event. Direct
 * dispatch: the runtime already invoked the matching handler, so this
 * envelope only surfaces when that handler returned `handover`.
 */
export interface CheckpointEnvelope {
  kind: CheckpointKind;
  context: Record<string, unknown>;
  /** Present when the handler returned `handover` to the viewer. */
  viewer_url?: string;
  /** Present when the handler returned `handover` (either target). */
  prompt?: string;
  /** Gates the next tool call on the session until the agent acknowledges. */
  checkpoint_token?: string;
}

// ---------------------------------------------------------------------------
// Pending-checkpoint token gate
// ---------------------------------------------------------------------------

interface PendingCheckpoint {
  token: string;
  payload: CheckpointGatePayload;
}

interface CheckpointGatePayload {
  session_id: string;
  kind: CheckpointKind;
  context: Record<string, unknown>;
}

interface CheckpointAckAnswers {
  user_response?: string;
  viewer_result?: Record<string, unknown>;
  cancelled?: boolean;
  reason?: string;
}

const checkpointGate = buildTokenGate<CheckpointGatePayload, CheckpointAckAnswers>({
  kind: 'checkpoint_ack',
  buildChecklist: () => ({
    prompt:
      'Echo the checkpoint_token from the prior response and include either a user_response / viewer_result payload, or cancel explicitly with {cancelled: true, reason}.',
    items: {
      acknowledge:
        'checkpoint_token + (user_response | viewer_result) — or {cancelled: true, reason}',
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
        'checkpoint acknowledgement must include either user_response / viewer_result OR cancelled:true',
      );
    }
    if (cancelled && (typeof answers.reason !== 'string' || answers.reason.trim().length === 0)) {
      issues.push('cancelled checkpoint requires a non-empty reason');
    }
    return issues;
  },
});

const pendingCheckpoints = new Map<string, PendingCheckpoint>();

function rememberPendingCheckpoint(
  sessionId: string,
  payload: CheckpointGatePayload,
  token: string,
): void {
  pendingCheckpoints.set(sessionId, { token, payload });
}

function clearPendingCheckpoint(sessionId: string): void {
  pendingCheckpoints.delete(sessionId);
}

/**
 * Peek the kind of the currently-pending checkpoint for `sessionId` without
 * consuming it. Walks the auto-execute alias chain so callers holding the
 * outer (start_session-owned) id resolve to the inner-id pending entry the
 * checkpoint was registered against. `ackCheckpoint` reads the kind here
 * BEFORE running the gate (which clears the entry) so it can compose a
 * per-kind hint on the ack response.
 */
export function peekPendingCheckpointKind(sessionId: string): CheckpointKind | undefined {
  let entry = pendingCheckpoints.get(sessionId);
  if (!entry) {
    const innerId = resolveAutoExecuteAlias(sessionId);
    if (innerId) entry = pendingCheckpoints.get(innerId);
  }
  return entry?.payload.kind;
}

/** Mint a pending-checkpoint token for a handover resolution. */
export function mintCheckpointToken(
  sessionId: string,
  kind: CheckpointKind,
  context: Record<string, unknown>,
): string {
  const payload: CheckpointGatePayload = { session_id: sessionId, kind, context };
  const result = checkpointGate.process(payload, {});
  if (result.status !== 'pending' && result.status !== 'rejected') {
    throw new Error(
      `internal: mintCheckpointToken expected pending/rejected, got ${result.status}`,
    );
  }
  const token = result.rejection.token;
  rememberPendingCheckpoint(sessionId, payload, token);
  return token;
}

export interface CheckpointAckInput {
  checkpoint_token?: string;
  user_response?: string;
  viewer_result?: Record<string, unknown>;
  cancelled?: boolean;
  reason?: string;
}

/**
 * Centralized pending-checkpoint guard. Every MCP tool handler calls
 * this alongside `assertNoPendingInterruption` before running its
 * body — without this, an agent could ignore a handover and keep
 * driving the page.
 *
 * Tools that deliberately resolve the pending state (`ack_checkpoint`)
 * skip this guard.
 */
export function assertNoPendingCheckpoint(sessionId: string, args: CheckpointAckInput): void {
  // Resolve outer (start_session-owned) ids to the auto-execute inner id
  // they alias. The pending entry is registered under the inner id when
  // auto-execute pauses; without this fallback, ack_checkpoint with the
  // outer id no-ops, leaving the inner pending state to trip on the
  // subsequent resume_execution. See `runtime/src/auto-execute-alias.ts`.
  let effectiveId = sessionId;
  let entry = pendingCheckpoints.get(sessionId);
  if (!entry) {
    const innerId = resolveAutoExecuteAlias(sessionId);
    if (innerId) {
      const innerEntry = pendingCheckpoints.get(innerId);
      if (innerEntry) {
        effectiveId = innerId;
        entry = innerEntry;
      }
    }
  }
  if (!entry) return;
  const result = checkpointGate.process(entry.payload, {
    token: args.checkpoint_token,
    answers: {
      user_response: args.user_response,
      viewer_result: args.viewer_result,
      cancelled: args.cancelled,
      reason: args.reason,
    },
  });
  if (result.status === 'committed') {
    clearPendingCheckpoint(effectiveId);
    return;
  }
  const rejection = result.rejection;
  const reasonTag = rejection.reason;
  const issues = rejection.issues?.join('; ') ?? '';
  const diff = rejection.payload_diff?.join('; ') ?? '';
  const detail = [issues, diff ? `payload_diff: ${diff}` : ''].filter(Boolean).join(' — ');
  throw new Error(
    `invalid_strategy: pending_checkpoint, acknowledge before continuing ` +
      `(${reasonTag}${detail ? ': ' + detail : ''}). Echo checkpoint_token + ` +
      `user_response / viewer_result, or cancel with {cancelled: true, reason}.`,
  );
}

/**
 * Run a runtime-emitted checkpoint event through direct dispatch and,
 * if the resolution is a `handover`, mint the pending-checkpoint token
 * and build the envelope the caller attaches to its tool response.
 */
export async function invokeCheckpointAndGate(
  kind: CheckpointKind,
  event: CheckpointEvent,
): Promise<{
  resolution: CheckpointResolution;
  envelope?: CheckpointEnvelope;
}> {
  let session;
  try {
    session = pool.getSession(event.session_id);
  } catch {
    // Session gone / not yet registered — no envelope; caller continues.
    return { resolution: { status: 'continue' } };
  }
  const resolution = await invokeCheckpoint(kind, event, session);
  if (resolution.status === 'handover') {
    const token = mintCheckpointToken(event.session_id, kind, event.context);
    const envelope: CheckpointEnvelope = {
      kind,
      context: event.context,
      prompt: resolution.prompt,
      ...(resolution.viewer_url ? { viewer_url: resolution.viewer_url } : {}),
      checkpoint_token: token,
    };
    return { resolution, envelope };
  }
  return { resolution };
}

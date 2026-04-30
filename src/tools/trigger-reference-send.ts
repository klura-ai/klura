import { pool } from '../runtime-state';
import { buildTokenGate, type GateResult } from '../gate';

export interface TriggerReferenceSendArgs {
  session_id: string;
  /** Short sequence of perform_action-shaped steps to run. The tool
   *  runs them in order, then watches the ws-frame ring for new sent
   *  frames that land during / shortly after the sequence. */
  actions: Array<{
    action: string;
    selector?: string;
    value?: string;
  }>;
  /** Milliseconds to watch for new sent frames after the last action
   *  completes. Default 1500, clamped [100, 10_000]. */
  settle_ms?: number;
  /** When true, auto-pin the first sent frame whose payload length
   *  exceeds 100 bytes — a rough "probably the real send" heuristic
   *  (keepalives, pings, and acks are usually <50 bytes). Default
   *  false; agents can pin explicitly from the returned hashes. */
  auto_pin?: boolean;
  /** Consent gate (Level-3 token-gated per principles.md §pre-commit
   *  gates). First call without `consent_token` returns a checklist the
   *  agent must classify + echo on the next call. The token binds to a
   *  hash of the consented payload (actions + settle_ms + auto_pin) so
   *  the agent can't consent to sequence X and fire sequence Y. */
  consent_token?: string;
  consent_answers?: ConsentAnswers;
}

export interface ConsentAnswers {
  /** '1' = Tier 1 (low-stakes — sandbox, idempotent, read-only check).
   *  '2' = Tier 2 (destructive, irreversible, monetary, or any third-
   *  party recipient — human OR bot). */
  tier: '1' | '2';
  /** What will fire, in the agent's own words. Non-empty. */
  action_description: string;
  /** Who (or what service) receives the side effect. Non-empty. */
  recipient_description: string;
  /** Required when tier === '2'. The user's own words confirming
   *  consent — tamper-evident paper trail, same rationale as
   *  save_warnings_acked reasons. Free text, non-empty for Tier 2. */
  user_acknowledgement_quote?: string;
}

export interface TriggerReferenceSendResult {
  ok: true;
  /** New sent frames captured in the window. Ordered oldest-first. */
  triggered_frames: Array<{
    ws_i: number;
    ws_hash: string;
    url: string;
    byte_length: number;
    first_byte_hex: string;
    ts: number;
  }>;
  /** When auto_pin was set, the hash that got pinned (if any). */
  auto_pinned_hash?: string;
  settle_ms_used: number;
}

// What the consent is bound to. Hashed by the gate framework so an
// agent who consents to fire payload A can't then fire payload B with
// the same token.
interface ConsentPayload {
  actions: TriggerReferenceSendArgs['actions'];
  settle_ms: number;
  auto_pin: boolean;
}

function buildActionSummary(actions: ConsentPayload['actions']): string {
  return actions
    .map((s) => {
      if (!s.value) return s.action;
      const ellipsis = s.value.length > 40 ? '…' : '';
      return `${s.action}(${JSON.stringify(s.value.slice(0, 40))}${ellipsis})`;
    })
    .join(' → ');
}

const consentGate = buildTokenGate<ConsentPayload, ConsentAnswers>({
  kind: 'trigger_reference_send.consent',
  buildChecklist: (payload) => {
    const summary = buildActionSummary(payload.actions);
    return {
      prompt:
        `trigger_reference_send re-fires a real submit on every call. Classify the side-effect before it fires. ` +
        `Return your answers in "consent_answers" on your next call, along with the "consent_token" echoed back. ` +
        `The token is bound to this exact action sequence — changing the actions forces a re-classification.`,
      items: {
        consenting_to: { actions_summary: summary, settle_ms: payload.settle_ms },
        required_fields: [
          'tier: "1" (low-stakes — sandbox, idempotent, read-only) or "2" (destructive, irreversible, monetary, OR any third-party recipient human/bot)',
          'action_description: what will fire, your own words',
          'recipient_description: who/what service receives the side effect',
          'user_acknowledgement_quote: REQUIRED for tier "2" — paste the user\'s own words confirming consent. Tamper-evident paper trail.',
        ],
      },
    };
  },
  validateAnswers: (_payload, answers) => {
    const issues: string[] = [];
    if ((answers.tier as unknown) !== '1' && (answers.tier as unknown) !== '2') {
      issues.push(`tier must be "1" or "2"; got ${JSON.stringify(answers.tier)}`);
    }
    if (
      typeof answers.action_description !== 'string' ||
      answers.action_description.trim().length === 0
    ) {
      issues.push('action_description must be a non-empty string');
    }
    if (
      typeof answers.recipient_description !== 'string' ||
      answers.recipient_description.trim().length === 0
    ) {
      issues.push('recipient_description must be a non-empty string');
    }
    if (answers.tier === '2') {
      const quote = answers.user_acknowledgement_quote;
      if (typeof quote !== 'string' || quote.trim().length === 0) {
        issues.push(
          'user_acknowledgement_quote is required for tier "2" — paste the user\'s own words confirming consent. If the user has not confirmed yet, stop and ask them first, then re-call with the quote.',
        );
      }
    }
    return issues;
  },
});

function rejectionToErrorMessage(result: GateResult): string {
  if (result.status === 'committed') {
    throw new Error('rejectionToErrorMessage called on a committed result');
  }
  const r = result.rejection;
  const lines: string[] = [];
  lines.push(`consent_required (${r.reason})`);
  lines.push(`  consent_token: ${r.token}`);
  if (r.issues && r.issues.length > 0) {
    lines.push('  issues:');
    for (const iss of r.issues) lines.push(`    - ${iss}`);
  }
  const items = r.checklist.items as {
    consenting_to?: { actions_summary: string; settle_ms: number };
    required_fields?: string[];
  };
  if (items.consenting_to) {
    lines.push(
      `  consenting_to: ${items.consenting_to.actions_summary} (settle_ms: ${items.consenting_to.settle_ms})`,
    );
  }
  if (items.required_fields) {
    lines.push('  required_fields:');
    for (const f of items.required_fields) lines.push(`    - ${f}`);
  }
  lines.push(
    `  how_to_respond: call trigger_reference_send again with {consent_token, consent_answers: {tier, action_description, recipient_description, user_acknowledgement_quote?}}`,
  );
  return lines.join('\n');
}

/**
 * Fire a short UI action sequence and surface any new sent WebSocket frames
 * that arrive during / shortly after. Used when the agent wants a fresh
 * reference frame for RE work AFTER the close_session auto-pin window has
 * passed, or on sessions that weren't going to hit close_session at all
 * (execute-only probes, etc).
 *
 * Consent-gated: the first call always returns a checklist + token. The
 * second call must echo the token + answers to fire.
 */
export async function triggerReferenceSend(
  args: TriggerReferenceSendArgs,
): Promise<TriggerReferenceSendResult | { error: string }> {
  if (!args.session_id) return { error: 'session_id is required' };
  if (!Array.isArray(args.actions) || args.actions.length === 0) {
    return { error: 'actions is required (non-empty array of {action, selector?, value?} steps)' };
  }
  if (args.actions.length > 10) {
    return {
      error: 'actions is capped at 10 steps — use perform_action directly for longer sequences',
    };
  }

  const settleMs = Math.max(100, Math.min(args.settle_ms ?? 1500, 10_000));
  const payload: ConsentPayload = {
    actions: args.actions,
    settle_ms: settleMs,
    auto_pin: Boolean(args.auto_pin),
  };
  const gateResult = consentGate.process(payload, {
    token: args.consent_token,
    answers: args.consent_answers,
  });
  if (gateResult.status !== 'committed') {
    return { error: rejectionToErrorMessage(gateResult) };
  }

  const session = pool.getSession(args.session_id);
  const before = new Set((session.wsFrames ?? []).map((f, i) => `${i}|${f.timestamp}`));

  // Deferred import to break the load-time cycle: `performAction` lives in
  // ../index, which itself pulls in this tool's re-export. Resolving it at call
  // time reads the already-loaded module off the graph.
  const { performAction } = await import('../index');

  try {
    for (const step of args.actions) {
      if (typeof step.action !== 'string' || step.action.length === 0) {
        return { error: 'each action step requires a non-empty `action` field' };
      }
      await performAction(args.session_id, step.action, step.selector ?? '', step.value, {
        returnTree: false,
      });
    }
  } catch (err) {
    return { error: `action step failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Settle — let the post-action ws activity land in the ring.
  await new Promise((resolve) => setTimeout(resolve, settleMs));

  // Refresh from the driver so the ring reflects the latest.
  const driver = pool.driverFor(args.session_id);
  await driver.getInterceptedWebSocketFrames(session).catch(() => []);
  const ring = session.wsFrames ?? [];
  const { hashWsFrame, pinWsFrame: pinImpl } = await import('../response/ws-pin');

  const triggered: TriggerReferenceSendResult['triggered_frames'] = [];
  ring.forEach((f, i) => {
    if (f.direction !== 'sent') return;
    const key = `${i}|${f.timestamp}`;
    if (before.has(key)) return;
    const payload = typeof f.payload === 'string' ? f.payload : '';
    triggered.push({
      ws_i: i,
      ws_hash: hashWsFrame(f),
      url: f.url,
      byte_length: payload.length,
      first_byte_hex: payload.length > 0 ? payload.charCodeAt(0).toString(16).padStart(2, '0') : '',
      ts: f.timestamp,
    });
  });

  let autoPinned: string | undefined;
  if (args.auto_pin) {
    const candidate = triggered.find((t) => t.byte_length > 100);
    if (candidate) {
      const frame = ring[candidate.ws_i];
      if (frame) autoPinned = pinImpl(session, frame);
    }
  }

  return {
    ok: true,
    triggered_frames: triggered,
    ...(autoPinned ? { auto_pinned_hash: autoPinned } : {}),
    settle_ms_used: settleMs,
  };
}

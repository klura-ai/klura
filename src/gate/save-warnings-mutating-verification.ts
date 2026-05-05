// Mutating-shape verification detector + supporting tags. Split out of
// save-warnings.ts to keep the main detector file under the per-file line
// cap; save-warnings.ts re-exports for the public surface.

import type { Strategy } from '../strategies/skills';
import type { SaveWarning } from './save-warnings';

/**
 * Mutating-shape detector — every saved strategy that performs a
 * server-state-changing action must declare its verification approach.
 * `status: 200` from a mutating call only proves the network call
 * succeeded; it doesn't prove the action took effect on the right entity
 * (wrong recipient, partial submit, write landed in someone else's
 * draft). UI-confirmation is the norm on real sites — a "sent"
 * indicator, the new outbound bubble, a count increment, a status
 * field — and the strategy should read it back.
 *
 * The runtime can't classify which verification approach fits — that's
 * task-dependent. So this detector ALWAYS fires on mutating-shaped
 * strategies and the agent must ack with a reason naming WHAT
 * verifies. The ack is anti-canned (must reference a real structural
 * element of the saved strategy OR a recognized shape tag) and
 * anchor-matched (module/protocol-anchored strategies can't ack with
 * a DOM-poll-only verification).
 *
 * ackReason: 'required' — declared at the Detector wrapper site in
 * audit/save-strategy.ts, which also carries the validateAck
 * implementation that reads the context we emit here.
 *
 * See `runtime/.claude/memory/feedback_always_verify_mutating_actions.md`
 * for the full design rule (always-verify, send-not-reply, anchor-match).
 */
export function detectMutatingStrategyVerificationApproach(data: Strategy): SaveWarning[] {
  const obj = data as Record<string, unknown>;
  const tier = typeof obj.strategy === 'string' ? obj.strategy : '';
  if (tier !== 'fetch' && tier !== 'page-script' && tier !== 'recorded-path') return [];

  // Mutating-shape detection. Four crisp signals.
  const method = typeof obj.method === 'string' ? obj.method.toUpperCase() : '';
  const httpMutating =
    (tier === 'fetch' || tier === 'page-script') &&
    (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE');

  let recordedPathMutating = false;
  if (tier === 'recorded-path' && Array.isArray(obj.steps)) {
    for (const step of obj.steps as Array<{ action?: unknown }>) {
      const a = step.action;
      if (
        a === 'type' ||
        a === 'fill_editor' ||
        a === 'fill' ||
        a === 'submit' ||
        a === 'key_press'
      ) {
        recordedPathMutating = true;
        break;
      }
    }
  }

  const frameExpr =
    obj.frameFromPage &&
    typeof obj.frameFromPage === 'object' &&
    typeof (obj.frameFromPage as { expression?: unknown }).expression === 'string'
      ? (obj.frameFromPage as { expression: string }).expression
      : '';
  const wsPublishing = frameExpr.includes('.publish(') || frameExpr.includes('.send(');

  // WebSocket-protocol strategy: `{strategy: "fetch"|"page-script",
  // protocol: "websocket", ...}` is the canonical shape for binary-WS
  // publishes (either via `generated.frame` on fetch, or via
  // `frameFromPage` on page-script). Always mutating by construction —
  // you don't open a WS connection and PUBLISH a frame to read state.
  // Independent of HTTP `method` since WS frames use their own opcode,
  // not an HTTP verb.
  const wsProtocolFetch =
    (tier === 'fetch' || tier === 'page-script') && obj.protocol === 'websocket';

  if (!httpMutating && !recordedPathMutating && !wsPublishing && !wsProtocolFetch) return [];

  const anchorType = readAnchorType(data);
  const validPaths = collectStructuralPaths(data);

  return [
    {
      kind: 'mutating_verification_required',
      message:
        `Strategy is mutating-shaped (${describeMutatingShape({ httpMutating, recordedPathMutating, wsPublishing, wsProtocolFetch, method, tier })}). ` +
        `Every mutating action on a real site exposes some confirmation surface — a "sent" indicator, ` +
        `the new outbound bubble in the thread, a toast, a count increment, a redirect, a status field ` +
        `on the response. status:200 alone doesn't prove the action took effect on the right entity; ` +
        `it only proves the network call succeeded. The strategy must verify the side effect actually ` +
        `landed before returning ok:true.`,
      hint:
        `Acknowledge inline: notes.save_warnings_acked: [{kind: "mutating_verification_required", reason: "<approach + structural anchor>"}]. ` +
        `The reason must name WHAT verifies success, by structural element of the saved strategy. ` +
        `Examples by shape:\n` +
        `  • transaction-shape (server returns confirmation): "transaction-shape: response.extract.message_id pulls the server-issued id"\n` +
        `  • chat-shape (read back our own outbound): "chat-shape: frameFromPage.expression polls thread DOM for the typed text appearing as outbound before returning"\n` +
        `  • dom-poll (fragile but sometimes the only signal): "dom-poll: verify_sent js-eval prereq polls .toast-success for 2s after publish"\n` +
        `  • intrinsic-to-caller (the next capability IS the verification): "intrinsic-to-caller — caller's next move is read_messages"\n` +
        `  • rpc-read (POST envelope is a read, not a mutation — GraphQL query, JSON-RPC read, search endpoint): "rpc-read: GraphQL query; response.data is the payload, no side effect"\n` +
        `  • fire-and-forget (rare; specific noun required): "fire-and-forget — telemetry beacon, no UI surface, idempotent"\n\n` +
        `Verification verifies the SEND, not the recipient's reply. For chat: "we confirmed our outbound message appeared in the thread" — not "we waited for a reply." The reply is a separate capability.\n\n` +
        `Anchor-match: verification durability must match notes.anchor_type. Module/protocol-anchored strategies cannot ack with dom-poll only — that makes the DOM the new fragility bottleneck. Match the verification anchor to the capability's anchor.\n\n` +
        `Also consider validating each declared notes.params.<name> value before the call fires (e.g., the recipient lookup actually found a thread before typing into the composer).`,
      context: {
        anchor_type: anchorType,
        valid_paths: validPaths,
        shape: { httpMutating, recordedPathMutating, wsPublishing, wsProtocolFetch },
      },
    },
  ];
}

function describeMutatingShape(s: {
  httpMutating: boolean;
  recordedPathMutating: boolean;
  wsPublishing: boolean;
  wsProtocolFetch: boolean;
  method: string;
  tier: string;
}): string {
  if (s.httpMutating) return `HTTP ${s.method} on ${s.tier}`;
  if (s.recordedPathMutating) return 'recorded-path with type/submit step';
  if (s.wsPublishing) return 'page-script with WS publish/send call';
  if (s.wsProtocolFetch) return `${s.tier} with protocol="websocket" (binary WS publish)`;
  return 'mutating';
}

function readAnchorType(data: Strategy): 'module' | 'protocol' | 'dom' | 'unknown' {
  const notes = (data as { notes?: { anchor_type?: unknown } }).notes;
  const a = notes?.anchor_type;
  if (a === 'module' || a === 'protocol' || a === 'dom') return a;
  return 'unknown';
}

/**
 * Enumerate structural path-shaped tokens that exist on the saved
 * strategy. The agent's ack reason can reference any of these to prove
 * the verification claim is grounded in the actual artifact (anti-canned
 * ack). The list is necessarily incomplete — the agent might reference
 * any depth — but covers the common surfaces (response.extract, prereqs,
 * frame, headers, top-level body fields).
 */
function collectStructuralPaths(data: Strategy): string[] {
  const out = new Set<string>();
  const obj = data as Record<string, unknown>;

  const response = obj.response;
  if (response && typeof response === 'object') {
    const extract = (response as { extract?: unknown }).extract;
    if (extract && typeof extract === 'object' && !Array.isArray(extract)) {
      out.add('response.extract');
      for (const key of Object.keys(extract as Record<string, unknown>)) {
        out.add(`response.extract.${key}`);
      }
    }
  }

  if (Array.isArray(obj.prerequisites)) {
    obj.prerequisites.forEach((p, i) => {
      out.add(`prerequisites[${i}]`);
      if (p && typeof p === 'object') {
        const pp = p as { name?: unknown; kind?: unknown; binds?: unknown };
        if (typeof pp.name === 'string') {
          out.add(`prerequisites[${i}].name=${pp.name}`);
          out.add(pp.name); // bare name for ergonomic ack-writing
        }
        if (typeof pp.binds === 'string') out.add(pp.binds);
      }
    });
  }

  if (obj.frameFromPage && typeof obj.frameFromPage === 'object') {
    out.add('frameFromPage');
    out.add('frameFromPage.expression');
  }

  if (obj.headers && typeof obj.headers === 'object') {
    for (const key of Object.keys(obj.headers as Record<string, unknown>)) {
      out.add(`headers.${key}`);
    }
  }

  const body = obj.body;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const key of Object.keys(body as Record<string, unknown>)) {
      out.add(`body.${key}`);
    }
  }

  if (Array.isArray(obj.steps)) {
    obj.steps.forEach((_, i) => {
      out.add(`steps[${i}]`);
    });
  }

  return [...out];
}

/** Recognized shape tags the agent can use in the ack reason. Case-
 *  sensitive — these are tags, not English prose. `rpc-read` covers
 *  POST-as-read (GraphQL queries, JSON-RPC reads, "search" endpoints)
 *  where the response payload IS the data and there's no side effect
 *  to verify; the heuristic can't crisply distinguish read-shaped POST
 *  from write-shaped POST without brand-specific URL parsing, so the
 *  ack vocabulary carries the load. */
export const VERIFICATION_SHAPE_TAGS = [
  'transaction-shape',
  'chat-shape',
  'dom-poll',
  'intrinsic-to-caller',
  'fire-and-forget',
  'rpc-read',
] as const;

/** Justifying nouns that must accompany `fire-and-forget`. The tag
 *  alone is too cheap; the agent has to name the kind of action that
 *  legitimately has no verification surface. */
export const FIRE_AND_FORGET_JUSTIFYING_NOUNS = [
  'telemetry',
  'idempotent',
  'beacon',
  'analytics',
  'keepalive',
  'heartbeat',
  'log',
  'metric',
] as const;

/** Tokens whose presence in the ack reason indicates a non-DOM
 *  verification surface — used by the anchor-match check to clear
 *  module/protocol-anchored strategies whose ack is chat-shape (not
 *  dom-poll). */
export const NON_DOM_VERIFICATION_MARKERS = [
  'response.extract',
  'response_extract',
  'window.require',
  'page-global',
  'page global',
  'module',
  'frameFromPage.expression',
  'wire',
  'WS frame',
  'ws_frame',
  'mqtt',
] as const;

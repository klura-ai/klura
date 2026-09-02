import { pool } from '../runtime-state';
import { computeSessionObligation } from '../session-obligations';
import type { Session } from '../drivers/types/session';
import { TOOL_NAMES } from '../vocab';

// Signer-discovery tool-floor list. The three tools whose zero-use during
// LIFT is strong evidence that the agent never actually looked for the
// page's signer before declining — it only ran surface-cue heuristics.
//
// Why these three specifically: `list_loaded_scripts` enumerates bundles (10
// seconds; pure I/O). `search_js_source` greps bundles for signing keywords
// (sign/token/hmac/nonce/auth; 2 minutes). `read_js_function` pulls a candidate
// function once located. Together they answer "is there a page-side signer, and
// where is it?" — the question a decline has to have an answer to in order to
// be well-grounded.
//
// Grounded in: - arXiv 2503.13657 "Why Do Multi-Agent LLM Systems Fail?" — LLM
// self-assessment is unreliable; the runtime provides objectively verifiable
// criteria (did the tool calls happen or not?) to replace it. - Anthropic
// Engineering, "Effective harnesses for long-running agents" — externalized
// checklists beat prompt-level imperatives for preventing premature victory
// declaration. - CircleCI (2026) "Building LLM agents to validate tool use" —
// business rules in prompts become suggestions, not constraints; enforce in the
// validator where the model can't talk past it. Transport-aware
// encoder/signer-discovery gate. Three satisfier paths: HTTP path:
// list_loaded_scripts + search_js_source + read_js_function — right toolchain
// for signed HTTP URLs where the signer lives in a JS bundle and the agent
// needs to locate + read + call it. WS path: inspect_ws_frame + try_generator +
// evaluate_on_frame — right toolchain for binary WebSocket sends where the
// encoder is the page's own publisher and the inspect_ws_frame starter +
// try_generator convergence loop is the canonical lift path. Context-bound
// path: evaluate_in_iframe + evaluate_in_iframe_chain + evaluate_in_worker —
// right toolchain for sites where the server validates tokens bound to the
// JS-execution context that generated them (vendor SDK init in an iframe,
// proof-of-work bound to its WebWorker origin, iframe-init-bound CSRF cookies).
//
// Agent satisfies the gate by demonstrating non-zero use of ANY path.
// The transport-aware split prevents binary-WS agents being forced down the
// HTTP path (search_js_source for a signer that doesn't exist in WS captures)
// and never reaching for inspect_ws_frame; same shape for context-bound agents
// who solved the problem via iframe-context fetch but used no HTTP/WS RE tools.
export const HTTP_SIGNER_TOOLS = [
  'list_loaded_scripts',
  'search_js_source',
  'read_js_function',
] as const;
export const WS_ENCODER_TOOLS = ['inspect_ws_frame', 'try_generator', 'evaluate_on_frame'] as const;
export const CONTEXT_BOUND_TOOLS = [
  'evaluate_in_iframe',
  'evaluate_in_iframe_chain',
  'evaluate_in_worker',
] as const;

export function getUnusedSignerDiscoveryTools(session: Session): string[] {
  const acc = session.artifactAccumulator;
  if (!acc) return [...HTTP_SIGNER_TOOLS, ...WS_ENCODER_TOOLS, ...CONTEXT_BOUND_TOOLS];
  const httpUsed =
    acc.listLoadedScriptsCalls.length +
      acc.searchJsSourceCalls.length +
      acc.readJsFunctionCalls.length >
    0;
  const wsUsed =
    acc.inspectWsFrameCalls.length +
      acc.tryGeneratorCalls.length +
      acc.evaluateOnFrameCalls.length >
    0;
  const contextBoundUsed =
    acc.evaluateInIframeCalls.length +
      acc.evaluateInIframeChainCalls.length +
      acc.evaluateInWorkerCalls.length >
    0;
  // At least one path exercised satisfies the gate — return empty "unused."
  if (httpUsed || wsUsed || contextBoundUsed) return [];
  // None of the paths touched. Name all so the agent picks whichever fits
  // their capture shape.
  return [...HTTP_SIGNER_TOOLS, ...WS_ENCODER_TOOLS, ...CONTEXT_BOUND_TOOLS];
}

/**
 * LIFT-flow tools whose OWN response is the authoritative next-step guide:
 * the save_strategy rejection envelope, the end_drive triage handoff, the
 * triage-plan relay, the capability-declaration ack, the update_strategy
 * re-audit. The sticky obligation banner ("you haven't saved — call X next")
 * is redundant on these and actively harmful: prepended to a save_strategy
 * rejection it pushes the actionable audit text below the fold, and it repeats
 * verbatim across every retry of the same save. The agent is already inside the
 * flow the banner points at — suppress it so the tool's own envelope is what
 * the agent reads. The banner's real target is read / perform_action responses,
 * where nothing else reminds the agent a save is still owed.
 */
const OBLIGATION_SUPPRESSED_TOOLS = new Set<string>([
  TOOL_NAMES.saveStrategy,
  TOOL_NAMES.updateStrategy,
  TOOL_NAMES.endDrive,
  TOOL_NAMES.submitTriagePlan,
  TOOL_NAMES.declareCapability,
]);

/**
 * Compute the LIFT obligation for a session — a sticky reminder surfaced
 * on tool responses when mutating actions have happened but no strategy is
 * saved (and end_drive hasn't completed). Returns null if no obligation
 * applies, or when `toolName` is a LIFT-flow tool whose own response already
 * carries the next-step guidance (see `OBLIGATION_SUPPRESSED_TOOLS`). See
 * `runtime/src/session-obligations/index.ts` for the full rationale.
 */
export function getSessionObligation(
  sessionId: string,
  toolName?: string,
): ReturnType<typeof computeSessionObligation> | null {
  if (toolName && OBLIGATION_SUPPRESSED_TOOLS.has(toolName)) return null;
  let session;
  try {
    session = pool.getSession(sessionId);
  } catch {
    return null;
  }
  return computeSessionObligation(session);
}

// ---------------------------------------------------------------------------
// Tool registry metadata
// ---------------------------------------------------------------------------

import type { ToolDef } from '../tools/types';
import { endDrive } from '../phases/drive/end-drive-orchestrator';
import { ackCheckpoint } from '../checkpoints/api';
import { CHECKPOINT_KINDS, composeAckHint } from '../checkpoints';

const checkpointAckTable = CHECKPOINT_KINDS.map(
  (kind) => `- ${kind}: ${composeAckHint(kind, {})}`,
).join('\n');

const ackCheckpointDescription = `Acknowledge a runtime-emitted checkpoint. When a tool response carries \`_checkpoint: {kind, prompt?, viewer_url?, checkpoint_token}\`, runtime paused at a known lifecycle boundary and a handler returned \`handover\`. Echo \`checkpoint_token\` + the ack that matches the target: \`user_response: "<reply>"\` for text-turn checkpoints, \`viewer_result: {...}\` for viewer-handover checkpoints after the user completed the action in the viewer, OR \`{cancelled: true, reason: "..."}\` to abandon. Current checkpoint kinds and post-ack hints:\n${checkpointAckTable}\nWithout an ack, every other tool call on the session rejects with \`invalid_strategy: pending_checkpoint\`. See klura://reference#checkpoints.`;

export const TOOL_DEFS: ToolDef[] = [
  {
    name: TOOL_NAMES.endDrive,
    // extraPhases: lift admits end_drive as the abandon path when an audit
    // loop fails to converge (auto-synth still runs at the orchestrator, so
    // a salvageable recorded-path can land from drive history); execute
    // admits it as the strategy-invocation abort. It survives every
    // exhausted budget — a soft-blocked session must always have an exit.
    phasePolicy: {
      category: 'drive_active',
      extraPhases: ['lift', 'execute'],
      allowedWhenExhaustedIn: ['drive', 'lift', 'execute'],
    },
    description:
      'End the DRIVE phase. The agent has finished driving the UI; runtime ALWAYS hands over to TRIAGE — agent does not get to decide "this was a one-off task, no triage needed." When any declared capability is unresolved, the triage handoff returns with captures inventory + diagnostic tools menu + plan-structure preview. When every declared capability is already saved (no unresolved work), the end_drive_audit `triage_acknowledgment` warning fires instead: agent confirms triage was considered by passing `acks: {triage_acknowledgment: "<own words ≥20 chars>"}` — supplying the reason IS the acknowledgment, no token round-trip. Phase-locked to drive — calling from triage or lift returns a structured rejection. Auto-close on terminal save_strategy means most sessions never need to call this explicitly.\n\nCloses the browser session. Runs auto-synthesis: builds `page-script`/`fetch` strategies by joining typed literals to captured HTTP request bodies, and a `recorded-path` from perform_action history. Also persists the discovery artifact (resume pointers + tool-call trace). Response carries `auto_synthesized: [{capability, tier, path}]`, `artifacts_updated: [{capability, sessions_contributed, has_blob}]`, and `_diagnostics.synth: [{pass, capability, phase, outcome, detail}]` explaining exactly what each synth pass found — whether it matched, where (http_request_body / ws_frame_sent / etc.), and why it saved or skipped. Read `_diagnostics` when you need to understand why auto-save produced nothing — the most common case is `outcome: "literal_in_ws_frame_only"` which means the send rode a binary WS frame and needs manual lift via `inspect_ws_frame` + `try_generator`. A related shape is `outcome: "context_bound_token_in_request"` — auto-save produced a fetch strategy whose captured request carries opaque headers that may bind to the JS context that generated them; if warm execute returns 401/403, lift manually via `evaluate_in_iframe` / `evaluate_in_iframe_chain` / `evaluate_in_worker` (third RE-toolkit axis).',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        platform: { type: 'string', description: 'Platform name to save storage state for' },
        audit_token: {
          type: 'string',
          description:
            'Echo the audit_token returned on a prior end_drive audit rejection that carried one. Detector-emitted warnings (capability_declaration_required / save_attempted_none_landed / re_persistence / triage_acknowledgment) need no token — answer them via `acks`.',
        },
        audit_answers: {
          type: 'object',
          description:
            'Audit answers for Classifier-style gates, per the checklist from the prior rejection. Only send what that rejection asked for.',
        },
        acks: {
          type: 'object',
          description:
            'Acknowledgements for Detector-emitted warnings, keyed by Detector kind, value is a one-sentence reason. Example: `{observed_capabilities_not_lifted: "deferring get_product_detail because the surface is paginated-listing-without-cursor"}`. The ack reason must mention every leftover slug verbatim (anti-canned). `{triage_acknowledgment: "<why no triage round is warranted, ≥20 chars in your own words>"}` clears the triage gate. re_persistence is a Detector but has no acks path — either persist progress (save_verified_expression / add_discovery_note / add_resume_pointer) and retry, or use abort_session(session_id, reason) to bail honestly.',
        },
      },
      required: ['session_id'],
    },
    handler: (args: any, ctx) =>
      endDrive(
        args.session_id,
        {
          platform: args.platform,
          auditToken: args.audit_token,
          auditAnswers: args.audit_answers,
          acks: args.acks,
        },
        { progress: ctx?.progress },
      ),
  },

  {
    name: TOOL_NAMES.ackCheckpoint,
    phasePolicy: { category: 'universal' },
    description: ackCheckpointDescription,
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        checkpoint_token: {
          type: 'string',
          description: 'Token from the `_checkpoint` envelope on the prior tool response.',
        },
        user_response: {
          type: 'string',
          description:
            "The user's reply for text-turn checkpoints (triage_plan, surface_changed, post_save_validation_consent).",
        },
        viewer_result: {
          type: 'object',
          description:
            'Structured result for viewer-handover checkpoints (recorded_step_failed, session_expired) after the user completed the action in the viewer.',
        },
        cancelled: {
          type: 'boolean',
          description: 'Set true to abandon the checkpoint. Requires `reason`.',
        },
        reason: {
          type: 'string',
          description: 'When `cancelled:true`, a one-sentence reason for abandoning.',
        },
      },
      required: ['session_id', 'checkpoint_token'],
    },
    skipCheckpointGate: true,
    handler: (args: any) =>
      ackCheckpoint({
        session_id: args.session_id,
        checkpoint_token: args.checkpoint_token,
        user_response: args.user_response,
        viewer_result: args.viewer_result,
        cancelled: args.cancelled,
        reason: args.reason,
      }),
  },
];

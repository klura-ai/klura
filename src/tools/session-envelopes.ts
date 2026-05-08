import { pool } from '../runtime-state';
import { computeSessionObligation } from '../session-obligations';
import type { Session } from '../drivers/types/session';

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
// encoder/signer-discovery gate. Two satisfier paths: HTTP path:
// list_loaded_scripts + search_js_source + read_js_function — right toolchain
// for signed HTTP URLs where the signer lives in a JS bundle and the agent
// needs to locate + read + call it. WS path: inspect_ws_frame + try_generator +
// evaluate_on_frame — right toolchain for binary WebSocket sends where the
// encoder is the page's own publisher and the inspect_ws_frame starter +
// try_generator convergence loop is the canonical lift path.
//
// Agent satisfies the gate by demonstrating non-zero use of EITHER path.
// The transport-aware split prevents binary-WS agents being forced down the
// HTTP path (search_js_source for a signer that doesn't exist in WS captures)
// and never reaching for inspect_ws_frame.
export const HTTP_SIGNER_TOOLS = [
  'list_loaded_scripts',
  'search_js_source',
  'read_js_function',
] as const;
export const WS_ENCODER_TOOLS = ['inspect_ws_frame', 'try_generator', 'evaluate_on_frame'] as const;

export function getUnusedSignerDiscoveryTools(session: Session): string[] {
  const acc = session.artifactAccumulator;
  if (!acc) return [...HTTP_SIGNER_TOOLS, ...WS_ENCODER_TOOLS];
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
  // At least one path exercised satisfies the gate — return empty "unused."
  if (httpUsed || wsUsed) return [];
  // Neither path touched. Name both so the agent picks whichever fits their
  // capture shape.
  return [...HTTP_SIGNER_TOOLS, ...WS_ENCODER_TOOLS];
}

/**
 * Compute the LIFT obligation for a session — a sticky reminder surfaced
 * on tool responses when mutating actions have happened but no strategy is
 * saved (and end_drive hasn't completed). Returns null if no obligation
 * applies. See `runtime/src/session-obligations.ts` for the full rationale.
 */
export function getSessionObligation(
  sessionId: string,
): ReturnType<typeof computeSessionObligation> | null {
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

import { TOOL_NAMES } from '../vocab';
import type { ToolDef } from '../tool-types';
import { endDrive } from '../phases/drive/end-drive-orchestrator';
import { ackCheckpoint } from '../checkpoints-api';
import { CHECKPOINT_KINDS, composeAckHint } from '../checkpoints';

const checkpointAckTable = CHECKPOINT_KINDS.map(
  (kind) => `- ${kind}: ${composeAckHint(kind, {})}`,
).join('\n');

const ackCheckpointDescription = `Acknowledge a runtime-emitted checkpoint. When a tool response carries \`_checkpoint: {kind, prompt?, viewer_url?, checkpoint_token}\`, runtime paused at a known lifecycle boundary and a handler returned \`handover\`. Echo \`checkpoint_token\` + the ack that matches the target: \`user_response: "<reply>"\` for text-turn checkpoints, \`viewer_result: {...}\` for viewer-handover checkpoints after the user completed the action in the viewer, OR \`{cancelled: true, reason: "..."}\` to abandon. Current checkpoint kinds and post-ack hints:\n${checkpointAckTable}\nWithout an ack, every other tool call on the session rejects with \`invalid_strategy: pending_checkpoint\`. See klura://reference#checkpoints.`;

export const TOOL_DEFS: ToolDef[] = [
  {
    name: TOOL_NAMES.endDrive,
    description:
      'End the DRIVE phase. The agent has finished driving the UI; runtime ALWAYS hands over to TRIAGE — agent does not get to decide "this was a one-off task, no triage needed." When any declared capability is unresolved, the triage handoff returns with captures inventory + diagnostic tools menu + plan-structure preview. When every declared capability is already saved (no unresolved work), the end_drive_audit `triage_acknowledgment` classifier fires instead: agent must echo `audit_token` + `{triage_acknowledgment: {acknowledged: true, reason: "<own words ≥20 chars>"}}` to confirm triage was considered. Phase-locked to drive — calling from triage or lift returns a structured rejection. Auto-close on terminal save_strategy means most sessions never need to call this explicitly.\n\nCloses the browser session. Runs auto-synthesis: builds `page-script`/`fetch` strategies by joining typed literals to captured HTTP request bodies, and a `recorded-path` from perform_action history. Also persists the discovery artifact (resume pointers + tool-call trace). Response carries `auto_synthesized: [{capability, tier, path}]`, `artifacts_updated: [{capability, sessions_contributed, has_blob}]`, and `_diagnostics.synth: [{pass, capability, phase, outcome, detail}]` explaining exactly what each synth pass found — whether it matched, where (http_request_body / ws_frame_sent / etc.), and why it saved or skipped. Read `_diagnostics` when you need to understand why auto-save produced nothing — the most common case is `outcome: "literal_in_ws_frame_only"` which means the send rode a binary WS frame and needs manual lift via `inspect_ws_frame` + `try_generator`.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        platform: { type: 'string', description: 'Platform name to save storage state for' },
        audit_token: {
          type: 'string',
          description:
            'Echo the audit_token returned on the prior end_drive audit rejection (capability_declaration_required / save_attempted_none_landed / re_persistence Detectors, or triage_acknowledgment Classifier). See klura://reference#end-drive-audit.',
        },
        audit_answers: {
          type: 'object',
          description:
            'Audit answers per the checklist from the prior rejection. Shape: {triage_acknowledgment?: {acknowledged: true, reason: "<own words ≥20 chars>"}}. For triage_acknowledgment: only ack when you truly considered triage — explain in your own words why no triage round was warranted (e.g. "all caps fetch-tier saved, no graduation candidate observed in captures"). re_persistence is a Detector and has no audit_answers path: either persist progress (save_verified_expression / add_discovery_note / add_resume_pointer) and retry, or use abort_session(session_id, reason) to bail honestly.',
        },
      },
      required: ['session_id'],
    },
    handler: (args: any) =>
      endDrive(args.session_id, {
        platform: args.platform,
        auditToken: args.audit_token,
        auditAnswers: args.audit_answers,
      }),
  },

  {
    name: TOOL_NAMES.ackCheckpoint,
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

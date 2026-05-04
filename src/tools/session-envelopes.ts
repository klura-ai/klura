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

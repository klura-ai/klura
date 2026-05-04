// Literal-matching toolkit shared across the synth passes: scans every byte
// the session captured for verbatim occurrences of a typed value and reports
// raw findings. Generic by design — the runtime reports what it found, the
// agent reasons from there. Also hosts the typed-text drift detector and the
// save-warnings attachment helper, which both ride on the same primitive.

import type { Session } from '../../drivers/types/session';
import { WRITE_SHAPED_ACTIONS } from '../../audit/end-drive';
import { stringifyOrEmpty } from './helpers';

/** One source of ground-truth matches for a typed literal across every
 * byte the session captured. Generic by design — the runtime reports
 * raw findings without inferring meaning. Agent reasons from there. */
export interface LiteralMatch {
  source:
    | 'http_request_body'
    | 'http_response_body'
    | 'http_url'
    | 'ws_frame_sent'
    | 'ws_frame_received'
    | 'visited_url';
  source_index: number;
  offset: number;
}

export function findLiteralInSessionCaptures(session: Session, literal: string): LiteralMatch[] {
  if (!literal) return [];
  const out: LiteralMatch[] = [];
  const intercepted = session.intercepted;
  for (let i = 0; i < intercepted.length; i += 1) {
    const req = intercepted[i];
    if (!req) continue;
    // URL
    if (typeof req.url === 'string') {
      const o = req.url.indexOf(literal);
      if (o !== -1) out.push({ source: 'http_url', source_index: i, offset: o });
    }
    // post_data (string or serializable)
    const postStr = stringifyOrEmpty(req.postData);
    if (postStr) {
      const o = postStr.indexOf(literal);
      if (o !== -1) out.push({ source: 'http_request_body', source_index: i, offset: o });
    }
    // responseBody (string)
    const respStr = stringifyOrEmpty(req.responseBody);
    if (respStr) {
      const o = respStr.indexOf(literal);
      if (o !== -1) out.push({ source: 'http_response_body', source_index: i, offset: o });
    }
  }
  const wsFrames = session.wsFrames ?? [];
  for (let i = 0; i < wsFrames.length; i += 1) {
    const f = wsFrames[i];
    if (!f) continue;
    if (typeof f.payload === 'string') {
      const o = f.payload.indexOf(literal);
      if (o !== -1) {
        out.push({
          source: f.direction === 'sent' ? 'ws_frame_sent' : 'ws_frame_received',
          source_index: i,
          offset: o,
        });
      }
    }
  }
  // Top-level document navigations land in session.visitedUrls, not
  // session.intercepted (the CDP interceptor skips document loads). For
  // read-shaped capabilities whose user-arg is in the URL path (/@handle,
  // /user/<id>, /orders/<slug>), this is the only source where the literal
  // appears — without this pass, findLiteralInSessionCaptures reports
  // no_literal_match_in_captures for every profile-view capability.
  const visited = session.visitedUrls ?? [];
  for (let i = 0; i < visited.length; i += 1) {
    const u = visited[i];
    if (typeof u !== 'string' || !u || u === 'about:blank') continue;
    const o = u.indexOf(literal);
    if (o !== -1) out.push({ source: 'visited_url', source_index: i, offset: o });
  }
  return out;
}

export type SaveWarning = { kind: string; message: string; hint?: string };

// Typed-text drift: runtime scans declared arg values against what was actually
// typed (perform_action type/fill history) AND what appeared in captured HTTP
// request bodies. If an arg value appears in neither, the agent probably
// abbreviated or rephrased the user's input — auto-save's join against captured
// traffic missed, so warm execute will template the arg incorrectly. Emits a
// save_warning per un-observed arg so the next warm run surfaces the drift
// instead of silently misbehaving.
export function detectTypedTextDrift(
  session: Session,
  declaredArgs: Record<string, unknown> | undefined,
): SaveWarning[] {
  if (!declaredArgs) return [];
  const typedTexts: string[] = [];
  for (const record of session.performActionHistory ?? []) {
    const action = (record as { action?: string }).action;
    if (typeof action !== 'string' || !WRITE_SHAPED_ACTIONS.has(action)) continue;
    const v = (record as { value?: unknown }).value;
    if (typeof v === 'string' && v.length > 0) typedTexts.push(v);
  }
  const bodies: string[] = [];
  for (const req of session.intercepted) {
    const body = (req as { body?: unknown }).body;
    if (typeof body === 'string' && body.length > 0) bodies.push(body);
  }
  const warnings: SaveWarning[] = [];
  for (const [argName, argVal] of Object.entries(declaredArgs)) {
    // Short values aren't worth flagging — a 1-2 char value matches everything.
    // 3+ chars gives real signal.
    if (typeof argVal !== 'string' || argVal.length < 3) continue;
    const found =
      typedTexts.some((t) => t.includes(argVal)) || bodies.some((b) => b.includes(argVal));
    if (!found) {
      const preview =
        argVal.length > 60
          ? `${argVal.slice(0, 60).replace(/"/g, '\\"')}…`
          : argVal.replace(/"/g, '\\"');
      warnings.push({
        kind: 'typed_text_drift',
        message:
          `Declared arg "${argName}" (value: "${preview}") never appeared in any typed text or captured request body during discovery. ` +
          `Auto-save couldn't template this arg — the saved strategy will NOT pass caller-provided "${argName}" through to the wire at warm execute.`,
        hint:
          `Either (a) re-open the session and type the literal value verbatim so capture-join can find it, ` +
          `or (b) if the agent intentionally typed different text, the declared args don't match what was actually done — re-declare with the values that were typed.`,
      });
    }
  }
  return warnings;
}

export function attachSaveWarningsToStrategy(
  strategy: Record<string, unknown>,
  warnings: SaveWarning[],
): void {
  if (warnings.length === 0) return;
  const meta = (strategy.runtime_meta ?? {}) as Record<string, unknown>;
  const existing = Array.isArray(meta.save_warnings) ? (meta.save_warnings as SaveWarning[]) : [];
  meta.save_warnings = [...existing, ...warnings];
  strategy.runtime_meta = meta;
}

// Literal-matching toolkit shared across the synth passes: scans every byte
// the session captured for verbatim occurrences of a typed value and reports
// raw findings. Generic by design — the runtime reports what it found, the
// agent reasons from there. Also hosts the typed-text drift detector and the
// save-warnings attachment helper, which both ride on the same primitive.

import type { Session } from '../../drivers/types/session';
import { WRITE_SHAPED_ACTIONS } from '../../audit/drive/end-drive';
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

/**
 * Subset of `detectTypedTextDrift` warnings that are *guaranteed* to break the
 * saved strategy at warm execute: the declared arg's literal was never typed
 * or sent (so auto-synth couldn't template it), AND the synthesized strategy
 * does not contain a `{{argName}}` placeholder anywhere either. The arg slot
 * is baked to whatever literal the agent actually typed during discovery —
 * future callers' arg values can never reach the wire.
 *
 * For each blocking drift the saved strategy is structurally non-functional;
 * the synth-on-close caller should skip persistence and let the agent re-drive
 * with proper literal typing.
 *
 * Lower-confidence drifts (declared arg WAS templated somewhere in the
 * strategy but didn't surface in capture — e.g. URL-encoded forms, base64
 * wrappers) stay as advisory warnings via `detectTypedTextDrift`.
 */
export function detectBlockingTypedTextDrift(
  strategy: Record<string, unknown>,
  session: Session,
  declaredArgs: Record<string, unknown> | undefined,
): SaveWarning[] {
  const drifts = detectTypedTextDrift(session, declaredArgs);
  if (drifts.length === 0) return [];
  const serialized = JSON.stringify(strategy);
  const blocking: SaveWarning[] = [];
  for (const drift of drifts) {
    const argName = extractArgNameFromMessage(drift.message);
    if (!argName) continue;
    const placeholder = `{{${argName}}}`;
    if (serialized.includes(placeholder)) continue;
    blocking.push({
      ...drift,
      kind: 'typed_text_drift_blocking',
      message:
        `STRUCTURAL: declared arg "${argName}" was neither typed/sent during discovery NOR ` +
        `templated as \`{{${argName}}}\` anywhere in the synthesized strategy. The strategy ` +
        `bakes whatever literal the agent did type into the arg slot — caller-supplied ` +
        `"${argName}" values cannot reach the wire at warm execute. ` +
        `Original drift: ${drift.message}`,
      hint:
        `Re-open the session, type the literal value of "${argName}" verbatim so capture-join ` +
        `can template it, then end_drive again. Auto-synth will skip persisting this capability ` +
        `until the literal appears in typed text or a captured request body.`,
    });
  }
  return blocking;
}

const ARG_NAME_RE = /Declared arg "([^"]+)"/;
function extractArgNameFromMessage(message: string): string | null {
  const match = ARG_NAME_RE.exec(message);
  return match?.[1] ?? null;
}

/**
 * A typed arg value can land on the wire in several encodings depending on the
 * request body's content-type: raw (JSON string value, plain query), percent-
 * encoded (form-urlencoded, URL query), form-plus (space as `+`), or JSON-
 * string-escaped (value embedded in a JSON body — quotes, `\n`, non-ASCII).
 * Auto-synth templating and the silent-bake postcondition both match against
 * this candidate set so a value that is present-but-encoded is still found
 * rather than baked into the strategy as a literal. Raw value is always first.
 */
export function wireEncodingVariants(value: string): string[] {
  if (value.length === 0) return [];
  const out = new Set<string>([value]);
  try {
    const pct = encodeURIComponent(value);
    out.add(pct);
    out.add(pct.replace(/%20/g, '+')); // form-urlencoded encodes space as '+'
  } catch {
    // encodeURIComponent throws only on lone surrogates — skip the variant.
  }
  try {
    const json = JSON.stringify(value); // "a\nb" -> "\"a\\nb\""
    if (json.length >= 2) out.add(json.slice(1, -1)); // drop the wrapping quotes
  } catch {
    // Non-serializable — skip the JSON-escaped variant.
  }
  return [...out];
}

/**
 * Silent-bake postcondition for auto-synthesized fetch / page-script
 * strategies — the resilient backstop to the best-effort templating passes.
 *
 * Templating replaces a declared arg's value with `{{arg}}` wherever the value
 * (in any `wireEncodingVariants` form) appears in the captured request. When
 * it misses — an encoding it does not recognize, a partial match — the arg
 * ships baked as a literal and warm execute silently ignores caller input
 * while still returning the same 2xx the agent saw during discovery. That
 * false-positive success is the worst failure mode a saved strategy can have:
 * it looks like it worked and the caller's data never reached the wire.
 *
 * Rather than depend on templating having handled every encoding, this asserts
 * the end state directly: every declared string arg whose value is present in
 * the capture the strategy was built from MUST surface as a `{{arg}}`
 * placeholder in the serialized strategy. Any present-but-untemplated arg is
 * returned; the caller skips persistence so the recorded-path fallback (which
 * replays the real typed values) stands in and the next session can lift
 * manually.
 *
 * Complete for every strategy auto-synth actually ships: a body is persisted
 * only when it parsed as JSON or form-urlencoded, and for both a value's wire
 * form is one of the encodings `wireEncodingVariants` enumerates — so a present
 * value cannot hide from this check on a shipped strategy. Anchoring to THIS
 * capture (not the whole session) also means args that legitimately belong to a
 * different request in a multi-call flow are not false-flagged. Values shorter
 * than 3 chars are skipped — they match too much to give a reliable signal.
 */
export function detectSilentlyBakedArgs(
  strategy: Record<string, unknown>,
  capturedUrl: string,
  capturedBody: string,
  declaredArgs: Record<string, unknown> | undefined,
): string[] {
  if (!declaredArgs) return [];
  const serialized = JSON.stringify(strategy);
  const wire = `${capturedUrl}\n${capturedBody}`;
  const baked: string[] = [];
  for (const [argName, argVal] of Object.entries(declaredArgs)) {
    if (typeof argVal !== 'string' || argVal.length < 3) continue;
    if (serialized.includes(`{{${argName}}}`)) continue; // templated — fine
    if (wireEncodingVariants(argVal).some((v) => wire.includes(v))) baked.push(argName);
  }
  return baked;
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

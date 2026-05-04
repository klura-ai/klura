// Per-session memory of binary-WS starters emitted by inspect_ws_frame. Used by
// tryGenerator to detect when an agent inspected a frame, got a runnable
// iteration-1 starter back, and then wrote their own generator from scratch
// instead of using it. That's a costly skip — the starter returns ok:true on
// iteration 1 for the captured-args case, which confirms envelope shape in one
// round. When the agent ignores it, the runtime emits a `runtime_hint` on the
// try_generator response nudging them to use the starter first.
//
// Module-level state because the cache is short-lived (cleared on endDrive)
// and there is exactly one process-local instance per Node runtime. Keeping it
// on the Pool would force every Pool implementation (local + docker) to ship
// the same plumbing for a detection-only signal that has no remote-side
// dependency.

import type { InspectStarter } from './ws-frame-starter';

interface StarterEntry {
  ws_i: number;
  literal: string;
  /** First 64 chars of the captured payload's base64 — enough to
   *  fingerprint references in submitted try_generator code without
   *  storing the entire payload. */
  base64_head: string;
}

const STARTERS_PER_SESSION_CAP = 8;
const _starters = new Map<string, StarterEntry[]>();

export function recordStarterIssued(
  sessionId: string,
  wsI: number,
  literal: string,
  starter: InspectStarter,
): void {
  if (!sessionId) return;
  // Pull the captured-base64 head out of the starter code. The synthesised code
  // begins with `const captured = Buffer.from('<base64>', 'base64');` — match
  // the literal so we can fingerprint references without re- computing the
  // base64 here.
  const m = /Buffer\.from\('([A-Za-z0-9+/=]+)'/.exec(starter.code);
  if (!m || typeof m[1] !== 'string') return;
  const head = m[1].slice(0, 64);

  let buf = _starters.get(sessionId);
  if (!buf) {
    buf = [];
    _starters.set(sessionId, buf);
  }
  // Replace any prior entry for the same ws_i (re-inspection updates the cached
  // starter rather than accumulating duplicates).
  const idx = buf.findIndex((e) => e.ws_i === wsI);
  if (idx >= 0) buf.splice(idx, 1);
  buf.push({ ws_i: wsI, literal, base64_head: head });
  if (buf.length > STARTERS_PER_SESSION_CAP) {
    buf.splice(0, buf.length - STARTERS_PER_SESSION_CAP);
  }
}

/** Look up a previously-issued starter for this session + ws_i. Returns
 * null when no starter was issued (the gate didn't match, or
 *  inspect_ws_frame was not called with text_contains for this frame). */
export function findIssuedStarter(sessionId: string, wsI: number): StarterEntry | null {
  if (!sessionId) return null;
  const buf = _starters.get(sessionId);
  if (!buf) return null;
  return buf.find((e) => e.ws_i === wsI) ?? null;
}

/** True when the submitted try_generator code references the starter — by
 * embedding its base64 head, or by clearly being the splice shape. The check is
 * best-effort; false positives (agent wrote their own splice matching the
 * prefix) are acceptable, false negatives (agent wrote
 *  their own envelope from scratch) are exactly what we want to flag. */
export function codeReferencesStarter(code: string, entry: StarterEntry): boolean {
  if (!code) return false;
  if (entry.base64_head.length >= 32 && code.includes(entry.base64_head.slice(0, 32))) {
    return true;
  }
  return false;
}

export function clearStartersForSession(sessionId: string): void {
  _starters.delete(sessionId);
}

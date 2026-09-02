// Save-warning detector: a REQUIRED caller param that carries no `example`.
//
// `example` is the only place a caller who did not author the strategy learns
// what shape a param takes. Without one, an opaque id, a slug, a cursor or a
// URL param is a guess — and the runtime feels it too: post-save verification
// resolves its args from session-declared args falling back to
// `notes.params.*.example`, so a required param with neither leaves the
// strategy unverified. It lands on disk having never been executed once.
//
// That combination is what a corpus sweep on 2026-08-03 surfaced: capabilities
// saved, listed, stamped, and callable by nobody except their author.
//
// Ackable rather than a hard rejection, because one legitimate exception is
// structural: a credential param must NOT carry an example. Writing a real
// password into `notes.params.password.example` would persist it to disk in
// plaintext, which is the opposite of what the secret store exists for. The
// ack channel lets that case through with the reason stated, and forces every
// other case to supply the value the agent already has in hand.
//
// Crisp by construction: reads declared param records, checks two declared
// booleans (`optional`) and the presence of one declared key (`example`). No
// prose matching, no inference about what the param means.

import type { Strategy } from '../strategies/skills';
import type { SaveWarning } from './save-warnings';
import { WARNING_KINDS } from '../vocab';

interface ParamRecord {
  example?: unknown;
  optional?: unknown;
}

/** A param is exempt when the caller may omit it — the unsatisfied-placeholder
 *  check skips optional params too, so an absent example costs nothing there. */
function isOptional(record: ParamRecord): boolean {
  return record.optional === true;
}

function hasExample(record: ParamRecord): boolean {
  // `null` and `false` are legitimate example values; only absence counts.
  return 'example' in record && record.example !== undefined;
}

export function detectRequiredParamsWithoutExample(data: Strategy): SaveWarning[] {
  const notes = (data as { notes?: { params?: unknown } }).notes;
  const params = notes?.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return [];

  const missing: string[] = [];
  for (const [name, value] of Object.entries(params as Record<string, unknown>)) {
    // A bare string param declaration is a description shorthand with no
    // example slot at all — same gap, same consequence.
    if (typeof value === 'string') {
      missing.push(name);
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as ParamRecord;
    if (isOptional(record)) continue;
    if (!hasExample(record)) missing.push(name);
  }
  if (missing.length === 0) return [];

  const plural = missing.length > 1;
  const list = missing.map((n) => `notes.params.${n}.example`).join(', ');
  return [
    {
      kind: WARNING_KINDS.requiredParamWithoutExample,
      message:
        `${missing.length} required param${plural ? 's' : ''} carry no example: ${list}. ` +
        `That is the only place a caller who did not author this strategy learns the shape to ` +
        `pass, and post-save verification falls back to these values when the session declares ` +
        `no args — so a required param with neither leaves the capability saved but never ` +
        `executed once.`,
      hint:
        `Add the value you just drove with as \`example\` on each — you have a working one in ` +
        `hand. The one case that should NOT get an example is a credential: writing a real ` +
        `password into notes.params would persist it to disk in plaintext. Ack with that reason ` +
        `if it applies: acks / notes.save_warnings_acked ` +
        `[{kind: "${WARNING_KINDS.requiredParamWithoutExample}", reason: "<why>"}].`,
    },
  ];
}

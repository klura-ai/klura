// Detector: js-eval prereq declares `binds: "<name>"` but `{{<name>}}`
// is not referenced anywhere else on the strategy. Catches the
// "envelope-and-prereq-do-different-things" shape: agent stuffs the real
// fetch + parse into the prereq's expression, runtime then fires the
// declared HTTP envelope on top with no body that mentions the binding,
// caller receives the dead envelope's response instead of the prereq's
// return value. This shape silently corrupts warm execute on every save
// where it slips through.
//
// Sibling shape catalog: dropping the dead envelope and using
// `frameFromPage.expression` makes the prereq's return value the caller's
// result. Or referencing `{{<binds>}}` in body / endpoint / a sibling
// prereq feeds the binding into the request. The ack path covers
// legitimate side-effect-only bindings (e.g. a refresh that the agent
// wants to fire pre-call but whose value warm callers don't read), since
// `js-eval` always returns a value but the value isn't always consumed.

import type { Strategy } from '../strategies/skills';
import type { SaveWarning } from './save-warnings';

export function detectUnreferencedPrereqBinding(data: Strategy): SaveWarning[] {
  const obj = data as Record<string, unknown>;
  const tier = typeof obj.strategy === 'string' ? obj.strategy : '';
  if (tier !== 'fetch' && tier !== 'page-script') return [];
  const prereqs = obj.prerequisites;
  if (!Array.isArray(prereqs) || prereqs.length === 0) return [];

  const out: SaveWarning[] = [];
  for (let i = 0; i < prereqs.length; i += 1) {
    const p: unknown = prereqs[i];
    if (!p || typeof p !== 'object') continue;
    const kind = (p as { kind?: unknown }).kind;
    if (kind !== 'js-eval') continue;
    const binds = (p as { binds?: unknown }).binds;
    if (typeof binds !== 'string' || binds.length === 0) continue;

    // Search corpus = the strategy minus this prereq, serialized. Template
    // engine accepts `{{name}}` with optional inner whitespace. Escape
    // regex meta in the name (the schema allows alphanumeric + underscore
    // for binds names, so escaping is defensive against future schema
    // widening).
    const trimmedPrereqs = (prereqs as unknown[]).filter((_, j) => j !== i);
    const corpus = JSON.stringify({ ...obj, prerequisites: trimmedPrereqs });
    const escaped = binds.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\{\\{\\s*${escaped}\\s*\\}\\}`);
    if (re.test(corpus)) continue;

    out.push({
      kind: 'unreferenced_prereq_binding',
      message:
        `prerequisites[${i}] (kind: js-eval) declares binds: "${binds}" but {{${binds}}} ` +
        `is not referenced anywhere in the strategy envelope (endpoint / baseUrl / body / ` +
        `headers / params / frameFromPage.expression / sibling prereq fields). The prereq ` +
        `runs and produces a value that the runtime never reads — either the prereq is doing ` +
        `the real work via side effects (the fetch + parse happens inside the expression) and ` +
        `the declared HTTP envelope is dead, or the binding name is misspelled at the call ` +
        `site. Both shapes silently corrupt warm execute: the caller receives whatever the ` +
        `dead envelope returns, not the prereq's value.`,
      hint:
        `Pick one: (a) reference {{${binds}}} in body / endpoint / headers / a sibling ` +
        `prereq's args_template / fetch_body if the binding should feed into the request; ` +
        `(b) drop the dead HTTP envelope (clear endpoint/method/body/headers) and move the ` +
        `prereq's logic into a top-level frameFromPage.expression so the return value IS the ` +
        `caller's result; (c) ack via notes.save_warnings_acked: [{kind: "unreferenced_prereq_binding", ` +
        `reason: "<one sentence — e.g. binding intentionally drives a refresh-only side effect, ` +
        `the value isn't consumed by warm callers>"}] when the binding genuinely has no ` +
        `consumer but the prereq must still run. See klura://reference#save-strategy-audit.`,
      context: { prereq_index: i, binds_name: binds },
    });
  }
  return out;
}

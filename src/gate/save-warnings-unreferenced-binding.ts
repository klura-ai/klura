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
import { escapeRegExp } from '../utils/regex';
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
    const prereqName = (p as { name?: unknown }).name;

    // A prereq's "bindings" are the names it injects into the template scope:
    // `binds` (single name) for js-eval, the `vars` map keys for capability /
    // fetch-extract / page-extract. A capability prereq with NO vars is
    // side-effect-only (e.g. an auth login leaving a cookie) — legitimate, never
    // flagged. Any other kind, or a prereq with no bindings, is out of scope.
    let bindingNames: string[];
    if (kind === 'js-eval') {
      const binds = (p as { binds?: unknown }).binds;
      bindingNames = typeof binds === 'string' && binds.length > 0 ? [binds] : [];
    } else if (kind === 'capability' || kind === 'fetch-extract' || kind === 'page-extract') {
      const vars = (p as { vars?: unknown }).vars;
      bindingNames =
        vars && typeof vars === 'object' && !Array.isArray(vars) ? Object.keys(vars) : [];
    } else {
      bindingNames = [];
    }
    if (bindingNames.length === 0) continue;

    // `response.from` makes a prereq's value the strategy's return value (no
    // templating). The response validator (strategies/validate/response.ts)
    // accepts `from === binds ?? name`, so skip the warning on the SAME axis:
    // either the prereq's name OR one of its binding names. Matching only the
    // name (the old behavior) false-flagged the legitimate binds-renamed shape
    // (`binds:"result"`, `response.from:"result"`, name="submit_req").
    const responseFrom = (obj.response as { from?: unknown } | null | undefined)?.from;
    if (
      typeof responseFrom === 'string' &&
      ((typeof prereqName === 'string' && responseFrom === prereqName) ||
        bindingNames.includes(responseFrom))
    ) {
      continue;
    }

    // Search corpus = the strategy minus this prereq, serialized. Template
    // engine accepts `{{name}}` with optional inner whitespace. Escape
    // regex meta in each name (the schema allows alphanumeric + underscore, so
    // escaping is defensive against future schema widening). The prereq's
    // output is "consumed" if ANY of its binding names is referenced.
    const trimmedPrereqs = (prereqs as unknown[]).filter((_, j) => j !== i);
    const corpus = JSON.stringify({ ...obj, prerequisites: trimmedPrereqs });
    const anyReferenced = bindingNames.some((name) =>
      new RegExp(`\\{\\{\\s*${escapeRegExp(name)}\\s*\\}\\}`).test(corpus),
    );
    if (anyReferenced) continue;

    const namesLabel = bindingNames.map((n) => `{{${n}}}`).join(', ');
    const bindDesc =
      kind === 'js-eval'
        ? `declares binds: "${bindingNames[0]}"`
        : `declares vars [${bindingNames.join(', ')}]`;
    out.push({
      kind: 'unreferenced_prereq_binding',
      message:
        `prerequisites[${i}] (kind: ${String(kind)}) ${bindDesc} but ${namesLabel} ` +
        `is not referenced anywhere in the strategy envelope (endpoint / baseUrl / body / ` +
        `headers / params / frameFromPage.expression / sibling prereq fields). The prereq ` +
        `runs and produces a value that the runtime never reads — either the prereq is doing ` +
        `the real work via side effects and the declared HTTP envelope is dead, or the binding ` +
        `name is misspelled at the call site. Both shapes silently corrupt warm execute: the ` +
        `caller receives whatever the dead envelope returns, not the prereq's value.`,
      hint:
        `Pick one: (a) reference ${namesLabel} in body / endpoint / headers / a sibling ` +
        `prereq's args if the binding should feed into the request; ` +
        `(b) set response.from: "${typeof prereqName === 'string' ? prereqName : '<prereq.name>'}" ` +
        `(the prereq's \`name\` field) if the prereq's return value IS the strategy result — the ` +
        `strategy then skips its HTTP fire and returns the prereq's bound value directly; ` +
        `(c) for a capability prereq that should run purely for its side effect (auth/refresh), ` +
        `drop \`vars\` entirely so it's declared side-effect-only; ` +
        `(d) ack via notes.save_warnings_acked: [{kind: "unreferenced_prereq_binding", ` +
        `reason: "<one sentence>"}] when the binding genuinely has no consumer but must still run.`,
      context: { prereq_index: i, binds_name: bindingNames.join(',') },
    });
  }
  return out;
}

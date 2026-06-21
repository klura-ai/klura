// Save-warning detector: a top-level `params` key that no token references.
//
// `params` is documented as "template defaults / static params" — its entries
// are merged into the substitution scope and substituted into `{{key}}` / `:key`
// tokens in endpoint / baseUrl / body / headers. A key that NO token references
// is silently dropped at execute time (it is NOT auto-appended as a query
// string), so the value never reaches the server. The recurring failure: the
// agent saves a templated shape expecting `params` to be sent, gets a 400, and
// loses the strategy to the archive. Surfacing this at save time turns a
// silent execute-time drop into a one-retry fix.

import type { Strategy } from '../strategies/skills';
import { escapeRegExp } from '../utils/regex';
import type { SaveWarning } from './save-warnings';

export function detectUnreferencedParams(data: Strategy): SaveWarning[] {
  const obj = data as Record<string, unknown>;
  const params = obj.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return [];
  const keys = Object.keys(params as Record<string, unknown>);
  if (keys.length === 0) return [];

  // Corpus = every place a `{{key}}` / `:key` token can legitimately appear.
  const parts: string[] = [];
  for (const field of ['endpoint', 'baseUrl'] as const) {
    const v = obj[field];
    if (typeof v === 'string') parts.push(v);
  }
  for (const field of ['body', 'headers'] as const) {
    const v = obj[field];
    if (v && typeof v === 'object') {
      try {
        parts.push(JSON.stringify(v));
      } catch {
        /* unserializable — skip */
      }
    }
  }
  const corpus = parts.join('\n');

  const unreferenced = keys.filter((k) => {
    const esc = escapeRegExp(k);
    const templ = new RegExp(`\\{\\{\\s*${esc}\\s*\\}\\}`);
    const rest = new RegExp(`:${esc}(?![A-Za-z0-9_])`);
    return !templ.test(corpus) && !rest.test(corpus);
  });
  if (unreferenced.length === 0) return [];

  const first = unreferenced[0] as string;
  const plural = unreferenced.length > 1;
  return [
    {
      kind: 'params_key_unreferenced',
      message:
        `top-level \`params\` ${plural ? 'keys' : 'key'} [${unreferenced.join(', ')}] ` +
        `${plural ? 'are' : 'is'} not referenced by any \`{{key}}\` or \`:key\` token in ` +
        `endpoint / baseUrl / body / headers. \`params\` are template DEFAULTS substituted INTO ` +
        `tokens — a key no token references is silently DROPPED at execute time (it is NOT ` +
        `auto-appended as a query string), so the value never reaches the server.`,
      hint:
        `Pick one: (a) reference it — e.g. add \`?${first}={{${first}}}\` to the endpoint query, ` +
        `or use \`{{${first}}}\` in body / a header; (b) if the endpoint already encodes this ` +
        `constant, drop it from \`params\`; (c) if it's a real caller arg, declare it under ` +
        `\`notes.params\` and template it. \`params\` never auto-append to the query string.`,
    },
  ];
}

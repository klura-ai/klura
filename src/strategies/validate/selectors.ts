// Cross-field validators that tie selectors, headers, and placeholder names
// together.
//
// - Selector-self-reference: prereq selector that embeds the same hardcoded
//   literal already baked into endpoint/wsUrl.
// - Synthesized auth headers: agent reaching for a {{__gen.X}} generator to
//   produce a server-issued token.
// - Placeholder references: every {{X}} must be declared for the context in
//   which it appears.

import type { Strategy } from '../skills';
import {
  collectDeclaredPlaceholders,
  collectPlaceholderUses,
  isPlaceholderDeclared,
  listAvailablePlaceholders,
} from '../placeholder-semantics';

// Opaque-id regex bank — locates a candidate literal inside a selector string
// so the self-reference check has something concrete to compare against the
// endpoint/wsUrl. Scope is narrow on purpose: the self-reference validator only
// fires when the SAME literal also appears in endpoint/wsUrl, so a too-loose
// match still wouldn't produce a false positive unless that literal is
// duplicated across fields by the agent's own hand.
const OPAQUE_ID_PATTERNS: Array<[RegExp, string]> = [
  [/\b\d{10,}\b/g, '10+ digit numeric id'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, 'UUID'],
  [/\b[0-9a-f]{24,}\b/gi, 'hex blob (ObjectId / SHA / content hash)'],
  [
    /\b(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}\b/g,
    'base64-shaped opaque blob ≥20 chars',
  ],
];

function findFirstOpaqueIdLike(s: string): { match: string; label: string } | null {
  if (typeof s !== 'string' || s.length === 0) return null;
  for (const [re, label] of OPAQUE_ID_PATTERNS) {
    const one = new RegExp(re.source, re.flags.replace('g', ''));
    const m = one.exec(s);
    if (m && typeof m[0] === 'string') return { match: m[0], label };
  }
  return null;
}

const AUTH_HEADER_MARKERS = [
  'nonce',
  'csrf',
  'xsrf',
  'csrftoken',
  'fetchnonce',
  'fetchtoken',
  'authtoken',
  'accesstoken',
  'sessiontoken',
  'bearer',
  'signature',
] as const;

function looksLikeAuthHeaderName(headerName: string): boolean {
  const normalized = headerName.toLowerCase().replaceAll('-', '').replaceAll('_', '');
  return normalized === 'authorization' || AUTH_HEADER_MARKERS.some((m) => normalized.includes(m));
}

const GEN_PLACEHOLDER_RE = /\{\{__gen\.[^}]+\}\}/;

/**
 * Selector-self-reference detector. Rejects the cover-story prereq pattern
 * where a `page-extract` selector embeds the same hardcoded id that already
 * appears in `endpoint` or `wsUrl` — the prereq pretends to dynamically extract
 * a value but only ever matches when the value is already there, defeating the
 * point of having the prereq at all.
 *
 * Narrow check: fires only when an opaque-id-shaped literal appears in a
 * prereq selector AND in endpoint/wsUrl at the same time — the relationship
 * between the two fields is the failure mode, not either literal on its own.
 */
export function validateNoSelectorSelfReference(data: Strategy): void {
  const obj = data as Record<string, unknown>;
  const endpointLikeFields: string[] = [];
  if (typeof obj.endpoint === 'string') endpointLikeFields.push(obj.endpoint);
  if (typeof obj.wsUrl === 'string') endpointLikeFields.push(obj.wsUrl);
  if (endpointLikeFields.length === 0) return;

  const prereqs = obj.prerequisites;
  if (!Array.isArray(prereqs)) return;
  prereqs.forEach((p, idx) => {
    if (!p || typeof p !== 'object') return;
    const vars = (p as Record<string, unknown>).vars;
    if (!vars || typeof vars !== 'object') return;
    for (const [vname, ventry] of Object.entries(vars as Record<string, unknown>)) {
      if (!ventry || typeof ventry !== 'object') continue;
      const sel = (ventry as Record<string, unknown>).selector;
      if (typeof sel !== 'string') continue;
      const found = findFirstOpaqueIdLike(sel);
      if (!found) continue;
      for (const ep of endpointLikeFields) {
        if (ep.includes(found.match)) {
          throw new Error(
            `invalid_strategy: prerequisites[${idx}].vars.${vname}.selector embeds the literal "${found.match}" that also appears in the strategy's endpoint/wsUrl. That is a self-referential probe — it only matches on the page where the id is already hardcoded, which defeats the purpose of page-extract. Either extract the id from a structural source (regex-capture from the URL, page global like __INITIAL_STATE__.<x>, or a JSON-shaped <script type="application/json">), or remove the prereq and document the strategy as single-entity-scoped via notes.params.<slug>.example.`,
          );
        }
      }
    }
  });
}

export function validateNoSynthesizedAuthHeaders(data: Strategy): void {
  const sources: Array<{ label: string; headers: Record<string, unknown> }> = [];
  const headers = (data as { headers?: Record<string, unknown> }).headers;
  if (headers && typeof headers === 'object') sources.push({ label: 'header', headers });
  const wsHeaders = (data as { wsHeaders?: Record<string, unknown> }).wsHeaders;
  if (wsHeaders && typeof wsHeaders === 'object') {
    sources.push({ label: 'wsHeaders entry', headers: wsHeaders });
  }
  if (sources.length === 0) return;

  for (const { label, headers: hs } of sources) {
    for (const [headerName, headerValue] of Object.entries(hs)) {
      if (typeof headerValue !== 'string') continue;
      if (!GEN_PLACEHOLDER_RE.test(headerValue)) continue;
      if (!looksLikeAuthHeaderName(headerName)) continue;
      throw new Error(
        `invalid_strategy: ${label} "${headerName}" is set from a {{__gen.X}} generator (${headerValue}) — ` +
          `but its name looks like a server-issued auth token. ` +
          `Server tokens like CSRF nonces, session signatures, and bearer tokens CANNOT be synthesized client-side ` +
          `because the server validates them against state it issued. Use a page-extract prerequisite instead: ` +
          `\`{kind: "page-extract", url: "<page that contains the token>", vars: {tokenName: {selector: "...", attr: "..."}}}\` ` +
          `and reference it via \`{{tokenName}}\` in the header. See REFERENCE.md "prerequisites" section.`,
      );
    }
  }
}

/**
 * Validate every `{{X}}` placeholder against the set of names the strategy
 * actually declares *for the field that is trying to resolve it*. The same
 * placeholder can be valid in one surface and invalid in another:
 * `{{__gen.req_id}}` is fine in HTTP headers/body after generator resolution,
 * but invalid in prereq URLs, ws frames, or frameFromPage expressions where the
 * executor never threads `__gen` into scope.
 */
export function validatePlaceholderReferences(data: Strategy): void {
  const declared = collectDeclaredPlaceholders(data);
  const used = collectPlaceholderUses(data);

  for (const use of used) {
    if (isPlaceholderDeclared(use.ref, declared, use.context)) continue;

    const available = listAvailablePlaceholders(declared, use.context);
    const availableList = available.length > 0 ? available.join(', ') : '(none declared)';
    let contextHint = 'This field resolves caller args and prereq outputs only.';
    if (use.context.allowGeneratedNames) {
      contextHint =
        'This field resolves caller args / prereq outputs plus {{__gen.<key>}} after generators run.';
    } else if (use.context.allowInterruptProducedNames) {
      contextHint =
        'This field resolves caller args, prereq outputs, and interrupt handler binds values.';
    }

    throw new Error(
      `invalid_strategy: placeholder {{${use.ref}}} at ${use.path} is not declared anywhere this field can resolve. ` +
        `Available placeholders: ${availableList}. ` +
        `${contextHint} ` +
        `The runtime will NOT resolve anything else — unresolved placeholders stay literal in the request ` +
        `and break the API call. Common mistake: writing \`{{__prereq.X}}\` instead of \`{{X}}\` — ` +
        `prereq-extracted values go directly into the args namespace with no prefix.`,
    );
  }
}

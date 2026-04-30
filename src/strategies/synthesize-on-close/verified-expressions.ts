// Auto-synth pass that templates rotating header / body values out of
// captured requests using the session's saved verified_expressions.
//
// Background. close_session's auto-synth fallback used to dump captured
// HTTP headers verbatim. For sites that gate writes on rotating tokens
// (short-TTL JWTs, sentinel proof tokens, anti-bot headers), every saved
// strategy was broken before warm execute fired — the literal headers
// were stale by the time anything tried to replay them.
//
// During LIFT the agent verifies expressions that re-derive those tokens
// from the live page (`save_verified_expression`). Each VE carries an
// `expression` string and a `returns` shape (`'string'` | `'object'` |
// `'hex'` | `'base64'`). This pass re-evaluates each VE against the still-
// alive page and matches the result back into the captured request,
// turning literal header values into `{{prereq_name}}` placeholders
// backed by js-eval prereqs.
//
// Match semantics:
//   - String-returning VE: scan headers + body for an exact substring of
//     the eval result. Templating preserves any prefix (e.g. `Bearer ` in
//     Authorization) and replaces only the matched substring.
//   - Object-returning VE: walk top-level string properties and treat each
//     as an independent string match against headers + body. All matches
//     for one VE share a single js-eval prereq with a `return_shape` that
//     enumerates the properties used; placeholders are `{{name.<field>}}`.
//
// Best-effort throughout: if eval throws, the VE is skipped. If no header /
// body location matches the result, no template change is made.

import type { BrowserDriver } from '../../drivers/interface';
import type { Session } from '../../drivers/types/session';

export interface VerifiedExpressionEntry {
  expression: string;
  binds_args: string[];
  returns: 'hex' | 'base64' | 'string' | 'object';
  sample_byte_length?: number;
  notes?: string;
  tested_at: string;
}

export interface EvaluatedVE {
  /** The VE the agent saved during LIFT. */
  ve: VerifiedExpressionEntry;
  /** Raw result of re-evaluating `ve.expression` at synth time. */
  result: unknown;
  /** For string-returning VEs, the result coerced to string. Empty for
   *  object/hex/base64 returns. */
  resultString: string | null;
  /** For object-returning VEs, the top-level string properties (key →
   *  string-coerced value). Empty for string returns. */
  objectFields: Map<string, string>;
}

/** Re-evaluate every verified_expression bucketed under this capability
 *  against the live page, in order, returning the structured results.
 *  Failures are logged via the supplied diag callback and the offending
 *  VE is dropped from the result. */
export async function evaluateVerifiedExpressions(
  driver: BrowserDriver,
  session: Session,
  capability: string,
  onError: (msg: string) => void,
): Promise<EvaluatedVE[]> {
  const acc = session.artifactAccumulator;
  if (!acc) return [];
  const ves = acc.verifiedExpressions[capability] ?? [];
  if (ves.length === 0) return [];

  const out: EvaluatedVE[] = [];
  for (const ve of ves) {
    let result: unknown;
    try {
      result = await driver.evaluateExpression(session, ve.expression, {
        timeoutMs: 5000,
      });
    } catch (err) {
      onError(
        `verified_expression eval failed at synth time (capability="${capability}"): ` +
          (err instanceof Error ? err.message : String(err)),
      );
      continue;
    }
    out.push(buildEvaluatedVE(ve, result));
  }
  return out;
}

function buildEvaluatedVE(ve: VerifiedExpressionEntry, result: unknown): EvaluatedVE {
  if (ve.returns === 'string' && typeof result === 'string') {
    return { ve, result, resultString: result, objectFields: new Map() };
  }
  if (ve.returns === 'object' && result && typeof result === 'object') {
    const fields = new Map<string, string>();
    for (const [k, v] of Object.entries(result as Record<string, unknown>)) {
      if (typeof v === 'string' && v.length > 0) fields.set(k, v);
    }
    return { ve, result, resultString: null, objectFields: fields };
  }
  // hex / base64 / coerce-mismatched returns. We don't try to template
  // those automatically — bytes-shaped results don't land verbatim in
  // headers, and a mismatched return shape (saved as 'string' but eval
  // returned an object) is precisely the kind of contract drift we don't
  // want to paper over.
  return { ve, result, resultString: null, objectFields: new Map() };
}

export interface TemplateMatch {
  /** The header name (case-preserved from input) the placeholder lands in,
   *  or null when the match is in the request body. */
  headerName: string | null;
  /** The literal substring that got replaced. */
  literal: string;
  /** The placeholder name used in `{{...}}`. For string VEs this is the
   *  bare placeholder; for object VEs it's `<prereq_name>.<field>`. */
  placeholder: string;
}

export interface TemplatedRequest {
  /** Updated headers map with placeholders substituted. */
  headers: Record<string, string>;
  /** Updated body string with placeholders substituted. May be null when
   *  the original request had no body. */
  body: string | null;
  /** js-eval prereq array to attach to the saved strategy. Empty when no
   *  VE matched anything. */
  prerequisites: JsEvalPrereqShape[];
  /** Per-match record for diagnostics and tests. */
  matches: TemplateMatch[];
}

export interface JsEvalPrereqShape {
  name: string;
  kind: 'js-eval';
  url: string;
  expression: string;
  binds: string;
  /** Validator-shaped: `{kind: "string"}` for scalar returns;
   *  `{kind: "object", required_keys: [...]}` for object returns. The bare
   *  `"string"` form the validator rejects with "must be a plain object". */
  return_shape: { kind: 'string' } | { kind: 'object'; required_keys: string[] };
}

/** Template literal occurrences of evaluated VE results in the captured
 *  headers + body. Returns the rewritten request along with a js-eval
 *  prereq for every VE that matched something. */
export function templateRequestFromVEs(
  evaluated: EvaluatedVE[],
  rawHeaders: Record<string, string>,
  rawBody: string | null,
  origin: string,
): TemplatedRequest {
  const headers: Record<string, string> = { ...rawHeaders };
  let body: string | null = rawBody;
  const prerequisites: JsEvalPrereqShape[] = [];
  const matches: TemplateMatch[] = [];

  // Per-name counter so two VEs whose first match lands on a header named
  // similarly don't collide on placeholder name.
  const usedNames = new Set<string>();

  for (const ev of evaluated) {
    if (ev.resultString) {
      const literal = ev.resultString;
      const headerHit = findFirstHeaderContaining(headers, literal);
      const bodyHit = body !== null && body.includes(literal);
      if (!headerHit && !bodyHit) continue;

      const baseName = headerHit
        ? placeholderNameFromHeader(headerHit, usedNames)
        : uniqueName('body_value', usedNames);
      const placeholder = baseName;
      usedNames.add(baseName);

      // Replace EVERY occurrence across headers + body, not just the first
      // hit. Same rotating value often shows up in multiple headers.
      for (const [hname, hval] of Object.entries(headers)) {
        if (hval.includes(literal)) {
          headers[hname] = hval.split(literal).join(`{{${placeholder}}}`);
          matches.push({ headerName: hname, literal, placeholder });
        }
      }
      if (body !== null && body.includes(literal)) {
        body = body.split(literal).join(`{{${placeholder}}}`);
        matches.push({ headerName: null, literal, placeholder });
      }

      prerequisites.push({
        name: placeholder,
        kind: 'js-eval',
        url: origin,
        expression: ev.ve.expression,
        binds: placeholder,
        return_shape: { kind: 'string' },
      });
      continue;
    }

    if (ev.objectFields.size > 0) {
      // Walk the object's string fields. Track which fields actually match
      // something — the prereq's `return_shape` only enumerates fields we
      // actually use.
      const matchedFields = new Map<string, string>(); // field → literal
      const stagedReplacements: Array<{
        field: string;
        literal: string;
        placeholderField: string;
      }> = [];

      const baseName = uniqueName(suggestObjectName(ev), usedNames);

      for (const [field, literal] of ev.objectFields) {
        const headerHit = findFirstHeaderContaining(headers, literal);
        const bodyHit = body !== null && body.includes(literal);
        if (!headerHit && !bodyHit) continue;
        matchedFields.set(field, literal);
        stagedReplacements.push({
          field,
          literal,
          placeholderField: `${baseName}.${field}`,
        });
      }
      if (matchedFields.size === 0) continue;
      usedNames.add(baseName);

      for (const repl of stagedReplacements) {
        const tag = `{{${repl.placeholderField}}}`;
        for (const [hname, hval] of Object.entries(headers)) {
          if (hval.includes(repl.literal)) {
            headers[hname] = hval.split(repl.literal).join(tag);
            matches.push({
              headerName: hname,
              literal: repl.literal,
              placeholder: repl.placeholderField,
            });
          }
        }
        if (body !== null && body.includes(repl.literal)) {
          body = body.split(repl.literal).join(tag);
          matches.push({
            headerName: null,
            literal: repl.literal,
            placeholder: repl.placeholderField,
          });
        }
      }

      prerequisites.push({
        name: baseName,
        kind: 'js-eval',
        url: origin,
        expression: ev.ve.expression,
        binds: baseName,
        return_shape: {
          kind: 'object',
          required_keys: Array.from(matchedFields.keys()),
        },
      });
    }
  }

  return { headers, body, prerequisites, matches };
}

function findFirstHeaderContaining(
  headers: Record<string, string>,
  literal: string,
): string | null {
  for (const [k, v] of Object.entries(headers)) {
    if (v.includes(literal)) return k;
  }
  return null;
}

/** Snake-case derivation that strips common HTTP-header noise prefixes
 *  (`x-`, `oai-`, `openai-`) so the placeholder reads naturally in the
 *  saved strategy. Caller-provided usedNames set guarantees uniqueness
 *  via numeric suffix. */
export function placeholderNameFromHeader(headerName: string, used: Set<string>): string {
  let base = headerName.toLowerCase();
  base = base.replace(/^x-/, '');
  /* eslint-disable sonarjs/slow-regex */
  base = base
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+/, '')
    .replace(/_+$/, '');
  /* eslint-enable sonarjs/slow-regex */
  if (!base) base = 'header_value';
  return uniqueName(base, used);
}

function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}_${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return base;
}

/** Pick a structured prereq name for an object-returning VE. Without a
 *  specific anchor we use a generic `prereq_object` token plus a numeric
 *  suffix, since the placeholder is never user-visible at execute time —
 *  it's an internal binding name. */
function suggestObjectName(_ev: EvaluatedVE): string {
  return 'prereq_object';
}

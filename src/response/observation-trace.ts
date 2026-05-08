// Observation-trace — per-session set of strings the agent has been shown
// during this session via tool responses. Used at save time to distinguish
// "property name the agent observed at runtime" (fragile — rotates next
// deploy) from "property name from a stable web API contract" (safe).
//
// The runtime is the source of every observation: every tool response it
// emits is data the agent might later bake into a saved expression. By
// recording string values from those responses into a per-session set, the
// save-time gate can crisply check whether a baked property-access key
// came from observation or from contract knowledge.
//
// Per `runtime/docs/principles.md` §"Crisp vs fuzzy": this is membership
// against a session-collected set — no language/locale assumptions, no
// keyword bank against arbitrary text. The narrow exception is
// `STABLE_API_NAMES`, a small finite allowlist of well-known DOM/JS API
// property names that should never count as observations even when they
// happen to appear in a tool response.
//
// Listed in the heuristics-exceptions table at runtime/docs/principles.md
// §"Delegate to the LLM, but allow narrowly-scoped runtime heuristics."

import type { Session } from '../drivers/types/session';

/**
 * Per-session cap on the observed-strings set. LRU-evicted on overflow.
 * Bounded so a long discovery session on a chatty site can't grow the
 * Set without limit. Picked to comfortably hold every distinct property
 * name a normal discovery flow surfaces (Object.keys runs, form input
 * names, response field keys) without retaining noise like long body
 * substrings — the recursive extractor's MIN_LENGTH cap below already
 * filters those.
 */
const OBSERVED_STRINGS_CAP = 5000;

/**
 * Length bounds for recorded strings. The lower bound is 1 (single-char
 * keys are exactly the canonical minified-property case — `o`, `a`, `b`
 * — that the gate is designed to catch). The upper bound filters out
 * body/DOM content too long to be a property name.
 */
const MIN_OBSERVED_STRING_LENGTH = 1;
const MAX_OBSERVED_STRING_LENGTH = 80;

/**
 * Recursion depth cap for the string extractor. Prevents stack-blowup on
 * pathological cyclic objects. Most observation results are flat or 2-3
 * levels deep.
 */
const MAX_RECURSION_DEPTH = 6;

/**
 * Stable JS / DOM property names that should never count as fragile even
 * when they happen to appear in observation results. Small finite list,
 * auditable. Anything outside this set + observed in this session is
 * flagged at save time.
 *
 * Convention: only names whose semantics are guaranteed by published web
 * standards (ECMAScript, WHATWG, W3C) — not site- or framework-specific.
 */
export const STABLE_API_NAMES = new Set<string>([
  // Object / Array / String generic
  'length',
  'constructor',
  'prototype',
  'name',
  'toString',
  'valueOf',
  // Document / Window / Navigator
  'document',
  'window',
  'navigator',
  'location',
  'history',
  'screen',
  'self',
  'top',
  'parent',
  'localStorage',
  'sessionStorage',
  'crypto',
  'performance',
  'console',
  'JSON',
  'Math',
  'Object',
  'Array',
  'String',
  'Number',
  'Boolean',
  'Date',
  'Promise',
  'fetch',
  // Document / Element common
  'body',
  'head',
  'documentElement',
  'querySelector',
  'querySelectorAll',
  'getElementById',
  'getElementsByClassName',
  'getElementsByTagName',
  'cookie',
  'title',
  'URL',
  'baseURI',
  'innerHTML',
  'outerHTML',
  'innerText',
  'outerText',
  'textContent',
  'children',
  'childNodes',
  'parentNode',
  'parentElement',
  'firstChild',
  'lastChild',
  'nextSibling',
  'previousSibling',
  'attributes',
  'classList',
  'className',
  'id',
  'tagName',
  'nodeName',
  'nodeType',
  'value',
  'checked',
  'disabled',
  'selected',
  'src',
  'href',
  'rel',
  'type',
  'alt',
  'title',
  'placeholder',
  'dataset',
  'style',
  'hidden',
  // Event
  'target',
  'currentTarget',
  'srcElement',
  'eventPhase',
  'bubbles',
  'cancelable',
  'defaultPrevented',
  'isTrusted',
  'preventDefault',
  'stopPropagation',
  'stopImmediatePropagation',
  'detail',
  'view',
  'which',
  'key',
  'code',
  'keyCode',
  'charCode',
  'altKey',
  'ctrlKey',
  'metaKey',
  'shiftKey',
  'button',
  'buttons',
  'clientX',
  'clientY',
  'pageX',
  'pageY',
  'screenX',
  'screenY',
  // Location / URL
  'protocol',
  'host',
  'hostname',
  'port',
  'pathname',
  'search',
  'searchParams',
  'hash',
  'origin',
  'username',
  'password',
  // Navigator / Screen
  'userAgent',
  'platform',
  'language',
  'languages',
  'cookieEnabled',
  'onLine',
  'width',
  'height',
  'availWidth',
  'availHeight',
  'colorDepth',
  'pixelDepth',
  // Response / Request (fetch)
  'ok',
  'status',
  'statusText',
  'headers',
  'body',
  'url',
  'redirected',
  'method',
  'mode',
  'credentials',
  'cache',
  'redirect',
  'referrer',
  'referrerPolicy',
  'integrity',
  'signal',
  // Common runtime arg names that show up in agent code
  'args',
  'arguments',
  'this',
]);

/**
 * Recursively extract candidate property-key strings from a value. Used
 * by the observation hooks: when a tool returns a result, we walk it and
 * push strings that look like property keys (short-to-medium length,
 * non-empty) into the session's observedStrings set.
 *
 * Captures BOTH:
 *  - String VALUES (e.g., `["me", "xa"]` from `Object.keys` — these are
 *    THE keys the agent will later reference)
 *  - Object KEYS (the keys of any plain object in the result tree —
 *    these are the names the agent saw structurally)
 */
export function extractObservedStrings(value: unknown, depth = 0): string[] {
  if (depth > MAX_RECURSION_DEPTH) return [];
  if (value === null || value === undefined) return [];

  if (typeof value === 'string') {
    if (value.length >= MIN_OBSERVED_STRING_LENGTH && value.length <= MAX_OBSERVED_STRING_LENGTH) {
      return [value];
    }
    return [];
  }

  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      out.push(...extractObservedStrings(item, depth + 1));
    }
    return out;
  }

  if (typeof value === 'object') {
    const out: string[] = [];
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      // Object KEYS — what the agent observed structurally as available
      // properties on this object.
      if (key.length >= MIN_OBSERVED_STRING_LENGTH && key.length <= MAX_OBSERVED_STRING_LENGTH) {
        out.push(key);
      }
      // Recurse into the value.
      out.push(...extractObservedStrings(v, depth + 1));
    }
    return out;
  }

  return [];
}

/**
 * Record observations from a tool response into the session's
 * observed-strings set. LRU-evicts on overflow.
 *
 * Called from the runtime's tool entry points — js_eval result, find_in_page
 * matches, etc. Skip-on-error: if anything throws (cyclic object, unusual
 * value), the observation just isn't recorded — never break the tool's
 * return path.
 */
export function recordObservations(session: Session, value: unknown): void {
  try {
    const sessionAny = session as Session & { observedStrings?: Set<string> };
    if (!sessionAny.observedStrings) {
      sessionAny.observedStrings = new Set<string>();
    }
    const set = sessionAny.observedStrings;
    const extracted = extractObservedStrings(value);
    for (const s of extracted) {
      // Skip stable API names — they're never fragile, no point taking
      // up the cap.
      if (STABLE_API_NAMES.has(s)) continue;
      // LRU semantics: re-insert moves to "most recent."
      if (set.has(s)) set.delete(s);
      set.add(s);
      if (set.size > OBSERVED_STRINGS_CAP) {
        // Drop oldest (first-inserted in iteration order for Set).
        const oldest = set.values().next().value;
        if (oldest !== undefined) set.delete(oldest);
      }
    }
  } catch {
    // best-effort — never break the caller
  }
}

/**
 * Read the session's observed-strings set. Returns an empty set when
 * none have been recorded yet.
 */
export function getObservedStrings(session: Session): Set<string> {
  const sessionAny = session as Session & { observedStrings?: Set<string> };
  return sessionAny.observedStrings ?? new Set<string>();
}

/**
 * Walk an expression body for property-access chains and return the
 * KEY names (after the root identifier). Bracket-string-literal access
 * is canonicalized to dot form so `obj["a"]["b"]` yields `["a", "b"]`
 * the same as `obj.a.b`. Optional chaining markers are stripped.
 *
 * Skips the root identifier (variable name) — that's a JS variable
 * scope, not a property the agent observed.
 */
export function extractPropertyKeys(expression: string): Array<{ key: string; chainRoot: string }> {
  const canon = expression.replace(/\[\s*["']([A-Za-z_$][A-Za-z0-9_$]*)["']\s*\]/g, '.$1');
  const out: Array<{ key: string; chainRoot: string }> = [];
  const chainRe = /\b[A-Za-z_$][A-Za-z0-9_$]*(?:\??\.[A-Za-z_$][A-Za-z0-9_$]*)+/g;
  let m: RegExpExecArray | null;
  while ((m = chainRe.exec(canon)) !== null) {
    const segs = m[0]
      .split('.')
      .filter(Boolean)
      .map((s) => s.replace(/\?$/, ''));
    if (segs.length < 2) continue;
    const root = segs[0];
    if (root === undefined) continue;
    for (let i = 1; i < segs.length; i += 1) {
      const key = segs[i];
      if (key === undefined) continue;
      out.push({ key, chainRoot: root });
    }
  }
  return out;
}

export interface ObservedKey {
  /** The property key name the agent baked. */
  key: string;
  /** The root identifier of the chain it appeared in (variable name). */
  chainRoot: string;
}

/**
 * Common HTTP / wire-protocol values that legitimately appear in saved
 * strategies even when they happen to be in the session's observation
 * set (e.g., the agent saw `application/json` in a find_in_page result
 * AND the strategy uses the same string as a header value). Small finite
 * list — auditable. False positives outside this set ack via reason.
 */
const STABLE_LITERAL_VALUES = new Set<string>([
  'application/json',
  'application/x-www-form-urlencoded',
  'application/xml',
  'application/octet-stream',
  'application/javascript',
  'text/html',
  'text/plain',
  'text/css',
  'multipart/form-data',
  'no-cache',
  'no-store',
  'max-age=0',
  'gzip',
  'deflate',
  'br',
  'identity',
  'keep-alive',
  'close',
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'HEAD',
  'OPTIONS',
  'true',
  'false',
  'null',
  'undefined',
  'XMLHttpRequest',
  'fetch',
  'cors',
  'no-cors',
  'same-origin',
  'include',
  'omit',
  'follow',
  'manual',
  'error',
]);

export interface ObservedLiteral {
  /** Path inside the strategy where the literal lives, e.g.
   *  `headers.x-nonce` or `body.text`. */
  location: string;
  /** The literal value the agent baked. */
  value: string;
}

/**
 * Walk a strategy's literal-bearing value slots (header values, body
 * values, recorded-path step values) and return non-templated string
 * literals ≥ 8 chars. Used by the audit's `observed_literal_values`
 * Detector to cross-reference against the session's observed-strings
 * trace: a value the agent saw at runtime AND baked verbatim is by
 * construction observation (rotating token / nonce / signed header)
 * rather than contract.
 */
export function extractStrategyLiteralValues(data: unknown): ObservedLiteral[] {
  const out: ObservedLiteral[] = [];
  if (!data || typeof data !== 'object') return out;
  const root = data as Record<string, unknown>;

  const headers = root.headers;
  if (headers && typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
      if (typeof v !== 'string') continue;
      if (isTemplatedOnly(v)) continue;
      if (v.length < 8) continue;
      out.push({ location: `headers["${k}"]`, value: v });
    }
  }

  if (typeof root.body === 'string' && !isTemplatedOnly(root.body) && root.body.length >= 8) {
    out.push({ location: 'body', value: root.body });
  } else if (root.body && typeof root.body === 'object' && !Array.isArray(root.body)) {
    walkLeafStrings(root.body as Record<string, unknown>, 'body', out);
  }

  // Recorded-path step values (`steps[i].value`) — the literal the agent
  // types into the page. If observed, suspicious.
  const steps = root.steps;
  if (Array.isArray(steps)) {
    steps.forEach((step, i) => {
      if (!step || typeof step !== 'object') return;
      const v = (step as Record<string, unknown>).value;
      if (typeof v !== 'string') return;
      if (isTemplatedOnly(v)) return;
      if (v.length < 8) return;
      out.push({ location: `steps[${i}].value`, value: v });
    });
  }

  return out;
}

function walkLeafStrings(
  obj: Record<string, unknown>,
  prefix: string,
  out: ObservedLiteral[],
): void {
  for (const [k, v] of Object.entries(obj)) {
    const path = `${prefix}.${k}`;
    if (typeof v === 'string') {
      if (isTemplatedOnly(v)) continue;
      if (v.length < 8) continue;
      out.push({ location: path, value: v });
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      walkLeafStrings(v as Record<string, unknown>, path, out);
    }
  }
}

// True iff the string is entirely placeholder template references (no
// literal content). `{{text}}` → true; `Bearer {{token}}` → false (the
// "Bearer " prefix is literal); `abc` → false.
function isTemplatedOnly(s: string): boolean {
  return /^\s*(?:\{\{[^}]+\}\}\s*)+$/.test(s);
}

/**
 * Find baked literal values in the strategy that match strings observed
 * during this session — same provenance check as `findObservedKeys` but
 * applied to value slots (headers, body, steps[i].value) rather than
 * property-access keys in expression bodies.
 *
 * Filters STABLE_LITERAL_VALUES (common HTTP / wire vocabulary that
 * legitimately appears even when also observed). Remaining matches are
 * flagged.
 */
export function findObservedLiterals(data: unknown, session: Session): ObservedLiteral[] {
  const observed = getObservedStrings(session);
  if (observed.size === 0) return [];
  const literals = extractStrategyLiteralValues(data);
  return literals.filter((l) => !STABLE_LITERAL_VALUES.has(l.value) && observed.has(l.value));
}

/**
 * Find property-access keys in an expression that match strings the agent
 * observed during this session — i.e., baked observation, not contract.
 * Stable API names are filtered out before the membership check. The
 * remaining flagged keys are what the save-time gate rejects on.
 */
export function findObservedKeys(expression: string, session: Session): ObservedKey[] {
  const observed = getObservedStrings(session);
  if (observed.size === 0) return [];
  const keys = extractPropertyKeys(expression);
  const flagged: ObservedKey[] = [];
  for (const { key, chainRoot } of keys) {
    if (STABLE_API_NAMES.has(key)) continue;
    if (observed.has(key)) flagged.push({ key, chainRoot });
  }
  return flagged;
}

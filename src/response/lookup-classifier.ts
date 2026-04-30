// Classify a captured HTTP request by its "lookup-by-X → returns-id" shape.
// Consumed by the opaque-param validator: when `notes.params[X].example` is
// declared as a user arg but the accumulator saw the same literal in a
// lookup-shaped response, the save is rejected (the value is server-produced,
// not typed by the caller).
//
// ---- Architectural exception note ----
//
// The "delegate to the LLM" principle (see `runtime/docs/principles.md`) says
// the runtime should not pattern-match on specific protocol/site shapes — the
// LLM decides, the runtime just exposes primitives. The classifier below breaks
// that rule in the same shape as `envelope-advisories.ts`: a bounded set of
// heuristics that turn raw captured traffic into a RANKED CANDIDATE LIST so the
// agent doesn't have to scan 200 requests by hand at the exact moment they're
// fighting a save rejection.
//
// The exception is bounded on purpose. The classifier outputs CANDIDATES — the
// `looks_like_lookup` flag is a gate, not a judgment. The save-time rejection
// message frames the skeleton as "candidate based on captured traffic; tweak
// the response.extract path if wrong" — the LLM decides whether the match is
// real and composes the final strategy. Simple sites (plain JSON POST, no
// lookup chain) match zero candidates; the accumulator is empty; no harm done.
//
// If you find yourself adding a classifier heuristic for a specific site's URL
// pattern, stop: that's the class of code the principles doc forbids
// (`runtime/docs/principles.md`). Either the heuristic generalizes structurally
// (input-key name, path segment name, output shape) OR it belongs in the LLM's
// discovery reasoning, not the runtime. Keep the signals structural and narrow.
//
// ---- Shape ----
//
// The classifier is PURE — input: an InterceptedRequest, output: a
// LookupCandidate or null. No session state, no side effects. Tested in
// isolation against fixtures.
//
// The heuristic is deliberately narrow: a request counts as "lookup-like" only
// when BOTH (a) it takes an input shaped like a query / name / slug, and (b)
// its response body contains id-shaped fields. Neither signal alone is enough —
// we'd over-match bulk-resource endpoints (lots of ids, no query input) or
// fuzzy-filter UI endpoints (query input, no ids returned). The intersection is
// the sweet spot for name→id resolution.

import type { InterceptedRequest } from '../drivers/types/network';

/** Input keys on a request that signal the request is a LOOKUP (takes a
 *  user-facing handle and returns an internal id). Order-insensitive. */
const LOOKUP_INPUT_KEYS = new Set([
  'q',
  'query',
  'name',
  'text',
  'term',
  'search',
  'searchterm',
  'search_term',
  'searchquery',
  'search_query',
  'slug',
  'handle',
  'username',
  'email',
  'filter',
  'keyword',
]);

/** URL path segment patterns that suggest search/lookup shape. Matched
 *  case-insensitively against individual path segments. */
const LOOKUP_PATH_SEGMENTS = new Set([
  'search',
  'typeahead',
  'lookup',
  'find',
  'resolve',
  'autocomplete',
  'suggest',
]);

// The classifier walks the parsed response tree and stores every string/number
// scalar value, keyed by its JSON path. No shape filter, no "looks opaque"
// regex. `findCandidatesForLiteral` does exact-string equality against the
// stored values — if a declared example matches any captured value, the
// opaque-param validator has ground truth that the server produced it.

export interface LookupCandidate {
  /** Back-reference into the captured network log (`i` on the shaped
   *  entry, so the agent can round-trip via {i, full: true}). */
  request_i: number;
  url: string;
  method: string;
  input_shape: {
    /** Path param NAMES the runtime was able to infer (not values). E.g.
     *  for `/api/threads/abc`, `path_tail` is `['abc']` — the classifier
     *  doesn't know the param name without an OpenAPI schema, so we
     *  preserve the tail segment(s) verbatim. */
    path_tail?: string[];
    /** Query string keys (not values). */
    query_keys?: string[];
    /** POST body top-level keys (when body is JSON). */
    body_keys?: string[];
  };
  output_shape: {
    response_format: 'json' | 'html' | 'binary' | 'text';
    /** True when the JSON response is an array OR has a top-level array
     *  field. */
    has_array_of_objects: boolean;
    /** Every string/number scalar value found in the parsed response body,
     *  keyed by its JSON path. Populated only when the body parses as JSON.
     *  The save-time guard matches hardcoded literals against
     *  `sample_value` with exact string equality — no shape filter. Capped
     *  per-response so a huge response can't blow memory. */
    id_fields: Array<{ field_path: string; value_shape: string; sample_value: string }>;
  };
  /** The load-bearing signal: true when input + output heuristics both
   *  fire with enough confidence. */
  looks_like_lookup: boolean;
  /** 0..1 confidence score; the save-time guard uses this to rank
   *  candidates when multiple responses returned the same literal. */
  lookup_confidence: number;
}

interface ClassifyOptions {
  /** Required — the request's absolute index in the network log (used as
   *  back-reference on the output LookupCandidate). */
  request_i: number;
}

export function classifyRequestShape(
  entry: InterceptedRequest,
  opts: ClassifyOptions,
): LookupCandidate | null {
  if (typeof entry.url !== 'string' || entry.url.length === 0) return null;

  const inputShape = analyzeInputShape(entry);
  const outputShape = analyzeOutputShape(entry);
  if (!outputShape) return null;

  const { looksLikeLookup, confidence } = scoreLookupShape(entry, inputShape, outputShape);

  return {
    request_i: opts.request_i,
    url: entry.url,
    method: entry.method.toUpperCase(),
    input_shape: inputShape,
    output_shape: outputShape,
    looks_like_lookup: looksLikeLookup,
    lookup_confidence: confidence,
  };
}

function analyzeInputShape(entry: InterceptedRequest): LookupCandidate['input_shape'] {
  const out: LookupCandidate['input_shape'] = {};
  // Query string keys — parse robustly; bail silently on malformed URLs.
  try {
    const u = new URL(entry.url);
    const queryKeys = Array.from(new Set(Array.from(u.searchParams.keys())));
    if (queryKeys.length > 0) out.query_keys = queryKeys;
    // Path tail — the final 1-2 path segments (not including the host or
    // leading slashes). Helps the classifier recognize slug-in-path lookups
    // like /t/<slug>/ or /users/<username>.
    const segments = u.pathname.split('/').filter((s) => s.length > 0);
    if (segments.length > 0) {
      out.path_tail = segments.slice(-2);
    }
  } catch {
    // Malformed URL — skip the parse, still return any shape we inferred.
  }
  // POST body keys — only for JSON-shaped bodies at the top level.
  const post = entry.postData;
  if (post !== undefined && post !== null) {
    if (typeof post === 'object' && !Array.isArray(post)) {
      const keys = Object.keys(post as Record<string, unknown>);
      if (keys.length > 0) out.body_keys = keys;
    } else if (typeof post === 'string') {
      try {
        const parsed: unknown = JSON.parse(post);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const keys = Object.keys(parsed as Record<string, unknown>);
          if (keys.length > 0) out.body_keys = keys;
        }
      } catch {
        // Not JSON — try common non-JSON envelope shapes before giving up. (a)
        // GraphQL-in-string envelope: pull the `variables` keys.
        const gqlMatch = /"variables"\s*:\s*\{([^}]*)\}/.exec(post);
        if (gqlMatch && typeof gqlMatch[1] === 'string') {
          out.body_keys = [...gqlMatch[1].matchAll(/"([^"]+)"\s*:/g)]
            .map((match) => match[1])
            .filter((key): key is string => typeof key === 'string');
        }
        // (b) URL-encoded body (`application/x-www-form-urlencoded`). Parse via
        // URLSearchParams, strip bracket suffixes so `route_urls[0]=...` and
        // `route_urls[1]=...` both register as `route_urls`. Fall back silently
        // on any parse error.
        if (!out.body_keys || out.body_keys.length === 0) {
          try {
            const params = new URLSearchParams(post);
            const keys = Array.from(
              new Set(Array.from(params.keys()).map((k) => k.replace(/\[\d*\]$/, ''))),
            ).filter((k) => k.length > 0);
            if (keys.length > 0) out.body_keys = keys;
          } catch {
            // not URL-encoded either — leave body_keys unset
          }
        }
      }
    }
  }
  return out;
}

function analyzeOutputShape(entry: InterceptedRequest): LookupCandidate['output_shape'] | null {
  const body = entry.responseBody;
  const format = detectResponseFormat(entry, body);
  if (!format) return null;

  const shape: LookupCandidate['output_shape'] = {
    response_format: format,
    has_array_of_objects: false,
    id_fields: [],
  };

  if (format === 'json' && body !== null && body !== undefined) {
    const parsed = coerceJson(body);
    if (parsed !== null) {
      shape.has_array_of_objects = detectArrayOfObjects(parsed);
      shape.id_fields = collectIdFields(parsed, '', 0);
    }
  }
  // HTML responses are not parsed server-side — the agent inspects them via
  // `get_network_log({i, full: true})` and `find_in_page`. Bringing in a full
  // HTML parser (cheerio/jsdom) to auto-extract ids would both inflate the
  // dependency graph and bake in structural assumptions about where ids live in
  // a page. The LLM handles HTML interpretation.

  return shape;
}

function detectResponseFormat(
  entry: InterceptedRequest,
  body: unknown,
): 'json' | 'html' | 'binary' | 'text' | null {
  const contentType = (
    entry.headers['content-type'] ??
    entry.headers['Content-Type'] ??
    ''
  ).toLowerCase();
  if (contentType.includes('application/json')) return 'json';
  if (contentType.includes('text/html')) return 'html';
  if (
    contentType.includes('application/octet-stream') ||
    contentType.includes('application/protobuf')
  ) {
    return 'binary';
  }
  if (contentType.startsWith('text/')) return 'text';
  // Infer from the body shape if the content-type is missing/ambiguous.
  if (body && typeof body === 'object') return 'json';
  if (typeof body === 'string') {
    const trimmed = body.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
    if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html')) return 'html';
    return 'text';
  }
  return null;
}

function coerceJson(body: unknown): unknown {
  if (body === null || body === undefined) return null;
  if (typeof body === 'object') return body;
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }
  return null;
}

function detectArrayOfObjects(v: unknown, depth = 0): boolean {
  if (depth > 3) return false;
  if (Array.isArray(v)) {
    return v.some((item) => item !== null && typeof item === 'object' && !Array.isArray(item));
  }
  if (v && typeof v === 'object') {
    for (const child of Object.values(v as Record<string, unknown>)) {
      if (detectArrayOfObjects(child, depth + 1)) return true;
    }
  }
  return false;
}

/** Walk the JSON tree collecting every string/number scalar value with
 * its path. No shape filter — the save-time guard does exact-string equality
 * against the stored values. Caps at 256 values per response
 *  so a massive nested payload can't blow memory. */
function collectIdFields(
  v: unknown,
  path: string,
  depth: number,
): LookupCandidate['output_shape']['id_fields'] {
  const out: LookupCandidate['output_shape']['id_fields'] = [];
  const FIELD_CAP = 256;
  function walk(value: unknown, currentPath: string, currentDepth: number): void {
    if (out.length >= FIELD_CAP) return;
    if (currentDepth > 6) return;
    if (typeof value === 'string' || typeof value === 'number') {
      const s = String(value);
      if (s.length > 0 && s.length <= 512) {
        out.push({
          field_path: currentPath || '(root)',
          value_shape: typeof value,
          sample_value: s,
        });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        walk(item, `${currentPath}[${i}]`, currentDepth + 1);
      });
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (out.length >= FIELD_CAP) return;
        const childPath = currentPath ? `${currentPath}.${key}` : key;
        walk(child, childPath, currentDepth + 1);
      }
    }
  }
  walk(v, path, depth);
  return out;
}

function scoreLookupShape(
  entry: InterceptedRequest,
  inputShape: LookupCandidate['input_shape'],
  outputShape: LookupCandidate['output_shape'],
): { looksLikeLookup: boolean; confidence: number } {
  let inputSignal = 0;
  let outputSignal = 0;

  // Input signals (max 1.0).
  const allInputKeys = [...(inputShape.query_keys ?? []), ...(inputShape.body_keys ?? [])].map(
    (k) => k.toLowerCase(),
  );
  if (allInputKeys.some((k) => LOOKUP_INPUT_KEYS.has(k))) inputSignal += 0.6;
  // Path segment signal: /search, /typeahead, /find, etc.
  try {
    const u = new URL(entry.url);
    const segments = u.pathname
      .toLowerCase()
      .split('/')
      .filter((s) => s.length > 0);
    if (segments.some((seg) => LOOKUP_PATH_SEGMENTS.has(seg))) inputSignal += 0.4;
  } catch {
    // URL parse failure — no path signal.
  }
  // Slug-in-path signal: when the tail segment is a short (≤40 chars)
  // non-numeric string, it's likely a slug. Helps navigation-lookup (GET
  // /t/<slug>/) register as a candidate.
  if (inputShape.path_tail && inputShape.path_tail.length > 0) {
    const lastSeg = inputShape.path_tail[inputShape.path_tail.length - 1] ?? '';
    if (
      lastSeg.length > 0 &&
      lastSeg.length <= 40 &&
      /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(lastSeg) &&
      !/^\d+$/.test(lastSeg)
    ) {
      inputSignal += 0.3;
    }
  }
  if (inputSignal > 1) inputSignal = 1;

  // Output signals (max 1.0).
  if (outputShape.id_fields.length > 0) outputSignal += 0.6;
  if (outputShape.has_array_of_objects) outputSignal += 0.4;
  if (outputSignal > 1) outputSignal = 1;

  const confidence = (inputSignal + outputSignal) / 2;
  const looksLikeLookup = inputSignal >= 0.4 && outputSignal >= 0.6;
  return { looksLikeLookup, confidence: Number(confidence.toFixed(2)) };
}

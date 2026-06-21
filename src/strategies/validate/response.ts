// api-tier `response` field. Lets a GET return HTML and be extracted into a
// structured dict inside the container's browser context, without the 525KB raw
// page blowing the MCP tool-output budget.
//
// Rules:
// - Absent `response` → current JSON passthrough behavior (no migration).
// - `format: 'json'` or absent + `extract` present → reject (loud). The extract
//   shape doesn't apply to JSON today and silent ignore would hide bugs.
// - `format: 'html'` → `extract` is required, non-empty, and method must be
//   GET. Each extract entry is `{selector, attr?, multiple?}` with a non-empty
//   selector.
// - `format` enum is 'json' | 'html' only; xml/text are deferred until a real
//   benchmark forces us to get the quirks right.
// - `response` on any tier other than api / recorded-path → reject. Execution
//   dispatch doesn't handle response.extract elsewhere today; accepting the
//   field on other tiers would silently do nothing.

import { isPlainObject } from './helpers';
import { responseSchema } from '../schemas/response';
import { renderZodSkeletonInline, zodErrorToIssues } from '../schemas/zod-helpers';

export function validateResponseShape(data: Record<string, unknown>, tier: string): void {
  if (!('response' in data) || data.response === undefined || data.response === null) return;

  const response = data.response;
  if (!isPlainObject(response)) {
    throw new Error(`invalid_strategy: ${tier}.response must be an object`);
  }
  const hasFrom = typeof response.from === 'string' && response.from.length > 0;

  // `response` is meaningful on:
  //   - fetch (HTTP response body → HTML/JSON, optional extract)
  //   - recorded-path (post-replay live DOM → HTML extract)
  //   - any tier when `response.from` is set (the value comes from a prereq —
  //     the strategy doesn't fire HTTP/replay at all, so this is universal).
  // page-script without `response.from` would silently ignore the field — reject.
  if (tier !== 'fetch' && tier !== 'recorded-path' && !hasFrom) {
    throw new Error(
      `invalid_strategy: "response" field is only valid on fetch and recorded-path strategies (got tier "${tier}"). ` +
        `For HTML scraping with cookies, use tier "fetch" — Node-tier fetch automatically sends the platform's ` +
        `session cookies (no transport:browser needed). Then add {response: {format: "html", extract: {...}}} ` +
        `to pull fields out of the GET response. ` +
        `For recorded-path, use the same {format: "html", extract} shape to extract from the final page DOM after the step loop. ` +
        `For JSON endpoints, remove the response field and let execute() return the parsed body verbatim. ` +
        `If your data IS the return value of a prereq (e.g. a js-eval prereq that scrapes the live DOM and produces JSON), ` +
        `set {response: {from: "<prereq-name>"}} on any tier — the strategy then skips its HTTP/replay fire and returns the prereq's value.`,
    );
  }

  // --- Applicability guards (run BEFORE the Zod shape parse so a well-worded
  // error wins over a raw shape error for the common misuses: extract on a JSON
  // endpoint, a string-valued extract entry, format:"html" on a non-GET). The
  // full Zod shape validation still runs below. ---
  const format = response.format;
  const hasExtract =
    'extract' in response && response.extract !== undefined && response.extract !== null;

  if (format !== undefined && format !== 'json' && format !== 'html') {
    throw new Error(
      `invalid_strategy: ${tier}.response.format = ${JSON.stringify(format)} must be "json" or "html" ` +
        `(xml and other formats are not supported yet)`,
    );
  }

  // recorded-path extract is HTML-only today (extracts from the live page DOM,
  // which is always HTML). Reject non-html format before the generic
  // extract-on-json guard so recorded-path keeps its specific message.
  if (tier === 'recorded-path' && format !== undefined && format !== 'html') {
    throw new Error(
      `invalid_strategy: recorded-path.response.format must be "html" (got ${JSON.stringify(format)}). ` +
        `recorded-path extracts run against the live page DOM after the last step — there's no JSON to parse. ` +
        `For JSON endpoints, lift the strategy to api instead.`,
    );
  }

  if (format !== 'html' && hasExtract) {
    // json (explicit or default) with extract is a common misuse — agents
    // sometimes set response.extract on a JSON endpoint. Reject loudly so they
    // fix it instead of wondering why their extractors are ignored.
    throw new Error(
      `invalid_strategy: ${tier}.response.extract is only valid when response.format = "html" ` +
        `(got format = ${format === undefined ? '"json" (default)' : JSON.stringify(format)}). ` +
        `For JSON endpoints, remove the extract field and let execute() return the parsed body verbatim.`,
    );
  }

  // The {id: "id"} footgun: agents write extract as a key→string map, but each
  // entry must be {selector, attr?, multiple?}. Catch it before the raw Zod
  // shape error so the corrected line is in front of the agent.
  if (format === 'html' && hasExtract && isPlainObject(response.extract)) {
    for (const [k, v] of Object.entries(response.extract)) {
      if (typeof v === 'string') {
        throw new Error(
          `invalid_strategy: ${tier}.response.extract.${k} must be an object {selector, attr?, multiple?}, not a string. ` +
            `You wrote ${k}: ${JSON.stringify(v)} — the corrected shape is ${k}: {selector: ${JSON.stringify(v)}}. ` +
            `Example: extract: {title: {selector: "h1"}, ${k}: {selector: ${JSON.stringify(v)}}}.`,
        );
      }
    }
  }

  // format === 'html' on fetch requires method = GET. recorded-path carries no
  // method field; skip when response.from is set (no HTTP fires).
  if (format === 'html' && tier === 'fetch' && !hasFrom) {
    let methodStr = 'GET';
    if (typeof data.method === 'string') {
      methodStr = data.method;
    } else if (typeof data.endpoint === 'string' && data.endpoint.includes(' ')) {
      methodStr = data.endpoint.split(' ')[0] ?? 'GET';
    }
    const method = methodStr.toUpperCase();
    if (method !== 'GET') {
      throw new Error(
        `invalid_strategy: fetch response.format = "html" requires a GET method (got "${method}"). ` +
          `HTML extraction is only supported on read-shaped endpoints — the save-time probe fires the real ` +
          `request to verify the selectors, which is unsafe for non-GET methods.`,
      );
    }
  }

  const parsed = responseSchema.safeParse(response);
  if (!parsed.success) {
    const issues = zodErrorToIssues(parsed.error, `${tier}.response`);
    const bullets = issues.map((issue) => `  - ${issue}`).join('\n');
    const issueLabel = issues.length === 1 ? '1 issue' : `${issues.length} issues`;
    throw new Error(
      `invalid_strategy: ${tier}.response has ${issueLabel} — fix all before retrying:\n${bullets}\n\nExpected shape: ${tier}.response is ${renderZodSkeletonInline(responseSchema)}`,
    );
  }

  // When response.from is set, validate the named prereq exists and is a
  // value-producing kind. Fail loudly so the agent doesn't ship a strategy
  // that silently returns undefined at warm-execute.
  if (hasFrom) {
    // recorded-path's response.from semantics are unclear: prereqs run BEFORE
    // step replay, so "return the prereq value" would skip the steps entirely
    // — at which point the strategy might as well be page-script. Steer
    // recorded-path users to response.extract (post-replay HTML extraction)
    // instead.
    if (tier === 'recorded-path') {
      throw new Error(
        `invalid_strategy: recorded-path.response.from is not supported. recorded-path's prereqs run BEFORE step replay, ` +
          `so returning a prereq value would skip the steps entirely — use tier "page-script" with response.from instead. ` +
          `For post-replay DOM extraction, use {response: {format: "html", extract: {var: {selector: ".css"}}}} — the executor reads ` +
          `the live page DOM after the last step.`,
      );
    }
    const fromName = response.from as string;
    const prereqs = Array.isArray(data.prerequisites) ? data.prerequisites : [];
    // Execution reads response.from out of the token scope, so it must reference
    // a token the prereq actually STORES — and that name is kind-dependent:
    //   • js-eval (and tag): tokens[binds ?? name] — a single bound value.
    //   • fetch-extract / page-extract / capability: one token per `vars` KEY
    //     (tokens[varName]). The prereq `name` is NOT a stored token for these,
    //     so accepting response.from === name (the old binds ?? name rule) let a
    //     fetch-extract strategy validate but silently break at execute.
    const storedTokenNames = (p: Record<string, unknown>): string[] => {
      const kind = typeof p.kind === 'string' ? p.kind : '';
      if (kind === 'fetch-extract' || kind === 'page-extract' || kind === 'capability') {
        const vars = p.vars;
        if (vars && typeof vars === 'object' && !Array.isArray(vars)) {
          return Object.keys(vars as Record<string, unknown>);
        }
        return [];
      }
      if (typeof p.binds === 'string' && p.binds.length > 0) return [p.binds];
      if (typeof p.name === 'string') return [p.name];
      return [];
    };
    const named = prereqs.find(
      (p): p is Record<string, unknown> =>
        isPlainObject(p) && storedTokenNames(p).includes(fromName),
    );
    if (!named) {
      // Footgun: response.from references a prereq's NAME, but that prereq stores
      // its value under different token name(s) — `binds` for js-eval, the `vars`
      // KEYS for fetch-extract / page-extract / capability. Execution reads
      // tokens[response.from] → the read misses → broken warm-execute.
      const nameMatch = prereqs.find(
        (p): p is Record<string, unknown> =>
          isPlainObject(p) && p.name === fromName && !storedTokenNames(p).includes(fromName),
      );
      if (nameMatch) {
        const tokens = storedTokenNames(nameMatch);
        const tokenList =
          tokens.length > 0
            ? tokens.map((t) => `"${t}"`).join(', ')
            : `(none — a ${String(nameMatch.kind)} prereq exposes a token per \`vars\` key; add a vars entry)`;
        throw new Error(
          `invalid_strategy: ${tier}.response.from = "${fromName}" matches a prereq's name, but at execute time ` +
            `(kind:"${String(nameMatch.kind)}") its value is stored under ${tokenList}, not the prereq name. ` +
            `Change response.from to one of those token names.`,
        );
      }
      const declared = prereqs
        .flatMap((p) => (isPlainObject(p) ? storedTokenNames(p) : []))
        .map((n) => `"${n}"`);
      const declaredList = declared.length > 0 ? declared.join(', ') : '(none)';
      throw new Error(
        `invalid_strategy: ${tier}.response.from = "${fromName}" but no prereq stores a token with that name. ` +
          `Available prereq tokens: ${declaredList}. ` +
          `Either add a prereq that produces "${fromName}" (js-eval binds / fetch-extract|page-extract|capability vars key) ` +
          `or remove response.from to let the strategy fire its own HTTP/replay.`,
      );
    }
    const allowedKinds = new Set(['js-eval', 'page-extract', 'fetch-extract', 'capability', 'tag']);
    const namedKind = typeof named.kind === 'string' ? named.kind : null;
    if (namedKind === null || !allowedKinds.has(namedKind)) {
      throw new Error(
        `invalid_strategy: ${tier}.response.from = "${fromName}" references a prereq of kind "${namedKind ?? 'unknown'}". ` +
          `Only value-producing prereqs (js-eval, page-extract, fetch-extract, capability, tag) can supply a strategy result. ` +
          `For browser/cached prereqs, the bound value isn't a return shape the runtime can hand back as the strategy's response.`,
      );
    }
  }

  // json (or absent) passthrough: nothing more to validate (extract on a
  // non-html response was already rejected in the applicability guards above).
  if (format !== 'html') return;

  if (
    !hasExtract ||
    !isPlainObject(response.extract) ||
    Object.keys(response.extract).length === 0
  ) {
    throw new Error(
      `invalid_strategy: ${tier} response.format = "html" requires a non-empty "extract" object. ` +
        `Example: {response: {format: "html", extract: {title: {selector: "h1"}, orders: {selector: ".order-row", multiple: true}}}}`,
    );
  }

  for (const [varName, rawSpec] of Object.entries(response.extract)) {
    if (!isPlainObject(rawSpec)) {
      throw new Error(
        `invalid_strategy: ${tier}.response.extract.${varName} must be {selector, attr?, multiple?}`,
      );
    }
    const spec = rawSpec;
    if (typeof spec.selector !== 'string' || spec.selector.length === 0) {
      throw new Error(
        `invalid_strategy: ${tier}.response.extract.${varName} requires a "selector" string. ` +
          `Example: {selector: "h1.title"} or {selector: "meta[name='author']", attr: "content"}`,
      );
    }
    if (spec.attr !== undefined && typeof spec.attr !== 'string') {
      throw new Error(
        `invalid_strategy: ${tier}.response.extract.${varName}.attr must be a string if present`,
      );
    }
    if (spec.multiple !== undefined && typeof spec.multiple !== 'boolean') {
      throw new Error(
        `invalid_strategy: ${tier}.response.extract.${varName}.multiple must be a boolean if present`,
      );
    }
  }
}

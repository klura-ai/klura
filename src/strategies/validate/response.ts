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
    const named = prereqs.find(
      (p): p is Record<string, unknown> => isPlainObject(p) && p.name === fromName,
    );
    if (!named) {
      const declared = prereqs
        .map((p) => (isPlainObject(p) && typeof p.name === 'string' ? `"${p.name}"` : null))
        .filter((n): n is string => n !== null);
      const declaredList = declared.length > 0 ? declared.join(', ') : '(none)';
      throw new Error(
        `invalid_strategy: ${tier}.response.from = "${fromName}" but no prereq with that name was declared. ` +
          `Declared prereq names: ${declaredList}. ` +
          `Either add a prereq with name:"${fromName}" (kind:"js-eval" / "page-extract" / "fetch-extract" / "capability" / "tag") ` +
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

  const format = response.format;
  if (format !== undefined && format !== 'json' && format !== 'html') {
    throw new Error(
      `invalid_strategy: ${tier}.response.format = ${JSON.stringify(format)} must be "json" or "html" ` +
        `(xml and other formats are not supported yet)`,
    );
  }

  // recorded-path extract is HTML-only today (extracts from the live page DOM,
  // which is always HTML). Reject format: 'json' on recorded-path so agents
  // don't save a shape the executor will ignore.
  if (tier === 'recorded-path' && format !== undefined && format !== 'html') {
    throw new Error(
      `invalid_strategy: recorded-path.response.format must be "html" (got ${JSON.stringify(format)}). ` +
        `recorded-path extracts run against the live page DOM after the last step — there's no JSON to parse. ` +
        `For JSON endpoints, lift the strategy to api instead.`,
    );
  }

  const hasExtract =
    'extract' in response && response.extract !== undefined && response.extract !== null;

  if (format !== 'html') {
    // json (explicit or default) with extract is a common misuse — agents
    // sometimes set response.extract on a JSON endpoint. Reject loudly so they
    // fix it instead of wondering why their extractors are ignored.
    if (hasExtract) {
      throw new Error(
        `invalid_strategy: ${tier}.response.extract is only valid when response.format = "html" ` +
          `(got format = ${format === undefined ? '"json" (default)' : JSON.stringify(format)}). ` +
          `For JSON endpoints, remove the extract field and let execute() return the parsed body verbatim.`,
      );
    }
    return;
  }

  // format === 'html' on fetch: require method = GET. recorded-path doesn't
  // carry a method field — the restriction is on the HTTP request shape, not on
  // DOM extracts after a DOM replay. Skip when response.from is set; HTTP
  // doesn't fire at all in that case so method doesn't apply.
  if (tier === 'fetch' && !hasFrom) {
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

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
import { zodErrorToIssues } from '../schemas/zod-helpers';

export function validateResponseShape(data: Record<string, unknown>, tier: string): void {
  if (!('response' in data) || data.response === undefined || data.response === null) return;

  // `response` is currently meaningful on fetch (HTTP response body → HTML
  // extract) and recorded-path (post-navigation page DOM → HTML extract).
  // page-script and the listener tier don't have a post-execute extract phase,
  // so a `response` there would be silently ignored — reject loudly.
  if (tier !== 'fetch' && tier !== 'recorded-path') {
    throw new Error(
      `invalid_strategy: "response" field is only valid on fetch and recorded-path strategies (got tier "${tier}"). ` +
        `For HTML scraping with cookies, use tier "fetch" — Node-tier fetch automatically sends the platform's ` +
        `session cookies (no transport:browser needed). Then add {response: {format: "html", extract: {...}}} ` +
        `to pull fields out of the GET response. ` +
        `For recorded-path, use the same {format: "html", extract} shape to extract from the final page DOM after the step loop. ` +
        `For JSON endpoints, remove the response field and let execute() return the parsed body verbatim. ` +
        `If your strategy genuinely needs to run JS in the page (window.* state, in-page crypto), keep tier "page-script" ` +
        `and have the script return the structured object directly — there's no post-execute extract phase to add.`,
    );
  }

  const response = data.response;
  if (!isPlainObject(response)) {
    throw new Error(`invalid_strategy: ${tier}.response must be an object`);
  }

  const parsed = responseSchema.safeParse(response);
  if (!parsed.success) {
    const issues = zodErrorToIssues(parsed.error, `${tier}.response`);
    const bullets = issues.map((issue) => `  - ${issue}`).join('\n');
    const issueLabel = issues.length === 1 ? '1 issue' : `${issues.length} issues`;
    throw new Error(
      `invalid_strategy: ${tier}.response has ${issueLabel} — fix all before retrying:\n${bullets}`,
    );
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
  // DOM extracts after a DOM replay.
  if (tier === 'fetch') {
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

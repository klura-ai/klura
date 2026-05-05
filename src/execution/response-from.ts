// `response.from: "<prereq-name>"` execution helper.
//
// When a strategy declares response.from, the strategy's return value IS the
// named prereq's bound value. The strategy does not fire HTTP / WS / UI
// replay — prereqs run, the named prereq's value is parsed (per
// response.format) and optionally extracted (per response.extract), and the
// result is returned wrapped in the same `{ok, status, body, url}` envelope
// other execution paths produce.
//
// Centralized here so fetch-node, fetch-browser, and recorded-path consume
// one helper. Drift across three sites is the canonical bug this avoids.
//
// Schema-side validation (validateResponseShape in
// `runtime/src/strategies/validate/response.ts`) guarantees that when this
// helper runs:
//   - response.from is a non-empty string
//   - a prereq with that name exists on the strategy
//   - the prereq is a value-producing kind (js-eval / page-extract /
//     fetch-extract / capability / tag)
// So execution-time errors here are runtime-data issues, not shape issues.

import { extractFromHtml } from '../response/html-extract';

export interface StrategyResponseLike {
  from?: unknown;
  format?: unknown;
  extract?: unknown;
}

/** True if the strategy's `response.from` is set and non-empty. */
export function hasResponseFrom(
  strategy: { response?: StrategyResponseLike } | null | undefined,
): boolean {
  const from = strategy?.response?.from;
  return typeof from === 'string' && from.length > 0;
}

/** Resolve `strategy.response.from` against the prereq-result map and return
 *  the parsed body. Caller wraps in their site-specific ExecuteResult envelope
 *  (`{status: 200, body, tier, transport, ...}`). Throws on data-integrity
 *  violations — caller surfaces these as their existing error envelope. */
export function applyResponseFrom(
  strategy: { response?: StrategyResponseLike } | null | undefined,
  prereqResults: Record<string, string>,
): { body: unknown } {
  const response = strategy?.response;
  const fromName = (response?.from as string | undefined) ?? '';
  if (fromName.length === 0) {
    throw new Error('response-from: applyResponseFrom called without response.from set');
  }
  const raw = prereqResults[fromName];
  if (raw === undefined) {
    throw new Error(
      `response.from = "${fromName}" but prereq did not produce a bound value (the prereq may have failed silently or returned undefined)`,
    );
  }

  const format = (response?.format as string | undefined) ?? 'json';
  const extract = response?.extract as Record<string, unknown> | undefined;

  let body: unknown;
  if (format === 'json') {
    if (typeof raw !== 'string') {
      body = raw;
    } else {
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        body = '';
      } else {
        try {
          body = JSON.parse(raw);
        } catch (e) {
          throw new Error(
            `response.from = "${fromName}" with format:"json": prereq value did not parse as JSON. ` +
              `Either set the prereq's return_shape.kind to "object" + JSON.stringify the value, or set response.format:"html" if the value is raw text. ` +
              `First 80 chars: ${raw.slice(0, 80)}`,
            { cause: e },
          );
        }
      }
    }
  } else if (format === 'html') {
    if (typeof raw !== 'string') {
      throw new Error(
        `response.from = "${fromName}" with format:"html": expected the prereq to return a string (HTML), got ${typeof raw}`,
      );
    }
    if (extract && Object.keys(extract).length > 0) {
      // extractFromHtml expects the same shape as response.extract on
      // recorded-path / fetch HTML responses.
      body = extractFromHtml(
        raw,
        extract as Record<string, { selector: string; attr?: string; multiple?: boolean }>,
      );
    } else {
      body = raw;
    }
  } else {
    body = raw;
  }

  return { body };
}

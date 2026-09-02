// Exports a saved local `fetch` strategy as the public http_request strategy
// source. The package format already carries PublicHttpStrategyV1 and the
// compiler already parses it; this is the projection from the local tier onto
// it, so the fastest tier has a route into a package rather than stopping at
// review.
//
// The local tier is broader than the public one. Everything it can express and
// the public profile cannot is rejected by name here rather than silently
// dropped — a strategy that exports minus its dynamic parts is not the strategy
// that was verified.
import {
  parseBoundedRecord,
  parseExactRecord,
  parseJsonPointer,
  parseStableContractId,
  PublicContractError,
} from '../../public/contracts/common';
import { parseJsonSchema } from '../../public/contracts/json-schema';
import type { PublicHttpStrategyV1 } from '../../public/contracts/package';
import type { ValueExpressionV1 } from '../../public/contracts/value-expression';

/**
 * Public source for one http_request strategy.
 *
 * Identical to the compiled shape: unlike the page-script source, an http
 * strategy carries no digest that the compiler fills in later, so there is
 * nothing for a separate source type to vary.
 */
export type PublicHttpStrategySourceV1 = PublicHttpStrategyV1;

// eslint-disable-next-line sonarjs/slow-regex
const PLACEHOLDER_RE = /\{\{([^}]*)\}\}/g;

/**
 * Compiles one local `{{name}}` template string into a value expression.
 *
 * Every placeholder must name a top-level property of the reviewed input
 * schema. That is what makes the export honest: the public strategy takes its
 * inputs from the declared contract, so a placeholder the schema does not
 * declare has no value to read at call time and is rejected rather than
 * exported as a literal.
 */
export function compileTemplateExpression(
  template: string,
  inputProperties: ReadonlySet<string>,
  field: string,
): ValueExpressionV1 {
  const parts: ValueExpressionV1[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  PLACEHOLDER_RE.lastIndex = 0;

  while ((match = PLACEHOLDER_RE.exec(template)) !== null) {
    const name = (match[1] ?? '').trim();
    if (match.index > lastIndex) {
      parts.push({ op: 'literal', value: template.slice(lastIndex, match.index) });
    }
    if (name.length === 0) {
      throw new PublicContractError(field, 'contains an empty {{}} placeholder');
    }
    if (name.startsWith('__gen')) {
      throw new PublicContractError(
        field,
        `references the generated value "${name}", which is arbitrary local JavaScript with no ` +
          `public equivalent. A package strategy declares its inputs; it cannot run code to ` +
          `invent them. Replace the generated value with a caller argument, or export this ` +
          `capability at the page-script tier where the program runs in the page.`,
      );
    }
    if (!inputProperties.has(name)) {
      throw new PublicContractError(
        field,
        `references "${name}", which is not a top-level property of the reviewed input_schema. ` +
          `Every placeholder must read from a declared caller input: ` +
          `[${[...inputProperties].join(', ') || 'none declared'}]`,
      );
    }
    parts.push({ op: 'input', pointer: parseJsonPointer(`/${name}`, field) });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < template.length) {
    parts.push({ op: 'literal', value: template.slice(lastIndex) });
  }
  const [only] = parts;
  if (only === undefined) return { op: 'literal', value: '' };
  if (parts.length === 1) return only;
  return { op: 'concat', values: parts };
}

function compileMap(
  value: unknown,
  inputProperties: ReadonlySet<string>,
  field: string,
): Record<string, ValueExpressionV1> {
  if (value === undefined || value === null) return {};
  const record = parseBoundedRecord(value, field, 64);
  const out: Record<string, ValueExpressionV1> = {};
  for (const [key, entry] of Object.entries(record)) {
    // A literal value expression carries string | number | boolean | null, so a
    // numeric query param (`num_results_per_page: 24`) is expressible as-is.
    // Only a string can hold a {{name}} template and needs compiling.
    if (typeof entry === 'number' || typeof entry === 'boolean' || entry === null) {
      out[key] = { op: 'literal', value: entry };
      continue;
    }
    if (typeof entry !== 'string') {
      throw new PublicContractError(
        `${field}.${key}`,
        'must be a string, number, boolean or null in the public http profile',
      );
    }
    out[key] = compileTemplateExpression(entry, inputProperties, `${field}.${key}`);
  }
  return out;
}

/** Top-level property names of the reviewed input schema. */
function inputPropertyNames(inputSchema: unknown): ReadonlySet<string> {
  const record = inputSchema as { properties?: Record<string, unknown> } | null;
  const properties = record && typeof record === 'object' ? record.properties : undefined;
  if (!properties || typeof properties !== 'object') return new Set<string>();
  return new Set(Object.keys(properties));
}

/**
 * Exports the strict local read-only subset of the `fetch` tier: a static
 * request whose only dynamic parts are caller arguments declared in the
 * reviewed input schema. Public network and outcome policy remain explicit
 * package-source fields reviewed by the maintainer.
 */
export function exportReviewedLocalFetchStrategySource(value: unknown): PublicHttpStrategySourceV1 {
  const input = parseExactRecord(value, 'http_export', [
    'local_strategy',
    'input_schema',
    'strategy_id',
    'context',
    'replay',
    'response_body_limit_bytes',
  ]);
  const inputSchema = parseJsonSchema(input.input_schema, 'http_export.input_schema');
  const properties = inputPropertyNames(inputSchema);
  const local = parseBoundedRecord(input.local_strategy, 'http_export.local_strategy', 40);

  if (local.strategy !== 'fetch') {
    throw new PublicContractError('http_export.local_strategy.strategy', 'must be fetch');
  }
  if (local.method !== 'GET' && local.method !== 'POST') {
    throw new PublicContractError(
      'http_export.local_strategy.method',
      'must be GET or POST in the public http profile',
    );
  }
  if (typeof local.baseUrl !== 'string' || local.baseUrl.length === 0) {
    throw new PublicContractError('http_export.local_strategy.baseUrl', 'must be a string');
  }
  // Generated values are arbitrary local JavaScript evaluated per call. The
  // public profile has no expression that can run them, and exporting the
  // strategy without them would ship a request that was never verified.
  if (local.generated !== undefined && local.generated !== null) {
    const names = Object.keys(
      parseBoundedRecord(local.generated, 'http_export.local_strategy.generated', 32),
    );
    throw new PublicContractError(
      'http_export.local_strategy.generated',
      `must be absent: generated values (${names.join(', ')}) are local JavaScript with no ` +
        `public equivalent. Export this capability at the page-script tier, where the program ` +
        `runs inside the page and can compute them.`,
    );
  }
  if (Array.isArray(local.prerequisites) && local.prerequisites.length > 0) {
    throw new PublicContractError(
      'http_export.local_strategy.prerequisites',
      'must be empty in the public http profile: a prerequisite needs a live page or a prior ' +
        'request, neither of which a packaged http strategy performs',
    );
  }
  if (input.context !== 'node' && input.context !== 'browser') {
    throw new PublicContractError('http_export.context', 'must be node or browser');
  }
  if (input.replay !== 'safe_read' && input.replay !== 'indeterminate') {
    throw new PublicContractError('http_export.replay', 'must be safe_read or indeterminate');
  }
  if (
    typeof input.response_body_limit_bytes !== 'number' ||
    !Number.isInteger(input.response_body_limit_bytes) ||
    input.response_body_limit_bytes < 1
  ) {
    throw new PublicContractError(
      'http_export.response_body_limit_bytes',
      'must be a positive integer',
    );
  }

  const endpointTemplate = typeof local.endpoint === 'string' ? local.endpoint : '';
  let bodyTemplate: string | null = null;
  if (local.body !== undefined && local.body !== null) {
    bodyTemplate = typeof local.body === 'string' ? local.body : JSON.stringify(local.body);
  }
  const body =
    bodyTemplate === null
      ? null
      : compileTemplateExpression(bodyTemplate, properties, 'http_export.local_strategy.body');
  if (local.method === 'GET' && body !== null) {
    throw new PublicContractError(
      'http_export.local_strategy.body',
      'must be absent for a GET request',
    );
  }

  return {
    kind: 'http_request',
    context: input.context,
    request: {
      strategy_id: parseStableContractId(input.strategy_id, 'http_export.strategy_id'),
      method: local.method,
      base_url: local.baseUrl,
      endpoint: compileTemplateExpression(
        endpointTemplate,
        properties,
        'http_export.local_strategy.endpoint',
      ),
      headers: compileMap(local.headers, properties, 'http_export.local_strategy.headers'),
      query: compileMap(local.params, properties, 'http_export.local_strategy.params'),
      body,
      response_body_limit_bytes: input.response_body_limit_bytes,
    },
    projection: { kind: 'json' },
    prerequisites: [],
    replay: input.replay,
  };
}

import {
  parseBoundedRecord,
  parseExactRecord,
  parseJsonPointer,
  parseString,
  PublicContractError,
  sha256Digest,
} from '../../public/contracts/common';
import {
  parseBrowserPageScriptStrategy,
  type PublicBrowserPageScriptProgramV1,
  type PublicBrowserPageScriptStrategyV1,
} from '../../public/contracts/browser-page-script';
import type { ValueExpressionV1 } from '../../public/contracts/value-expression';
import { parseJsonSchema, type JsonSchemaV1 } from '../../public/contracts/json-schema';
import { needsBlockBodyWrap } from '../../response/js-eval-wrapper';

export type PublicBrowserPageScriptStrategySourceV1 = Omit<
  PublicBrowserPageScriptStrategyV1,
  'program'
> & {
  program: Omit<PublicBrowserPageScriptProgramV1, 'source_digest'> & {
    source_digest: null;
  };
};

/**
 * Exports the strict local read-only subset whose only result-producing work is
 * one page-bound js-eval prerequisite. Public network and outcome policy remain
 * explicit package-source fields reviewed by the maintainer.
 */
export function exportReviewedLocalPageScriptStrategySource(
  value: unknown,
): PublicBrowserPageScriptStrategySourceV1 {
  const input = parseExactRecord(value, 'page_script_export', [
    'local_strategy',
    'input_schema',
    'strategy_id',
    'wait',
    'interaction',
    'expect',
    'request_body_limits',
    'replay',
  ]);
  const inputSchema = parseJsonSchema(input.input_schema, 'page_script_export.input_schema');
  const local = parseBoundedRecord(input.local_strategy, 'page_script_export.local_strategy', 40);
  if (local.strategy !== 'page-script') {
    throw new PublicContractError(
      'page_script_export.local_strategy.strategy',
      'must be page-script',
    );
  }
  if (local.protocol !== undefined && local.protocol !== null && local.protocol !== 'http') {
    throw new PublicContractError(
      'page_script_export.local_strategy.protocol',
      'must be absent or http',
    );
  }
  const response = parseBoundedRecord(
    local.response,
    'page_script_export.local_strategy.response',
    3,
  );
  assertAllowedKeys(
    response,
    ['from', 'format', 'extract'],
    'page_script_export.local_strategy.response',
  );
  if (typeof response.from !== 'string' || response.from.length === 0) {
    throw new PublicContractError(
      'page_script_export.local_strategy.response.from',
      'must name the js-eval binding',
    );
  }
  if (response.format !== undefined && response.format !== 'json') {
    throw new PublicContractError(
      'page_script_export.local_strategy.response.format',
      'must be absent or json',
    );
  }
  if (response.extract !== undefined && response.extract !== null) {
    throw new PublicContractError(
      'page_script_export.local_strategy.response.extract',
      'must be absent because the reviewed program returns its JSON result directly',
    );
  }
  if (!Array.isArray(local.prerequisites) || local.prerequisites.length !== 1) {
    throw new PublicContractError(
      'page_script_export.local_strategy.prerequisites',
      'must contain exactly one js-eval prerequisite',
    );
  }
  const prerequisite = parseBoundedRecord(
    local.prerequisites[0],
    'page_script_export.local_strategy.prerequisites[0]',
    16,
  );
  if (prerequisite.kind !== 'js-eval') {
    throw new PublicContractError(
      'page_script_export.local_strategy.prerequisites[0].kind',
      'must be js-eval',
    );
  }
  const binding = parseString(
    prerequisite.binds,
    'page_script_export.local_strategy.prerequisites[0].binds',
    128,
  );
  if (binding.length === 0 || binding !== response.from) {
    throw new PublicContractError(
      'page_script_export.local_strategy.response.from',
      'must exactly equal the js-eval binds value',
    );
  }
  if (prerequisite.frame !== undefined && prerequisite.frame !== null) {
    throw new PublicContractError(
      'page_script_export.local_strategy.prerequisites[0].frame',
      'is outside the reviewed main-frame export profile',
    );
  }
  if (prerequisite.refresh !== undefined && prerequisite.refresh !== null) {
    throw new PublicContractError(
      'page_script_export.local_strategy.prerequisites[0].refresh',
      'is outside the per-call reviewed export profile',
    );
  }
  const returnShape = parseBoundedRecord(
    prerequisite.return_shape,
    'page_script_export.local_strategy.prerequisites[0].return_shape',
    4,
  );
  assertAllowedKeys(
    returnShape,
    ['kind', 'min_length', 'max_length', 'required_keys'],
    'page_script_export.local_strategy.prerequisites[0].return_shape',
  );
  if (returnShape.kind !== 'object') {
    throw new PublicContractError(
      'page_script_export.local_strategy.prerequisites[0].return_shape.kind',
      'must be object so the public response has a structural JSON body kind',
    );
  }
  if (returnShape.min_length !== undefined || returnShape.max_length !== undefined) {
    throw new PublicContractError(
      'page_script_export.local_strategy.prerequisites[0].return_shape',
      'cannot declare string length limits when kind is object',
    );
  }
  if (
    returnShape.required_keys !== undefined &&
    (!Array.isArray(returnShape.required_keys) || returnShape.required_keys.length > 64)
  ) {
    throw new PublicContractError(
      'page_script_export.local_strategy.prerequisites[0].return_shape.required_keys',
      'must contain at most 64 keys',
    );
  }
  const requiredKeys = (returnShape.required_keys ?? [])
    .map((candidate, index) =>
      parseNonEmptyLocalString(
        candidate,
        `page_script_export.local_strategy.prerequisites[0].return_shape.required_keys[${index}]`,
        256,
      ),
    )
    .filter((key, index, keys) => keys.indexOf(key) === index)
    .sort(compareText);
  const urlTemplate = parseNonEmptyLocalString(
    prerequisite.url,
    'page_script_export.local_strategy.prerequisites[0].url',
    8_192,
  );
  const expression = parseNonEmptyLocalString(
    prerequisite.expression,
    'page_script_export.local_strategy.prerequisites[0].expression',
    8_192,
  );
  const argumentTemplate = parseBoundedRecord(
    prerequisite.args_template,
    'page_script_export.local_strategy.prerequisites[0].args_template',
    64,
  );
  const state = { nodes: 0 };
  const argumentExpression = compileTemplateValue(
    argumentTemplate,
    'page_script_export.local_strategy.prerequisites[0].args_template',
    inputSchema,
    state,
    0,
  );
  const source = needsBlockBodyWrap(expression)
    ? `async (args) => { ${expression} }`
    : `async (args) => await (${expression})`;
  const candidate = parseBrowserPageScriptStrategy(
    {
      kind: 'browser_page_script',
      strategy_id: input.strategy_id,
      url: compileTemplateString(
        urlTemplate,
        inputSchema,
        'page_script_export.local_strategy.prerequisites[0].url',
      ),
      wait: input.wait,
      interaction: input.interaction,
      program: {
        source,
        source_digest: sha256Digest(source),
        arguments: argumentExpression,
        result_shape: { kind: 'object', required_keys: requiredKeys },
        expect: input.expect,
        request_body_limits: input.request_body_limits,
      },
      prerequisites: [],
      replay: input.replay,
    },
    'page_script_export.public_strategy',
  );
  return {
    ...candidate,
    program: {
      ...candidate.program,
      source_digest: null,
    },
  };
}

function compileTemplateValue(
  value: unknown,
  field: string,
  inputSchema: JsonSchemaV1,
  state: { nodes: number },
  depth: number,
): ValueExpressionV1 {
  if (depth > 12) throw new PublicContractError(field, 'exceeds maximum template depth 12');
  state.nodes += 1;
  if (state.nodes > 256) {
    throw new PublicContractError(field, 'exceeds maximum template node count 256');
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new PublicContractError(field, 'must contain only finite JSON numbers');
    }
    return { op: 'literal', value };
  }
  if (typeof value === 'string') return compileTemplateString(value, inputSchema, field);
  if (Array.isArray(value)) {
    if (value.length > 64) {
      throw new PublicContractError(field, 'must contain at most 64 array items');
    }
    return {
      op: 'array',
      items: value.map((item, index) =>
        compileTemplateValue(item, `${field}[${index}]`, inputSchema, state, depth + 1),
      ),
    };
  }
  const record = parseBoundedRecord(value, field, 64);
  return {
    op: 'object',
    fields: Object.fromEntries(
      Object.entries(record).map(([key, item]) => [
        key,
        compileTemplateValue(item, `${field}.${key}`, inputSchema, state, depth + 1),
      ]),
    ),
  };
}

function compileTemplateString(
  value: string,
  inputSchema: JsonSchemaV1,
  field: string,
): ValueExpressionV1 {
  const segments = parseTemplateSegments(value, field);
  if (segments.every((segment) => segment.kind === 'literal')) {
    return { op: 'literal', value };
  }
  const values: ValueExpressionV1[] = segments.map((segment) =>
    segment.kind === 'literal'
      ? { op: 'literal', value: segment.value }
      : {
          op: 'to_string',
          value: {
            op: 'input',
            pointer: scalarRequiredInputPointer(inputSchema, segment.path, field),
          },
        },
  );
  return values.length === 1 ? (values[0] as ValueExpressionV1) : { op: 'concat', values };
}

function parseTemplateSegments(
  value: string,
  field: string,
): Array<{ kind: 'literal'; value: string } | { kind: 'input'; path: string }> {
  const segments: Array<{ kind: 'literal'; value: string } | { kind: 'input'; path: string }> = [];
  let literalStart = 0;
  let cursor = 0;
  while (cursor < value.length - 3) {
    if (value[cursor] !== '{' || value[cursor + 1] !== '{') {
      cursor += 1;
      continue;
    }
    const end = value.indexOf('}}', cursor + 2);
    if (end < 0) break;
    const path = value.slice(cursor + 2, end);
    if (!isSupportedInputPath(path)) {
      throw new PublicContractError(
        field,
        `contains unsupported local placeholder ${JSON.stringify(value.slice(cursor, end + 2))}`,
      );
    }
    if (cursor > literalStart) {
      segments.push({ kind: 'literal', value: value.slice(literalStart, cursor) });
    }
    segments.push({ kind: 'input', path });
    cursor = end + 2;
    literalStart = cursor;
  }
  if (literalStart < value.length) {
    segments.push({ kind: 'literal', value: value.slice(literalStart) });
  }
  if (segments.length === 0) segments.push({ kind: 'literal', value });
  return segments;
}

function scalarRequiredInputPointer(
  schema: JsonSchemaV1,
  path: string,
  field: string,
): ReturnType<typeof parseJsonPointer> {
  let current = schema;
  for (const segment of path.split('.')) {
    if (current.type !== 'object') {
      throw new PublicContractError(
        field,
        `placeholder ${JSON.stringify(path)} does not traverse a required input object path`,
      );
    }
    const next = current.properties[segment];
    if (next === undefined || !current.required.includes(segment)) {
      throw new PublicContractError(
        field,
        `placeholder ${JSON.stringify(path)} must name a required declared input property`,
      );
    }
    current = next;
  }
  if (
    current.type !== 'string' &&
    current.type !== 'number' &&
    current.type !== 'integer' &&
    current.type !== 'boolean'
  ) {
    throw new PublicContractError(
      field,
      `placeholder ${JSON.stringify(path)} must resolve to a string, number, integer, or boolean`,
    );
  }
  return toJsonPointer(path);
}

function isSupportedInputPath(value: string): boolean {
  if (value.length === 0) return false;
  return value.split('.').every((part) => {
    if (part.length === 0) return false;
    for (const character of part) {
      if (!isAsciiWordCharacter(character)) return false;
    }
    return true;
  });
}

function isAsciiWordCharacter(value: string): boolean {
  const code = value.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    code === 95 ||
    (code >= 97 && code <= 122)
  );
}

function toJsonPointer(path: string): ReturnType<typeof parseJsonPointer> {
  const pointer = `/${path
    .split('.')
    .map((part) => part.replaceAll('~', '~0').replaceAll('/', '~1'))
    .join('/')}`;
  return parseJsonPointer(pointer, 'page_script_export.input_pointer');
}

function parseNonEmptyLocalString(value: unknown, field: string, maximumBytes: number): string {
  const parsed = parseString(value, field, maximumBytes);
  if (parsed.length === 0 || parsed.includes('\0')) {
    throw new PublicContractError(field, 'must be non-empty and contain no NUL');
  }
  return parsed;
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new PublicContractError(`${field}.${key}`, 'is not supported by this export profile');
    }
  }
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

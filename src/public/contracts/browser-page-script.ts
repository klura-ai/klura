import {
  parseBoundedRecord,
  parseExactRecord,
  parseInteger,
  parseSha256Digest,
  parseStableContractId,
  parseString,
  PublicContractError,
  sha256Digest,
  type Sha256DigestV1,
  type StableContractIdV1,
} from './common';
import {
  parseBrowserActionExpectation,
  parseBrowserInteractionProgram,
  parseBrowserWait,
  validateBrowserActionExpectationAgainstRules,
  validateBrowserInteractionProgram,
  type BrowserActionExpectationV1,
  type BrowserInteractionProgramV1,
  type BrowserWaitV1,
} from './browser-interaction';
import { parseValueExpression, type ValueExpressionV1 } from './value-expression';
import type { JsonSchemaV1 } from './json-schema';
import type { BrowserResourcePolicyV1 } from '../../consumer/execution/public-browser/resource-policy';

const MAX_BROWSER_PAGE_SCRIPT_BYTES_V1 = 64 * 1024;
const MAX_BROWSER_PAGE_SCRIPT_REQUEST_BODY_BYTES_V1 = 8 * 1024 * 1024;

export interface PublicBrowserPageScriptRequestBodyLimitsV1 {
  max_encoded_request_body_bytes_per_script: number;
  max_single_request_body_bytes: number;
  max_encoded_request_body_bytes_by_rule: Record<StableContractIdV1, number>;
}

export interface PublicBrowserPageScriptProgramV1 {
  source: string;
  source_digest: Sha256DigestV1;
  arguments: ValueExpressionV1;
  result_shape: PublicBrowserPageScriptResultShapeV1;
  expect: BrowserActionExpectationV1;
  request_body_limits: PublicBrowserPageScriptRequestBodyLimitsV1;
}

export interface PublicBrowserPageScriptResultShapeV1 {
  kind: 'object' | 'array';
  required_keys: string[];
}

export interface PublicBrowserPageScriptStrategyV1 {
  kind: 'browser_page_script';
  strategy_id: StableContractIdV1;
  url: ValueExpressionV1;
  wait: BrowserWaitV1;
  interaction: BrowserInteractionProgramV1 | null;
  program: PublicBrowserPageScriptProgramV1;
  prerequisites: [];
  replay: 'safe_read' | 'indeterminate';
}

export function parseBrowserPageScriptStrategy(
  value: unknown,
  field: string,
): PublicBrowserPageScriptStrategyV1 {
  const record = parseExactRecord(value, field, [
    'kind',
    'strategy_id',
    'url',
    'wait',
    'interaction',
    'program',
    'prerequisites',
    'replay',
  ]);
  if (record.kind !== 'browser_page_script') {
    throw new PublicContractError(`${field}.kind`, 'must be browser_page_script');
  }
  if (!Array.isArray(record.prerequisites) || record.prerequisites.length !== 0) {
    throw new PublicContractError(
      `${field}.prerequisites`,
      'must be an empty array in the reviewed browser page-script profile',
    );
  }
  if (record.replay !== 'safe_read' && record.replay !== 'indeterminate') {
    throw new PublicContractError(`${field}.replay`, 'must be safe_read or indeterminate');
  }
  return {
    kind: 'browser_page_script',
    strategy_id: parseStableContractId(record.strategy_id, `${field}.strategy_id`),
    url: parseValueExpression(record.url, `${field}.url`),
    wait: parseBrowserWait(record.wait, `${field}.wait`),
    interaction:
      record.interaction === null
        ? null
        : parseBrowserInteractionProgram(record.interaction, `${field}.interaction`),
    program: parseBrowserPageScriptProgram(record.program, `${field}.program`),
    prerequisites: [],
    replay: record.replay,
  };
}

export function validateBrowserPageScriptStrategy(
  strategy: PublicBrowserPageScriptStrategyV1,
  navigationOrigin: string,
  policy: BrowserResourcePolicyV1,
  inputSchema: JsonSchemaV1,
  field: string,
): void {
  validatePageScriptArgumentExpression(
    strategy.program.arguments,
    inputSchema,
    `${field}.program.arguments`,
  );
  if (strategy.interaction !== null) {
    if (strategy.interaction.repeat !== null) {
      throw new PublicContractError(
        `${field}.interaction.repeat`,
        'must be null because page-script preparation does not project intermediate rounds',
      );
    }
    validateBrowserInteractionProgram(strategy.interaction, 'one', policy, `${field}.interaction`);
    const interactionRules = new Map(
      policy.egress_rules
        .filter((rule) => rule.phase === 'interaction')
        .map((rule) => [rule.rule_id, rule]),
    );
    for (const [index, action] of strategy.interaction.initial.entries()) {
      if (
        'frame' in action.target &&
        action.target.frame.kind === 'child' &&
        action.target.frame.origin !== navigationOrigin
      ) {
        throw new PublicContractError(
          `${field}.interaction.initial[${index}].target.frame.origin`,
          'must equal the sole reviewed page-script origin',
        );
      }
      for (const ruleId of action.expect.egress_rule_ids) {
        if (interactionRules.get(ruleId)?.origin !== navigationOrigin) {
          throw new PublicContractError(
            `${field}.interaction.initial[${index}].expect.egress_rule_ids`,
            'must reference only same-origin interaction rules in the reviewed page-script profile',
          );
        }
      }
    }
  }
  if (
    policy.egress_rules.some(
      (rule) => rule.phase === 'navigation' && rule.origin !== navigationOrigin,
    )
  ) {
    throw new PublicContractError(
      `${field}.url`,
      'requires every navigation rule to stay on the sole reviewed page-script origin',
    );
  }
  const scriptRules = new Map(
    policy.egress_rules
      .filter((rule) => rule.phase === 'page_script')
      .map((rule) => [rule.rule_id, rule]),
  );
  validateBrowserActionExpectationAgainstRules(
    strategy.program.expect,
    scriptRules,
    `${field}.program.expect`,
    'page_script',
  );
  const expectedRuleIds = strategy.program.expect.egress_rule_ids;
  const bodyLimitRuleIds = Object.keys(
    strategy.program.request_body_limits.max_encoded_request_body_bytes_by_rule,
  ).sort(compareText);
  if (
    expectedRuleIds.length !== bodyLimitRuleIds.length ||
    expectedRuleIds.some((ruleId, index) => ruleId !== bodyLimitRuleIds[index])
  ) {
    throw new PublicContractError(
      `${field}.program.request_body_limits.max_encoded_request_body_bytes_by_rule`,
      'must name every script egress rule exactly once',
    );
  }
  if (
    strategy.program.request_body_limits.max_encoded_request_body_bytes_per_script >
      policy.max_encoded_request_body_bytes_per_browser_task ||
    strategy.program.request_body_limits.max_single_request_body_bytes >
      policy.max_single_request_body_bytes
  ) {
    throw new PublicContractError(
      `${field}.program.request_body_limits`,
      'must stay within the enclosing browser resource body limits',
    );
  }
  for (const ruleId of expectedRuleIds) {
    const rule = scriptRules.get(ruleId);
    if (rule?.origin !== navigationOrigin) {
      throw new PublicContractError(
        `${field}.program.expect.egress_rule_ids`,
        'must reference only same-origin page_script rules',
      );
    }
    if (
      (strategy.program.request_body_limits.max_encoded_request_body_bytes_by_rule[ruleId] ?? 0) >
      rule.max_encoded_request_body_bytes
    ) {
      throw new PublicContractError(
        `${field}.program.request_body_limits.max_encoded_request_body_bytes_by_rule.${ruleId}`,
        'must not exceed the enclosing browser egress rule body limit',
      );
    }
  }
}

function validatePageScriptArgumentExpression(
  expression: ValueExpressionV1,
  inputSchema: JsonSchemaV1,
  field: string,
): void {
  if (expression.op === 'literal') return;
  if (expression.op === 'binding') {
    throw new PublicContractError(
      field,
      'cannot read a binding because reviewed page scripts have no public prerequisites',
    );
  }
  if (expression.op === 'input') {
    resolveGuaranteedInputSchema(inputSchema, expression.pointer, field);
    return;
  }
  if (expression.op === 'object') {
    for (const [key, value] of Object.entries(expression.fields)) {
      validatePageScriptArgumentExpression(value, inputSchema, `${field}.fields.${key}`);
    }
    return;
  }
  if (expression.op === 'array') {
    for (const [index, value] of expression.items.entries()) {
      validatePageScriptArgumentExpression(value, inputSchema, `${field}[${index}]`);
    }
    return;
  }
  if (expression.op === 'concat') {
    for (const [index, value] of expression.values.entries()) {
      validatePageScriptArgumentExpression(value, inputSchema, `${field}[${index}]`);
    }
    return;
  }
  if (expression.op === 'hmac_sha256') {
    validatePageScriptArgumentExpression(expression.key, inputSchema, `${field}.key`);
    validatePageScriptArgumentExpression(expression.value, inputSchema, `${field}.value`);
    return;
  }
  if (expression.op === 'to_string' && expression.value.op === 'input') {
    const schema = resolveGuaranteedInputSchema(inputSchema, expression.value.pointer, field);
    if (
      schema.type !== 'string' &&
      schema.type !== 'number' &&
      schema.type !== 'integer' &&
      schema.type !== 'boolean'
    ) {
      throw new PublicContractError(
        field,
        'can stringify only a required string, number, integer, or boolean input',
      );
    }
  }
  validatePageScriptArgumentExpression(expression.value, inputSchema, `${field}.value`);
}

function resolveGuaranteedInputSchema(
  root: JsonSchemaV1,
  pointer: string,
  field: string,
): JsonSchemaV1 {
  let current = root;
  if (pointer.length === 0) return current;
  for (const encodedToken of pointer.slice(1).split('/')) {
    const token = encodedToken.replace(/~1/g, '/').replace(/~0/g, '~');
    if (current.type === 'object') {
      const next = current.properties[token];
      if (next === undefined || !current.required.includes(token)) {
        throw new PublicContractError(
          field,
          `input pointer ${JSON.stringify(pointer)} must traverse required declared properties`,
        );
      }
      current = next;
      continue;
    }
    if (current.type === 'array' && /^(?:0|[1-9]\d*)$/.test(token)) {
      const index = Number(token);
      if (current.minItems === null || index >= current.minItems) {
        throw new PublicContractError(
          field,
          `input pointer ${JSON.stringify(pointer)} must name a guaranteed array item`,
        );
      }
      current = current.items;
      continue;
    }
    throw new PublicContractError(
      field,
      `input pointer ${JSON.stringify(pointer)} does not follow its input schema`,
    );
  }
  return current;
}

function parseBrowserPageScriptProgram(
  value: unknown,
  field: string,
): PublicBrowserPageScriptProgramV1 {
  const record = parseExactRecord(value, field, [
    'source',
    'source_digest',
    'arguments',
    'result_shape',
    'expect',
    'request_body_limits',
  ]);
  const source = parseString(record.source, `${field}.source`, MAX_BROWSER_PAGE_SCRIPT_BYTES_V1);
  if (source.length === 0 || source.includes('\0')) {
    throw new PublicContractError(`${field}.source`, 'must be non-empty and contain no NUL');
  }
  const sourceDigest = parseSha256Digest(record.source_digest, `${field}.source_digest`);
  if (sourceDigest !== sha256Digest(source)) {
    throw new PublicContractError(
      `${field}.source_digest`,
      'does not match the exact reviewed source bytes',
    );
  }
  return {
    source,
    source_digest: sourceDigest,
    arguments: parseValueExpression(record.arguments, `${field}.arguments`),
    result_shape: parseBrowserPageScriptResultShape(record.result_shape, `${field}.result_shape`),
    expect: parseBrowserActionExpectation(record.expect, `${field}.expect`),
    request_body_limits: parseBrowserPageScriptRequestBodyLimits(
      record.request_body_limits,
      `${field}.request_body_limits`,
    ),
  };
}

function parseBrowserPageScriptResultShape(
  value: unknown,
  field: string,
): PublicBrowserPageScriptResultShapeV1 {
  const record = parseExactRecord(value, field, ['kind', 'required_keys']);
  if (record.kind !== 'object' && record.kind !== 'array') {
    throw new PublicContractError(`${field}.kind`, 'must be object or array');
  }
  if (!Array.isArray(record.required_keys) || record.required_keys.length > 64) {
    throw new PublicContractError(`${field}.required_keys`, 'must contain at most 64 keys');
  }
  const requiredKeys = record.required_keys.map((candidate, index) => {
    const key = parseString(candidate, `${field}.required_keys[${index}]`, 256);
    if (key.length === 0 || key.includes('\0')) {
      throw new PublicContractError(
        `${field}.required_keys[${index}]`,
        'must be non-empty and contain no NUL',
      );
    }
    return key;
  });
  if (
    new Set(requiredKeys).size !== requiredKeys.length ||
    requiredKeys.some((key, index) => index > 0 && (requiredKeys[index - 1] ?? '') >= key)
  ) {
    throw new PublicContractError(
      `${field}.required_keys`,
      'must be sorted in canonical order without duplicates',
    );
  }
  if (record.kind === 'array' && requiredKeys.length > 0) {
    throw new PublicContractError(
      `${field}.required_keys`,
      'must be empty when result kind is array',
    );
  }
  return { kind: record.kind, required_keys: requiredKeys };
}

function parseBrowserPageScriptRequestBodyLimits(
  value: unknown,
  field: string,
): PublicBrowserPageScriptRequestBodyLimitsV1 {
  const record = parseExactRecord(value, field, [
    'max_encoded_request_body_bytes_per_script',
    'max_single_request_body_bytes',
    'max_encoded_request_body_bytes_by_rule',
  ]);
  const total = parseInteger(
    record.max_encoded_request_body_bytes_per_script,
    `${field}.max_encoded_request_body_bytes_per_script`,
    0,
    MAX_BROWSER_PAGE_SCRIPT_REQUEST_BODY_BYTES_V1,
  );
  const single = parseInteger(
    record.max_single_request_body_bytes,
    `${field}.max_single_request_body_bytes`,
    0,
    total,
  );
  const byRuleRecord = parseBoundedRecord(
    record.max_encoded_request_body_bytes_by_rule,
    `${field}.max_encoded_request_body_bytes_by_rule`,
    32,
  );
  const byRule = {} as Record<StableContractIdV1, number>;
  for (const [key, candidate] of Object.entries(byRuleRecord)) {
    const ruleId = parseStableContractId(
      key,
      `${field}.max_encoded_request_body_bytes_by_rule key`,
    );
    byRule[ruleId] = parseInteger(
      candidate,
      `${field}.max_encoded_request_body_bytes_by_rule.${ruleId}`,
      0,
      single,
    );
  }
  return {
    max_encoded_request_body_bytes_per_script: total,
    max_single_request_body_bytes: single,
    max_encoded_request_body_bytes_by_rule: byRule,
  };
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

import {
  parseBoundedRecord,
  parseExactRecord,
  parseHttpsOrigin,
  parseInteger,
  parseStableContractId,
  parseString,
  PublicContractError,
  type StableContractIdV1,
} from './common';
import { parseCssSelector } from './css-selector';
import { parseValueExpression, type ValueExpressionV1 } from './value-expression';
import { type BrowserResourcePolicyV1 } from '../../consumer/execution/public-browser/resource-policy';

const MAX_BROWSER_ACTIONS_V1 = 64;
const MAX_BROWSER_ACTION_EGRESS_RULES_V1 = 32;
const MAX_BROWSER_INTERACTION_ROUNDS_V1 = 128;
const MAX_BROWSER_REQUESTS_PER_ACTION_V1 = 256;
const MAX_DOM_PREDICATE_DEPTH_V1 = 8;
const MAX_DOM_PREDICATE_NODES_V1 = 128;

export type BrowserWaitV1 =
  | { kind: 'dom_content_loaded' }
  | { kind: 'selector'; selector: string; state: 'attached' | 'visible'; minimum_count: number }
  | { kind: 'network_quiet'; quiet_ms: number; maximum_in_flight: number };

export type BrowserTargetV1 = {
  frame: { kind: 'main' } | { kind: 'child'; frame_selector: string; origin: string };
  selector: string;
};

export interface BrowserActionExpectationV1 {
  wait: BrowserWaitV1 | null;
  egress_rule_ids: StableContractIdV1[];
  minimum_matching_requests: number;
  maximum_matching_requests: number;
}

export type BrowserActionV1 =
  | {
      action_id: StableContractIdV1;
      kind: 'click';
      target: BrowserTargetV1;
      expect: BrowserActionExpectationV1;
    }
  | {
      action_id: StableContractIdV1;
      kind: 'fill' | 'select_option';
      target: BrowserTargetV1;
      value: ValueExpressionV1;
      expect: BrowserActionExpectationV1;
    }
  | {
      action_id: StableContractIdV1;
      kind: 'press_enter';
      target: BrowserTargetV1;
      expect: BrowserActionExpectationV1;
    }
  | {
      action_id: StableContractIdV1;
      kind: 'scroll';
      target: { kind: 'window' } | BrowserTargetV1;
      amount: 'one_viewport';
      direction: 'down';
      expect: BrowserActionExpectationV1;
    }
  | {
      action_id: StableContractIdV1;
      kind: 'dismiss_if_present';
      target: BrowserTargetV1;
      expect: BrowserActionExpectationV1;
    };

export type DomPredicateV1 =
  | { op: 'all' | 'any'; items: [DomPredicateV1, ...DomPredicateV1[]] }
  | { op: 'not'; item: DomPredicateV1 }
  | {
      op: 'selector_count';
      selector: string;
      compare: 'eq' | 'lt' | 'lte' | 'gt' | 'gte';
      value: number;
    }
  | {
      op: 'attribute';
      selector: string;
      attribute: string;
      test: 'exists' | 'equals';
      value: string | null;
    };

export interface BrowserInteractionProgramV1 {
  initial: BrowserActionV1[];
  repeat: null | {
    actions: [BrowserActionV1, ...BrowserActionV1[]];
    continue_when: DomPredicateV1;
    exhausted_when: DomPredicateV1;
    maximum_rounds: number;
    projection_schedule: 'final_only' | 'initial_and_each_round';
  };
}

export function parseBrowserWait(value: unknown, field: string): BrowserWaitV1 {
  const record = parseBoundedRecord(value, field, 4);
  if (record.kind === 'dom_content_loaded' && Object.keys(record).length === 1) {
    return { kind: 'dom_content_loaded' };
  }
  if (record.kind === 'selector') {
    const selector = parseExactRecord(record, field, [
      'kind',
      'selector',
      'state',
      'minimum_count',
    ]);
    if (selector.state !== 'attached' && selector.state !== 'visible') {
      throw new PublicContractError(`${field}.state`, 'must be attached or visible');
    }
    return {
      kind: 'selector',
      selector: parseCssSelector(selector.selector, `${field}.selector`),
      state: selector.state,
      minimum_count: parseInteger(selector.minimum_count, `${field}.minimum_count`, 1, 128),
    };
  }
  if (record.kind === 'network_quiet') {
    const network = parseExactRecord(record, field, ['kind', 'quiet_ms', 'maximum_in_flight']);
    return {
      kind: 'network_quiet',
      quiet_ms: parseInteger(network.quiet_ms, `${field}.quiet_ms`, 100, 10_000),
      maximum_in_flight: parseInteger(
        network.maximum_in_flight,
        `${field}.maximum_in_flight`,
        0,
        32,
      ),
    };
  }
  throw new PublicContractError(`${field}.kind`, 'must be a browser wait kind');
}

export function parseBrowserInteractionProgram(
  value: unknown,
  field: string,
): BrowserInteractionProgramV1 {
  const record = parseExactRecord(value, field, ['initial', 'repeat']);
  const initial = parseBrowserActions(record.initial, `${field}.initial`, true);
  const repeat =
    record.repeat === null ? null : parseBrowserInteractionRepeat(record.repeat, `${field}.repeat`);
  if (initial.length === 0 && repeat === null) {
    throw new PublicContractError(field, 'must declare an initial action or a repeat program');
  }
  const actionIds = new Set<string>();
  for (const action of [...initial, ...(repeat?.actions ?? [])]) {
    if (actionIds.has(action.action_id)) {
      throw new PublicContractError(
        field,
        `duplicates action_id ${JSON.stringify(action.action_id)}`,
      );
    }
    actionIds.add(action.action_id);
  }
  return { initial, repeat };
}

export function validateBrowserInteractionProgram(
  interaction: BrowserInteractionProgramV1,
  projectionCardinality: 'one' | 'array',
  policy: BrowserResourcePolicyV1,
  field: string,
): void {
  if (
    interaction.repeat?.projection_schedule === 'initial_and_each_round' &&
    projectionCardinality !== 'array'
  ) {
    throw new PublicContractError(
      `${field}.repeat.projection_schedule`,
      'requires an array DOM projection',
    );
  }
  const interactionRules = new Map(
    policy.egress_rules
      .filter((rule) => rule.phase === 'interaction')
      .map((rule) => [rule.rule_id, rule]),
  );
  const childOrigins = new Set(policy.egress_rules.map((rule) => rule.origin));
  const actions = [...interaction.initial, ...(interaction.repeat?.actions ?? [])];
  for (const [index, action] of actions.entries()) {
    const actionField = actionPath(field, index, interaction.initial.length);
    validateBrowserActionExpectationAgainstRules(
      action.expect,
      interactionRules,
      `${actionField}.expect`,
      'interaction',
    );
    const target = getActionTarget(action);
    if (target?.frame.kind === 'child' && !childOrigins.has(target.frame.origin)) {
      throw new PublicContractError(
        `${actionField}.target.frame.origin`,
        'must be covered by a browser resource origin',
      );
    }
  }
}

export function validateBrowserActionExpectationAgainstRules(
  expectation: BrowserActionExpectationV1,
  rules: ReadonlyMap<StableContractIdV1, { max_requests: number }>,
  field: string,
  phase: 'interaction' | 'page_script',
): void {
  for (const ruleId of expectation.egress_rule_ids) {
    if (!rules.has(ruleId)) {
      throw new PublicContractError(
        `${field}.egress_rule_ids`,
        `must reference a ${phase} egress rule: ${JSON.stringify(ruleId)}`,
      );
    }
  }
  const maximum = expectation.egress_rule_ids.reduce(
    (total, ruleId) => total + (rules.get(ruleId)?.max_requests ?? 0),
    0,
  );
  if (expectation.maximum_matching_requests > maximum) {
    throw new PublicContractError(
      `${field}.maximum_matching_requests`,
      `exceeds the declared ${phase} egress-rule budget`,
    );
  }
}

function parseBrowserInteractionRepeat(
  value: unknown,
  field: string,
): NonNullable<BrowserInteractionProgramV1['repeat']> {
  const record = parseExactRecord(value, field, [
    'actions',
    'continue_when',
    'exhausted_when',
    'maximum_rounds',
    'projection_schedule',
  ]);
  if (
    record.projection_schedule !== 'final_only' &&
    record.projection_schedule !== 'initial_and_each_round'
  ) {
    throw new PublicContractError(
      `${field}.projection_schedule`,
      'must be final_only or initial_and_each_round',
    );
  }
  const actions = parseBrowserActions(record.actions, `${field}.actions`, false);
  if (actions.length === 0) {
    throw new PublicContractError(`${field}.actions`, 'must contain at least one browser action');
  }
  const predicateState = { nodes: 0 };
  return {
    actions: actions as [BrowserActionV1, ...BrowserActionV1[]],
    continue_when: parseDomPredicate(
      record.continue_when,
      `${field}.continue_when`,
      0,
      predicateState,
    ),
    exhausted_when: parseDomPredicate(
      record.exhausted_when,
      `${field}.exhausted_when`,
      0,
      predicateState,
    ),
    maximum_rounds: parseInteger(
      record.maximum_rounds,
      `${field}.maximum_rounds`,
      1,
      MAX_BROWSER_INTERACTION_ROUNDS_V1,
    ),
    projection_schedule: record.projection_schedule,
  };
}

function parseBrowserActions(value: unknown, field: string, initial: boolean): BrowserActionV1[] {
  if (!Array.isArray(value) || value.length > MAX_BROWSER_ACTIONS_V1) {
    throw new PublicContractError(
      field,
      `must contain at most ${MAX_BROWSER_ACTIONS_V1} browser actions`,
    );
  }
  const actions = value.map((candidate, index) =>
    parseBrowserAction(candidate, `${field}[${index}]`),
  );
  const dismisses = actions.filter((action) => action.kind === 'dismiss_if_present');
  if (!initial && dismisses.length > 0) {
    throw new PublicContractError(field, 'must not contain dismiss_if_present in a repeat program');
  }
  if (dismisses.length > 1) {
    throw new PublicContractError(field, 'must contain dismiss_if_present at most once');
  }
  return actions;
}

function parseBrowserAction(value: unknown, field: string): BrowserActionV1 {
  const record = parseBoundedRecord(value, field, 6);
  const actionId = parseStableContractId(record.action_id, `${field}.action_id`);
  const expect = parseBrowserActionExpectation(record.expect, `${field}.expect`);
  if (
    record.kind === 'click' ||
    record.kind === 'press_enter' ||
    record.kind === 'dismiss_if_present'
  ) {
    const action = parseExactRecord(record, field, ['action_id', 'kind', 'target', 'expect']);
    const target = parseBrowserTarget(action.target, `${field}.target`);
    if (record.kind === 'click') return { action_id: actionId, kind: 'click', target, expect };
    if (record.kind === 'press_enter') {
      return { action_id: actionId, kind: 'press_enter', target, expect };
    }
    if (expect.wait !== null || expect.minimum_matching_requests !== 0) {
      throw new PublicContractError(
        `${field}.expect`,
        'dismiss_if_present must have null wait and zero minimum matching requests',
      );
    }
    return { action_id: actionId, kind: 'dismiss_if_present', target, expect };
  }
  if (record.kind === 'fill' || record.kind === 'select_option') {
    const action = parseExactRecord(record, field, [
      'action_id',
      'kind',
      'target',
      'value',
      'expect',
    ]);
    const target = parseBrowserTarget(action.target, `${field}.target`);
    return {
      action_id: actionId,
      kind: record.kind,
      target,
      value: parseValueExpression(action.value, `${field}.value`),
      expect,
    };
  }
  if (record.kind === 'scroll') {
    const action = parseExactRecord(record, field, [
      'action_id',
      'kind',
      'target',
      'amount',
      'direction',
      'expect',
    ]);
    if (action.amount !== 'one_viewport' || action.direction !== 'down') {
      throw new PublicContractError(field, 'scroll must be one_viewport down');
    }
    return {
      action_id: actionId,
      kind: 'scroll',
      target: parseBrowserScrollTarget(action.target, `${field}.target`),
      amount: 'one_viewport',
      direction: 'down',
      expect,
    };
  }
  throw new PublicContractError(`${field}.kind`, 'must be a browser action kind');
}

function parseBrowserTarget(value: unknown, field: string): BrowserTargetV1 {
  const record = parseExactRecord(value, field, ['frame', 'selector']);
  const frame = parseBoundedRecord(record.frame, `${field}.frame`, 3);
  if (frame.kind === 'main' && Object.keys(frame).length === 1) {
    return {
      frame: { kind: 'main' },
      selector: parseCssSelector(record.selector, `${field}.selector`),
    };
  }
  const child = parseExactRecord(frame, `${field}.frame`, ['kind', 'frame_selector', 'origin']);
  if (child.kind !== 'child') {
    throw new PublicContractError(`${field}.frame.kind`, 'must be main or child');
  }
  return {
    frame: {
      kind: 'child',
      frame_selector: parseCssSelector(child.frame_selector, `${field}.frame.frame_selector`),
      origin: parseHttpsOrigin(child.origin, `${field}.frame.origin`),
    },
    selector: parseCssSelector(record.selector, `${field}.selector`),
  };
}

function parseBrowserScrollTarget(
  value: unknown,
  field: string,
): { kind: 'window' } | BrowserTargetV1 {
  const record = parseBoundedRecord(value, field, 3);
  if (record.kind === 'window' && Object.keys(record).length === 1) return { kind: 'window' };
  return parseBrowserTarget(value, field);
}

export function parseBrowserActionExpectation(
  value: unknown,
  field: string,
): BrowserActionExpectationV1 {
  const record = parseExactRecord(value, field, [
    'wait',
    'egress_rule_ids',
    'minimum_matching_requests',
    'maximum_matching_requests',
  ]);
  if (
    !Array.isArray(record.egress_rule_ids) ||
    record.egress_rule_ids.length > MAX_BROWSER_ACTION_EGRESS_RULES_V1
  ) {
    throw new PublicContractError(
      `${field}.egress_rule_ids`,
      `must contain at most ${MAX_BROWSER_ACTION_EGRESS_RULES_V1} rule IDs`,
    );
  }
  const ruleIds = record.egress_rule_ids.map((candidate, index) =>
    parseStableContractId(candidate, `${field}.egress_rule_ids[${index}]`),
  );
  assertCanonicalSortedUnique(ruleIds, `${field}.egress_rule_ids`);
  const minimum = parseInteger(
    record.minimum_matching_requests,
    `${field}.minimum_matching_requests`,
    0,
    MAX_BROWSER_REQUESTS_PER_ACTION_V1,
  );
  const maximum = parseInteger(
    record.maximum_matching_requests,
    `${field}.maximum_matching_requests`,
    0,
    MAX_BROWSER_REQUESTS_PER_ACTION_V1,
  );
  if (minimum > maximum) {
    throw new PublicContractError(
      `${field}.minimum_matching_requests`,
      'must not exceed maximum_matching_requests',
    );
  }
  if (ruleIds.length === 0 && maximum !== 0) {
    throw new PublicContractError(
      `${field}.maximum_matching_requests`,
      'must be zero when no egress rules are declared',
    );
  }
  return {
    wait: record.wait === null ? null : parseBrowserWait(record.wait, `${field}.wait`),
    egress_rule_ids: ruleIds,
    minimum_matching_requests: minimum,
    maximum_matching_requests: maximum,
  };
}

function parseDomPredicate(
  value: unknown,
  field: string,
  depth: number,
  state: { nodes: number },
): DomPredicateV1 {
  if (depth > MAX_DOM_PREDICATE_DEPTH_V1) {
    throw new PublicContractError(
      field,
      `must not exceed ${MAX_DOM_PREDICATE_DEPTH_V1} predicate levels`,
    );
  }
  state.nodes += 1;
  if (state.nodes > MAX_DOM_PREDICATE_NODES_V1) {
    throw new PublicContractError(
      field,
      `must not exceed ${MAX_DOM_PREDICATE_NODES_V1} predicate nodes`,
    );
  }
  const record = parseBoundedRecord(value, field, 5);
  if (record.op === 'all' || record.op === 'any') {
    const compound = parseExactRecord(record, field, ['op', 'items']);
    if (
      !Array.isArray(compound.items) ||
      compound.items.length === 0 ||
      compound.items.length > 16
    ) {
      throw new PublicContractError(`${field}.items`, 'must contain one to 16 DOM predicates');
    }
    return {
      op: record.op,
      items: compound.items.map((item, index) =>
        parseDomPredicate(item, `${field}.items[${index}]`, depth + 1, state),
      ) as [DomPredicateV1, ...DomPredicateV1[]],
    };
  }
  if (record.op === 'not') {
    const negation = parseExactRecord(record, field, ['op', 'item']);
    return {
      op: 'not',
      item: parseDomPredicate(negation.item, `${field}.item`, depth + 1, state),
    };
  }
  if (record.op === 'selector_count') {
    const selectorCount = parseExactRecord(record, field, ['op', 'selector', 'compare', 'value']);
    if (!['eq', 'lt', 'lte', 'gt', 'gte'].includes(selectorCount.compare as string)) {
      throw new PublicContractError(`${field}.compare`, 'must be a selector-count comparator');
    }
    return {
      op: 'selector_count',
      selector: parseCssSelector(selectorCount.selector, `${field}.selector`),
      compare: selectorCount.compare as Extract<
        DomPredicateV1,
        { op: 'selector_count' }
      >['compare'],
      value: parseInteger(selectorCount.value, `${field}.value`, 0, 65_536),
    };
  }
  if (record.op === 'attribute') {
    const attribute = parseExactRecord(record, field, [
      'op',
      'selector',
      'attribute',
      'test',
      'value',
    ]);
    if (attribute.test !== 'exists' && attribute.test !== 'equals') {
      throw new PublicContractError(`${field}.test`, 'must be exists or equals');
    }
    if (attribute.test === 'exists' && attribute.value !== null) {
      throw new PublicContractError(`${field}.value`, 'must be null when attribute test is exists');
    }
    if (attribute.test === 'equals' && typeof attribute.value !== 'string') {
      throw new PublicContractError(
        `${field}.value`,
        'must be a string when attribute test is equals',
      );
    }
    return {
      op: 'attribute',
      selector: parseCssSelector(attribute.selector, `${field}.selector`),
      attribute: parseDomAttribute(attribute.attribute, `${field}.attribute`),
      test: attribute.test,
      value:
        attribute.test === 'equals' ? parseString(attribute.value, `${field}.value`, 2_048) : null,
    };
  }
  throw new PublicContractError(`${field}.op`, 'must be a DOM predicate operator');
}

function actionPath(field: string, index: number, initialLength: number): string {
  if (index < initialLength) return `${field}.initial[${index}]`;
  return `${field}.repeat.actions[${index - initialLength}]`;
}

function getActionTarget(action: BrowserActionV1): BrowserTargetV1 | null {
  if (action.kind !== 'scroll') return action.target;
  return isWindowScrollTarget(action.target) ? null : action.target;
}

function isWindowScrollTarget(
  target: BrowserTargetV1 | { kind: 'window' },
): target is { kind: 'window' } {
  return 'kind' in target;
}

function parseDomAttribute(value: unknown, field: string): string {
  const attribute = parseString(value, field, 128);
  if (attribute.length === 0 || attribute.includes('\0')) {
    throw new PublicContractError(field, 'must be a non-empty DOM attribute name without NUL');
  }
  return attribute;
}

function assertCanonicalSortedUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) {
    throw new PublicContractError(field, 'must not contain duplicates');
  }
  if (values.some((value, index) => index > 0 && (values[index - 1] ?? '') >= value)) {
    throw new PublicContractError(field, 'must be sorted in canonical order without duplicates');
  }
}

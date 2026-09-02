import { type Frame, type Locator, type Page } from 'playwright';
import { sha256Digest } from '../../../public/contracts/common';
import type { JsonValueV1 } from '../../../public/contracts/json';
import { canonicalJson } from '../../../public/contracts/json';
import {
  type BrowserActionExpectationV1,
  type BrowserActionV1,
  type BrowserInteractionProgramV1,
  type BrowserTargetV1,
  type BrowserWaitV1,
  type DomPredicateV1,
} from '../../../public/contracts/browser-interaction';
import {
  evaluateValueExpression,
  type ValueExpressionContextV1,
} from '../../../public/contracts/value-expression';
import type { DomProjectionV1 } from '../../../public/contracts/package';
import { projectBrowserDom } from './dom-projection';

export interface BrowserInteractionFailureV1 {
  kind: 'browser_interaction_failed';
  strategy_id: string;
  code:
    | 'target_not_found'
    | 'target_ambiguous'
    | 'value_invalid'
    | 'action_failed'
    | 'action_egress_mismatch'
    | 'wait_failed'
    | 'interaction_indeterminate'
    | 'interaction_stalled'
    | 'interaction_limit_exhausted'
    | 'aggregation_too_large';
  action_id: string | null;
  round: number;
}

export class BrowserInteractionExecutionError extends Error {
  constructor(
    public readonly failure: BrowserInteractionFailureV1,
    message: string,
  ) {
    super(message);
    this.name = 'BrowserInteractionExecutionError';
  }
}

export interface BrowserInteractionActionScopeV1 {
  action_id: string;
}

export interface BrowserInteractionNetworkBoundaryV1 {
  beginAction(action: BrowserActionV1): BrowserInteractionActionScopeV1;
  finishAction(
    scope: BrowserInteractionActionScopeV1,
    expect: BrowserActionExpectationV1,
    signal: AbortSignal,
  ): Promise<void>;
  abortAction(scope: BrowserInteractionActionScopeV1): void;
  waitForQuiet(
    wait: Extract<BrowserWaitV1, { kind: 'network_quiet' }>,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface BrowserInteractionExecutionInputV1 {
  page: Page;
  program: BrowserInteractionProgramV1;
  projection: DomProjectionV1;
  maximum_output_bytes: number;
  expression_context: ValueExpressionContextV1;
  strategy_id: string;
  network: BrowserInteractionNetworkBoundaryV1;
  signal: AbortSignal;
  timeout_ms: number;
}

export async function executeBrowserInteractionProgram(
  input: BrowserInteractionExecutionInputV1,
): Promise<JsonValueV1 | null> {
  await executeActions(input, input.program.initial, 0);
  const repeat = input.program.repeat;
  if (repeat === null) return null;

  const aggregate = createAggregate(repeat.projection_schedule);
  let previousDigest: string | null = null;
  if (repeat.projection_schedule === 'initial_and_each_round') {
    const initialProjection = await projectBrowserDom(
      input.page,
      input.projection,
      input.maximum_output_bytes,
    );
    previousDigest = sha256Digest(canonicalJson(initialProjection));
    appendProjection(
      aggregate,
      initialProjection,
      input.maximum_output_bytes,
      input.strategy_id,
      null,
      0,
    );
  }

  for (let round = 1; round <= repeat.maximum_rounds; round += 1) {
    await executeActions(input, repeat.actions, round);
    const projection = await projectBrowserDom(
      input.page,
      input.projection,
      input.maximum_output_bytes,
    );
    const digest = sha256Digest(canonicalJson(projection));
    if (digest === previousDigest) {
      throw interactionError(input.strategy_id, 'interaction_stalled', null, round);
    }
    previousDigest = digest;
    if (repeat.projection_schedule === 'initial_and_each_round') {
      appendProjection(
        aggregate,
        projection,
        input.maximum_output_bytes,
        input.strategy_id,
        null,
        round,
      );
    }
    const continues = await evaluateDomPredicate(input.page, repeat.continue_when);
    const exhausted = await evaluateDomPredicate(input.page, repeat.exhausted_when);
    if (continues === exhausted) {
      throw interactionError(input.strategy_id, 'interaction_indeterminate', null, round);
    }
    if (exhausted) {
      return repeat.projection_schedule === 'final_only' ? projection : aggregate.items;
    }
  }
  throw interactionError(
    input.strategy_id,
    'interaction_limit_exhausted',
    null,
    repeat.maximum_rounds,
  );
}

async function executeActions(
  input: BrowserInteractionExecutionInputV1,
  actions: readonly BrowserActionV1[],
  round: number,
): Promise<void> {
  for (const action of actions) await executeAction(input, action, round);
}

async function executeAction(
  input: BrowserInteractionExecutionInputV1,
  action: BrowserActionV1,
  round: number,
): Promise<void> {
  let target: Locator | null;
  try {
    target = await resolveActionTarget(input.page, action, input.strategy_id, round);
  } catch (error) {
    if (error instanceof BrowserInteractionExecutionError) throw error;
    throw interactionError(input.strategy_id, 'action_failed', action.action_id, round, error);
  }
  if (target === null) return;
  const scope = input.network.beginAction(action);
  try {
    await invokeAction(input, action, target, round);
    if (action.expect.wait !== null) {
      try {
        await waitForBrowserAction(
          input.page,
          input.network,
          action.expect.wait,
          input.signal,
          input.timeout_ms,
        );
      } catch (error) {
        throw interactionError(input.strategy_id, 'wait_failed', action.action_id, round, error);
      }
    }
    try {
      await input.network.finishAction(scope, action.expect, input.signal);
    } catch (error) {
      throw interactionError(
        input.strategy_id,
        'action_egress_mismatch',
        action.action_id,
        round,
        error,
      );
    }
  } catch (error) {
    input.network.abortAction(scope);
    if (error instanceof BrowserInteractionExecutionError) throw error;
    throw interactionError(input.strategy_id, 'action_failed', action.action_id, round, error);
  }
}

async function invokeAction(
  input: BrowserInteractionExecutionInputV1,
  action: BrowserActionV1,
  target: Locator,
  round: number,
): Promise<void> {
  try {
    if (action.kind === 'click' || action.kind === 'dismiss_if_present') {
      await target.click({ timeout: input.timeout_ms });
      return;
    }
    if (action.kind === 'press_enter') {
      await target.press('Enter', { timeout: input.timeout_ms });
      return;
    }
    if (action.kind === 'fill' || action.kind === 'select_option') {
      const value = evaluateValueExpression(action.value, input.expression_context);
      if (typeof value !== 'string') {
        throw interactionError(input.strategy_id, 'value_invalid', action.action_id, round);
      }
      if (action.kind === 'fill') {
        await target.fill(value, { timeout: input.timeout_ms });
      } else {
        await target.selectOption(value, { timeout: input.timeout_ms });
      }
      return;
    }
    await target.scrollIntoViewIfNeeded({ timeout: input.timeout_ms });
    const viewportHeight = input.page.viewportSize()?.height ?? 720;
    await input.page.mouse.wheel(0, viewportHeight);
  } catch (error) {
    if (error instanceof BrowserInteractionExecutionError) throw error;
    throw interactionError(input.strategy_id, 'action_failed', action.action_id, round, error);
  }
}

async function resolveActionTarget(
  page: Page,
  action: BrowserActionV1,
  strategyId: string,
  round: number,
): Promise<Locator | null> {
  if (action.kind === 'scroll') {
    if (isWindowTarget(action.target)) return page.locator('html');
    const frame = await resolveTargetFrame(
      page,
      action.target,
      strategyId,
      action.action_id,
      round,
    );
    const locator = frame.locator(action.target.selector);
    await assertTargetCardinality(locator, action, strategyId, round);
    return locator;
  }
  const target = action.target;
  const frame = await resolveTargetFrame(page, target, strategyId, action.action_id, round);
  const locator = frame.locator(target.selector);
  return (await assertTargetCardinality(locator, action, strategyId, round)) ? locator : null;
}

async function assertTargetCardinality(
  locator: Locator,
  action: BrowserActionV1,
  strategyId: string,
  round: number,
): Promise<boolean> {
  const count = await locator.count();
  if (count === 0 && action.kind === 'dismiss_if_present') return false;
  if (count === 0) throw interactionError(strategyId, 'target_not_found', action.action_id, round);
  if (count !== 1) throw interactionError(strategyId, 'target_ambiguous', action.action_id, round);
  return true;
}

async function resolveTargetFrame(
  page: Page,
  target: BrowserTargetV1,
  strategyId: string,
  actionId: string,
  round: number,
): Promise<Page | Frame> {
  if (target.frame.kind === 'main') return page;
  const frameLocator = page.locator(target.frame.frame_selector);
  const frameCount = await frameLocator.count();
  if (frameCount === 0) throw interactionError(strategyId, 'target_not_found', actionId, round);
  if (frameCount !== 1) throw interactionError(strategyId, 'target_ambiguous', actionId, round);
  const handle = await frameLocator.elementHandle();
  let frame: Frame | null | undefined;
  try {
    frame = await handle?.contentFrame();
  } finally {
    await handle?.dispose();
  }
  if (frame === null || frame === undefined) {
    throw interactionError(strategyId, 'target_not_found', actionId, round);
  }
  let origin: string;
  try {
    origin = new URL(frame.url()).origin;
  } catch {
    throw interactionError(strategyId, 'target_not_found', actionId, round);
  }
  if (origin !== target.frame.origin) {
    throw interactionError(strategyId, 'target_not_found', actionId, round);
  }
  return frame;
}

async function waitForBrowserAction(
  page: Page,
  network: BrowserInteractionNetworkBoundaryV1,
  wait: BrowserWaitV1,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  if (wait.kind === 'dom_content_loaded') return;
  if (wait.kind === 'network_quiet') {
    await network.waitForQuiet(wait, signal);
    return;
  }
  await page
    .locator(wait.selector)
    .nth(wait.minimum_count - 1)
    .waitFor({ state: wait.state, timeout: timeoutMs });
}

async function evaluateDomPredicate(page: Page, predicate: DomPredicateV1): Promise<boolean> {
  if (predicate.op === 'all' || predicate.op === 'any') {
    if (predicate.op === 'all') {
      for (const item of predicate.items)
        if (!(await evaluateDomPredicate(page, item))) return false;
      return true;
    }
    for (const item of predicate.items) if (await evaluateDomPredicate(page, item)) return true;
    return false;
  }
  if (predicate.op === 'not') return !(await evaluateDomPredicate(page, predicate.item));
  if (predicate.op === 'selector_count') {
    const count = await page.locator(predicate.selector).count();
    return compareCount(count, predicate.compare, predicate.value);
  }
  const attribute = predicate as Extract<DomPredicateV1, { op: 'attribute' }>;
  const locator = page.locator(attribute.selector);
  if ((await locator.count()) !== 1) return false;
  const value = await locator.getAttribute(attribute.attribute);
  return attribute.test === 'exists' ? value !== null : value === attribute.value;
}

function compareCount(
  actual: number,
  compare: Extract<DomPredicateV1, { op: 'selector_count' }>['compare'],
  expected: number,
): boolean {
  switch (compare) {
    case 'eq':
      return actual === expected;
    case 'lt':
      return actual < expected;
    case 'lte':
      return actual <= expected;
    case 'gt':
      return actual > expected;
    case 'gte':
      return actual >= expected;
  }
}

function createAggregate(schedule: 'final_only' | 'initial_and_each_round'): {
  schedule: 'final_only' | 'initial_and_each_round';
  items: JsonValueV1[];
  seen: Set<string>;
} {
  return { schedule, items: [], seen: new Set() };
}

function appendProjection(
  aggregate: ReturnType<typeof createAggregate>,
  projection: JsonValueV1,
  maximumBytes: number,
  strategyId: string,
  actionId: string | null,
  round: number,
): void {
  if (!Array.isArray(projection)) {
    throw interactionError(strategyId, 'aggregation_too_large', actionId, round);
  }
  for (const item of projection) {
    const digest = sha256Digest(canonicalJson(item));
    if (aggregate.seen.has(digest)) continue;
    aggregate.seen.add(digest);
    aggregate.items.push(item);
    if (Buffer.byteLength(canonicalJson(aggregate.items), 'utf8') > maximumBytes) {
      throw interactionError(strategyId, 'aggregation_too_large', actionId, round);
    }
  }
}

function interactionError(
  strategyId: string,
  code: BrowserInteractionFailureV1['code'],
  actionId: string | null,
  round: number,
  cause?: unknown,
): BrowserInteractionExecutionError {
  const suffix = cause instanceof Error ? `: ${cause.message}` : '';
  return new BrowserInteractionExecutionError(
    {
      kind: 'browser_interaction_failed',
      strategy_id: strategyId,
      code,
      action_id: actionId,
      round,
    },
    `browser interaction ${code}${suffix}`,
  );
}

function isWindowTarget(
  target: BrowserTargetV1 | { kind: 'window' },
): target is { kind: 'window' } {
  return 'kind' in target;
}

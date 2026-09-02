import { OriginSchedulerError, type OriginSchedulerPermitV1 } from '../origin-scheduler';
import { PublicHttpExecutionError } from '../node-http';
import type {
  ActiveBrowserOperationV1,
  ActiveBrowserRuntimeRequestV1,
  FetchHandlerStateV1,
} from './executor';
import type { BrowserFetchPausedV1 } from './fetch-paused';
import {
  matchBrowserEgressRule,
  matchBrowserPreflightEgressRule,
  type BrowserEgressRuleV1,
} from './resource-policy';
import { validateBrowserRequestBodiesForRule } from './request-body-policy';

export async function handleBrowserRequestStage(
  paused: BrowserFetchPausedV1,
  state: FetchHandlerStateV1,
): Promise<void> {
  const action = state.activeAction();
  const pageScript = state.activePageScript();
  const runtimeRequest = state.activeRuntimeRequest();
  if (state.pageScriptNetworkSealed()) {
    await state.fail(
      paused.request_id,
      new PublicHttpExecutionError(
        'request_blocked',
        'browser page-script emitted network traffic after its signed scope closed',
      ),
    );
    return;
  }
  const operation = pageScript ?? action;
  let phase: 'navigation' | 'resource' | 'interaction' | 'runtime_request' | 'page_script' =
    operation?.phase ?? 'interaction';
  if (operation === null && runtimeRequest === null) {
    phase = paused.resource_type === 'document' ? 'navigation' : 'resource';
  }
  if (runtimeRequest !== null) phase = 'runtime_request';
  const isPreflight = paused.method === 'OPTIONS';
  const rule = isPreflight
    ? matchBrowserPreflightEgressRule(state.policy, {
        phase,
        url: paused.url,
        method: paused.method,
        resource_type: paused.resource_type,
        requested_method: paused.preflight_method,
      })
    : matchBrowserEgressRule(state.policy, {
        phase,
        url: paused.url,
        method: paused.method,
        resource_type: paused.resource_type,
      });
  const originPolicy = findOriginPolicy(state.capability.origin_traffic_policies, paused.url);
  if (!rule || !originPolicy) {
    await state.fail(
      paused.request_id,
      new PublicHttpExecutionError(
        'request_blocked',
        'browser request is outside its signed egress policy',
      ),
    );
    return;
  }
  if (operation !== null && !operation.allowed_rule_ids.has(rule.rule_id)) {
    await state.fail(
      paused.request_id,
      new PublicHttpExecutionError(
        'request_blocked',
        'browser operation emitted an undeclared request',
      ),
    );
    return;
  }
  if (browserRequestBudgetExhausted(state, rule)) {
    await failRequestBudget(paused.request_id, state);
    return;
  }
  const bodies = validateBrowserRequestBodiesForRule(
    paused.request_body,
    state.policy,
    operation?.request_body_policy,
    rule,
    isPreflight,
  );
  if (bodies instanceof PublicHttpExecutionError) {
    await state.fail(paused.request_id, bodies);
    return;
  }
  trackPendingOperationRequest(operation, paused.request_id, state);
  let permit: OriginSchedulerPermitV1;
  try {
    permit = await state.options.scheduler.acquire(originPolicy, {
      signal: state.options.signal,
      workload_id: state.options.workload_id,
    });
  } catch (error) {
    untrackPendingOperationRequest(operation, paused.request_id, state);
    const code =
      error instanceof OriginSchedulerError && error.code === 'cancelled'
        ? 'cancelled'
        : 'request_blocked';
    await state.fail(paused.request_id, new PublicHttpExecutionError(code, asError(error).message));
    return;
  }
  const postAcquireError = validatePostAcquireState(
    state,
    operation,
    runtimeRequest,
    rule,
    bodies.task.bytes,
    bodies.operation?.bytes ?? null,
  );
  if (postAcquireError !== null) {
    permit.release('neutral');
    untrackPendingOperationRequest(operation, paused.request_id, state);
    await state.fail(paused.request_id, postAcquireError);
    return;
  }
  state.ruleRequests.set(rule.rule_id, (state.ruleRequests.get(rule.rule_id) ?? 0) + 1);
  state.targetRequests += 1;
  state.requestBodyBytes += bodies.task.bytes;
  state.activeRequests += 1;
  state.activityChanged();
  if (operation !== null) {
    if (bodies.operation !== null) operation.request_body_bytes += bodies.operation.bytes;
    if (!isPreflight) {
      operation.matching_requests.set(
        rule.rule_id,
        (operation.matching_requests.get(rule.rule_id) ?? 0) + 1,
      );
    }
    state.operationActivityChanged(operation);
  }
  state.admitted.set(paused.request_id, {
    request_id: paused.request_id,
    permit,
    rule,
    operation,
  });
  try {
    await state.cdp.send('Fetch.continueRequest', { requestId: paused.request_id });
  } catch (error) {
    await state.fail(
      paused.request_id,
      new PublicHttpExecutionError('transport_failure', asError(error).message),
    );
  }
}

function validatePostAcquireState(
  state: FetchHandlerStateV1,
  operation: ActiveBrowserOperationV1 | null,
  runtimeRequest: ActiveBrowserRuntimeRequestV1 | null,
  rule: BrowserEgressRuleV1,
  taskBodyBytes: number,
  operationBodyBytes: number | null,
): PublicHttpExecutionError | null {
  if (state.closed()) {
    return new PublicHttpExecutionError('cancelled', 'browser network boundary is closed');
  }
  const fatal = state.fatal();
  if (fatal !== null) return fatal;
  if (browserRequestScopeChanged(state, operation, runtimeRequest)) {
    return new PublicHttpExecutionError(
      'request_blocked',
      'browser request scope changed while awaiting scheduler admission',
    );
  }
  if (browserRequestBudgetExhausted(state, rule)) {
    return new PublicHttpExecutionError(
      'request_budget_exhausted',
      'browser request budget is exhausted',
    );
  }
  if (
    state.policy.max_encoded_request_body_bytes_per_browser_task - state.requestBodyBytes <
    taskBodyBytes
  ) {
    return new PublicHttpExecutionError(
      'request_budget_exhausted',
      'browser request body budget is exhausted',
    );
  }
  if (
    operation !== null &&
    operationBodyBytes !== null &&
    operation.request_body_policy !== undefined &&
    operation.request_body_policy.max_encoded_request_body_bytes_per_browser_task -
      operation.request_body_bytes <
      operationBodyBytes
  ) {
    return new PublicHttpExecutionError(
      'request_budget_exhausted',
      'browser operation request body budget is exhausted',
    );
  }
  return null;
}

function browserRequestScopeChanged(
  state: FetchHandlerStateV1,
  operation: ActiveBrowserOperationV1 | null,
  runtimeRequest: ActiveBrowserRuntimeRequestV1 | null,
): boolean {
  if (state.pageScriptNetworkSealed()) return true;
  if (operation?.phase === 'page_script') return state.activePageScript() !== operation;
  if (operation !== null) return state.activeAction() !== operation;
  if (runtimeRequest !== null) return state.activeRuntimeRequest() !== runtimeRequest;
  return (
    state.activeAction() !== null ||
    state.activePageScript() !== null ||
    state.activeRuntimeRequest() !== null
  );
}

function browserRequestBudgetExhausted(
  state: FetchHandlerStateV1,
  rule: BrowserEgressRuleV1,
): boolean {
  return (
    (state.ruleRequests.get(rule.rule_id) ?? 0) >= rule.max_requests ||
    state.targetRequests >= state.options.max_target_requests ||
    state.targetRequests >= state.policy.max_requests_per_browser_task
  );
}

async function failRequestBudget(requestId: string, state: FetchHandlerStateV1): Promise<void> {
  await state.fail(
    requestId,
    new PublicHttpExecutionError('request_budget_exhausted', 'browser request budget is exhausted'),
  );
}

function trackPendingOperationRequest(
  operation: ActiveBrowserOperationV1 | null,
  requestId: string,
  state: FetchHandlerStateV1,
): void {
  if (operation === null) return;
  operation.pending_request_ids.add(requestId);
  state.operationActivityChanged(operation);
}

function untrackPendingOperationRequest(
  operation: ActiveBrowserOperationV1 | null,
  requestId: string,
  state: FetchHandlerStateV1,
): void {
  if (operation === null) return;
  operation.pending_request_ids.delete(requestId);
  state.operationActivityChanged(operation);
}

function findOriginPolicy(
  policies: FetchHandlerStateV1['capability']['origin_traffic_policies'],
  value: string,
): FetchHandlerStateV1['capability']['origin_traffic_policies'][number] | null {
  try {
    const origin = new URL(value).origin;
    return policies.find((policy) => policy.origin === origin) ?? null;
  } catch {
    return null;
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

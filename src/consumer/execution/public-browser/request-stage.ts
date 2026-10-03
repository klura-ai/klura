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

type BrowserRequestPhaseV1 =
  | 'navigation'
  | 'resource'
  | 'interaction'
  | 'runtime_request'
  | 'page_script';
export async function handleBrowserRequestStage(
  paused: BrowserFetchPausedV1,
  state: FetchHandlerStateV1,
): Promise<void> {
  const action = state.activeAction();
  const pageScript = state.activePageScript();
  const runtimeRequest = state.activeRuntimeRequest();
  const mainFrameDocument = isMainFrameDocument(paused, state.mainFrameId());
  const denied = {
    url: paused.url,
    resource_type: paused.resource_type,
    cdp_resource_type: paused.cdp_resource_type,
  };
  // A reviewed program issues fetch and xhr to its own origin — exactly what a
  // page_script rule may admit — so inside its scope everything else the page
  // requests is the site loading itself: scripts, styles, images, beacons,
  // child frames, and anything cross-origin. A same-origin fetch or xhr that a
  // declared resource rule admits is the page's own too: the reviewer has named
  // it as such, and that rule's budgets bound it. That
  // traffic is judged as a resource, exactly as it is outside the scope, so a
  // live application that keeps loading while the program runs neither fails
  // the task nor widens what the program may send. A main-frame document is
  // the program navigating away and is never admitted.
  const program =
    isProgramTraffic(paused, state.programOrigin()) && !coveredByResourceRule(paused, state);
  const ambient = pageScript !== null && !program && !mainFrameDocument;
  if (state.pageScriptNetworkSealed()) {
    if (!program && !mainFrameDocument) {
      await state.deny(paused.request_id, denied);
      return;
    }
    await state.fail(
      paused.request_id,
      new PublicHttpExecutionError(
        'request_blocked',
        'browser page-script emitted network traffic after its signed scope closed',
        0,
        null,
        egressDiagnostic(paused, 'page_script'),
      ),
    );
    return;
  }
  if (pageScript !== null && mainFrameDocument) {
    await state.fail(
      paused.request_id,
      new PublicHttpExecutionError(
        'request_blocked',
        'browser page-script triggered a main-frame navigation while its scope was open',
        0,
        null,
        egressDiagnostic(paused, 'page_script'),
      ),
    );
    return;
  }
  const operation = ambient ? null : (pageScript ?? action);
  let phase: BrowserRequestPhaseV1 = operation?.phase ?? 'interaction';
  if (operation === null && runtimeRequest === null) {
    phase = mainFrameDocument ? 'navigation' : 'resource';
  }
  if (runtimeRequest !== null) phase = 'runtime_request';
  // A runtime request is the runtime's own fetch call; the label the browser
  // attaches to it (fetch or xhr) carries no information about what was sent,
  // so it is matched as the fetch its rule declares.
  const resourceType = phase === 'runtime_request' ? 'fetch' : paused.resource_type;
  const isPreflight = paused.method === 'OPTIONS';
  const rule = isPreflight
    ? matchBrowserPreflightEgressRule(state.policy, {
        phase,
        url: paused.url,
        method: paused.method,
        resource_type: resourceType,
        requested_method: paused.preflight_method,
      })
    : matchBrowserEgressRule(state.policy, {
        phase,
        url: paused.url,
        method: paused.method,
        resource_type: resourceType,
      });
  const originPolicy = findOriginPolicy(state.capability.origin_traffic_policies, paused.url);
  if (!rule || !originPolicy) {
    // A sub-resource the page fetched on its own is refused and the page
    // carries on without it; only the task's own traffic — navigation,
    // interaction, runtime and page-script requests — is bound to be declared.
    if (phase === 'resource') {
      await state.deny(paused.request_id, denied);
      return;
    }
    await state.fail(
      paused.request_id,
      new PublicHttpExecutionError(
        'request_blocked',
        'browser request is outside its signed egress policy',
        0,
        null,
        egressDiagnostic(paused, phase),
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
    await failRequestBudget(paused, phase, state);
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
    ambient,
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

const PROGRAM_RESOURCE_TYPES = new Set(['fetch', 'xhr']);

/** Whether a declared resource rule admits this request as the page's own. */
function coveredByResourceRule(paused: BrowserFetchPausedV1, state: FetchHandlerStateV1): boolean {
  return (
    matchBrowserEgressRule(state.policy, {
      phase: 'resource',
      url: paused.url,
      method: paused.method,
      resource_type: paused.resource_type,
    }) !== null
  );
}

/** Whether a request is one a page_script rule could admit — fetch or xhr to
 *  the reviewed program's own origin — and so is the program's traffic rather
 *  than the page loading itself. A URL that does not parse is read strictly. */
function isProgramTraffic(paused: BrowserFetchPausedV1, programOrigin: string | null): boolean {
  if (!PROGRAM_RESOURCE_TYPES.has(paused.resource_type)) return false;
  if (programOrigin === null) return true;
  try {
    return new URL(paused.url).origin === programOrigin;
  } catch {
    return true;
  }
}

/** A document request is a navigation only when the main frame issues it; a
 *  document loaded into any other frame is a sub-resource of the page. When
 *  either frame id is unknown the request is treated as a navigation, the
 *  stricter reading. */
function isMainFrameDocument(paused: BrowserFetchPausedV1, mainFrameId: string | null): boolean {
  if (paused.resource_type !== 'document') return false;
  if (paused.frame_id === null || mainFrameId === null) return true;
  return paused.frame_id === mainFrameId;
}

/** Names a request structurally — method, origin, path, phase — without
 *  echoing its query string or body. */
function describeRequest(paused: BrowserFetchPausedV1, phase: BrowserRequestPhaseV1): string {
  try {
    const url = new URL(paused.url);
    return `${paused.method} ${url.origin}${url.pathname} (${phase})`;
  } catch {
    return `${paused.method} request (${phase})`;
  }
}

function egressDiagnostic(
  paused: BrowserFetchPausedV1,
  phase: BrowserRequestPhaseV1,
): import('../node-http').PublicExecutionDiagnosticV1 {
  let origin: string | null = null;
  let path: string | null = null;
  let queryKeys: string[] = [];
  try {
    const url = new URL(paused.url);
    origin = url.origin;
    path = url.pathname;
    queryKeys = [...new Set(url.searchParams.keys())].sort(compareText);
  } catch {
    // The rejected URL remains represented structurally without echoing raw bytes.
  }
  return {
    kind: 'egress_rejected',
    phase,
    origin,
    path,
    query_keys: queryKeys,
    method: paused.method,
    resource_type: paused.resource_type,
    requested_method: paused.preflight_method,
  };
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function validatePostAcquireState(
  state: FetchHandlerStateV1,
  operation: ActiveBrowserOperationV1 | null,
  runtimeRequest: ActiveBrowserRuntimeRequestV1 | null,
  ambient: boolean,
  rule: BrowserEgressRuleV1,
  taskBodyBytes: number,
  operationBodyBytes: number | null,
): PublicHttpExecutionError | null {
  if (state.closed()) {
    return new PublicHttpExecutionError('cancelled', 'browser network boundary is closed');
  }
  const fatal = state.fatal();
  if (fatal !== null) return fatal;
  // The page's own loading is judged as a resource whatever the program scope
  // did while this request waited for admission; only the task's own traffic
  // is bound to the scope it was issued under.
  if (!ambient && browserRequestScopeChanged(state, operation, runtimeRequest)) {
    return new PublicHttpExecutionError(
      'request_blocked',
      'browser request scope changed while awaiting scheduler admission',
    );
  }
  if (browserRequestBudgetExhausted(state, rule)) {
    return new PublicHttpExecutionError(
      'request_budget_exhausted',
      `browser request budget is exhausted: rule ${rule.rule_id} has used ${
        state.ruleRequests.get(rule.rule_id) ?? 0
      } of ${rule.max_requests} requests and the task ${state.targetRequests} of ${Math.min(
        state.options.max_target_requests,
        state.policy.max_requests_per_browser_task,
      )}`,
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

async function failRequestBudget(
  paused: BrowserFetchPausedV1,
  phase: BrowserRequestPhaseV1,
  state: FetchHandlerStateV1,
): Promise<void> {
  await state.fail(
    paused.request_id,
    new PublicHttpExecutionError(
      'request_budget_exhausted',
      `browser request budget is exhausted: ${describeRequest(paused, phase)} would be target request ${
        state.targetRequests + 1
      } of ${Math.min(state.options.max_target_requests, state.policy.max_requests_per_browser_task)}`,
    ),
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

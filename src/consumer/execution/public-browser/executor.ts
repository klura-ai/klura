import { type Browser, type CDPSession, type Page } from 'playwright';
import type { JsonValueV1 } from '../../../public/contracts/json';
import { validateJsonSchema } from '../../../public/contracts/json-schema';
import type {
  BrowserActionExpectationV1,
  BrowserWaitV1,
  OriginTrafficPolicyV1,
  PublicBrowserPageScriptRequestBodyLimitsV1,
  PublicBrowserNavigationStrategyV1,
  PublicReadCapabilityV1,
} from '../../../public/contracts/package';
import { OriginSchedulerV1, type OriginSchedulerPermitV1 } from '../origin-scheduler';
import { PublicHttpExecutionError, type PublicHttpResponseV1 } from '../node-http';
import { projectBrowserDom, BrowserProjectionError } from './dom-projection';
import { AsyncSerialQueueV1 } from './async-serial-queue';
import {
  BrowserInteractionExecutionError,
  executeBrowserInteractionProgram,
  type BrowserInteractionActionScopeV1,
  type BrowserInteractionNetworkBoundaryV1,
} from './interaction-executor';
import { startPinnedEgressProxy, type PinnedEgressProxyV1 } from './pinned-proxy';
import {
  createPublicBrowserContextOptions,
  installPublicSinglePageGuard,
  launchPublicBrowser,
} from './context';
import { evaluateOutcomeSelectors } from './outcome-selectors';
import { type BrowserEgressRuleV1, type BrowserResourcePolicyV1 } from './resource-policy';
import { type BrowserRequestBodyPolicyV1 } from './request-body-policy';
import { parseBrowserFetchPaused, type BrowserFetchPausedV1 } from './fetch-paused';
import { resolveNavigationUrl, waitForBrowserStrategy } from './navigation-helpers';
import { waitForOperationSettled, type OperationSettledWaiterV1 } from './operation-settled';
import { handleBrowserRequestStage } from './request-stage';
import { readPausedResponseBody, rewriteResponseHeaders } from './response-boundary';

export interface BrowserNetworkCapabilityV1 {
  browser_resources: BrowserResourcePolicyV1 | null;
  origin_traffic_policies: readonly OriginTrafficPolicyV1[];
}

export interface PublicBrowserExecutionOptionsV1 {
  input: JsonValueV1;
  bindings: Readonly<Record<string, JsonValueV1>>;
  storage_state?: JsonValueV1;
  timeout_ms: number;
  max_target_requests: number;
  scheduler: OriginSchedulerV1;
  signal?: AbortSignal;
  workload_id?: string;
  resolve_host?: (hostname: string) => Promise<readonly string[]>;
}

export interface AdmittedBrowserRequestV1 {
  request_id: string;
  permit: OriginSchedulerPermitV1;
  rule: BrowserEgressRuleV1;
  operation: ActiveBrowserOperationV1 | null;
}

export interface BrowserRuntimeRequestScopeV1 {
  readonly kind: 'runtime_request';
}

export interface BrowserPageScriptScopeV1 {
  readonly kind: 'page_script';
  readonly strategy_id: string;
}

export interface BrowserNetworkBoundaryV1 extends BrowserInteractionNetworkBoundaryV1 {
  cdp: CDPSession;
  target_requests(): number;
  assertHealthy(): void;
  transition(
    capability: BrowserNetworkCapabilityV1,
    options: PublicBrowserExecutionOptionsV1 & { signal: AbortSignal },
  ): void;
  beginRuntimeRequest(): BrowserRuntimeRequestScopeV1;
  finishRuntimeRequest(scope: BrowserRuntimeRequestScopeV1): void;
  abortRuntimeRequest(scope: BrowserRuntimeRequestScopeV1): void;
  beginPageScript(
    strategyId: string,
    expect: BrowserActionExpectationV1,
    requestBodyLimits: PublicBrowserPageScriptRequestBodyLimitsV1,
  ): BrowserPageScriptScopeV1;
  finishPageScript(
    scope: BrowserPageScriptScopeV1,
    expect: BrowserActionExpectationV1,
    signal: AbortSignal,
  ): Promise<void>;
  abortPageScript(scope: BrowserPageScriptScopeV1): void;
  waitForQuiet(
    wait: Extract<BrowserWaitV1, { kind: 'network_quiet' }>,
    signal: AbortSignal,
  ): Promise<void>;
  close(): Promise<void>;
}

interface QuietWaiterV1 {
  maximum_in_flight: number;
  quiet_ms: number;
  signal: AbortSignal;
  resolve: () => void;
  reject: (error: Error) => void;
  abort: () => void;
  timer: NodeJS.Timeout | null;
}

export interface ActiveBrowserOperationV1 {
  scope: BrowserInteractionActionScopeV1 | BrowserPageScriptScopeV1;
  phase: 'interaction' | 'page_script';
  allowed_rule_ids: Set<string>;
  matching_requests: Map<string, number>;
  pending_request_ids: Set<string>;
  waiters: Set<OperationSettledWaiterV1>;
  request_body_bytes: number;
  request_body_policy?: BrowserRequestBodyPolicyV1;
}

export interface ActiveBrowserRuntimeRequestV1 {
  scope: BrowserRuntimeRequestScopeV1;
}

export async function executeBrowserNavigationStrategy(
  capability: PublicReadCapabilityV1,
  strategy: PublicBrowserNavigationStrategyV1,
  options: PublicBrowserExecutionOptionsV1,
): Promise<PublicHttpResponseV1> {
  if (!capability.strategies.includes(strategy)) {
    throw new PublicHttpExecutionError(
      'invalid_request',
      'strategy is absent from the selected capability',
    );
  }
  if (capability.browser_resources === null) {
    throw new PublicHttpExecutionError(
      'invalid_request',
      'browser navigation has no resource policy',
    );
  }
  if (!Number.isSafeInteger(options.timeout_ms) || options.timeout_ms < 1) {
    throw new PublicHttpExecutionError('invalid_request', 'timeout_ms must be a positive integer');
  }
  if (
    !Number.isSafeInteger(options.max_target_requests) ||
    options.max_target_requests < 1 ||
    options.max_target_requests > capability.max_target_requests_per_call
  ) {
    throw new PublicHttpExecutionError(
      'invalid_request',
      'max_target_requests must fit the selected capability budget',
    );
  }
  validateJsonSchema(options.input, capability.input_schema, 'call.input');
  const url = resolveNavigationUrl(
    strategy,
    options.input,
    options.bindings,
    capability.navigation_origins,
  );
  const deadline = new AbortController();
  const deadlineState = { timed_out: false };
  const timer = setTimeout(() => {
    deadlineState.timed_out = true;
    deadline.abort();
  }, options.timeout_ms);
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline.signal])
    : deadline.signal;
  let browser: Browser | null = null;
  let proxy: PinnedEgressProxyV1 | null = null;
  let boundary: BrowserNetworkBoundaryV1 | null = null;
  try {
    if (signal.aborted) {
      throw new PublicHttpExecutionError('cancelled', 'caller cancelled before browser launch');
    }
    proxy = await startPinnedEgressProxy({
      allowed_origins: capability.browser_resources.egress_rules.map((rule) => rule.origin),
      max_wire_bytes: capability.browser_resources.max_proxy_wire_bytes_per_browser_task,
      connect_timeout_ms: Math.min(options.timeout_ms, 60_000),
      resolve_host: options.resolve_host,
    });
    browser = await launchPublicBrowser(proxy);
    const context = await browser.newContext(
      createPublicBrowserContextOptions(options.storage_state),
    );
    await context.routeWebSocket('**/*', (webSocket) => webSocket.close());
    const page = await context.newPage();
    const pageGuard = await installPublicSinglePageGuard(context, page);
    boundary = await installBrowserNetworkBoundary({
      page,
      capability,
      options: { ...options, signal },
    });
    const abort = (): void => {
      void context.close();
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: options.timeout_ms,
      });
      if (!response) {
        throw new PublicHttpExecutionError(
          'transport_failure',
          'browser navigation did not produce a document response',
          boundary.target_requests(),
        );
      }
      await waitForBrowserStrategy(page, boundary, strategy.wait, signal, options.timeout_ms);
      const interactionBody =
        strategy.interaction === null
          ? null
          : await executeBrowserInteractionProgram({
              page,
              program: strategy.interaction,
              projection: strategy.projection,
              maximum_output_bytes: capability.max_encoded_outcome_bytes,
              expression_context: { input: options.input, bindings: options.bindings },
              strategy_id: strategy.strategy_id,
              network: boundary,
              signal,
              timeout_ms: options.timeout_ms,
            });
      const body =
        interactionBody ??
        (await projectBrowserDom(page, strategy.projection, capability.max_encoded_outcome_bytes));
      const selectorMatches = await evaluateOutcomeSelectors(page, capability, strategy);
      pageGuard.assertHealthy();
      boundary.assertHealthy();
      return {
        status: response.status(),
        headers: response.headers(),
        media_type: 'application/json',
        body_kind: Array.isArray(body) ? 'json_array' : 'json_object',
        body,
        target_requests: boundary.target_requests(),
        html_selector_exists: (selector: string) => selectorMatches.get(selector) ?? false,
      };
    } finally {
      signal.removeEventListener('abort', abort);
      await context.close();
    }
  } catch (error) {
    const targetRequests = boundary?.target_requests() ?? 0;
    if (deadlineState.timed_out) {
      throw new PublicHttpExecutionError(
        'request_timeout',
        'browser navigation deadline expired',
        targetRequests,
      );
    }
    if (signal.aborted) {
      throw new PublicHttpExecutionError(
        'cancelled',
        'caller cancelled browser navigation',
        targetRequests,
      );
    }
    if (error instanceof PublicHttpExecutionError) throw error;
    if (error instanceof BrowserProjectionError) {
      throw new PublicHttpExecutionError('response_invalid_json', error.message, targetRequests);
    }
    if (error instanceof BrowserInteractionExecutionError) {
      throw new PublicHttpExecutionError(
        'browser_interaction_failed',
        error.message,
        targetRequests,
        error.failure,
      );
    }
    throw new PublicHttpExecutionError('transport_failure', asError(error).message, targetRequests);
  } finally {
    clearTimeout(timer);
    await boundary?.close();
    await browser?.close();
    await proxy?.close();
  }
}

export async function installBrowserNetworkBoundary(input: {
  page: Page;
  capability: BrowserNetworkCapabilityV1;
  options: PublicBrowserExecutionOptionsV1 & { signal: AbortSignal };
}): Promise<BrowserNetworkBoundaryV1> {
  if (input.capability.browser_resources === null)
    throw new PublicHttpExecutionError('invalid_request', 'browser resource policy is absent');
  let capability = input.capability;
  let policy = input.capability.browser_resources;
  let options = input.options;
  const cdp = await input.page.context().newCDPSession(input.page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Fetch.enable', {
    patterns: [
      { urlPattern: '*', requestStage: 'Request' },
      { urlPattern: '*', requestStage: 'Response' },
    ],
  });
  const admitted = new Map<string, AdmittedBrowserRequestV1>();
  const ruleRequests = new Map<string, number>();
  let targetRequests = 0;
  let responseBytes = 0;
  let requestBodyBytes = 0;
  let activeRequests = 0;
  let pendingAdmissions = 0;
  let closed = false;
  let fatal: PublicHttpExecutionError | null = null;
  const responseBodyQueue = new AsyncSerialQueueV1();
  const quietWaiters = new Set<QuietWaiterV1>();
  let activeAction: ActiveBrowserOperationV1 | null = null;
  let activePageScript: ActiveBrowserOperationV1 | null = null;
  let pageScriptNetworkSealed = false;
  let activeRuntimeRequest: ActiveBrowserRuntimeRequestV1 | null = null;

  const finishQuietWaiter = (waiter: QuietWaiterV1): void => {
    if (!quietWaiters.delete(waiter)) return;
    if (waiter.timer !== null) clearTimeout(waiter.timer);
    waiter.signal.removeEventListener('abort', waiter.abort);
    waiter.resolve();
  };
  const rejectQuietWaiter = (waiter: QuietWaiterV1, error: Error): void => {
    if (!quietWaiters.delete(waiter)) return;
    if (waiter.timer !== null) clearTimeout(waiter.timer);
    waiter.signal.removeEventListener('abort', waiter.abort);
    waiter.reject(error);
  };
  const notifyActivity = (): void => {
    for (const waiter of quietWaiters) {
      if (activeRequests > waiter.maximum_in_flight) {
        if (waiter.timer !== null) {
          clearTimeout(waiter.timer);
          waiter.timer = null;
        }
        continue;
      }
      if (waiter.timer === null) {
        waiter.timer = setTimeout(() => {
          finishQuietWaiter(waiter);
        }, waiter.quiet_ms);
      }
    }
  };
  const rejectQuietWaiters = (error: Error): void => {
    for (const waiter of [...quietWaiters]) rejectQuietWaiter(waiter, error);
  };
  const finishOperationWaiter = (
    operation: ActiveBrowserOperationV1,
    waiter: OperationSettledWaiterV1,
  ): void => {
    if (!operation.waiters.delete(waiter)) return;
    waiter.signal.removeEventListener('abort', waiter.abort);
    waiter.resolve();
  };
  const rejectOperationWaiter = (
    operation: ActiveBrowserOperationV1,
    waiter: OperationSettledWaiterV1,
    error: Error,
  ): void => {
    if (!operation.waiters.delete(waiter)) return;
    waiter.signal.removeEventListener('abort', waiter.abort);
    waiter.reject(error);
  };
  const notifyOperationSettled = (operation: ActiveBrowserOperationV1): void => {
    if (operation.pending_request_ids.size !== 0) return;
    for (const waiter of [...operation.waiters]) finishOperationWaiter(operation, waiter);
  };
  const rejectOperationWaiters = (operation: ActiveBrowserOperationV1, error: Error): void => {
    for (const waiter of [...operation.waiters]) {
      rejectOperationWaiter(operation, waiter, error);
    }
  };
  const removeOperationRequest = (admission: AdmittedBrowserRequestV1): void => {
    if (admission.operation === null) return;
    admission.operation.pending_request_ids.delete(admission.request_id);
    notifyOperationSettled(admission.operation);
  };

  const fail = async (requestId: string, error: PublicHttpExecutionError): Promise<void> => {
    fatal ??= error;
    const admission = admitted.get(requestId);
    if (admission) {
      admitted.delete(requestId);
      activeRequests -= 1;
      admission.permit.release('neutral');
      removeOperationRequest(admission);
      notifyActivity();
    }
    rejectQuietWaiters(error);
    if (activeAction !== null) rejectOperationWaiters(activeAction, error);
    if (activePageScript !== null) rejectOperationWaiters(activePageScript, error);
    try {
      await cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
    } catch {
      return;
    }
  };

  const onPaused = (raw: unknown): void => {
    void handleFetchPaused(raw, {
      capability,
      policy,
      options,
      cdp,
      admitted,
      ruleRequests,
      get targetRequests() {
        return targetRequests;
      },
      set targetRequests(value: number) {
        targetRequests = value;
      },
      get responseBytes() {
        return responseBytes;
      },
      set responseBytes(value: number) {
        responseBytes = value;
      },
      get requestBodyBytes() {
        return requestBodyBytes;
      },
      set requestBodyBytes(value: number) {
        requestBodyBytes = value;
      },
      get activeRequests() {
        return activeRequests;
      },
      set activeRequests(value: number) {
        activeRequests = value;
      },
      get pendingAdmissions() {
        return pendingAdmissions;
      },
      set pendingAdmissions(value: number) {
        pendingAdmissions = value;
      },
      responseBodyQueue,
      fail,
      fatal: () => fatal,
      closed: () => closed,
      activityChanged: notifyActivity,
      activeAction: () => activeAction,
      activePageScript: () => activePageScript,
      pageScriptNetworkSealed: () => pageScriptNetworkSealed,
      activeRuntimeRequest: () => activeRuntimeRequest,
      operationActivityChanged: notifyOperationSettled,
    }).catch((error: unknown) => {
      const failure =
        error instanceof PublicHttpExecutionError
          ? error
          : new PublicHttpExecutionError('transport_failure', asError(error).message);
      fatal ??= failure;
      rejectQuietWaiters(failure);
      if (activeAction !== null) rejectOperationWaiters(activeAction, failure);
      if (activePageScript !== null) rejectOperationWaiters(activePageScript, failure);
      void input.page.context().close();
    });
  };
  cdp.on('Fetch.requestPaused', onPaused);
  return {
    cdp,
    target_requests: () => targetRequests,
    assertHealthy: () => {
      if (fatal !== null) throw fatal;
    },
    transition: (nextCapability, nextOptions) => {
      if (fatal !== null) throw fatal;
      if (nextCapability.browser_resources === null) {
        throw new PublicHttpExecutionError('invalid_request', 'browser resource policy is absent');
      }
      if (
        admitted.size !== 0 ||
        activeRequests !== 0 ||
        activeAction !== null ||
        activePageScript !== null ||
        activeRuntimeRequest !== null ||
        quietWaiters.size !== 0 ||
        pendingAdmissions !== 0
      ) {
        throw new PublicHttpExecutionError(
          'transport_failure',
          'browser network boundary cannot transition while requests are active',
        );
      }
      capability = nextCapability;
      policy = nextCapability.browser_resources;
      options = nextOptions;
      ruleRequests.clear();
      targetRequests = 0;
      responseBytes = 0;
      requestBodyBytes = 0;
      pageScriptNetworkSealed = false;
    },
    beginRuntimeRequest: () => {
      if (activeAction !== null || activePageScript !== null || activeRuntimeRequest !== null) {
        throw new PublicHttpExecutionError(
          'transport_failure',
          'browser request scope is already active',
        );
      }
      const scope = { kind: 'runtime_request' } as const;
      activeRuntimeRequest = { scope };
      return scope;
    },
    finishRuntimeRequest: (scope) => {
      if (activeRuntimeRequest?.scope !== scope) {
        throw new PublicHttpExecutionError(
          'transport_failure',
          'browser request scope is not active',
        );
      }
      const currentFatal = fatal;
      activeRuntimeRequest = null;
      if (currentFatal !== null) throw currentFatal;
    },
    abortRuntimeRequest: (scope) => {
      if (activeRuntimeRequest?.scope === scope) activeRuntimeRequest = null;
    },
    beginAction: (action) => {
      if (activeAction !== null || activePageScript !== null || activeRuntimeRequest !== null) {
        throw new PublicHttpExecutionError(
          'transport_failure',
          'browser action scope is already active',
        );
      }
      const scope = { action_id: action.action_id };
      activeAction = {
        scope,
        phase: 'interaction',
        allowed_rule_ids: new Set(action.expect.egress_rule_ids),
        matching_requests: new Map(),
        pending_request_ids: new Set(),
        waiters: new Set(),
        request_body_bytes: 0,
      };
      return scope;
    },
    finishAction: async (scope, expect, signal) => {
      const action = activeAction;
      if (action === null || action.scope !== scope) {
        throw new PublicHttpExecutionError(
          'transport_failure',
          'browser action scope is not active',
        );
      }
      const currentFatal = fatal;
      if (currentFatal !== null) throw currentFatal;
      await waitForOperationSettled(action, signal, finishOperationWaiter, rejectOperationWaiter);
      const settledFatal = fatal;
      if (settledFatal !== null) throw settledFatal;
      const matchingRequests = [...action.matching_requests.values()].reduce(
        (total, count) => total + count,
        0,
      );
      activeAction = null;
      if (
        matchingRequests < expect.minimum_matching_requests ||
        matchingRequests > expect.maximum_matching_requests
      ) {
        throw new PublicHttpExecutionError(
          'request_blocked',
          'browser action request count differs from its signed expectation',
        );
      }
    },
    abortAction: (scope) => {
      if (activeAction?.scope !== scope) return;
      rejectOperationWaiters(
        activeAction,
        new PublicHttpExecutionError('cancelled', 'browser action scope was aborted'),
      );
      activeAction = null;
    },
    beginPageScript: (strategyId, expect, requestBodyLimits) => {
      if (
        activeAction !== null ||
        activePageScript !== null ||
        activeRuntimeRequest !== null ||
        pageScriptNetworkSealed
      ) {
        throw new PublicHttpExecutionError(
          'transport_failure',
          'browser page-script scope is already active',
        );
      }
      const scope = { kind: 'page_script', strategy_id: strategyId } as const;
      activePageScript = {
        scope,
        phase: 'page_script',
        allowed_rule_ids: new Set(expect.egress_rule_ids),
        matching_requests: new Map(),
        pending_request_ids: new Set(),
        waiters: new Set(),
        request_body_bytes: 0,
        request_body_policy: {
          max_encoded_request_body_bytes_per_browser_task:
            requestBodyLimits.max_encoded_request_body_bytes_per_script,
          max_single_request_body_bytes: requestBodyLimits.max_single_request_body_bytes,
          max_encoded_request_body_bytes_by_rule:
            requestBodyLimits.max_encoded_request_body_bytes_by_rule,
        },
      };
      return scope;
    },
    finishPageScript: async (scope, expect, signal) => {
      const pageScript = activePageScript;
      if (pageScript === null || pageScript.scope !== scope) {
        throw new PublicHttpExecutionError(
          'transport_failure',
          'browser page-script scope is not active',
        );
      }
      const currentFatal = fatal;
      if (currentFatal !== null) throw currentFatal;
      await waitForOperationSettled(
        pageScript,
        signal,
        finishOperationWaiter,
        rejectOperationWaiter,
      );
      const settledFatal = fatal;
      if (settledFatal !== null) throw settledFatal;
      const matchingRequests = [...pageScript.matching_requests.values()].reduce(
        (total, count) => total + count,
        0,
      );
      activePageScript = null;
      pageScriptNetworkSealed = true;
      if (
        matchingRequests < expect.minimum_matching_requests ||
        matchingRequests > expect.maximum_matching_requests
      ) {
        throw new PublicHttpExecutionError(
          'request_blocked',
          'browser page-script request count differs from its signed expectation',
        );
      }
    },
    abortPageScript: (scope) => {
      if (activePageScript?.scope !== scope) return;
      rejectOperationWaiters(
        activePageScript,
        new PublicHttpExecutionError('cancelled', 'browser page-script scope was aborted'),
      );
      activePageScript = null;
      pageScriptNetworkSealed = true;
    },
    waitForQuiet: async (wait, signal) => {
      const currentFatal = fatal;
      if (currentFatal !== null) throw currentFatal;
      await new Promise<void>((resolve, reject) => {
        const waiter: QuietWaiterV1 = {
          maximum_in_flight: wait.maximum_in_flight,
          quiet_ms: wait.quiet_ms,
          signal,
          resolve,
          reject,
          timer: null,
          abort: () => {
            rejectQuietWaiter(
              waiter,
              new PublicHttpExecutionError('cancelled', 'caller cancelled browser quiet wait'),
            );
          },
        };
        quietWaiters.add(waiter);
        signal.addEventListener('abort', waiter.abort, { once: true });
        notifyActivity();
      });
    },
    close: async () => {
      closed = true;
      rejectQuietWaiters(new PublicHttpExecutionError('cancelled', 'browser context closed'));
      if (activeAction !== null) {
        rejectOperationWaiters(
          activeAction,
          new PublicHttpExecutionError('cancelled', 'browser context closed'),
        );
        activeAction = null;
      }
      if (activePageScript !== null) {
        rejectOperationWaiters(
          activePageScript,
          new PublicHttpExecutionError('cancelled', 'browser context closed'),
        );
        activePageScript = null;
      }
      activeRuntimeRequest = null;
      for (const admission of admitted.values()) admission.permit.release('neutral');
      admitted.clear();
      cdp.off('Fetch.requestPaused', onPaused);
      await cdp.detach().catch(() => undefined);
    },
  };
}

export interface FetchHandlerStateV1 {
  capability: BrowserNetworkCapabilityV1;
  policy: NonNullable<BrowserNetworkCapabilityV1['browser_resources']>;
  options: PublicBrowserExecutionOptionsV1 & { signal: AbortSignal };
  cdp: CDPSession;
  admitted: Map<string, AdmittedBrowserRequestV1>;
  ruleRequests: Map<string, number>;
  targetRequests: number;
  responseBytes: number;
  requestBodyBytes: number;
  activeRequests: number;
  pendingAdmissions: number;
  responseBodyQueue: AsyncSerialQueueV1;
  fail(requestId: string, error: PublicHttpExecutionError): Promise<void>;
  fatal(): PublicHttpExecutionError | null;
  closed(): boolean;
  activityChanged(): void;
  activeAction(): ActiveBrowserOperationV1 | null;
  activePageScript(): ActiveBrowserOperationV1 | null;
  pageScriptNetworkSealed(): boolean;
  activeRuntimeRequest(): ActiveBrowserRuntimeRequestV1 | null;
  operationActivityChanged(operation: ActiveBrowserOperationV1): void;
}

async function handleFetchPaused(raw: unknown, state: FetchHandlerStateV1): Promise<void> {
  const paused = parseBrowserFetchPaused(raw);
  if (!paused) {
    throw new PublicHttpExecutionError(
      'transport_failure',
      'browser CDP request interception is malformed',
    );
  }
  const fatal = state.fatal();
  if (fatal !== null) {
    await state.fail(paused.request_id, fatal);
    return;
  }
  if (paused.response_status === null) {
    state.pendingAdmissions += 1;
    try {
      await handleBrowserRequestStage(paused, state);
    } finally {
      state.pendingAdmissions -= 1;
    }
    return;
  }
  await handleResponseStage(paused, state);
}

async function handleResponseStage(
  paused: BrowserFetchPausedV1,
  state: FetchHandlerStateV1,
): Promise<void> {
  const responseStatus = paused.response_status;
  if (responseStatus === null) {
    await state.fail(
      paused.request_id,
      new PublicHttpExecutionError('transport_failure', 'browser response has no status code'),
    );
    return;
  }
  const admission = state.admitted.get(paused.request_id);
  if (!admission) {
    await state.fail(
      paused.request_id,
      new PublicHttpExecutionError('request_blocked', 'browser response has no admitted request'),
    );
    return;
  }
  try {
    const body = await state.responseBodyQueue.run(async () => {
      const result = await readPausedResponseBody(
        state.cdp,
        paused.request_id,
        Math.min(
          admission.rule.max_encoded_response_bytes,
          state.policy.max_single_response_bytes,
          state.policy.max_encoded_response_bytes_per_browser_task - state.responseBytes,
        ),
      );
      state.responseBytes += result.byteLength;
      return result;
    });
    await state.cdp.send('Fetch.fulfillRequest', {
      requestId: paused.request_id,
      responseCode: responseStatus,
      responseHeaders: rewriteResponseHeaders(paused.response_headers, body.byteLength),
      body: body.toString('base64'),
    });
    admission.permit.release(responseStatus >= 500 ? 'transient_failure' : 'success');
    state.admitted.delete(paused.request_id);
    state.activeRequests -= 1;
    if (admission.operation !== null) {
      admission.operation.pending_request_ids.delete(paused.request_id);
      state.operationActivityChanged(admission.operation);
    }
    state.activityChanged();
  } catch (error) {
    await state.fail(
      paused.request_id,
      error instanceof PublicHttpExecutionError
        ? error
        : new PublicHttpExecutionError('transport_failure', asError(error).message),
    );
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

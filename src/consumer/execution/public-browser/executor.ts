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
import {
  PublicHttpExecutionError,
  type PublicDeniedResourceV1,
  type PublicHttpResponseV1,
} from '../node-http';
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
  type PublicSinglePageGuardV1,
} from './context';
import { evaluateOutcomeSelectors } from './outcome-selectors';
import { type BrowserEgressRuleV1, type BrowserResourcePolicyV1 } from './resource-policy';
import { type BrowserRequestBodyPolicyV1 } from './request-body-policy';
import { parseBrowserFetchPaused } from './fetch-paused';
import { resolveNavigationUrl, waitForBrowserStrategy } from './navigation-helpers';
import { waitForOperationSettled, type OperationSettledWaiterV1 } from './operation-settled';
import { handleBrowserRequestStage } from './request-stage';
import { handleResponseStage, loadingFailedNetworkId } from './response-stage';
import { releaseVanishedRequest } from './request-stage';

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
  /** Chromium's network-level id, by which a cancelled load is matched back
   *  to its admission; null when Chromium reported none. */
  network_id: string | null;
  /** The request named structurally — method, origin, path, phase. */
  description: string;
  /** Whether the response has arrived and its body is being read. */
  reading_response: boolean;
  /** The traffic policy of the origin the request was admitted against; it
   *  bounds how many redirect hops the response may start. */
  origin_policy: BrowserNetworkCapabilityV1['origin_traffic_policies'][number];
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
  /** Page-initiated sub-resource requests refused because no rule admits them. */
  denied_requests(): number;
  /** Sub-resources the page requested on its own and the policy refused, in
   *  arrival order, capped so a busy page cannot grow it without bound. */
  denied_resources(): BrowserDeniedResourceV1[];
  /** Admitted requests whose responses have not yet arrived, named
   *  structurally — method, origin, path. */
  in_flight(): string[];
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
    programOrigin: string,
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
  /** The operation ended with its declared wait satisfied; traffic it still
   *  had in flight is the page's own from here on. */
  released: boolean;
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
  let pageGuard: PublicSinglePageGuardV1 | null = null;
  try {
    if (signal.aborted) {
      throw new PublicHttpExecutionError('cancelled', 'caller cancelled before browser launch');
    }
    proxy = await startPinnedEgressProxy({
      allowed_origins: [
        ...new Set(capability.browser_resources.egress_rules.map((rule) => rule.origin)),
      ],
      max_wire_bytes: capability.browser_resources.max_proxy_wire_bytes_per_browser_task,
      connect_timeout_ms: Math.min(options.timeout_ms, 60_000),
      resolve_host: options.resolve_host,
    });
    const launched = await launchPublicBrowser(proxy);
    browser = launched.browser;
    const context = await browser.newContext(
      createPublicBrowserContextOptions(options.storage_state, launched.user_agent),
    );
    await context.routeWebSocket('**/*', (webSocket) => webSocket.close());
    const page = await context.newPage();
    pageGuard = await installPublicSinglePageGuard(context, page);
    boundary = await installBrowserNetworkBoundary({
      proxy_auth: { username: proxy.username, password: proxy.password },
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
        denied_resources: boundary.denied_resources(),
        browser_identity: launched.identity,
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
    // A request the guard or boundary refused reaches the page as a generic
    // navigation error; their own verdicts name the rule and phase.
    for (const verdict of [pageGuard, boundary]) {
      try {
        verdict?.assertHealthy();
      } catch (refused) {
        if (refused instanceof PublicHttpExecutionError) {
          throw new PublicHttpExecutionError(
            refused.code,
            refused.message,
            targetRequests,
            refused.interaction_failure,
            refused.diagnostic,
          );
        }
      }
    }
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

export type BrowserDeniedResourceV1 = PublicDeniedResourceV1;

export const MAX_RECORDED_DENIED_RESOURCES_V1 = 32;

export interface BrowserProxyCredentialsV1 {
  username: string;
  password: string;
}

export async function installBrowserNetworkBoundary(input: {
  page: Page;
  capability: BrowserNetworkCapabilityV1;
  options: PublicBrowserExecutionOptionsV1 & { signal: AbortSignal };
  /** Credentials for the pinned egress proxy. Interception owns the page's
   *  Fetch domain, so the proxy's challenge is answered here, not by the
   *  launch-time proxy configuration. */
  proxy_auth?: BrowserProxyCredentialsV1;
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
    handleAuthRequests: true,
  });
  // Only a document the main frame loads is a navigation; a document any other
  // frame loads is a resource of the page, refused silently when undeclared.
  let mainFrameId: string | null = null;
  try {
    const tree = (await cdp.send('Page.getFrameTree')) as {
      frameTree?: { frame?: { id?: unknown } };
    };
    const id = tree.frameTree?.frame?.id;
    mainFrameId = typeof id === 'string' ? id : null;
  } catch {
    mainFrameId = null;
  }
  // Only the pinned proxy may challenge; a target site's own challenge is a
  // refusal the package must classify, never something answered on its behalf.
  cdp.on(
    'Fetch.authRequired',
    (event: { requestId: string; authChallenge: { source?: string } }) => {
      const proxyChallenge =
        event.authChallenge.source === 'Proxy' && input.proxy_auth !== undefined;
      void cdp
        .send('Fetch.continueWithAuth', {
          requestId: event.requestId,
          authChallengeResponse: proxyChallenge
            ? {
                response: 'ProvideCredentials',
                username: input.proxy_auth?.username,
                password: input.proxy_auth?.password,
              }
            : { response: 'CancelAuth' },
        })
        .catch(() => undefined);
    },
  );
  const admitted = new Map<string, AdmittedBrowserRequestV1>();
  const ruleRequests = new Map<string, number>();
  const redirectHops = new Map<string, number>();
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
  let programOrigin: string | null = null;
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

  let deniedRequests = 0;
  const deniedResources: BrowserDeniedResourceV1[] = [];
  const deny = async (requestId: string, resource: BrowserDeniedResourceV1): Promise<void> => {
    deniedRequests += 1;
    if (deniedResources.length < MAX_RECORDED_DENIED_RESOURCES_V1) deniedResources.push(resource);
    try {
      await cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
    } catch {
      return;
    }
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

  const handlerState: FetchHandlerStateV1 = {
    capability,
    policy,
    options,
    cdp,
    admitted,
    ruleRequests,
    redirectHops,
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
    deny,
    mainFrameId: () => mainFrameId,
    fatal: () => fatal,
    closed: () => closed,
    activityChanged: notifyActivity,
    activeAction: () => activeAction,
    activePageScript: () => activePageScript,
    pageScriptNetworkSealed: () => pageScriptNetworkSealed,
    programOrigin: () => programOrigin,
    activeRuntimeRequest: () => activeRuntimeRequest,
    operationActivityChanged: notifyOperationSettled,
  };
  const onPaused = (raw: unknown): void => {
    void handleFetchPaused(raw, handlerState).catch((error: unknown) => {
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
  // A load that Chromium reports finished or failed without a response-stage
  // pause — cancelled by a navigation, or completed outside interception —
  // leaves nothing else to settle its admission.
  const onLoadingFailed = (raw: unknown): void => {
    const networkId = loadingFailedNetworkId(raw);
    if (networkId === null) return;
    for (const admission of admitted.values()) {
      if (admission.network_id === networkId) {
        releaseVanishedRequest(admission.request_id, handlerState);
      }
    }
  };
  cdp.on('Network.loadingFailed', onLoadingFailed);
  cdp.on('Network.loadingFinished', onLoadingFailed);
  return {
    cdp,
    target_requests: () => targetRequests,
    denied_requests: () => deniedRequests,
    denied_resources: () => [...deniedResources],
    in_flight: () =>
      [...admitted.values()].map(
        (admission) =>
          `${admission.description}${admission.reading_response ? ' [reading response]' : ' [awaiting response]'}${admission.network_id === null ? ' [no network id]' : ''}`,
      ),
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
      programOrigin = null;
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
        released: false,
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
      // A declared wait is the action's completion: once it holds, whatever
      // the page still has in flight is its own loading, not the action's.
      // Without one, the action is complete when its traffic has settled.
      if (expect.wait === null) {
        await waitForOperationSettled(action, signal, finishOperationWaiter, rejectOperationWaiter);
      } else {
        action.released = true;
      }
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
    beginPageScript: (strategyId, expect, requestBodyLimits, origin) => {
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
      programOrigin = origin;
      activePageScript = {
        scope,
        phase: 'page_script',
        allowed_rule_ids: new Set(expect.egress_rule_ids),
        matching_requests: new Map(),
        pending_request_ids: new Set(),
        waiters: new Set(),
        request_body_bytes: 0,
        released: false,
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
      cdp.off('Network.loadingFailed', onLoadingFailed);
      cdp.off('Network.loadingFinished', onLoadingFailed);
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
  /** Redirect hops taken so far, by redirect chain. */
  redirectHops: Map<string, number>;
  targetRequests: number;
  responseBytes: number;
  requestBodyBytes: number;
  activeRequests: number;
  pendingAdmissions: number;
  responseBodyQueue: AsyncSerialQueueV1;
  fail(requestId: string, error: PublicHttpExecutionError): Promise<void>;
  /** Refuses a request the page tried on its own without failing the task. */
  deny(requestId: string, resource: BrowserDeniedResourceV1): Promise<void>;
  /** The main frame's id, or null when the browser did not report one. */
  mainFrameId(): string | null;
  fatal(): PublicHttpExecutionError | null;
  closed(): boolean;
  activityChanged(): void;
  activeAction(): ActiveBrowserOperationV1 | null;
  activePageScript(): ActiveBrowserOperationV1 | null;
  pageScriptNetworkSealed(): boolean;
  /** The reviewed program's origin from the moment its scope opens, kept while
   *  the scope is sealed; null when no program has run on this boundary. */
  programOrigin(): string | null;
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
  // A response-stage pause that carries a network error instead of a status is
  // the admitted request failing, not a new request: it must not be charged
  // against the budget a second time.
  if (paused.response_error !== null) {
    await state.fail(
      paused.request_id,
      new PublicHttpExecutionError(
        'transport_failure',
        `browser request failed before a response: ${paused.response_error}`,
      ),
    );
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

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

import type { Browser, BrowserContext, Page } from 'playwright';
import { assertJsonValue, type JsonValueV1 } from '../../../public/contracts/json';
import type { PublicAuthenticationContractV1 } from '../../../public/contracts/authentication';
import type { PublicReadCapabilityV1 } from '../../../public/contracts/package';
import { PublicCallerV1, type PublicCallResultV1 } from '../../call';
import type { BrowserResourcePolicyV1 } from './resource-policy';
import { OriginSchedulerV1 } from '../origin-scheduler';
import { PublicHttpExecutionError } from '../node-http';
import {
  installBrowserNetworkBoundary,
  type BrowserNetworkBoundaryV1,
  type BrowserNetworkCapabilityV1,
} from './executor';
import { executeBrowserNavigationStrategyInBoundedPage } from './bounded-navigation';
import { executeBrowserHttpStrategyInBoundedPage } from './http-executor';
import {
  createPublicBrowserContextOptions,
  installPublicSinglePageGuard,
  launchPublicBrowser,
  type PublicSinglePageGuardV1,
} from './context';
import { startPinnedEgressProxy, type PinnedEgressProxyV1 } from './pinned-proxy';

export interface OpenPublicLoginBrowserInputV1 {
  contract: PublicAuthenticationContractV1;
  check_capability: PublicReadCapabilityV1;
  scheduler: OriginSchedulerV1;
  signal?: AbortSignal;
  resolve_host?: (hostname: string) => Promise<readonly string[]>;
}

export interface PublicLoginBrowserV1 {
  readonly page: Page;
  assertHealthy(): void;
  completeCheck(): Promise<CompletedPublicLoginCheckV1>;
  close(): Promise<void>;
}

export interface CompletedPublicLoginCheckV1 {
  result: PublicCallResultV1;
  state: JsonValueV1;
}

/** Opens one user-visible browser subject to the declared login-only policy. */
export async function openPublicLoginBrowser(
  input: OpenPublicLoginBrowserInputV1,
): Promise<PublicLoginBrowserV1> {
  const signal = input.signal;
  if (signal?.aborted) {
    throw new PublicHttpExecutionError('cancelled', 'login was cancelled before browser launch');
  }
  const capability = loginNetworkCapability(input.contract);
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let proxy: PinnedEgressProxyV1 | null = null;
  let boundary: BrowserNetworkBoundaryV1 | null = null;
  let pageGuard: PublicSinglePageGuardV1 | null = null;
  let page: Page;
  let closed = false;
  let abort: (() => void) | null = null;
  const closeLoginBrowser = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (abort !== null) signal?.removeEventListener('abort', abort);
    await context?.close();
    await boundary?.close();
    boundary = null;
    await browser?.close();
    await proxy?.close();
  };
  try {
    proxy = await startPinnedEgressProxy({
      allowed_origins: checkedLoginOrigins(input.contract, input.check_capability),
      max_wire_bytes: checkedLoginWireBudget(input.contract, input.check_capability),
      connect_timeout_ms: Math.min(input.contract.browser_resources.total_timeout_ms, 60_000),
      resolve_host: input.resolve_host,
    });
    browser = await launchPublicBrowser(proxy, { headless: false });
    context = await browser.newContext(createPublicBrowserContextOptions(undefined));
    await context.routeWebSocket('**/*', (webSocket) => webSocket.close());
    page = await context.newPage();
    pageGuard = await installPublicSinglePageGuard(context, page);
    boundary = await installBrowserNetworkBoundary({
      proxy_auth: { username: proxy.username, password: proxy.password },
      page,
      capability,
      options: {
        input: {},
        bindings: {},
        timeout_ms: input.contract.browser_resources.total_timeout_ms,
        max_target_requests: input.contract.browser_resources.max_requests_per_login,
        scheduler: input.scheduler,
        signal: signal ?? new AbortController().signal,
      },
    });
    abort = (): void => {
      void closeLoginBrowser();
    };
    signal?.addEventListener('abort', abort, { once: true });
    await page.goto(input.contract.login_url, {
      waitUntil: 'domcontentloaded',
      timeout: input.contract.browser_resources.total_timeout_ms,
    });
    return {
      page,
      assertHealthy: () => {
        pageGuard?.assertHealthy();
        boundary?.assertHealthy();
      },
      completeCheck: async () => {
        const activeBoundary = boundary;
        if (activeBoundary === null || context === null) {
          throw new PublicHttpExecutionError('transport_failure', 'login browser is unavailable');
        }
        pageGuard?.assertHealthy();
        activeBoundary.assertHealthy();
        const caller = new PublicCallerV1(
          undefined,
          undefined,
          async (capability, strategy, options) =>
            await executeBrowserNavigationStrategyInBoundedPage(
              page,
              activeBoundary,
              capability,
              strategy,
              options,
            ),
          async (capability, strategy, options) =>
            await executeBrowserHttpStrategyInBoundedPage(
              page,
              activeBoundary,
              capability,
              strategy,
              options,
            ),
        );
        try {
          const result = await caller.call(input.check_capability, input.contract.check.input, {
            scheduler: input.scheduler,
          });
          pageGuard?.assertHealthy();
          activeBoundary.assertHealthy();
          const state = await context.storageState();
          assertJsonValue(state, 'login.storage_state', 12);
          return { result, state };
        } finally {
          await closeLoginBrowser();
        }
      },
      close: async () => {
        await closeLoginBrowser();
      },
    };
  } catch (error) {
    await closeLoginBrowser();
    if (error instanceof PublicHttpExecutionError) throw error;
    if (signal?.aborted) {
      throw new PublicHttpExecutionError('cancelled', 'login was cancelled during browser startup');
    }
    throw new PublicHttpExecutionError('transport_failure', errorMessage(error));
  }
}

function checkedLoginOrigins(
  contract: PublicAuthenticationContractV1,
  checkCapability: PublicReadCapabilityV1,
): string[] {
  const browserResources = checkCapability.browser_resources;
  if (browserResources === null) {
    throw new PublicHttpExecutionError(
      'invalid_request',
      'login check has no browser resource policy',
    );
  }
  return [
    ...new Set([
      ...contract.browser_resources.egress_rules.map((rule) => rule.origin),
      ...browserResources.egress_rules.map((rule) => rule.origin),
    ]),
  ];
}

function checkedLoginWireBudget(
  contract: PublicAuthenticationContractV1,
  checkCapability: PublicReadCapabilityV1,
): number {
  const browserResources = checkCapability.browser_resources;
  if (browserResources === null) {
    throw new PublicHttpExecutionError(
      'invalid_request',
      'login check has no browser resource policy',
    );
  }
  const total =
    contract.browser_resources.max_proxy_wire_bytes_per_login +
    browserResources.max_proxy_wire_bytes_per_browser_task;
  if (!Number.isSafeInteger(total) || total < 1) {
    throw new PublicHttpExecutionError('invalid_request', 'login browser wire budget is invalid');
  }
  return total;
}

function loginNetworkCapability(
  contract: PublicAuthenticationContractV1,
): BrowserNetworkCapabilityV1 {
  const policy: BrowserResourcePolicyV1 = {
    egress_rules: contract.browser_resources.egress_rules.map((rule) => ({
      rule_id: rule.rule_id,
      phase: rule.resource_types[0] === 'document' ? 'navigation' : 'resource',
      origin: rule.origin,
      methods: rule.methods,
      route: rule.route,
      resource_types: rule.resource_types,
      max_requests: rule.max_requests,
      max_encoded_request_body_bytes: rule.max_encoded_request_body_bytes,
      max_encoded_response_bytes: rule.max_encoded_response_bytes,
    })) as BrowserResourcePolicyV1['egress_rules'],
    max_requests_per_browser_task: contract.browser_resources.max_requests_per_login,
    max_encoded_request_body_bytes_per_browser_task:
      contract.browser_resources.max_encoded_request_body_bytes_per_login,
    max_encoded_response_bytes_per_browser_task:
      contract.browser_resources.max_encoded_response_bytes_per_login,
    max_proxy_wire_bytes_per_browser_task:
      contract.browser_resources.max_proxy_wire_bytes_per_login,
    max_single_request_body_bytes: contract.browser_resources.max_single_request_body_bytes,
    max_single_response_bytes: contract.browser_resources.max_single_response_bytes,
    service_workers: 'block',
    downloads: 'block',
    popups: 'block',
    websockets: 'block',
    webtransport: 'block',
    webrtc_direct_egress: 'block',
    browser_cache: 'block',
  };
  return {
    browser_resources: policy,
    origin_traffic_policies: contract.origin_traffic_policies,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import type { Browser, Page } from 'playwright';
import { validateJsonSchema } from '../../../public/contracts/json-schema';
import type {
  PublicHttpStrategyV1,
  PublicReadCapabilityV1,
} from '../../../public/contracts/package';
import {
  buildPublicHttpRequest,
  projectPublicResponse,
  PublicHttpExecutionError,
  type PublicHttpResponseV1,
} from '../node-http';
import { startPinnedEgressProxy, type PinnedEgressProxyV1 } from './pinned-proxy';
import {
  installBrowserNetworkBoundary,
  type BrowserNetworkBoundaryV1,
  type PublicBrowserExecutionOptionsV1,
} from './executor';
import {
  createPublicBrowserContextOptions,
  installPublicSinglePageGuard,
  launchPublicBrowser,
} from './context';

interface BrowserFetchResultV1 {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export async function executeBrowserHttpStrategy(
  capability: PublicReadCapabilityV1,
  strategy: PublicHttpStrategyV1,
  options: PublicBrowserExecutionOptionsV1,
): Promise<PublicHttpResponseV1> {
  if (!capability.strategies.includes(strategy)) {
    throw new PublicHttpExecutionError(
      'invalid_request',
      'strategy is absent from the selected capability',
    );
  }
  if (strategy.context !== 'browser') {
    throw new PublicHttpExecutionError(
      'invalid_request',
      'browser HTTP execution requires a browser-context strategy',
    );
  }
  if (capability.browser_resources === null) {
    throw new PublicHttpExecutionError('invalid_request', 'browser HTTP has no resource policy');
  }
  if (!capability.navigation_origins.includes(strategy.request.base_url)) {
    throw new PublicHttpExecutionError(
      'invalid_request',
      'browser HTTP base origin is not declared for navigation',
    );
  }
  if (!Number.isSafeInteger(options.timeout_ms) || options.timeout_ms < 1) {
    throw new PublicHttpExecutionError('invalid_request', 'timeout_ms must be a positive integer');
  }
  if (
    !Number.isSafeInteger(options.max_target_requests) ||
    options.max_target_requests < 2 ||
    options.max_target_requests > capability.max_target_requests_per_call
  ) {
    throw new PublicHttpExecutionError(
      'invalid_request',
      'browser HTTP needs budget for its bootstrap navigation and request',
    );
  }
  validateJsonSchema(options.input, capability.input_schema, 'call.input');
  const request = buildPublicHttpRequest(strategy, {
    input: options.input,
    bindings: options.bindings,
  });
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
  let boundary: Awaited<ReturnType<typeof installBrowserNetworkBoundary>> | null = null;
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
      await page.goto(strategy.request.base_url, {
        waitUntil: 'domcontentloaded',
        timeout: options.timeout_ms,
      });
      const scope = boundary.beginRuntimeRequest();
      let fetched: BrowserFetchResultV1;
      try {
        fetched = await page.evaluate(
          async (value) => {
            const response = await fetch(value.url, {
              method: value.method,
              headers: value.headers,
              credentials: 'include',
              ...(value.body === null ? {} : { body: value.body }),
            });
            const headers: Record<string, string> = {};
            response.headers.forEach((headerValue, name) => {
              headers[name] = headerValue;
            });
            return { status: response.status, headers, body: await response.text() };
          },
          {
            url: request.url.toString(),
            method: request.method,
            headers: request.headers,
            body: request.body?.toString('utf8') ?? null,
          },
        );
      } finally {
        boundary.finishRuntimeRequest(scope);
      }
      const bytes = Buffer.from(fetched.body, 'utf8');
      if (bytes.byteLength > request.response_limit) {
        throw new PublicHttpExecutionError(
          'response_too_large',
          'browser HTTP response exceeds its signed limit',
          boundary.target_requests(),
        );
      }
      pageGuard.assertHealthy();
      boundary.assertHealthy();
      return {
        ...projectPublicResponse(strategy.projection, {
          status: fetched.status,
          headers: fetched.headers,
          bytes,
        }),
        target_requests: boundary.target_requests(),
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
        'browser HTTP deadline expired',
        targetRequests,
      );
    }
    if (signal.aborted) {
      throw new PublicHttpExecutionError(
        'cancelled',
        'caller cancelled browser HTTP',
        targetRequests,
      );
    }
    if (error instanceof PublicHttpExecutionError) throw error;
    throw new PublicHttpExecutionError('transport_failure', asError(error).message, targetRequests);
  } finally {
    clearTimeout(timer);
    await boundary?.close();
    await browser?.close();
    await proxy?.close();
  }
}

/** Executes one browser HTTP strategy inside an already-isolated page. */
export async function executeBrowserHttpStrategyInBoundedPage(
  page: Page,
  boundary: BrowserNetworkBoundaryV1,
  capability: PublicReadCapabilityV1,
  strategy: PublicHttpStrategyV1,
  options: PublicBrowserExecutionOptionsV1,
): Promise<PublicHttpResponseV1> {
  if (!capability.strategies.includes(strategy)) {
    throw new PublicHttpExecutionError(
      'invalid_request',
      'strategy is absent from the selected capability',
    );
  }
  if (strategy.context !== 'browser') {
    throw new PublicHttpExecutionError(
      'invalid_request',
      'browser HTTP execution requires a browser-context strategy',
    );
  }
  if (capability.browser_resources === null) {
    throw new PublicHttpExecutionError('invalid_request', 'browser HTTP has no resource policy');
  }
  if (!capability.navigation_origins.includes(strategy.request.base_url)) {
    throw new PublicHttpExecutionError(
      'invalid_request',
      'browser HTTP base origin is not declared for navigation',
    );
  }
  if (!Number.isSafeInteger(options.timeout_ms) || options.timeout_ms < 1) {
    throw new PublicHttpExecutionError('invalid_request', 'timeout_ms must be a positive integer');
  }
  if (
    !Number.isSafeInteger(options.max_target_requests) ||
    options.max_target_requests < 2 ||
    options.max_target_requests > capability.max_target_requests_per_call
  ) {
    throw new PublicHttpExecutionError(
      'invalid_request',
      'browser HTTP needs budget for its bootstrap navigation and request',
    );
  }
  validateJsonSchema(options.input, capability.input_schema, 'call.input');
  const request = buildPublicHttpRequest(strategy, {
    input: options.input,
    bindings: options.bindings,
  });
  const deadline = new AbortController();
  const deadlineState = { timed_out: false };
  const timer = setTimeout(() => {
    deadlineState.timed_out = true;
    deadline.abort();
  }, options.timeout_ms);
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline.signal])
    : deadline.signal;
  try {
    if (signal.aborted) {
      throw new PublicHttpExecutionError('cancelled', 'caller cancelled before browser HTTP');
    }
    boundary.transition(
      {
        browser_resources: capability.browser_resources,
        origin_traffic_policies: capability.origin_traffic_policies,
      },
      { ...options, signal },
    );
    await page.goto(strategy.request.base_url, {
      waitUntil: 'domcontentloaded',
      timeout: options.timeout_ms,
    });
    const scope = boundary.beginRuntimeRequest();
    let fetched: BrowserFetchResultV1;
    try {
      fetched = await page.evaluate(
        async (value) => {
          const response = await fetch(value.url, {
            method: value.method,
            headers: value.headers,
            credentials: 'include',
            ...(value.body === null ? {} : { body: value.body }),
          });
          const headers: Record<string, string> = {};
          response.headers.forEach((headerValue, name) => {
            headers[name] = headerValue;
          });
          return { status: response.status, headers, body: await response.text() };
        },
        {
          url: request.url.toString(),
          method: request.method,
          headers: request.headers,
          body: request.body?.toString('utf8') ?? null,
        },
      );
    } finally {
      boundary.finishRuntimeRequest(scope);
    }
    const bytes = Buffer.from(fetched.body, 'utf8');
    if (bytes.byteLength > request.response_limit) {
      throw new PublicHttpExecutionError(
        'response_too_large',
        'browser HTTP response exceeds its signed limit',
        boundary.target_requests(),
      );
    }
    return {
      ...projectPublicResponse(strategy.projection, {
        status: fetched.status,
        headers: fetched.headers,
        bytes,
      }),
      target_requests: boundary.target_requests(),
    };
  } catch (error) {
    const targetRequests = boundary.target_requests();
    if (deadlineState.timed_out) {
      throw new PublicHttpExecutionError(
        'request_timeout',
        'browser HTTP deadline expired',
        targetRequests,
      );
    }
    if (signal.aborted) {
      throw new PublicHttpExecutionError(
        'cancelled',
        'caller cancelled browser HTTP',
        targetRequests,
      );
    }
    if (error instanceof PublicHttpExecutionError) throw error;
    throw new PublicHttpExecutionError('transport_failure', asError(error).message, targetRequests);
  } finally {
    clearTimeout(timer);
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

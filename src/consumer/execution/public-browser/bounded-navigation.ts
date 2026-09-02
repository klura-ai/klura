import type { Page } from 'playwright';
import { validateJsonSchema } from '../../../public/contracts/json-schema';
import type {
  PublicBrowserNavigationStrategyV1,
  PublicReadCapabilityV1,
} from '../../../public/contracts/package';
import { PublicHttpExecutionError, type PublicHttpResponseV1 } from '../node-http';
import { projectBrowserDom, BrowserProjectionError } from './dom-projection';
import {
  executeBrowserInteractionProgram,
  BrowserInteractionExecutionError,
} from './interaction-executor';
import { type BrowserNetworkBoundaryV1, type PublicBrowserExecutionOptionsV1 } from './executor';
import { resolveNavigationUrl, waitForBrowserStrategy } from './navigation-helpers';
import { evaluateOutcomeSelectors } from './outcome-selectors';

/** Executes one browser-navigation strategy inside an already-isolated page. */
export async function executeBrowserNavigationStrategyInBoundedPage(
  page: Page,
  boundary: BrowserNetworkBoundaryV1,
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
  try {
    if (signal.aborted) {
      throw new PublicHttpExecutionError('cancelled', 'caller cancelled before browser navigation');
    }
    boundary.transition(
      {
        browser_resources: capability.browser_resources,
        origin_traffic_policies: capability.origin_traffic_policies,
      },
      { ...options, signal },
    );
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
    return {
      status: response.status(),
      headers: response.headers(),
      media_type: 'application/json',
      body_kind: Array.isArray(body) ? 'json_array' : 'json_object',
      body,
      target_requests: boundary.target_requests(),
      html_selector_exists: (selector: string) => selectorMatches.get(selector) ?? false,
    };
  } catch (error) {
    const targetRequests = boundary.target_requests();
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
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

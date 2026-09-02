import { PublicContractError } from '../public/contracts/common';
import {
  evaluateOutcomeContracts,
  type OutcomeEvaluationResultV1,
} from '../public/contracts/outcome';
import type { JsonValueV1 } from '../public/contracts/json';
import type {
  PublicBrowserPageScriptStrategyV1,
  PublicBrowserNavigationStrategyV1,
  PublicHttpStrategyV1,
  PublicReadCapabilityV1,
} from '../public/contracts/package';
import {
  executeBrowserNavigationStrategy,
  type PublicBrowserExecutionOptionsV1,
} from './execution/public-browser/executor';
import { executeBrowserHttpStrategy } from './execution/public-browser/http-executor';
import { executeBrowserPageScriptStrategy } from './execution/public-browser/page-script-executor';
import {
  executeNodeHttpStrategy,
  PublicHttpExecutionError,
  type PublicHttpExecutionOptionsV1,
  type PublicHttpResponseV1,
} from './execution/node-http';
import { OriginSchedulerV1 } from './execution/origin-scheduler';
import type { BrowserInteractionFailureV1 } from './execution/public-browser/interaction-executor';

export type PublicCallResultV1 =
  | (OutcomeEvaluationResultV1 & { attempts: number })
  | {
      kind: 'failure';
      code:
        | 'invalid_timeout'
        | 'session_required'
        | 'session_invalid'
        | 'request_blocked'
        | 'request_budget_exhausted'
        | 'request_timeout'
        | 'response_too_large'
        | 'response_invalid_json'
        | 'response_contract_mismatch'
        | 'transport_failure'
        | 'cancelled'
        | 'invalid_input'
        | 'browser_unavailable';
      attempts: number;
    }
  | {
      kind: 'failure';
      code: 'browser_interaction_failed';
      attempts: number;
      cause: BrowserInteractionFailureV1;
    };

export interface PublicCallOptionsV1 {
  timeout_ms?: number;
  browser_storage_state?: JsonValueV1;
  signal?: AbortSignal;
  workload_id?: string;
  scheduler?: OriginSchedulerV1;
  resolve_host?: PublicHttpExecutionOptionsV1['resolve_host'];
}

export type PublicHttpExecutorV1 = (
  capability: PublicReadCapabilityV1,
  strategy: PublicHttpStrategyV1,
  options: PublicHttpExecutionOptionsV1,
) => Promise<PublicHttpResponseV1>;

export type PublicBrowserNavigationExecutorV1 = (
  capability: PublicReadCapabilityV1,
  strategy: PublicBrowserNavigationStrategyV1,
  options: PublicBrowserExecutionOptionsV1,
) => Promise<PublicHttpResponseV1>;

export type PublicBrowserHttpExecutorV1 = (
  capability: PublicReadCapabilityV1,
  strategy: PublicHttpStrategyV1,
  options: PublicBrowserExecutionOptionsV1,
) => Promise<PublicHttpResponseV1>;

export type PublicBrowserPageScriptExecutorV1 = (
  capability: PublicReadCapabilityV1,
  strategy: PublicBrowserPageScriptStrategyV1,
  options: PublicBrowserExecutionOptionsV1,
) => Promise<PublicHttpResponseV1>;

export class PublicCallerV1 {
  constructor(
    private readonly execute: PublicHttpExecutorV1 = executeNodeHttpStrategy,
    private readonly random: () => number = Math.random,
    private readonly executeBrowser: PublicBrowserNavigationExecutorV1 = executeBrowserNavigationStrategy,
    private readonly executeBrowserHttp: PublicBrowserHttpExecutorV1 = executeBrowserHttpStrategy,
    private readonly executeBrowserPageScript: PublicBrowserPageScriptExecutorV1 = executeBrowserPageScriptStrategy,
  ) {}

  async call(
    capability: PublicReadCapabilityV1,
    input: JsonValueV1,
    options: PublicCallOptionsV1 = {},
  ): Promise<PublicCallResultV1> {
    if (
      capability.authentication.mode === 'required' &&
      options.browser_storage_state === undefined
    ) {
      return { kind: 'failure', code: 'session_required', attempts: 0 };
    }
    const totalTimeout = options.timeout_ms ?? capability.call_timeouts.total_timeout_ms;
    if (
      !Number.isSafeInteger(totalTimeout) ||
      totalTimeout < 1 ||
      totalTimeout > capability.call_timeouts.total_timeout_ms
    ) {
      return { kind: 'failure', code: 'invalid_timeout', attempts: 0 };
    }
    const deadline = Date.now() + totalTimeout;
    const scheduler = options.scheduler ?? new OriginSchedulerV1();
    let targetRequests = 0;
    let lastResult: PublicCallResultV1 | null = null;
    for (const strategy of capability.strategies) {
      let retries = 0;
      while (targetRequests < capability.max_target_requests_per_call) {
        const remaining = deadline - Date.now();
        if (remaining <= 0)
          return { kind: 'failure', code: 'request_timeout', attempts: targetRequests };
        try {
          const executionOptions = {
            input,
            bindings: {},
            ...(options.browser_storage_state === undefined
              ? {}
              : { storage_state: options.browser_storage_state }),
            timeout_ms: Math.min(remaining, capability.call_timeouts.per_request_timeout_ms),
            max_target_requests: capability.max_target_requests_per_call - targetRequests,
            scheduler,
            signal: options.signal,
            workload_id: options.workload_id,
            resolve_host: options.resolve_host,
          };
          let response: PublicHttpResponseV1;
          if (strategy.kind === 'browser_navigation') {
            response = await this.executeBrowser(capability, strategy, executionOptions);
          } else if (strategy.kind === 'browser_page_script') {
            response = await this.executeBrowserPageScript(capability, strategy, executionOptions);
          } else if (strategy.context === 'node') {
            response = await this.execute(capability, strategy, executionOptions);
          } else {
            response = await this.executeBrowserHttp(capability, strategy, executionOptions);
          }
          const strategyId =
            strategy.kind === 'http_request' ? strategy.request.strategy_id : strategy.strategy_id;
          const consumed = parseConsumedTargetRequests(
            response.target_requests,
            capability.max_target_requests_per_call - targetRequests,
          );
          targetRequests += consumed;
          const outcome = evaluateOutcomeContracts(capability.outcomes, strategyId, response, {
            input,
            html_selector_exists: response.html_selector_exists,
            maximum_output_bytes: capability.max_encoded_outcome_bytes,
          });
          if (outcome.kind === 'outcome') {
            if (
              (outcome.outcome_class === 'rate_limited' ||
                outcome.outcome_class === 'upstream_unavailable') &&
              capability.call_retry_policy.on.includes(outcome.outcome_class) &&
              retries < capability.call_retry_policy.max_retries
            ) {
              retries += 1;
              const delay = retryDelay(
                capability.call_retry_policy,
                retries,
                outcome.retry_after_ms,
                this.random,
              );
              if (delay > deadline - Date.now()) return { ...outcome, attempts: targetRequests };
              await waitForRetry(delay, options.signal);
              continue;
            }
            return { ...outcome, attempts: targetRequests };
          }
          lastResult = { ...outcome, attempts: targetRequests };
          break;
        } catch (error) {
          targetRequests += consumedTargetRequestsOnFailure(
            error,
            capability.max_target_requests_per_call - targetRequests,
          );
          const failure = mapExecutionError(error, targetRequests);
          if (
            failure.code === 'transport_failure' &&
            capability.call_retry_policy.on.includes('transport_failure') &&
            retries < capability.call_retry_policy.max_retries
          ) {
            retries += 1;
            const delay = retryDelay(capability.call_retry_policy, retries, null, this.random);
            if (delay > deadline - Date.now()) return failure;
            await waitForRetry(delay, options.signal);
            continue;
          }
          if (failure.code === 'transport_failure' || failure.code === 'request_timeout') {
            lastResult = failure;
            break;
          }
          return failure;
        }
      }
    }
    return lastResult ?? { kind: 'failure', code: 'transport_failure', attempts: targetRequests };
  }
}

function retryDelay(
  policy: PublicReadCapabilityV1['call_retry_policy'],
  retry: number,
  structuralRetryAfterMs: number | null,
  random: () => number,
): number {
  const exponential = Math.min(policy.max_delay_ms, policy.base_delay_ms * 2 ** (retry - 1));
  const jitter = Math.floor(exponential * policy.jitter_ratio * boundedRandom(random));
  const structural =
    policy.honor_structural_retry_after && structuralRetryAfterMs !== null
      ? structuralRetryAfterMs
      : 0;
  return Math.max(exponential + jitter, structural);
}

function boundedRandom(random: () => number): number {
  const value = random();
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function mapExecutionError(
  error: unknown,
  attempts: number,
): Extract<PublicCallResultV1, { kind: 'failure' }> {
  if (error instanceof PublicHttpExecutionError) {
    if (error.code === 'invalid_request')
      return { kind: 'failure', code: 'invalid_input', attempts };
    if (error.code === 'browser_interaction_failed') {
      if (error.interaction_failure !== null) {
        return {
          kind: 'failure',
          code: 'browser_interaction_failed',
          attempts,
          cause: error.interaction_failure,
        };
      }
      return { kind: 'failure', code: 'transport_failure', attempts };
    }
    return { kind: 'failure', code: error.code, attempts };
  }
  if (error instanceof PublicContractError)
    return { kind: 'failure', code: 'invalid_input', attempts };
  return { kind: 'failure', code: 'transport_failure', attempts };
}

function parseConsumedTargetRequests(value: unknown, remaining: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > remaining) {
    throw new PublicHttpExecutionError(
      'transport_failure',
      'HTTP executor returned an invalid target request count',
    );
  }
  return value;
}

function consumedTargetRequestsOnFailure(error: unknown, remaining: number): number {
  if (remaining < 1) return 0;
  if (error instanceof PublicHttpExecutionError) {
    if (error.target_requests > remaining) return remaining;
    if (error.target_requests > 0) return error.target_requests;
    if (error.code === 'transport_failure' || error.code === 'request_timeout') return 1;
    return 0;
  }
  return 1;
}

async function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted)
    throw new PublicHttpExecutionError('cancelled', 'caller cancelled retry wait');
  await new Promise<void>((resolve, reject) => {
    const complete = (): void => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(complete, delayMs);
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(new PublicHttpExecutionError('cancelled', 'caller cancelled retry wait'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

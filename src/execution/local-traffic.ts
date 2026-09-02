import { loadConfig } from '../config/handler';
import { getKluraHome } from '../paths';
import {
  type OriginSchedulerPermitV1,
  type OriginSchedulerTrafficPolicyV1,
} from './origin-scheduler';
import { getSharedOriginScheduler } from './shared-origin-scheduler';
import { FactoryExecutionStateError } from './result-classification';

const LOCAL_MAX_REDIRECT_HOPS = 5;

export class LocalRequestTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`trusted local request timed out after ${timeoutMs}ms`);
    this.name = 'LocalRequestTimeoutError';
  }
}

/** True when a dispatched HTTP method may have changed remote state. */
export function httpMethodMayMutate(method: unknown): boolean {
  const normalized = typeof method === 'string' ? method.toUpperCase() : 'GET';
  return normalized !== 'GET' && normalized !== 'HEAD' && normalized !== 'OPTIONS';
}

export function dispatchedHttpDeliveryUnknown(
  method: unknown,
  url: string,
  details: Record<string, unknown> = {},
): FactoryExecutionStateError {
  const normalized = typeof method === 'string' ? method.toUpperCase() : 'GET';
  return new FactoryExecutionStateError(
    'sent_unconfirmed',
    'http_delivery_unknown',
    `${normalized} ${url} was dispatched but no response confirmed its delivery`,
    { method: normalized, url, ...details },
  );
}

/**
 * Convert a local deadline into a neutral delivery outcome only after the
 * caller has dispatched a mutation-shaped HTTP request.
 */
export function mapDispatchedHttpTimeout(error: unknown, method: unknown, url: string): unknown {
  if (!(error instanceof LocalRequestTimeoutError) || !httpMethodMayMutate(method)) return error;
  return dispatchedHttpDeliveryUnknown(method, url, { timeout_ms: error.timeoutMs });
}

/** Returns the configured traffic policy for one trusted local HTTP(S) or WS(S) request. */
export function localTrafficPolicyForUrl(url: string): OriginSchedulerTrafficPolicyV1 {
  const parsed = new URL(url);
  const originUrl = new URL(parsed);
  if (parsed.protocol === 'ws:') {
    originUrl.protocol = 'http:';
  } else if (parsed.protocol === 'wss:') {
    originUrl.protocol = 'https:';
  } else if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('trusted local traffic requires an HTTP(S) or WS(S) URL');
  }
  const traffic = loadConfig().traffic;
  return {
    origin: originUrl.origin,
    max_concurrency: traffic.max_concurrency,
    requests_per_second: traffic.requests_per_second,
    burst: traffic.burst,
    min_delay_ms: traffic.min_delay_ms,
    max_redirect_hops: LOCAL_MAX_REDIRECT_HOPS,
    circuit_breaker: {
      transient_failure_threshold: traffic.transient_failure_threshold,
      transient_window_ms: traffic.transient_window_ms,
      cooldown_ms: traffic.cooldown_ms,
    },
  };
}

/** Returns the configured deadline for one trusted local HTTP(S) request. */
export function localRequestTimeoutMs(): number {
  return loadConfig().traffic.request_timeout_ms;
}

/** Reserves one shared local traffic admission for an HTTP(S) or WS(S) request. */
export async function acquireLocalOriginPermit(
  url: string,
  workloadId: string,
): Promise<OriginSchedulerPermitV1> {
  return await getSharedOriginScheduler(getKluraHome()).acquire(localTrafficPolicyForUrl(url), {
    workload_id: workloadId,
  });
}

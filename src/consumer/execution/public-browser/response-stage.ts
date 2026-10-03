import type { BrowserFetchPausedV1 } from './fetch-paused';
import { PublicHttpExecutionError } from '../node-http';
import type { AdmittedBrowserRequestV1, FetchHandlerStateV1 } from './executor';
import { describeRequest, releaseVanishedRequest } from './request-stage';
import { readPausedResponseBody, rewriteResponseHeaders } from './response-boundary';
import { redirectChainKey, redirectLocation } from './response-redirect';

export async function handleResponseStage(
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
  const chain = redirectChainKey(paused);
  admission.reading_response = true;
  try {
    if (redirectLocation(paused) !== null) {
      await continueRedirect(paused, admission, chain, state);
      return;
    }
    state.redirectHops.delete(chain);
    const body = await state.responseBodyQueue.run(async () => {
      const remaining =
        state.policy.max_encoded_response_bytes_per_browser_task - state.responseBytes;
      const limit = Math.min(
        admission.rule.max_encoded_response_bytes,
        state.policy.max_single_response_bytes,
        remaining,
      );
      let result: Buffer;
      try {
        result = await readPausedResponseBody(state.cdp, paused.request_id, limit);
      } catch (error) {
        if (error instanceof PublicHttpExecutionError && error.code === 'response_too_large') {
          throw new PublicHttpExecutionError(
            'response_too_large',
            `${error.message}: ${describeRequest(paused, admission.rule.phase === 'login' ? 'navigation' : admission.rule.phase)} may carry at most ${limit} bytes (rule ${admission.rule.rule_id} ${admission.rule.max_encoded_response_bytes}, single response ${state.policy.max_single_response_bytes}, task remaining ${remaining})`,
          );
        }
        throw error;
      }
      state.responseBytes += result.byteLength;
      return result;
    });
    await state.cdp.send('Fetch.fulfillRequest', {
      requestId: paused.request_id,
      responseCode: responseStatus,
      responseHeaders: rewriteResponseHeaders(paused.response_headers, body.byteLength),
      body: body.toString('base64'),
    });
    settleAdmission(
      paused,
      admission,
      state,
      responseStatus >= 500 ? 'transient_failure' : 'success',
    );
  } catch (error) {
    if (error instanceof PublicHttpExecutionError) {
      await state.fail(paused.request_id, error);
      return;
    }
    // A protocol error here means the browser dropped the interception — the
    // page navigated away while its response was being read — not that the
    // response broke a bound; the task carries on.
    releaseVanishedRequest(paused.request_id, state);
  }
}

/** The network id Chromium reports on a load that finished or failed. */
export function loadingFailedNetworkId(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const requestId = (raw as { requestId?: unknown }).requestId;
  return typeof requestId === 'string' ? requestId : null;
}

/** A redirect carries no body: the browser follows it and the next hop is
 *  paused and admitted as a request of its own, so here only the chain length
 *  is bounded, by the admitted origin's policy. */
async function continueRedirect(
  paused: BrowserFetchPausedV1,
  admission: AdmittedBrowserRequestV1,
  chain: string,
  state: FetchHandlerStateV1,
): Promise<void> {
  const hops = (state.redirectHops.get(chain) ?? 0) + 1;
  if (hops > admission.origin_policy.max_redirect_hops) {
    state.redirectHops.delete(chain);
    throw new PublicHttpExecutionError(
      'request_blocked',
      `redirect limit is exhausted: ${describeRedirect(paused)} would be hop ${hops} of at most ${admission.origin_policy.max_redirect_hops}`,
    );
  }
  state.redirectHops.set(chain, hops);
  await state.cdp.send('Fetch.continueRequest', { requestId: paused.request_id });
  settleAdmission(paused, admission, state, 'success');
}

function describeRedirect(paused: BrowserFetchPausedV1): string {
  try {
    const url = new URL(paused.url);
    return `${paused.method} ${url.origin}${url.pathname} → ${paused.response_status}`;
  } catch {
    return `${paused.method} request → ${paused.response_status}`;
  }
}

function settleAdmission(
  paused: BrowserFetchPausedV1,
  admission: AdmittedBrowserRequestV1,
  state: FetchHandlerStateV1,
  outcome: 'success' | 'transient_failure',
): void {
  admission.permit.release(outcome);
  state.admitted.delete(paused.request_id);
  state.activeRequests -= 1;
  if (admission.operation !== null) {
    admission.operation.pending_request_ids.delete(paused.request_id);
    state.operationActivityChanged(admission.operation);
  }
  state.activityChanged();
}

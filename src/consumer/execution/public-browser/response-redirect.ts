import type { BrowserFetchPausedV1 } from './fetch-paused';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** The Location a redirect response points at, or null when the response is
 *  not a redirect the browser will follow. */
export function redirectLocation(paused: BrowserFetchPausedV1): string | null {
  if (paused.response_status === null || !REDIRECT_STATUSES.has(paused.response_status)) {
    return null;
  }
  const header = paused.response_headers.find((entry) => entry.name.toLowerCase() === 'location');
  return header === undefined || header.value === '' ? null : header.value;
}

/** Groups the hops of one redirect chain: Chromium keeps the network id across
 *  hops while the interception id changes, so the chain is counted under the
 *  network id and a request without one is its own chain. */
export function redirectChainKey(paused: BrowserFetchPausedV1): string {
  return paused.network_id ?? paused.request_id;
}

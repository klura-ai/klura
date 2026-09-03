import { promises as dns } from 'node:dns';
import type { IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { URL } from 'node:url';
import { PublicContractError } from '../../public/contracts/common';
import { canonicalJson, parseStrictJson, type JsonValueV1 } from '../../public/contracts/json';
import { validateJsonSchema } from '../../public/contracts/json-schema';
import type { PublicHttpStrategyV1, PublicReadCapabilityV1 } from '../../public/contracts/package';
import {
  evaluateValueExpression,
  type ValueExpressionContextV1,
} from '../../public/contracts/value-expression';
import type { HtmlProjectionV1 } from '../../public/contracts/html-projection';
import { readConsumerRuntimeVersion } from '../runtime-version';
import { decodeHtmlBody, projectHtml } from './html-projection';
import { OriginSchedulerV1 } from './origin-scheduler';
import type { BrowserInteractionFailureV1 } from './public-browser/interaction-executor';

let cachedUserAgent: string | null = null;

/** Identifies the runtime on every target request a package does not label itself. */
export function consumerUserAgent(): string {
  if (cachedUserAgent === null) cachedUserAgent = `klura/${readConsumerRuntimeVersion()}`;
  return cachedUserAgent;
}

/** The exact header set dispatched for a prepared request: the runtime's
 *  user-agent unless the package declares its own, every declared header, and
 *  the pinned host. */
export function outgoingRequestHeaders(
  request: Pick<PreparedRequestV1, 'headers' | 'url'>,
): Record<string, string> {
  return {
    'user-agent': consumerUserAgent(),
    ...request.headers,
    host: request.url.host,
  };
}

export interface PublicHttpResponseV1 {
  status: number;
  headers: Record<string, string>;
  media_type: string | null;
  body_kind: 'json_object' | 'json_array';
  body: JsonValueV1;
  target_requests: number;
  html_selector_exists?: (selector: string) => boolean;
}

export interface PublicHttpExecutionOptionsV1 {
  input: JsonValueV1;
  bindings: Readonly<Record<string, JsonValueV1>>;
  timeout_ms: number;
  max_target_requests: number;
  scheduler: OriginSchedulerV1;
  signal?: AbortSignal;
  workload_id?: string;
  resolve_host?: (hostname: string) => Promise<readonly string[]>;
}

export class PublicHttpExecutionError extends PublicContractError {
  constructor(
    public readonly code:
      | 'cancelled'
      | 'invalid_request'
      | 'request_blocked'
      | 'request_budget_exhausted'
      | 'request_timeout'
      | 'response_too_large'
      | 'response_invalid_json'
      | 'response_contract_mismatch'
      | 'transport_failure'
      | 'browser_unavailable'
      | 'browser_interaction_failed',
    message: string,
    public readonly target_requests = 0,
    public readonly interaction_failure: BrowserInteractionFailureV1 | null = null,
    public readonly diagnostic: PublicExecutionDiagnosticV1 | null = null,
  ) {
    super('public_http', message);
    this.name = 'PublicHttpExecutionError';
  }
}

export interface PublicExecutionDiagnosticV1 {
  kind: 'egress_rejected';
  phase: 'navigation' | 'resource' | 'interaction' | 'runtime_request' | 'page_script';
  origin: string | null;
  path: string | null;
  query_keys: string[];
  method: string;
  resource_type: string;
  requested_method: string | null;
}

export async function executeNodeHttpStrategy(
  capability: PublicReadCapabilityV1,
  strategy: PublicHttpStrategyV1,
  options: PublicHttpExecutionOptionsV1,
): Promise<PublicHttpResponseV1> {
  assertStrategyBelongsToCapability(capability, strategy);
  if (strategy.context !== 'node') {
    throw new PublicHttpExecutionError(
      'invalid_request',
      'node HTTP execution requires a node-context strategy',
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
  const expressionContext: ValueExpressionContextV1 = {
    input: options.input,
    bindings: options.bindings,
  };
  validateJsonSchema(options.input, capability.input_schema, 'call.input');
  let request: PreparedRequestV1;
  try {
    request = buildPublicHttpRequest(strategy, expressionContext);
  } catch (error) {
    if (error instanceof PublicHttpExecutionError) throw error;
    throw new PublicHttpExecutionError('invalid_request', asError(error).message);
  }
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
    return await executeRedirectSequence(
      request,
      capability,
      { ...options, signal },
      0,
      0,
      options.resolve_host ?? resolvePublicHost,
    );
  } catch (error) {
    if (!deadlineState.timed_out) throw error;
    const targetRequests = error instanceof PublicHttpExecutionError ? error.target_requests : 0;
    throw new PublicHttpExecutionError(
      'request_timeout',
      'target request deadline expired',
      targetRequests,
    );
  } finally {
    clearTimeout(timer);
  }
}

function assertStrategyBelongsToCapability(
  capability: PublicReadCapabilityV1,
  strategy: PublicHttpStrategyV1,
): void {
  if (!capability.strategies.includes(strategy)) {
    throw new PublicHttpExecutionError(
      'invalid_request',
      'strategy is absent from the selected capability',
    );
  }
}

async function executeRedirectSequence(
  request: PreparedRequestV1,
  capability: PublicReadCapabilityV1,
  options: PublicHttpExecutionOptionsV1,
  redirectHops: number,
  targetRequests: number,
  resolveHost: (hostname: string) => Promise<readonly string[]>,
): Promise<PublicHttpResponseV1> {
  if (options.signal?.aborted) {
    throw new PublicHttpExecutionError('cancelled', 'caller cancelled before target dispatch');
  }
  const policy = capability.origin_traffic_policies.find(
    (candidate) => candidate.origin === request.url.origin,
  );
  if (!policy || !capability.request_origins.includes(request.url.origin)) {
    throw new PublicHttpExecutionError(
      'request_blocked',
      'request origin is not declared by the capability',
    );
  }
  if (targetRequests >= options.max_target_requests) {
    throw new PublicHttpExecutionError(
      'request_budget_exhausted',
      'signed target request budget is exhausted',
      targetRequests,
    );
  }
  const permit = await options.scheduler.acquire(policy, {
    signal: options.signal,
    workload_id: options.workload_id,
  });
  const nextTargetRequests = targetRequests + 1;
  let received: ReceivedResponseV1;
  try {
    received = await sendPinnedHttpsRequest(request, options, resolveHost);
    permit.release(received.status >= 500 ? 'transient_failure' : 'success');
  } catch (error) {
    permit.release(isTransientExecutionFailure(error) ? 'transient_failure' : 'neutral');
    throw withTargetRequestCount(error, targetRequests);
  }
  if (!isRedirectStatus(received.status)) {
    try {
      return {
        ...projectPublicResponse(capability, received),
        target_requests: nextTargetRequests,
      };
    } catch (error) {
      throw withTargetRequestCount(error, nextTargetRequests);
    }
  }
  if (redirectHops >= policy.max_redirect_hops) {
    throw new PublicHttpExecutionError(
      'request_blocked',
      'redirect limit is exhausted',
      nextTargetRequests,
    );
  }
  const location = received.headers.location;
  if (!location) {
    throw new PublicHttpExecutionError(
      'transport_failure',
      'redirect response has no Location header',
      nextTargetRequests,
    );
  }
  if (request.method !== 'GET' && received.status !== 307 && received.status !== 308) {
    throw new PublicHttpExecutionError(
      'request_blocked',
      'redirect would change the declared request method',
      nextTargetRequests,
    );
  }
  let redirectUrl: URL;
  try {
    redirectUrl = new URL(location, request.url);
  } catch {
    throw new PublicHttpExecutionError(
      'request_blocked',
      'redirect Location is invalid',
      nextTargetRequests,
    );
  }
  try {
    assertTargetUrl(redirectUrl);
  } catch (error) {
    throw withTargetRequestCount(error, nextTargetRequests);
  }
  return executeRedirectSequence(
    { ...request, url: redirectUrl },
    capability,
    options,
    redirectHops + 1,
    nextTargetRequests,
    resolveHost,
  );
}

export function buildPublicHttpRequest(
  strategy: PublicHttpStrategyV1,
  context: ValueExpressionContextV1,
): PreparedRequestV1 {
  const endpoint = evaluateAsString(strategy.request.endpoint, context, 'request.endpoint');
  let url: URL;
  try {
    url = new URL(endpoint, strategy.request.base_url);
  } catch {
    throw new PublicHttpExecutionError('invalid_request', 'endpoint does not resolve to a URL');
  }
  if (url.origin !== strategy.request.base_url) {
    throw new PublicHttpExecutionError(
      'request_blocked',
      'endpoint leaves its declared base origin',
    );
  }
  assertTargetUrl(url);
  for (const [name, expression] of Object.entries(strategy.request.query)) {
    url.searchParams.set(name, evaluateAsString(expression, context, `request.query.${name}`));
  }
  const headers: Record<string, string> = {};
  for (const [name, expression] of Object.entries(strategy.request.headers)) {
    headers[name] = evaluateAsString(expression, context, `request.headers.${name}`);
  }
  const body = encodeBody(strategy, context, headers);
  return {
    url,
    method: strategy.request.method,
    headers,
    body,
    response_limit: strategy.request.response_body_limit_bytes,
  };
}

function encodeBody(
  strategy: PublicHttpStrategyV1,
  context: ValueExpressionContextV1,
  headers: Record<string, string>,
): Buffer | null {
  if (strategy.request.body === null) return null;
  const value = evaluateValueExpression(strategy.request.body, context);
  const body = Buffer.from(typeof value === 'string' ? value : canonicalJson(value), 'utf8');
  if (!Object.hasOwn(headers, 'content-type') && typeof value !== 'string') {
    headers['content-type'] = 'application/json';
  }
  return body;
}

function evaluateAsString(
  expression: PublicHttpStrategyV1['request']['endpoint'],
  context: ValueExpressionContextV1,
  field: string,
): string {
  const value = evaluateValueExpression(expression, context);
  if (typeof value !== 'string') {
    throw new PublicHttpExecutionError('invalid_request', `${field} must evaluate to a string`);
  }
  return value;
}

async function sendPinnedHttpsRequest(
  request: PreparedRequestV1,
  options: PublicHttpExecutionOptionsV1,
  resolveHost: (hostname: string) => Promise<readonly string[]>,
): Promise<ReceivedResponseV1> {
  const addresses = await awaitWithSignal(resolveHost(request.url.hostname), options.signal);
  if (addresses.length === 0 || addresses.some((address) => !isPublicInternetAddress(address))) {
    throw new PublicHttpExecutionError(
      'request_blocked',
      'DNS resolution did not yield only public addresses',
    );
  }
  const address = addresses[0];
  if (!address) {
    throw new PublicHttpExecutionError(
      'request_blocked',
      'DNS resolution did not yield an address',
    );
  }
  return new Promise<ReceivedResponseV1>((resolve, reject) => {
    let settled = false;
    let dispatched = false;
    const fail = (
      error: unknown,
      code: PublicHttpExecutionError['code'] = 'transport_failure',
    ): void => {
      if (settled) return;
      settled = true;
      if (error instanceof PublicHttpExecutionError && (error.target_requests > 0 || !dispatched)) {
        reject(error);
        return;
      }
      const failureCode = error instanceof PublicHttpExecutionError ? error.code : code;
      reject(
        new PublicHttpExecutionError(
          failureCode,
          asError(error).message,
          dispatched ? 1 : 0,
          null,
          error instanceof PublicHttpExecutionError ? error.diagnostic : null,
        ),
      );
    };
    const succeed = (value: ReceivedResponseV1): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const headers = outgoingRequestHeaders(request);
    const outgoing = https.request({
      protocol: 'https:',
      hostname: address,
      port: request.url.port || 443,
      servername: request.url.hostname,
      method: request.method,
      path: `${request.url.pathname}${request.url.search}`,
      headers,
      rejectUnauthorized: true,
      agent: false,
    });
    dispatched = true;
    const abort = (): void => {
      outgoing.destroy(
        new PublicHttpExecutionError('cancelled', 'caller cancelled target dispatch'),
      );
    };
    if (options.signal) options.signal.addEventListener('abort', abort, { once: true });
    const cleanup = (): void => {
      options.signal?.removeEventListener('abort', abort);
    };
    outgoing.once('error', (error) => {
      cleanup();
      fail(error);
    });
    outgoing.setTimeout(options.timeout_ms, () => {
      outgoing.destroy(new PublicHttpExecutionError('request_timeout', 'target request timed out'));
    });
    outgoing.once('response', (incoming) => {
      const headers = normalizeResponseHeaders(incoming.headers);
      const chunks: Buffer[] = [];
      let total = 0;
      incoming.on('data', (chunk: Buffer) => {
        total += chunk.byteLength;
        if (total > request.response_limit) {
          incoming.destroy(
            new PublicHttpExecutionError(
              'response_too_large',
              'target response exceeds its signed limit',
            ),
          );
          return;
        }
        chunks.push(chunk);
      });
      incoming.once('error', (error) => {
        cleanup();
        fail(error);
      });
      incoming.once('end', () => {
        cleanup();
        succeed({ status: incoming.statusCode ?? 0, headers, bytes: Buffer.concat(chunks, total) });
      });
    });
    if (request.body !== null) outgoing.write(request.body);
    outgoing.end();
  });
}

async function awaitWithSignal<Value>(value: Promise<Value>, signal?: AbortSignal): Promise<Value> {
  if (signal?.aborted) {
    throw new PublicHttpExecutionError('cancelled', 'caller cancelled before target dispatch');
  }
  return new Promise<Value>((resolve, reject) => {
    const abort = (): void => {
      reject(new PublicHttpExecutionError('cancelled', 'caller cancelled target dispatch'));
    };
    const cleanup = (): void => {
      signal?.removeEventListener('abort', abort);
    };
    signal?.addEventListener('abort', abort, { once: true });
    value.then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error: unknown) => {
        cleanup();
        reject(asError(error));
      },
    );
  });
}

/** Projects a received response by the strategy the capability selected for it:
 *  JSON bodies parse strictly; documents go through the declared HTML
 *  projection and arrive at the outcome contracts as one extracted object. */
export function projectPublicResponse(
  projection: PublicHttpStrategyV1['projection'] | PublicReadCapabilityV1,
  response: ReceivedResponseV1,
): Omit<PublicHttpResponseV1, 'target_requests'> {
  const selected = 'kind' in projection ? projection : httpProjectionOf(projection);
  if (selected.kind === 'html') return parsePublicHtmlResponse(response, selected);
  return parsePublicJsonResponse(response);
}

function httpProjectionOf(capability: PublicReadCapabilityV1): PublicHttpStrategyV1['projection'] {
  const strategy = capability.strategies.find(
    (candidate): candidate is PublicHttpStrategyV1 => candidate.kind === 'http_request',
  );
  return strategy?.projection ?? { kind: 'json' };
}

export function parsePublicHtmlResponse(
  response: ReceivedResponseV1,
  projection: HtmlProjectionV1,
): Omit<PublicHttpResponseV1, 'target_requests'> {
  const contentType = response.headers['content-type'];
  const mediaType = normalizeMediaType(contentType);
  // An HTML document may be served as text/html, application/xhtml+xml, or a
  // vendor partial such as text/vnd.reddit.partial+html; what matters is that
  // the subtype is HTML.
  if (mediaType === null || !/(^|\/|\+)x?html(\+xml)?$/.test(mediaType)) {
    throw new PublicHttpExecutionError(
      'response_contract_mismatch',
      'response is not declared as an HTML document',
    );
  }
  const body = projectHtml(decodeHtmlBody(response.bytes, contentType), projection);
  return {
    status: response.status,
    headers: response.headers,
    media_type: mediaType,
    body_kind: 'json_object',
    body,
  };
}

export function parsePublicJsonResponse(
  response: ReceivedResponseV1,
): Omit<PublicHttpResponseV1, 'target_requests'> {
  const mediaType = normalizeMediaType(response.headers['content-type']);
  if (mediaType !== 'application/json' && !mediaType?.endsWith('+json')) {
    throw new PublicHttpExecutionError('response_invalid_json', 'response is not declared as JSON');
  }
  let body: JsonValueV1;
  try {
    body = parseStrictJson(response.bytes, 'response.body', response.bytes.byteLength, 12);
  } catch (error) {
    throw new PublicHttpExecutionError('response_invalid_json', asError(error).message);
  }
  if (!body || typeof body !== 'object') {
    throw new PublicHttpExecutionError(
      'response_invalid_json',
      'JSON response must be an object or array',
    );
  }
  return {
    status: response.status,
    headers: response.headers,
    media_type: mediaType,
    body_kind: Array.isArray(body) ? 'json_array' : 'json_object',
    body,
  };
}

function withTargetRequestCount(
  error: unknown,
  completedTargetRequests: number,
): PublicHttpExecutionError {
  const sentTargetRequests = error instanceof PublicHttpExecutionError ? error.target_requests : 0;
  const targetRequests = completedTargetRequests + sentTargetRequests;
  if (error instanceof PublicHttpExecutionError && error.target_requests === targetRequests) {
    return error;
  }
  if (error instanceof PublicHttpExecutionError) {
    return new PublicHttpExecutionError(error.code, error.message, targetRequests);
  }
  return new PublicHttpExecutionError('transport_failure', asError(error).message, targetRequests);
}

async function resolvePublicHost(hostname: string): Promise<readonly string[]> {
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => entry.address);
}

function assertTargetUrl(url: URL): void {
  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    throw new PublicHttpExecutionError('request_blocked', 'target URL violates the HTTPS boundary');
  }
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isTransientExecutionFailure(error: unknown): boolean {
  return (
    error instanceof PublicHttpExecutionError &&
    (error.code === 'request_timeout' || error.code === 'transport_failure')
  );
}

function normalizeResponseHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    normalized[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return normalized;
}

function normalizeMediaType(value: string | undefined): string | null {
  if (!value) return null;
  const [mediaType] = value.split(';', 1);
  return mediaType?.trim().toLowerCase() || null;
}

export function isPublicInternetAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  const first = parts[0];
  const second = parts[1];
  if (first === undefined || second === undefined) return false;
  if (first === 0 || first === 10 || first === 127 || first >= 224) return false;
  if (first === 100 && second >= 64 && second <= 127) return false;
  if (first === 169 && second === 254) return false;
  if (first === 172 && second >= 16 && second <= 31) return false;
  if (first === 192 && (second === 0 || second === 168)) return false;
  if (first === 198 && (second === 18 || second === 19 || second === 51)) return false;
  if (first === 203 && second === 0) return false;
  return true;
}

function isPublicIpv6(address: string): boolean {
  const bytes = parseIpv6Bytes(address);
  if (bytes === null) return false;
  const mappedIpv4 = readIpv4MappedAddress(bytes);
  if (mappedIpv4 !== null) return isPublicIpv4(mappedIpv4);
  if (hasPrefix(bytes, [0x00], 8)) return false;
  if (hasPrefix(bytes, [0xfc], 7)) return false;
  if (hasPrefix(bytes, [0xfe, 0x80], 10)) return false;
  if (hasPrefix(bytes, [0xff], 8)) return false;
  if (
    hasPrefix(bytes, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], 96)
  ) {
    return false;
  }
  if (hasPrefix(bytes, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01], 48)) return false;
  if (hasPrefix(bytes, [0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], 64)) return false;
  if (hasPrefix(bytes, [0x20, 0x01, 0x00, 0x00], 23)) return false;
  if (hasPrefix(bytes, [0x20, 0x01, 0x0d, 0xb8], 32)) return false;
  if (hasPrefix(bytes, [0x20, 0x02], 16)) return false;
  if (hasPrefix(bytes, [0x3f, 0xff, 0x00], 20)) return false;
  return true;
}

function parseIpv6Bytes(address: string): Uint8Array | null {
  if (net.isIP(address) !== 6) return null;
  const halves = address.toLowerCase().split('::');
  if (halves.length > 2) return null;
  const head = parseIpv6Half(halves[0] ?? '');
  const tail = parseIpv6Half(halves[1] ?? '');
  if (head === null || tail === null) return null;
  const hasCompression = halves.length === 2;
  const missing = 8 - head.length - tail.length;
  if ((!hasCompression && missing !== 0) || (hasCompression && missing < 1)) return null;
  const words = hasCompression ? [...head, ...new Array<number>(missing).fill(0), ...tail] : head;
  if (words.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (const [index, word] of words.entries()) {
    bytes[index * 2] = word >> 8;
    bytes[index * 2 + 1] = word & 0xff;
  }
  return bytes;
}

function parseIpv6Half(value: string): number[] | null {
  if (value.length === 0) return [];
  const parts = value.split(':');
  const words: number[] = [];
  for (const part of parts) {
    if (part.includes('.')) {
      if (part !== parts.at(-1)) return null;
      const ipv4 = parseIpv4Words(part);
      if (ipv4 === null) return null;
      words.push(...ipv4);
      continue;
    }
    if (part.length === 0 || part.length > 4 || !/^[0-9a-f]+$/.test(part)) return null;
    const word = Number.parseInt(part, 16);
    if (!Number.isSafeInteger(word) || word < 0 || word > 0xffff) return null;
    words.push(word);
  }
  return words;
}

function parseIpv4Words(address: string): [number, number] | null {
  if (net.isIP(address) !== 4) return null;
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return null;
  const [first, second, third, fourth] = octets;
  if (first === undefined || second === undefined || third === undefined || fourth === undefined) {
    return null;
  }
  return [(first << 8) | second, (third << 8) | fourth];
}

function readIpv4MappedAddress(bytes: Uint8Array): string | null {
  if (!hasPrefix(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96)) return null;
  return `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
}

function hasPrefix(bytes: Uint8Array, prefix: readonly number[], bits: number): boolean {
  const completeBytes = Math.floor(bits / 8);
  for (let index = 0; index < completeBytes; index += 1) {
    if (bytes[index] !== prefix[index]) return false;
  }
  const remainder = bits % 8;
  if (remainder === 0) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  const actual = bytes[completeBytes] ?? 0;
  const expected = prefix[completeBytes] ?? 0;
  return (actual & mask) === (expected & mask);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export interface PreparedRequestV1 {
  url: URL;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body: Buffer | null;
  response_limit: number;
}

export interface ReceivedResponseV1 {
  status: number;
  headers: Record<string, string>;
  bytes: Buffer;
}

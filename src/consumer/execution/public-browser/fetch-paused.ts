import {
  parseBrowserFetchRequestBody,
  type BrowserFetchRequestBodyV1,
} from './request-body-policy';

export interface BrowserFetchPausedV1 {
  request_id: string;
  url: string;
  method: string;
  resource_type: string;
  response_status: number | null;
  response_headers: Array<{ name: string; value: string }>;
  request_body: BrowserFetchRequestBodyV1;
  preflight_method: string | null;
}

export function parseBrowserFetchPaused(value: unknown): BrowserFetchPausedV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const request = record.request;
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null;
  const requestRecord = request as Record<string, unknown>;
  if (
    typeof record.requestId !== 'string' ||
    typeof requestRecord.url !== 'string' ||
    typeof requestRecord.method !== 'string' ||
    typeof record.resourceType !== 'string'
  ) {
    return null;
  }
  const status = record.responseStatusCode;
  if (
    status !== undefined &&
    (typeof status !== 'number' || !Number.isSafeInteger(status) || status < 100 || status > 599)
  ) {
    return null;
  }
  const headers = Array.isArray(record.responseHeaders)
    ? record.responseHeaders.flatMap((header) => {
        if (!header || typeof header !== 'object' || Array.isArray(header)) return [];
        const entry = header as Record<string, unknown>;
        return typeof entry.name === 'string' && typeof entry.value === 'string'
          ? [{ name: entry.name, value: entry.value }]
          : [];
      })
    : [];
  const requestBody = parseBrowserFetchRequestBody(requestRecord);
  if (requestBody === null) return null;
  return {
    request_id: record.requestId,
    url: requestRecord.url,
    method: requestRecord.method,
    resource_type: normalizeResourceType(record.resourceType),
    response_status: status === undefined ? null : status,
    response_headers: headers,
    request_body: requestBody,
    preflight_method: parsePreflightMethod(requestRecord),
  };
}

function normalizeResourceType(value: string): string {
  switch (value) {
    case 'Document':
      return 'document';
    case 'Stylesheet':
      return 'stylesheet';
    case 'Script':
      return 'script';
    case 'XHR':
      return 'xhr';
    case 'Fetch':
      return 'fetch';
    case 'EventSource':
      return 'event_source';
    case 'Image':
      return 'image';
    case 'Font':
      return 'font';
    case 'Media':
      return 'media';
    case 'Ping':
      return 'ping';
    case 'Worker':
      return 'worker';
    case 'Preflight':
      return 'preflight';
    default:
      return '';
  }
}

function parsePreflightMethod(request: Record<string, unknown>): string | null {
  if (request.method !== 'OPTIONS') return null;
  const headers = request.headers;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return null;
  const matching = Object.entries(headers).filter(
    ([name]) => name.toLowerCase() === 'access-control-request-method',
  );
  if (matching.length !== 1 || typeof matching[0]?.[1] !== 'string') return null;
  return matching[0][1].length === 0 ? null : matching[0][1];
}

// Headers the browser refuses to let fetch() set. Removing them before
// page.evaluate keeps network-log-derived strategies compatible with the
// browser's request-header policy.
const FORBIDDEN_FETCH_HEADERS = new Set([
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'connection',
  'content-length',
  'cookie',
  'cookie2',
  'date',
  'dnt',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'referer',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
]);

export function stripForbiddenBrowserFetchHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const allowed: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    if (FORBIDDEN_FETCH_HEADERS.has(lowerName)) continue;
    if (lowerName.startsWith('proxy-') || lowerName.startsWith('sec-')) continue;
    allowed[name] = value;
  }
  return allowed;
}

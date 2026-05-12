// Shared constants and small describer helpers extracted from validate.ts.
//
// The `notes` allowlist + synopsis renderer live with the validator that
// consumes them (`./notes.ts`) and derive directly from the Zod schema in
// `../schemas/notes.ts`. A hand-written parallel table here is the canonical
// drift point we eliminated — see also `renderZodSkeletonInline` in
// `../schemas/zod-helpers.ts` for the underlying mechanism.

export const ANCHOR_TYPES = ['module', 'protocol', 'dom', 'unknown'] as const;

const STRATEGY_TIER_DESCRIPTIONS: ReadonlyArray<{ key: string; hint: string }> = [
  {
    key: 'fetch',
    hint: '(OPTIMAL WHEN ACHIEVABLE) — templated HTTP or WebSocket request. Fires from Node, no browser — fastest, stateless, parallelizable. Works cleanly on simple / legacy sites with unsigned APIs. Body or frame can be a string template with {{placeholders}}, a Node-VM generator (generated.frame — for binary envelopes you byte-spliced against a captured reference), or derived via a prereq chain (cached / fetch-extract / page-extract / capability / tag). For js-eval or browser prereqs, save as page-script — those require a live page and are rejected on fetch.',
  },
  {
    key: 'page-script',
    hint: '(REALISTIC DEFAULT for modern signed sites) — a JS expression that runs inside the live page and builds the request there. The page\'s own signer / builder / transport runs on every call, so you don\'t need to lift per-call signing, rotating tokens, or anti-bot headers. Declare notes.anchor_type: "module" (calls a module the page also calls) or "protocol" (builds a wire-level payload + hands it to the page\'s durable sender). "dom" (walks rendered components / React fiber) is fragile, discouraged.',
  },
  {
    key: 'recorded-path',
    hint: '(LAST RESORT) — replays captured perform_action steps. UI automation, no API lift.',
  },
];

export function describeStrategyTiers(): string {
  return STRATEGY_TIER_DESCRIPTIONS.map((t) => `  • ${t.key} ${t.hint}`).join('\n');
}

export const JS_EVAL_TIMEOUT_HARD_CAP_MS = 30_000;
export const JS_EVAL_TIMEOUT_DEFAULT_MS = 5_000;

export const ARRAY_ITEM_REQUIRES: Record<string, string[]> = {
  prerequisites: ['name', 'kind'],
  steps: ['action'],
};

export const ARRAY_ITEM_ENUMS: Record<string, Record<string, readonly string[]>> = {
  prerequisites: {
    kind: ['browser', 'cached', 'page-extract', 'fetch-extract', 'js-eval', 'capability', 'tag'],
  },
};

export const RECORDED_PATH_ACTIONS = [
  'navigate',
  'click',
  'type',
  'fill_editor',
  'select',
  'wait',
  'key_press',
] as const;

export const WS_FIELDS = [
  'wsUrl',
  'wsHeaders',
  'frame',
  'frameEncoding',
  'ackMatch',
  'ackTimeoutMs',
  'wsOpen',
  'wsOpenTimeoutMs',
] as const;

export type WireProtocol = 'http' | 'websocket';

export const WS_UNSAFE_HEADERS = new Set<string>([
  'host',
  'connection',
  'content-length',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-fetch-user',
  'upgrade-insecure-requests',
  ':authority',
  ':method',
  ':path',
  ':scheme',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-protocol',
  'sec-websocket-extensions',
  'upgrade',
]);

export const HTTP_EXCLUSIVE_FIELDS = [
  'endpoint',
  'body',
  'method',
  'contentType',
  'headers',
  'params',
  'response',
] as const;

export const PARAM_KIND_VALUES = ['id', 'slug', 'email', 'url', 'uuid', 'enum', 'text'] as const;
export const PARAM_EXAMPLE_MAX = 2000;
export const PARAM_FIELD_MAX = 2000;
export const GENERATOR_CODE_MAX = 10_000;
export const GENERATOR_INSTRUCTION_MAX = 2000;

export const SESSION_STATE_READS = [
  'window.location.pathname',
  'window.location.href',
  'window.location.search',
  'window.location.hash',
  'location.pathname',
  'location.href',
  'location.search',
  'document.cookie',
  'document.URL',
  'document.referrer',
] as const;

export const ID_EXTRACTION_SHAPES = [
  '.match(',
  '.split(',
  '.substring(',
  '.substr(',
  '.slice(',
  '.indexOf(',
] as const;

export const OPAQUE_EXAMPLE_PATTERNS: Array<[RegExp, string]> = [
  [/^[A-Za-z]{1,4}_[A-Za-z0-9+/=]{8,}$/, 'prefixed opaque ID'],
  [/^[a-z][a-z0-9+.-]*:\/\/\S+/, 'URI-scheme opaque ID'],
  [/^[a-z][a-z0-9]*:[a-z0-9]+:[A-Za-z0-9_-]{6,}/, 'colon-namespaced opaque ID'],
  [/^[0-9a-f]{24,}$/, 'long hex blob (ObjectId / SHA / content hash)'],
  [/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'UUID'],
  [/^[0-9A-HJKMNP-TV-Z]{26}$/, 'ULID'],
  [/^(?=.*\d)[A-Za-z0-9+/=_-]{30,}$/, 'base64-shaped blob ≥30 chars'],
];

export const ID_SHAPED_EXAMPLE_PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /^\d{6,}$/, label: 'numeric id (6+ digits)' },
  { re: /^[a-f0-9]{24}$/, label: 'hex/ObjectId (24 chars)' },
  { re: /^[0-9a-fA-F-]{32,}$/, label: 'hex/uuid-shaped (32+ chars)' },
  { re: /^[A-Za-z0-9_-]{20,}$/, label: 'opaque token (20+ url-safe chars)' },
];

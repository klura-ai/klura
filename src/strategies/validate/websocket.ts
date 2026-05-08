// Cross-field validator for the protocol × tier axis. Enforces: -
// protocol:'http' → forbid every ws* field; current HTTP rules apply. -
// protocol:'websocket' → require wsUrl; require exactly one of `frame` or
// `generated.frame`; forbid `endpoint`/`body`/`method`/
// `contentType`/`headers`. - ws + tier:'fetch' → forbid wsOpen +
// wsOpenTimeoutMs (Node dial has no page registry to poll). wsHeaders allowed
// (Node can set them). - ws + tier:'page-script' → forbid wsHeaders (the
// browser's WebSocket API cannot set arbitrary upgrade headers). -
// recorded-path → `protocol` must not be present. - Deep shape for wsOpen,
// ackTimeoutMs, wsOpenTimeoutMs (these don't fit the small OptionalFieldKind
// vocabulary).

import { isPlainObject } from './helpers';
import { WS_FIELDS, WS_UNSAFE_HEADERS, HTTP_EXCLUSIVE_FIELDS } from './constants';
import { asBoundedScript } from '../js-eval-validators';
import { collectInlinePlaceholderRefs } from '../../execution/placeholders';
import { collectDeclaredPlaceholders } from '../placeholder-semantics';
import { validateRecordedPathStepShape } from './recorded-path';
import { websocketFieldsSchema } from '../schemas/websocket';
import { zodErrorToIssues } from '../schemas/zod-helpers';

function validateNoLegacyTransport(data: Record<string, unknown>, tier: string): void {
  if ('transport' in data) {
    throw new Error(
      `invalid_strategy: ${tier}.transport is not allowed — execution environment is implicit in the tier. Drop the field. ` +
        `(tier "fetch" runs in Node; tier "page-script" runs in the page. If you had transport:"browser" on a fetch-shaped call, the tier is "page-script".)`,
    );
  }
}

function validateRecordedPathProtocol(
  data: Record<string, unknown>,
  tier: string,
  protocol: unknown,
): boolean {
  if (tier === 'recorded-path') {
    // Listener strategies (type:'listener') reuse the recorded-path tier as a
    // carrier but speak a different vocabulary — the listener subsystem owns
    // its own schema, so leave those alone.
    if (data.type === 'listener') return true;

    // recorded-path is a DOM-replay tier; it has no wire protocol of its own.
    // Reject any leftover wire fields so an LLM copy-paste from an api-tier
    // skill doesn't silently save a no-op.
    if (protocol !== undefined) {
      throw new Error(
        `invalid_strategy: recorded-path.protocol is not allowed — recorded-path replays DOM steps, it does not select a wire protocol. Remove the field.`,
      );
    }
    for (const f of WS_FIELDS) {
      if (f in data) {
        throw new Error(
          `invalid_strategy: recorded-path.${f} is not allowed — ws* fields require protocol:"websocket" on a fetch / page-script tier.`,
        );
      }
    }
    return true;
  }
  return false;
}

function validateHttpProtocolNoWsFields(
  data: Record<string, unknown>,
  tier: string,
  protocol: unknown,
): boolean {
  if (protocol === 'http' || protocol === undefined) {
    // HTTP (explicit or default): every ws* field is meaningless and must not
    // leak into the saved strategy. Silent acceptance is the worst outcome
    // because the LLM walks away thinking it saved a ws strategy.
    for (const f of WS_FIELDS) {
      if (f in data) {
        throw new Error(
          `invalid_strategy: ${tier}.${f} is only valid when protocol:"websocket" (current protocol: ${protocol === undefined ? '"http" (default)' : JSON.stringify(protocol)}). Set protocol:"websocket" or remove the field.`,
        );
      }
    }
    return true;
  }
  return false;
}

function validateProtocolValue(protocol: unknown, tier: string): void {
  if (protocol !== 'websocket') {
    throw new Error(
      `invalid_strategy: ${tier}.protocol = ${JSON.stringify(protocol)} is not allowed; must be one of: "http", "websocket"`,
    );
  }
}

function validateHttpExclusiveFields(data: Record<string, unknown>, tier: string): void {
  for (const f of HTTP_EXCLUSIVE_FIELDS) {
    if (f in data) {
      throw new Error(
        `invalid_strategy: ${tier}.${f} is not allowed when protocol:"websocket" — ${f} belongs to the HTTP request shape. Use wsUrl + frame/generated.frame for the ws payload.`,
      );
    }
  }
}

function validateWsUrl(data: Record<string, unknown>, tier: string): void {
  // The top-level Zod tier schema already checks wsUrl, but assert again so the
  // error attribution is WS-specific when someone calls validateWebSocketShape
  // directly in a test.
  if (typeof data.wsUrl !== 'string' || data.wsUrl.length === 0) {
    throw new Error(
      `invalid_strategy: ${tier}.wsUrl is required when protocol:"websocket" (non-empty string — the WS URL prefix the page-script tier matches against the page registry, or the full URL the fetch tier dials from Node).`,
    );
  }
}

function includesGeneratedFrame(generated: unknown): boolean {
  return (
    generated !== undefined &&
    generated !== null &&
    typeof generated === 'object' &&
    'frame' in (generated as Record<string, unknown>)
  );
}

function validateFrameSourceSelection(data: Record<string, unknown>, tier: string): boolean {
  const hasFrame = typeof data.frame === 'string' && data.frame.length > 0;
  const hasGeneratedFrame = includesGeneratedFrame(data.generated);
  const hasFrameFromPage =
    data.frameFromPage !== undefined &&
    data.frameFromPage !== null &&
    typeof data.frameFromPage === 'object';
  const present = [hasFrame, hasGeneratedFrame, hasFrameFromPage].filter(Boolean).length;
  if (present > 1) {
    throw new Error(
      `invalid_strategy: ${tier} has more than one of {"frame", "generated.frame", "frameFromPage"} — must contain exactly one. "frame" is a string template with {{placeholders}}; "generated.frame" runs a Node-VM generator (no page access); "frameFromPage" runs a JS expression in the live page (has full page/window/document access). Pick one.`,
    );
  }
  if (present === 0) {
    throw new Error(
      `invalid_strategy: ${tier} requires one of "frame" (string template), "generated.frame" (Node-VM generator), or "frameFromPage" (live-page expression) when protocol:"websocket" — the executor needs a payload to send.`,
    );
  }
  return hasFrameFromPage;
}

function validateFrameFromPageBasics(ffp: Record<string, unknown>, tier: string): void {
  if (typeof ffp.expression !== 'string' || ffp.expression.length === 0) {
    throw new Error(
      `invalid_strategy: ${tier}.frameFromPage.expression is required (non-empty string — the JS expression run in the live page; its value should be a hex or base64 string of the frame bytes).`,
    );
  }
  asBoundedScript(ffp.expression, 'frameFromPage.expression');
  if (ffp.returns !== 'hex' && ffp.returns !== 'base64') {
    throw new Error(
      `invalid_strategy: ${tier}.frameFromPage.returns is required — must be "hex" or "base64". The expression should return a string of the declared encoding; the runtime decodes to bytes before dispatch.`,
    );
  }
  if (
    ffp.timeout_ms !== undefined &&
    (typeof ffp.timeout_ms !== 'number' ||
      !Number.isInteger(ffp.timeout_ms) ||
      ffp.timeout_ms <= 0 ||
      ffp.timeout_ms > 30000)
  ) {
    throw new Error(
      `invalid_strategy: ${tier}.frameFromPage.timeout_ms must be a positive integer ≤ 30000 (milliseconds).`,
    );
  }
}

function frameFromPagePlaceholderSuggestion(expression: string): string {
  const argRefs = Array.from(expression.matchAll(/\b(?:args|params)\.([A-Za-z_]\w*)/g))
    .map((m) => m[1])
    .filter((s): s is string => typeof s === 'string');
  const usesArguments = /\barguments\s*\[/.test(expression);
  if (argRefs.length > 0) {
    const uniq = Array.from(new Set(argRefs)).slice(0, 3);
    const argList = uniq.map((n) => `args.${n}`).join('`, `');
    const placeholderList = uniq.map((n) => `{{${n}}}`).join('`, `');
    return ` Detected \`${argList}\` in the expression — replace with \`${placeholderList}\` (the runtime substitutes the literal at execute time).`;
  }
  if (usesArguments) {
    return ` Detected \`arguments[...]\` — the expression runs as a single value, not a function body, so positional args aren't available. Use \`{{paramName}}\` placeholders instead.`;
  }
  return '';
}

function validateFrameFromPagePlaceholders(
  data: Record<string, unknown>,
  ffp: Record<string, unknown>,
  tier: string,
): void {
  const expression = ffp.expression as string;
  const referenced = collectInlinePlaceholderRefs(expression);
  const declared = collectDeclaredPlaceholders(data);
  const bound = new Set([...declared.paramNames, ...declared.prereqProducedNames]);
  const hasAnyBoundRef = Array.from(referenced).some((name) => bound.has(name));
  if (referenced.size > 0 && hasAnyBoundRef) return;

  throw new Error(
    `invalid_strategy: ${tier}.frameFromPage.expression must reference at least one declared arg (notes.params.*) or prereq binding via {{name}} — otherwise the expression is session-hardcoded and can't produce a different frame on replay. Add a {{paramName}} interpolation for at least one varying field (e.g. {{text}}).${frameFromPagePlaceholderSuggestion(expression)}`,
  );
}

function validateFrameFromPage(data: Record<string, unknown>, tier: string): void {
  if (tier !== 'page-script') {
    throw new Error(
      `invalid_strategy: ${tier}.frameFromPage is only valid for strategy:"page-script" — the live page is the execution context. For strategy:"fetch" use "generated.frame" (runs in a Node VM sandbox).`,
    );
  }

  const ffp = data.frameFromPage as Record<string, unknown>;
  validateFrameFromPageBasics(ffp, tier);
  validateFrameFromPagePlaceholders(data, ffp, tier);
}

function validateWsHeaders(data: Record<string, unknown>, tier: string): void {
  const wsHeaders = data.wsHeaders;
  if (!wsHeaders || typeof wsHeaders !== 'object') return;

  for (const name of Object.keys(wsHeaders as Record<string, unknown>)) {
    const lower = name.toLowerCase();
    if (WS_UNSAFE_HEADERS.has(lower)) {
      throw new Error(
        `invalid_strategy: ${tier}.wsHeaders["${name}"] is not allowed — this header is either set by the ws library on the handshake itself (sec-websocket-*, upgrade, host, connection, content-length) or is a per-request metadata field whose saved value would lie (sec-fetch-*, :authority etc). Remove it. Cookie / User-Agent / Origin / sec-ch-ua-* are allowed and are typically what you want here.`,
      );
    }
  }
}

function validateWebSocketTierFields(data: Record<string, unknown>, tier: string): void {
  if (tier === 'fetch') {
    if ('wsOpen' in data) {
      throw new Error(
        `invalid_strategy: ${tier}.wsOpen is not allowed — Node dials the WebSocket directly, it has no page registry to poll. Remove the field (or switch to tier "page-script" if you need the page's existing connection).`,
      );
    }
    if ('wsOpenTimeoutMs' in data) {
      throw new Error(
        `invalid_strategy: ${tier}.wsOpenTimeoutMs is not allowed — no registry polling when Node dials directly. Remove the field.`,
      );
    }
    validateWsHeaders(data, tier);
    return;
  }

  if (tier === 'page-script' && 'wsHeaders' in data) {
    throw new Error(
      `invalid_strategy: ${tier}.wsHeaders is not allowed — the browser's WebSocket API cannot set arbitrary upgrade headers. Switch to tier "fetch" if you need to control Cookie / User-Agent / Origin on the handshake.`,
    );
  }
}

function validateWsOpenString(wsOpen: string, tier: string): void {
  if (wsOpen !== 'navigate' && wsOpen !== 'none') {
    throw new Error(
      `invalid_strategy: ${tier}.wsOpen = ${JSON.stringify(wsOpen)} must be "navigate" (default — navigate to baseUrl and poll for WS), "none" (assume WS already open from a warm session), or an object {steps: [...]} (recorded steps that trigger the page's WS open).`,
    );
  }
}

function validateWsOpenObject(wsOpen: Record<string, unknown>, tier: string): void {
  if (!Array.isArray(wsOpen.steps) || wsOpen.steps.length === 0) {
    throw new Error(
      `invalid_strategy: ${tier}.wsOpen (object form) requires a non-empty "steps" array — the recorded-path-shaped steps that trigger the page's WS open when the registry-poll misses.`,
    );
  }
  wsOpen.steps.forEach((step, i) => {
    if (!isPlainObject(step)) {
      throw new Error(
        `invalid_strategy: ${tier}.wsOpen.steps[${i}] must be an object with at least {action}.`,
      );
    }
    validateRecordedPathStepShape(i, step, `${tier}.wsOpen.steps[${i}]`, { requireId: false });
  });
}

function validateWsOpenShape(data: Record<string, unknown>, tier: string): void {
  if (!('wsOpen' in data) || data.wsOpen === undefined) return;

  const wsOpen = data.wsOpen;
  if (typeof wsOpen === 'string') {
    validateWsOpenString(wsOpen, tier);
    return;
  }
  if (isPlainObject(wsOpen)) {
    validateWsOpenObject(wsOpen, tier);
    return;
  }
  throw new Error(
    `invalid_strategy: ${tier}.wsOpen must be the string "navigate" / "none" or an object {steps: [...]} — got ${typeof wsOpen}.`,
  );
}

function validateWebSocketTimeouts(data: Record<string, unknown>, tier: string): void {
  for (const numField of ['ackTimeoutMs', 'wsOpenTimeoutMs'] as const) {
    if (numField in data && data[numField] !== undefined) {
      const v = data[numField];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        throw new Error(
          `invalid_strategy: ${tier}.${numField} must be a non-negative finite number (got ${JSON.stringify(v)}).`,
        );
      }
    }
  }
}

function validateFrameEncoding(data: Record<string, unknown>, tier: string): void {
  if ('frameEncoding' in data && data.frameEncoding !== undefined) {
    if (data.frameEncoding !== 'text' && data.frameEncoding !== 'binary') {
      throw new Error(
        `invalid_strategy: ${tier}.frameEncoding = ${JSON.stringify(data.frameEncoding)} is not allowed; must be one of: "text", "binary"`,
      );
    }
  }
}

export function validateWebSocketShape(data: Record<string, unknown>, tier: string): void {
  const protocol = data.protocol;
  validateNoLegacyTransport(data, tier);
  if (validateRecordedPathProtocol(data, tier, protocol)) return;
  if (validateHttpProtocolNoWsFields(data, tier, protocol)) return;

  validateProtocolValue(protocol, tier);
  validateHttpExclusiveFields(data, tier);
  validateWsUrl(data, tier);
  const hasFrameFromPage = validateFrameSourceSelection(data, tier);
  if (hasFrameFromPage) validateFrameFromPage(data, tier);
  validateWebSocketTierFields(data, tier);
  validateWsOpenShape(data, tier);
  validateWebSocketTimeouts(data, tier);
  validateFrameEncoding(data, tier);

  const parsed = websocketFieldsSchema.safeParse(data);
  if (!parsed.success) {
    const issues = zodErrorToIssues(parsed.error, tier);
    const bullets = issues.map((issue) => `  - ${issue}`).join('\n');
    const issueLabel = issues.length === 1 ? '1 issue' : `${issues.length} issues`;
    throw new Error(
      `invalid_strategy: ${tier} websocket shape has ${issueLabel} — fix all before retrying:\n${bullets}`,
    );
  }
}

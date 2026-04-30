// Strategy graduation tracker.
//
// After a successful recorded-path execute, the runtime inspects the
// intercepted traffic for a shape that could be lifted to a faster strategy.
// Two paths are tried in order:
//
// 1. HTTP-POST path: look for a clean capturable non-GET request with a
// JSON/form body and a 2xx response. When the same shape is observed across N
// consecutive successful runs, synthesize a `fetch` strategy from the captured
// call.
//
// 2. WebSocket-echo path: if nothing liftable was captured over HTTP (common on
// chat/realtime sites where all writes go over a persistent WebSocket), look
// for a sent ws frame whose payload contains a literal the step list typed.
// After N consistent observations, synthesize a `page-script` strategy with
// `protocol: "websocket"`.
//
// Either way, the synthesized strategy is persisted alongside the existing
// recorded-path. The cascade (see skills.ts:loadStrategies) tries the faster
// strategy first on the next run and falls back to recorded-path on failure.
//
// Graduation is a speed win, not a correctness change — the recorded-path
// remains the fallback and nothing about the existing strategy changes until
// the synthesized strategy has been validated through the same pipeline a
// save-time LLM-emitted strategy goes through. The LLM hallucinates, and so
// does our own synthesis — treating synthesized output as trusted would defeat
// the "validate everything" rule.

import fs from 'fs';
import path from 'path';
import type { InterceptedRequest } from '../drivers/types/network';
import type { WebSocketFrame } from '../drivers/types/websocket';
import * as skills from './skills';
import { loadConfig } from '../config/handler';
import { ValidationError, asArray, asObject, asEnum } from '../validators';
import { substringMatchWithDecoding, extractContentType } from '../response/network-log-shape';
import { KLURA_DIR } from '../paths';

const GRADUATION_DIR = path.join(KLURA_DIR, 'graduation');

// Observation record shape. One record per successful recorded-path execute.
// The fields are deliberately normalized so the consistency check is a pure
// structural compare rather than a string match over raw network-log entries.
interface CapturedCallShape {
  /** Upper-case HTTP method — "POST", "PUT", "PATCH". */
  method: string;
  /** `${host}${pathname}` — query params dropped entirely. */
  urlShape: string;
  /** Base URL origin (`scheme://host`) — used as the synthesized strategy baseUrl. */
  origin: string;
  /** Pathname portion (no query string) — used as the synthesized endpoint. */
  endpointPath: string;
  /** Sorted list of header names (lower-case) observed in this call. */
  headerNames: string[];
  /** Headers that are safe to replay from Node transport, preserved verbatim
   *  for the synthesis step. Only populated for capture-time use; the
   *  consistency check reads `headerNames` above. */
  headers: Record<string, string>;
  /** `json`, `form`, `other`, or `none`. */
  bodyKind: 'json' | 'form' | 'other' | 'none';
  /**
   * For `json` bodyKind: sorted list of top-level keys. Empty for other kinds.
   */
  bodyTopKeys: string[];
  /** Raw captured body — preserved for synthesis, not consistency. */
  rawBody: unknown;
}

interface ObservationRecord {
  at: number;
  call: CapturedCallShape;
}

// Observation record for the WebSocket-echo graduation path. Populated when a
// successful recorded-path replay sends a typed-literal value on a WebSocket
// (common on chat/realtime sites). Same consistency-threshold model as the HTTP
// path — 3 identical shapes across runs synthesizes a ws strategy alongside the
// existing recorded-path.
interface WsObservedShape {
  /** URL prefix up to '?' so sid / cid query params don't bust consistency. */
  wsUrl: string;
  /** Payload with each literal arg value replaced by `{{argname}}` so the
   *  shape is stable across runs with different user inputs. */
  frameTemplate: string;
  /** Arg names whose literal values were rewritten as `{{name}}` inside
   *  `frameTemplate`. Used at synthesis time to emit matching `notes.params`
   *  entries so the placeholder-reference validator doesn't reject the
   *  synthesized strategy. */
  substitutedArgs: Array<{ name: string; example: string }>;
  /** Substring of a received frame that arrived within ~1s after the send.
   *  Optional — absent if no receive-side frame followed. */
  ackSubstring?: string;
}

interface WsObservationRecord {
  at: number;
  shape: WsObservedShape;
}

interface GraduationState {
  observations: ObservationRecord[];
  /** Parallel to `observations` but for the ws-echo synthesis path. */
  wsObservations?: WsObservationRecord[];
  /** The tier we graduated to from recorded-path, if any. Prevents
   *  re-synthesizing the same strategy on every subsequent successful
   *  recorded-path execute. */
  graduatedTier?: 'fetch' | 'page-script';
}

/**
 * How many consecutive successful T3 observations with the same capturable POST
 * shape trip graduation. Small enough to actually happen during benchmarks (3
 * runs); config key in ~/.klura/config.json under `graduation`.
 */
const DEFAULT_OBSERVATION_THRESHOLD = 3;

/** Upper bound on observations we keep per capability. The consistency check
 * only reads the most recent `threshold` entries, so older ones exist only
 *  for diagnostics. Kept small so the file stays tiny. */
const MAX_OBSERVATIONS = 10;

/** Headers we never replay — request-context specific, bound to the browser
 * session that fired them, or security-layer fields the destination server
 *  rewrites on every request. Lower-case comparison. */
const UNSAFE_HEADERS = new Set<string>([
  'host',
  'connection',
  'content-length',
  'cookie',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-fetch-user',
  'upgrade-insecure-requests',
  ':authority',
  ':method',
  ':path',
  ':scheme',
]);

/** Per-call header budget — keeps a single observation file well under the
 *  8 KB budget even with 10 observations of a large header set. */
const MAX_HEADERS_PER_CALL = 32;
const MAX_HEADER_VALUE_CHARS = 1024;

function fileFor(platform: string, capability: string): string {
  return path.join(GRADUATION_DIR, platform, `${capability}.json`);
}

function readState(platform: string, capability: string): GraduationState {
  const file = fileFor(platform, capability);
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { observations: [] };
    }
    const obj = parsed as Record<string, unknown>;
    const observations = Array.isArray(obj.observations)
      ? (obj.observations as ObservationRecord[])
      : [];
    const wsObservations = Array.isArray(obj.wsObservations)
      ? (obj.wsObservations as WsObservationRecord[])
      : undefined;
    const out: GraduationState = { observations };
    if (wsObservations) out.wsObservations = wsObservations;
    if (obj.graduatedTier === 'fetch' || obj.graduatedTier === 'page-script') {
      out.graduatedTier = obj.graduatedTier;
    }
    return out;
  } catch {
    return { observations: [] };
  }
}

function writeState(platform: string, capability: string, state: GraduationState): void {
  const file = fileFor(platform, capability);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
  } catch {
    // Best-effort — graduation must never crash execute().
  }
}

function classifyBodyKind(
  contentType: string | undefined,
  body: unknown,
): { kind: CapturedCallShape['bodyKind']; topKeys: string[] } {
  if (body === undefined || body === null || body === '') {
    return { kind: 'none', topKeys: [] };
  }
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('application/json')) {
    const parsed = typeof body === 'string' ? tryParseJson(body) : body;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        kind: 'json',
        topKeys: Object.keys(parsed as Record<string, unknown>).sort((a, b) => a.localeCompare(b)),
      };
    }
    return { kind: 'json', topKeys: [] };
  }
  if (ct.includes('application/x-www-form-urlencoded')) {
    return { kind: 'form', topKeys: [] };
  }
  return { kind: 'other', topKeys: [] };
}

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Select the one candidate capturable POST from a network log, or return null
 * if none qualifies. Criteria: - Non-GET/HEAD/OPTIONS method - Non-empty body -
 * 2xx status - Not a form navigation (those are liftable via a `fetch` strategy
 * with a page-extract prerequisite, but require a save-time DOM probe we're not
 * running)
 *
 * When multiple candidates exist we pick the last one — typically the final
 * submit that corresponds to the user's intent.
 */
function selectCandidateCall(log: InterceptedRequest[]): CapturedCallShape | null {
  const candidates: CapturedCallShape[] = [];
  for (const entry of log) {
    const method = entry.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS' || method === '') continue;
    if (entry.status === null || entry.status < 200 || entry.status >= 300) continue;
    if (entry.isNavigation) continue;
    if (entry.postData === undefined || entry.postData === null || entry.postData === '') continue;

    let url: URL;
    try {
      url = new URL(entry.url);
    } catch {
      continue;
    }

    const contentType = extractContentType(entry);
    const { kind, topKeys } = classifyBodyKind(contentType, entry.postData);
    if (kind === 'other' || kind === 'none') continue;

    const headers: Record<string, string> = {};
    const headerNames: string[] = [];
    let count = 0;
    for (const [rawKey, rawValue] of Object.entries(entry.headers)) {
      if (typeof rawValue !== 'string') continue;
      const key = rawKey.toLowerCase();
      if (UNSAFE_HEADERS.has(key)) continue;
      if (count >= MAX_HEADERS_PER_CALL) break;
      const value =
        rawValue.length > MAX_HEADER_VALUE_CHARS
          ? rawValue.slice(0, MAX_HEADER_VALUE_CHARS)
          : rawValue;
      headers[key] = value;
      headerNames.push(key);
      count += 1;
    }
    headerNames.sort((a, b) => a.localeCompare(b));

    candidates.push({
      method,
      urlShape: `${url.host}${url.pathname}`,
      origin: `${url.protocol}//${url.host}`,
      endpointPath: url.pathname,
      headerNames,
      headers,
      bodyKind: kind,
      bodyTopKeys: topKeys,
      rawBody: entry.postData,
    });
  }
  return candidates.length > 0 ? (candidates[candidates.length - 1] ?? null) : null;
}

/**
 * Walk the most recent `threshold` observations and check they describe the
 * same capturable POST. "Same" means: - identical method - identical urlShape
 * (host + path; query params already dropped) - identical bodyKind + sorted
 * bodyTopKeys - header intersection non-empty (a header that only appeared once
 * is not required, so the returned `requiredHeaders` is the intersection)
 *
 * Returns null if the observations are inconsistent or fewer than threshold.
 */
function detectConsistency(
  observations: ObservationRecord[],
  threshold: number,
): {
  base: CapturedCallShape;
  requiredHeaderNames: string[];
} | null {
  if (observations.length < threshold) return null;
  const window = observations.slice(-threshold);
  const [first, ...rest] = window;
  if (!first) return null;
  const base = first.call;
  for (const obs of rest) {
    const c = obs.call;
    if (c.method !== base.method) return null;
    if (c.urlShape !== base.urlShape) return null;
    if (c.bodyKind !== base.bodyKind) return null;
    if (c.bodyTopKeys.length !== base.bodyTopKeys.length) return null;
    for (let i = 0; i < c.bodyTopKeys.length; i += 1) {
      if (c.bodyTopKeys[i] !== base.bodyTopKeys[i]) return null;
    }
  }
  // Header intersection across the window — headers that appear in every
  // observation are required; anything else is transient.
  let intersection: Set<string> = new Set(base.headerNames);
  for (const obs of rest) {
    const next = new Set(obs.call.headerNames);
    intersection = new Set([...intersection].filter((h) => next.has(h)));
  }
  return {
    base,
    requiredHeaderNames: [...intersection].sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * Build a `fetch` strategy JSON from a detected consistent call. The runtime
 * does not try to classify auth/CSRF dependencies at synthesis time — the LLM
 * owns downstream classification (*"is this header a CSRF token or a bearer?"*)
 * better than any regex we would drift into keeping current. Empty
 * prerequisites mean the captured call replays Node-fired verbatim; if the LLM
 * later observes a CSRF dependency it will edit the saved strategy to attach
 * the prereq.
 *
 * The body is preserved verbatim — the agent-loop replaces this with a strategy
 * that parameterizes the body later if needed, but for the first graduation we
 * just replay the exact shape the browser fired.
 */
export function synthesizeHighestViable(
  base: CapturedCallShape,
  requiredHeaderNames: string[],
): Record<string, unknown> {
  const headers: Record<string, string> = {};
  for (const name of requiredHeaderNames) {
    const v = base.headers[name];
    if (typeof v === 'string') headers[name] = v;
  }

  let body: Record<string, unknown> | undefined;
  if (base.bodyKind === 'json') {
    const parsed =
      typeof base.rawBody === 'string'
        ? (tryParseJson(base.rawBody) as Record<string, unknown> | null)
        : (base.rawBody as Record<string, unknown>);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      body = parsed;
    }
  }

  const strategy: Record<string, unknown> = {
    strategy: 'fetch',
    method: base.method,
    baseUrl: base.origin,
    endpoint: base.endpointPath,
    contentType: base.bodyKind === 'json' ? 'json' : 'form',
    headers,
  };
  if (body !== undefined) strategy.body = body;
  return strategy;
}

/**
 * Sanity-check a synthesized strategy before we hand it to
 * `skills.saveStrategy`. This is the "validate our own output" rule — even
 * though we built the object ourselves, the inputs came from the browser and
 * could contain surprises (header with non-string value, non-parseable URL,
 * missing fields). Routes through validators.ts.
 */
function preValidate(strategy: Record<string, unknown>): void {
  try {
    const obj = asObject(strategy, 'strategy');
    asEnum(obj.strategy, 'strategy.strategy', ['fetch', 'page-script'] as const);
    if (typeof obj.baseUrl !== 'string' || obj.baseUrl.length === 0) {
      throw new ValidationError('strategy.baseUrl', 'must be a non-empty string');
    }
    const isWs = obj.protocol === 'websocket';
    if (!isWs) {
      if (typeof obj.endpoint !== 'string' || obj.endpoint.length === 0) {
        throw new ValidationError('strategy.endpoint', 'must be a non-empty string');
      }
      // URL parse check: rejects the "host was an IDN we failed to encode" and
      // "endpoint has a stray space" classes that otherwise surface only at
      // execute time as a confusing fetch error.
      try {
        new URL(obj.endpoint, obj.baseUrl);
      } catch {
        throw new ValidationError(
          'strategy.endpoint',
          `cannot be resolved against baseUrl ${JSON.stringify(obj.baseUrl)}`,
        );
      }
    } else {
      if (typeof obj.wsUrl !== 'string' || obj.wsUrl.length === 0) {
        throw new ValidationError('strategy.wsUrl', 'must be a non-empty string on ws strategies');
      }
    }
    if (obj.prerequisites !== undefined) {
      asArray(obj.prerequisites, 'strategy.prerequisites');
    }
  } catch (e) {
    if (e instanceof ValidationError) {
      throw new Error(`invalid_strategy: ${e.message}`, { cause: e });
    }
    throw e;
  }
}

function resolveObservationThreshold(): number {
  try {
    const raw = loadConfig().graduation.observation_threshold;
    if (Number.isInteger(raw) && raw >= 2 && raw <= 50) {
      return raw;
    }
  } catch {
    // Fall through to default.
  }
  return DEFAULT_OBSERVATION_THRESHOLD;
}

// Guard so we only log a synthesis failure once per (platform, capability)
// instead of spamming the daemon log on every successful recorded-path execute.
// Cleared when the state file is deleted (fresh start).
const synthesisFailureLogged = new Set<string>();

/**
 * Main hook. Called on every successful recorded-path execute with the raw
 * intercepted-request list (and optionally the ws frame buffer + typed literals
 * for the ws-echo fallback). Persists an observation, checks whether the
 * threshold has been met, and on success synthesizes + validates + saves a
 * `fetch` or `page-script` strategy alongside the recorded-path.
 *
 * Returns `true` if a new strategy was persisted, `false` otherwise. Never
 * throws — graduation is best-effort, and a crash here would turn a successful
 * execute into a failure at the caller.
 */
/**
 * WebSocket-side context the runtime passes into graduation. Optional — callers
 * that don't have a browser session with a ws ring buffer simply skip the
 * ws-echo path and fall back to the HTTP-only synthesis.
 */
interface GraduationWsContext {
  frames: WebSocketFrame[];
  typedValues: string[];
  /** The raw user args — used to rewrite typed literals back to
   *  `{{argname}}` in the captured payload so the saved frame template
   *  is reusable across calls. */
  args: Record<string, unknown>;
}

export function recordRecordedPathSuccess(
  platform: string,
  capability: string,
  log: InterceptedRequest[],
  wsContext?: GraduationWsContext,
): boolean {
  try {
    const state = readState(platform, capability);
    if (state.graduatedTier) return false;

    // If any higher-tier strategy already exists on disk (LLM saved it, or a
    // previous graduation run, or a previous T1→T0 promotion), don't overwrite
    // — the save-time validation and LLM-shaped notes.params on the existing
    // strategy are more valuable than our synthesis.
    const existing = skills.loadStrategies(platform, capability);
    const existingHigher = existing.find(
      (s) => s.strategy === 'fetch' || s.strategy === 'page-script',
    );
    if (existingHigher) {
      state.graduatedTier = existingHigher.strategy as 'fetch' | 'page-script';
      writeState(platform, capability, state);
      return false;
    }

    const observationThreshold = resolveObservationThreshold();

    const call = selectCandidateCall(log);
    if (call) {
      state.observations.push({ at: Date.now(), call });
      if (state.observations.length > MAX_OBSERVATIONS) {
        state.observations = state.observations.slice(-MAX_OBSERVATIONS);
      }
      writeState(platform, capability, state);

      const consistent = detectConsistency(state.observations, observationThreshold);
      if (consistent) {
        const synthesized = synthesizeHighestViable(
          consistent.base,
          consistent.requiredHeaderNames,
        );
        const synthesizedTier = synthesized.strategy as 'fetch' | 'page-script';

        try {
          preValidate(synthesized);
          skills.saveStrategy(
            platform,
            capability,
            synthesized as skills.Strategy,
            `graduated from recorded-path to ${synthesizedTier} (${observationThreshold} consistent observations)`,
          );
          state.graduatedTier = synthesizedTier;
          writeState(platform, capability, state);
          return true;
        } catch (err) {
          logSynthesisFailure(platform, capability, err);
          // Fall through — if HTTP synthesis failed, the ws path might still
          // work. Don't short-circuit.
        }
      }
    }

    // WebSocket-echo fallback. Runs when:
    //   (a) HTTP selectCandidateCall found nothing liftable (the modern
    //       chat/realtime case — all writes go over a persistent WS, no
    //       POST to capture), OR
    //   (b) HTTP synthesis was rejected at save time.
    // Requires the caller to provide wsContext (frames + typed values + args).
    if (wsContext) {
      const shape = detectWsEchoShape(wsContext);
      if (!shape) return false;

      const wsObs = state.wsObservations ?? [];
      wsObs.push({ at: Date.now(), shape });
      if (wsObs.length > MAX_OBSERVATIONS) {
        state.wsObservations = wsObs.slice(-MAX_OBSERVATIONS);
      } else {
        state.wsObservations = wsObs;
      }
      writeState(platform, capability, state);

      const consistentWs = detectWsConsistency(state.wsObservations, observationThreshold);
      if (!consistentWs) return false;

      const wsSynthesized = synthesizeWsStrategy(consistentWs.shape);
      try {
        preValidate(wsSynthesized);
        skills.saveStrategy(
          platform,
          capability,
          wsSynthesized as skills.Strategy,
          `graduated from recorded-path to page-script/websocket (${observationThreshold} consistent ws-echo observations)`,
        );
        state.graduatedTier = 'page-script';
        writeState(platform, capability, state);
        return true;
      } catch (err) {
        logSynthesisFailure(platform, capability, err);
        return false;
      }
    }

    return false;
  } catch {
    // Best-effort — never surface graduation errors to the caller.
    return false;
  }
}

function logSynthesisFailure(platform: string, capability: string, err: unknown): void {
  const key = `${platform}/${capability}`;
  if (synthesisFailureLogged.has(key)) return;
  synthesisFailureLogged.add(key);
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(
    `[graduation] ${platform}/${capability}: synthesized strategy failed validation — ${msg}`,
  );
}

/**
 * Look for a WebSocket sent frame whose payload contains a literal value the
 * recorded-path just typed. Returns the observation shape suitable for feeding
 * the consistency check, or null if nothing qualifies.
 *
 * Conservative bias: - Skip if the frame payload looks like opaque binary
 * (non-UTF8). - Skip if more than one sent frame matches — ambiguous
 * attribution. - Skip if URL-decoding the needle doesn't narrow to a single
 * frame.
 */
function detectWsEchoShape(ctx: GraduationWsContext): WsObservedShape | null {
  if (ctx.frames.length === 0) return null;

  // Collect all typed literals that are non-trivial (at least 3 chars, skip
  // obvious whitespace or single digits). These are the needles we'll search
  // for in sent frames.
  const needles: string[] = [];
  for (const raw of ctx.typedValues) {
    if (typeof raw !== 'string') continue;
    const s = raw.trim();
    if (s.length < 3) continue;
    needles.push(s);
  }
  if (needles.length === 0) return null;

  // Candidate: latest sent frame whose payload contains any needle.
  let candidate: WebSocketFrame | null = null;
  let matchedNeedle: string | null = null;
  for (const frame of ctx.frames) {
    if (frame.direction !== 'sent') continue;
    if (!isLikelyUtf8(frame.payload)) continue;
    for (const needle of needles) {
      if (substringMatchWithDecoding(frame.payload, needle.toLowerCase())) {
        candidate = frame;
        matchedNeedle = needle;
      }
    }
  }
  if (!candidate || !matchedNeedle) return null;

  // Disambiguation: if more than one sent frame matched the same needle, skip
  // synthesis — the one the user cares about is ambiguous.
  const matchCount = ctx.frames.filter(
    (f) =>
      f.direction === 'sent' && substringMatchWithDecoding(f.payload, matchedNeedle.toLowerCase()),
  ).length;
  if (matchCount > 1) return null;

  // Rewrite the payload: replace every literal arg value with `{{argname}}`.
  // Only replaces values that are non-trivial strings (length >= 3) so a stray
  // "1" doesn't scramble the template. Track which args were actually
  // substituted so synthesis emits matching notes.params.
  let template = candidate.payload;
  const substitutedArgs: Array<{ name: string; example: string }> = [];
  for (const [argName, argValue] of Object.entries(ctx.args)) {
    if (typeof argValue !== 'string') continue;
    if (argValue.trim().length < 3) continue;
    if (argName.startsWith('_')) continue;
    if (!template.includes(argValue)) continue;
    template = template.split(argValue).join(`{{${argName}}}`);
    substitutedArgs.push({ name: argName, example: argValue });
  }

  // Strip query params from the captured URL so sid / cid / sessionid
  // variations don't prevent consistency matching across runs.
  let wsUrl = candidate.url;
  const qmark = wsUrl.indexOf('?');
  if (qmark >= 0) wsUrl = wsUrl.slice(0, qmark);

  // Ack hint: the first received frame within 1s after the send. Extract a
  // short stable substring (a JSON key prefix works well on chat sites).
  const ackSubstring = findAckSubstring(ctx.frames, candidate);

  return {
    wsUrl,
    frameTemplate: template,
    substitutedArgs,
    ...(ackSubstring ? { ackSubstring } : {}),
  };
}

function isLikelyUtf8(s: string): boolean {
  // Quick proxy: if the string has any null bytes or a high density of
  // non-printable characters, it's probably an MQTT-class binary frame. Those
  // aren't candidates for payload-substring graduation (the literal user text
  // is embedded inside a length-prefixed envelope, not as a plain substring).
  if (!s) return false;
  if (s.includes('\u0000')) return false;
  let controlCount = 0;
  for (let i = 0; i < Math.min(s.length, 256); i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) controlCount++;
  }
  return controlCount / Math.min(s.length, 256) < 0.1;
}

const ACK_PAYLOAD_WINDOW_MS = 1000;
const ACK_MIN_SUBSTRING_LEN = 6;
const ACK_MAX_SUBSTRING_LEN = 40;

function findAckSubstring(frames: WebSocketFrame[], sent: WebSocketFrame): string | undefined {
  for (const f of frames) {
    if (f.direction !== 'received') continue;
    if (f.timestamp < sent.timestamp) continue;
    if (f.timestamp > sent.timestamp + ACK_PAYLOAD_WINDOW_MS) continue;
    if (!isLikelyUtf8(f.payload)) continue;
    // Return a stable-looking token: the first json-key-ish substring, or the
    // first N chars if nothing matches.
    const keyMatch = /[A-Z_a-z]\w{5,30}/.exec(f.payload);
    if (keyMatch) {
      const t = keyMatch[0];
      if (t.length >= ACK_MIN_SUBSTRING_LEN) return t;
    }
    const clipped = f.payload.slice(0, ACK_MAX_SUBSTRING_LEN);
    if (clipped.length >= ACK_MIN_SUBSTRING_LEN) return clipped;
  }
  return undefined;
}

function detectWsConsistency(
  obs: WsObservationRecord[],
  threshold: number,
): { shape: WsObservedShape } | null {
  if (obs.length < threshold) return null;
  const window = obs.slice(-threshold);
  const [first, ...rest] = window;
  if (!first) return null;
  const base = first.shape;
  for (const o of rest) {
    if (o.shape.wsUrl !== base.wsUrl) return null;
    if (o.shape.frameTemplate !== base.frameTemplate) return null;
  }
  // Guarantee the substitutedArgs field exists on the returned shape —
  // persisted records from a prior version of this code may omit it.
  const shape: WsObservedShape = {
    wsUrl: base.wsUrl,
    frameTemplate: base.frameTemplate,
    substitutedArgs: Array.isArray(base.substitutedArgs) ? base.substitutedArgs : [],
    ...(base.ackSubstring ? { ackSubstring: base.ackSubstring } : {}),
  };
  return { shape };
}

function synthesizeWsStrategy(shape: WsObservedShape): Record<string, unknown> {
  // baseUrl is required by the schema — derive from the ws URL by stripping the
  // scheme (`ws://` → `https://`). That's a best-effort; callers that have
  // richer context should edit the saved strategy post-graduation.
  const baseUrl = shape.wsUrl
    .replace(/^ws:/, 'http:')
    .replace(/^wss:/, 'https:')
    .replace(/\/[^/]*$/, '');
  // Emit a notes.params entry for each placeholder the template actually
  // references — the placeholder-reference validator rejects the save otherwise
  // ("{{message}} is not declared anywhere"). The captured literal is a
  // reasonable `example`; description is a stub the human / LLM can refine on
  // the next edit.
  const params: Record<string, { description: string; example: string }> = {};
  for (const { name, example } of shape.substitutedArgs) {
    params[name] = { description: `captured from WS-echo graduation`, example };
  }
  const strategy: Record<string, unknown> = {
    strategy: 'page-script',
    protocol: 'websocket',
    baseUrl: baseUrl || 'https://example.invalid',
    wsUrl: shape.wsUrl,
    frame: shape.frameTemplate,
    ...(Object.keys(params).length > 0 ? { notes: { params } } : {}),
  };
  if (shape.ackSubstring) {
    strategy.ackMatch = shape.ackSubstring;
  }
  return strategy;
}

// Detector framework that scans captured traffic for structural oddness (binary
// payloads, signature headers, high-entropy bodies, escaped-JSON envelopes) and
// emits a single inline advisory carrying the structural evidence. Simple sites
// (plain JSON POST, plain JSON over WS) match zero detectors and the response
// carries no advisory.
//
// ---- Architectural exception note ----
//
// Runtime-side pattern matching is normally off-limits — the LLM decides, the
// runtime just exposes primitives. The detectors below are a bounded exception:
// the runtime does the scanning (the LLM can't efficiently sweep a megabyte of
// traffic every turn), but it ONLY emits structural evidence. No prose recipes,
// no protocol names, no "do X next" instructions. The LLM reads the evidence
// and decides what to do with it.
//
// The detectors are heuristics, not ground truth. They are intentionally narrow
// (binary first-byte + literal-anchor, specific content-types, specific
// header-name patterns) so that simple sites never trigger them — a plain JSON
// POST or a text-only WS frame matches zero detectors and the response is
// unchanged.
//
// If you find yourself adding a detector for a new site that doesn't match one
// of the generic patterns here, stop: a one-off heuristic belongs in the LLM's
// discovery flow, not the runtime. Either the pattern generalizes (add it here)
// or don't add it at all.
//
// See
// runtime/docs/principles.md#delegate-to-the-llm-but-allow-narrowly-scoped-runtime-heuristics
// for the full exceptions list and the bar new heuristics must clear.
//
// One advisory per response — when multiple detectors fire, priority order
// (encoded in DETECTORS array order) picks the earliest.

import type { InterceptedRequest } from '../drivers/types/network';
import type { WebSocketFrame } from '../drivers/types/websocket';

export type EnvelopeAdvisoryKind =
  | 'binary_ws_frame'
  | 'multipart_binary_body'
  | 'escaped_json_envelope'
  | 'binary_http_body'
  | 'body_signature_header_present'
  | 'high_entropy_body'
  | 'body_carries_hash_field'
  | 'body_rotating_field'
  | 'jwt_shaped_token'
  | 'double_submit_csrf'
  | 'session_cookie_rotated';

export interface EnvelopeAdvisory {
  kind: EnvelopeAdvisoryKind;
  /** Pointer into the wsFrames array for WS-side detectors. */
  ws_i?: number;
  /** Pointer into the intercepted-requests array for HTTP-side detectors. */
  i?: number;
  /** Detector-specific structural evidence (sizes, byte signatures, header
   *  names). */
  evidence: Record<string, string | number | boolean>;
  /** klura://reference#... URLs available for the agent to opt into
   *  reading. */
  refs: string[];
}

/** Indexed HTTP entry — `i` is the absolute index into the raw intercepted
 *  array. */
interface IndexedHttpEntry {
  entry: InterceptedRequest;
  i: number;
}

/** Indexed WS frame — `i` is the absolute index into the raw ws ring buffer. */
interface IndexedWsFrame {
  frame: WebSocketFrame;
  i: number;
}

interface DetectorInput {
  httpEntries: IndexedHttpEntry[];
  wsFrames: IndexedWsFrame[];
  /** The agent's `text_contains` filter value (when present). Anchors
   *  literal-offset checks. */
  textContains?: string;
  /**
   * Per-session try_generator counter snapshot. When present, the binary-WS
   * detector stamps the numeric counters onto its evidence map so the agent
   * sees its own progress without prose narration. Null when the runtime is
   * stateless or the session id wasn't threaded.
   */
  tryGeneratorStats?: {
    total: number;
    with_verify_against: number;
    ok_true: number;
    verified_ok: number;
  } | null;
  /**
   * Approximate count of tool calls against this session — incremented on every
   * getSession() lookup. Surfaced on the binary-WS evidence map so the agent
   * can read its own round count alongside the envelope shape.
   */
  sessionRoundCount?: number;
}

type EnvelopeDetector = (input: DetectorInput) => EnvelopeAdvisory | null;

// ---- Helpers ----

/**
 * Fraction of bytes in a payload string that look non-printable. We treat tab /
 * CR / LF as printable (otherwise normal text trips the check); every other
 * byte < 0x20 OR >= 0x80 counts as non-printable. Operates on the first
 * `sliceLen` bytes — enough signal for the binary detectors without scanning
 * megabyte payloads.
 */
export function nonPrintableRatio(payload: string, sliceLen = 64): number {
  if (!payload) return 0;
  const len = Math.min(payload.length, sliceLen);
  if (len === 0) return 0;
  let nonPrintable = 0;
  for (let k = 0; k < len; k += 1) {
    const c = payload.charCodeAt(k);
    if (c === 9 || c === 10 || c === 13) continue;
    if (c < 0x20 || c >= 0x80) nonPrintable += 1;
  }
  return nonPrintable / len;
}

/**
 * Shannon entropy of the byte distribution in `payload`, in bits/byte. Used to
 * flag bodies that look encrypted/compressed-but-undeclared (e.g. client-side
 * AES). Caps at 8 bits/byte (uniform distribution over 256 symbols).
 */
function shannonEntropy(payload: string): number {
  if (!payload) return 0;
  const counts: number[] = new Array<number>(256).fill(0);
  const len = payload.length;
  for (let k = 0; k < len; k += 1) {
    const c = payload.charCodeAt(k) & 0xff;
    counts[c] = (counts[c] ?? 0) + 1;
  }
  let entropy = 0;
  for (const count of counts) {
    if (count === 0) continue;
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** First index of `needle` in `payload`, or -1. Tiny indirection for symmetry
 *  with the rest of the helpers. */
function findLiteralOffset(payload: string, needle: string): number {
  if (!payload || !needle) return -1;
  return payload.indexOf(needle);
}

/**
 * True when the bytes around `offset` in `payload` look JSON-string-encoded —
 * i.e., the literal lives inside a "stringified JSON inside JSON" envelope. The
 * signal is `\\"` markers (a backslash followed by a literal quote — the shape
 * JSON.stringify produces when nested) within ~16 bytes before/after the
 * literal.
 */
function isEscapedNeighbor(payload: string, offset: number): boolean {
  if (!payload || offset < 0) return false;
  const start = Math.max(0, offset - 16);
  const end = Math.min(payload.length, offset + 16);
  const window = payload.slice(start, end);
  return window.includes('\\"');
}

/**
 * True when any header key matches one of the provided patterns. Patterns are
 * matched case-insensitively as substrings of the lowercased header name.
 */
function headerMatches(
  headers: Record<string, string>,
  patterns: ReadonlyArray<string>,
): { matched: true; headerName: string } | { matched: false } {
  for (const k of Object.keys(headers)) {
    const lc = k.toLowerCase();
    for (const p of patterns) {
      if (lc.includes(p)) return { matched: true, headerName: k };
    }
  }
  return { matched: false };
}

function bodyToString(body: unknown): string {
  if (body === null || body === undefined) return '';
  if (typeof body === 'string') return body;
  try {
    return JSON.stringify(body);
  } catch {
    return '';
  }
}

function contentTypeOf(headers: Record<string, string>): string {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'content-type' && typeof v === 'string') return v.toLowerCase();
  }
  return '';
}

function hasContentEncoding(headers: Record<string, string>): boolean {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'content-encoding' && typeof v === 'string' && v.trim().length > 0) {
      return true;
    }
  }
  return false;
}

function startsWithGzipMagic(body: string): boolean {
  return body.length >= 2 && body.charCodeAt(0) === 0x1f && body.charCodeAt(1) === 0x8b;
}

// ---- Detectors ----

export const BINARY_WS_NON_PRINTABLE_THRESHOLD = 0.15;
export const BINARY_WS_HEADER_PROBE_BYTES = 8;
export const BINARY_WS_HEADER_MIN_NON_PRINTABLE = 2;

export function isNonPrintableByte(c: number): boolean {
  if (c === 9 || c === 10 || c === 13) return false;
  return c < 0x20 || c >= 0x80;
}

/**
 * Binary-WS frame detector. Two arms covering two byte-shape patterns:
 *
 * 1. **High-ratio binary**: the payload is mostly non-printable bytes over the
 *    first 64 bytes. Threshold 0.15.
 *
 * 2. **Leading binary header + plaintext body**: the first few bytes are
 *    non-printable (a length prefix, a framing byte, a varint header) but the
 *    body past that is printable JSON or text that contains the literal
 *    `textContains`. Globally the non-printable ratio is tiny, so arm 1 misses
 *    — but ≥ 2 of the first 8 bytes are non-printable AND the literal lives
 *    past the header, which together identify a wrapped write rather than
 *    heartbeat noise. Arm 2 requires `text_contains` so it never fires
 *    speculatively.
 *
 * The `signature` evidence field names which arm fired. Numeric evidence
 * carries iteration + round counters when available — pure counters are the
 * runtime narrating the agent's own state back at them without prose.
 */
function detectBinaryWsWrite({
  wsFrames,
  textContains,
  tryGeneratorStats,
  sessionRoundCount,
}: DetectorInput): EnvelopeAdvisory | null {
  for (const { frame, i } of wsFrames) {
    if (frame.direction !== 'sent') continue;
    const payload = typeof frame.payload === 'string' ? frame.payload : '';
    if (payload.length < 4) continue;

    const ratio = nonPrintableRatio(payload);
    const firstByte = payload.charCodeAt(0) & 0xff;
    const literalOffset =
      textContains !== undefined ? findLiteralOffset(payload, textContains) : -1;

    const isHighRatioBinary =
      ratio >= BINARY_WS_NON_PRINTABLE_THRESHOLD &&
      (textContains === undefined || literalOffset >= 0);

    let headerNonPrintable = 0;
    const probeLen = Math.min(payload.length, BINARY_WS_HEADER_PROBE_BYTES);
    for (let k = 0; k < probeLen; k += 1) {
      if (isNonPrintableByte(payload.charCodeAt(k) & 0xff)) headerNonPrintable += 1;
    }
    const isLeadingHeaderEnvelope =
      payload.length >= 16 &&
      headerNonPrintable >= BINARY_WS_HEADER_MIN_NON_PRINTABLE &&
      textContains !== undefined &&
      literalOffset >= BINARY_WS_HEADER_PROBE_BYTES;

    if (!isHighRatioBinary && !isLeadingHeaderEnvelope) continue;

    const signature = isHighRatioBinary ? 'high_non_printable_ratio' : 'leading_binary_header';
    const evidence: Record<string, string | number | boolean> = {
      payload_total_chars: payload.length,
      first_byte: `0x${firstByte.toString(16).padStart(2, '0')}`,
      non_printable_ratio: Number(ratio.toFixed(2)),
      header_non_printable: headerNonPrintable,
      signature,
    };
    if (literalOffset >= 0) evidence.literal_at_offset = literalOffset;
    if (tryGeneratorStats) {
      evidence.verify_iterations_so_far = tryGeneratorStats.with_verify_against;
      evidence.verified_ok_so_far = tryGeneratorStats.verified_ok;
    }
    if (typeof sessionRoundCount === 'number') {
      evidence.session_round_count = sessionRoundCount;
    }

    return {
      kind: 'binary_ws_frame',
      ws_i: i,
      evidence,
      refs: ['klura://reference#try-generator', 'klura://reference#websocket-protocol'],
    };
  }
  return null;
}

const MULTIPART_NON_PRINTABLE_THRESHOLD = 0.05;

/**
 * Multipart/form-data with a binary part — e.g. file upload, image attachment.
 * The body's non-printable ratio exceeds the multipart text threshold because
 * the inline binary part inflates it.
 */
function detectMultipartBinary({ httpEntries }: DetectorInput): EnvelopeAdvisory | null {
  for (const { entry, i } of httpEntries) {
    const ct = contentTypeOf(entry.headers);
    if (!ct.startsWith('multipart/form-data')) continue;
    const body = bodyToString(entry.postData);
    if (body.length < 32) continue;
    const ratio = nonPrintableRatio(body, 256);
    if (ratio < MULTIPART_NON_PRINTABLE_THRESHOLD) continue;
    return {
      kind: 'multipart_binary_body',
      i,
      evidence: {
        content_type: ct,
        body_total_chars: body.length,
        non_printable_ratio: Number(ratio.toFixed(2)),
      },
      refs: ['klura://reference#try-generator', 'klura://reference#fetch-schema'],
    };
  }
  return null;
}

/**
 * Escaped-JSON-in-JSON envelope: the literal lives inside a JSON-string-
 * encoded JSON envelope (e.g. `{"payload": "{\\"text\\": \\"hi\\"}"}`).
 * Detected by `\"` escape markers within 16 bytes of the literal.
 */
function detectEscapedJsonEnvelope({
  httpEntries,
  textContains,
}: DetectorInput): EnvelopeAdvisory | null {
  if (!textContains) return null;
  for (const { entry, i } of httpEntries) {
    const body = bodyToString(entry.postData);
    if (!body) continue;
    const offset = findLiteralOffset(body, textContains);
    if (offset === -1) continue;
    if (!isEscapedNeighbor(body, offset)) continue;
    return {
      kind: 'escaped_json_envelope',
      i,
      evidence: {
        body_total_chars: body.length,
        literal_at_offset: offset,
      },
      refs: ['klura://reference#try-generator', 'klura://reference#fetch-schema'],
    };
  }
  return null;
}

const BINARY_HTTP_NON_PRINTABLE_THRESHOLD = 0.15;
const BINARY_HTTP_CONTENT_TYPES = [
  'application/x-protobuf',
  'application/protobuf',
  'application/grpc',
  'application/grpc-web',
  'application/grpc-web+proto',
  'application/grpc-web-text',
  'application/octet-stream',
  'application/cbor',
  'application/msgpack',
  'application/x-msgpack',
];

/**
 * Binary HTTP body — declared binary content-type + high non-printable ratio in
 * the request body.
 */
function detectBinaryHttpBody({ httpEntries }: DetectorInput): EnvelopeAdvisory | null {
  for (const { entry, i } of httpEntries) {
    const ct = contentTypeOf(entry.headers);
    if (!ct) continue;
    const isBinaryCt = BINARY_HTTP_CONTENT_TYPES.some((b) => ct.startsWith(b));
    if (!isBinaryCt) continue;
    const body = bodyToString(entry.postData);
    if (body.length < 4) continue;
    const ratio = nonPrintableRatio(body);
    if (ratio < BINARY_HTTP_NON_PRINTABLE_THRESHOLD) continue;
    return {
      kind: 'binary_http_body',
      i,
      evidence: {
        content_type: ct,
        body_total_chars: body.length,
        non_printable_ratio: Number(ratio.toFixed(2)),
      },
      refs: ['klura://reference#try-generator', 'klura://reference#fetch-schema'],
    };
  }
  return null;
}

// Generic signature-header substring patterns. Brand-specific headers (whatever
// X-<vendor>-* shape a particular site uses) are NOT in this list on purpose —
// the detector stays shape-general so new sites with new header names trigger
// it only when the name reads as a signature.
const SIGNATURE_HEADER_PATTERNS = ['-signature', '-sign', '-hmac', '-content-hash', '-digest'];

/**
 * Signature/HMAC-shaped header present on a request with a body. The header
 * name matches one of the generic signature substrings.
 */
function detectSignedRequest({ httpEntries }: DetectorInput): EnvelopeAdvisory | null {
  for (const { entry, i } of httpEntries) {
    const match = headerMatches(entry.headers, SIGNATURE_HEADER_PATTERNS);
    if (!match.matched) continue;
    const body = bodyToString(entry.postData);
    if (body.length === 0) continue;
    return {
      kind: 'body_signature_header_present',
      i,
      evidence: {
        header_name: match.headerName,
        body_total_chars: body.length,
      },
      refs: ['klura://reference#js-eval', 'klura://reference#page-script-schema'],
    };
  }
  return null;
}

const HIGH_ENTROPY_THRESHOLD = 6.5;
const HIGH_ENTROPY_MIN_BYTES = 64;

/**
 * High-entropy body without declared Content-Encoding — the body looks
 * encrypted or compressed but does not advertise a codec. Multipart and
 * gzip-magic bodies are skipped upstream so they don't false-trigger.
 */
function detectHighEntropyBody({ httpEntries }: DetectorInput): EnvelopeAdvisory | null {
  for (const { entry, i } of httpEntries) {
    const body = bodyToString(entry.postData);
    if (body.length < HIGH_ENTROPY_MIN_BYTES) continue;
    if (hasContentEncoding(entry.headers)) continue;
    if (startsWithGzipMagic(body)) continue;
    const ct = contentTypeOf(entry.headers);
    if (ct.startsWith('multipart/')) continue;
    const entropy = shannonEntropy(body.slice(0, 1024));
    if (entropy < HIGH_ENTROPY_THRESHOLD) continue;
    return {
      kind: 'high_entropy_body',
      i,
      evidence: {
        body_total_chars: body.length,
        entropy_bits_per_byte: Number(entropy.toFixed(2)),
        content_type: ct || 'unknown',
      },
      refs: ['klura://reference#js-eval', 'klura://reference#page-script-schema'],
    };
  }
  return null;
}

// A long hex hash shape — SHA-256 (64 chars), SHA-1 (40), MD5 (32). These are
// the shapes operation-hash-keyed APIs and schema-bound hash values take.
const HASH_FIELD_REGEX = /^[a-f0-9]{32,64}$/i;

/**
 * Body carries a deeply nested long-hex hash field. The hash shape is not tied
 * to any particular protocol — it's the structural claim that the body contains
 * a hex value of hash-appropriate length, deeply enough to look like a
 * schema/operation identifier rather than a free-text field. Hardcoding the
 * hash into a saved strategy typically rots across deploys.
 */
function detectBodyHashField({ httpEntries }: DetectorInput): EnvelopeAdvisory | null {
  for (const { entry, i } of httpEntries) {
    const body = bodyToString(entry.postData);
    if (!body || body.length < 64) continue;
    const parsed = tryParseJson(body);
    if (!parsed || typeof parsed !== 'object') continue;
    const hit = findHashField(parsed, []);
    if (!hit) continue;
    return {
      kind: 'body_carries_hash_field',
      i,
      evidence: {
        body_total_chars: body.length,
        field_path: hit.path,
        field_value_length: hit.value.length,
      },
      refs: ['klura://reference#page-script-schema'],
    };
  }
  return null;
}

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Walk a parsed-JSON value depth-first for the first string that matches
 * HASH_FIELD_REGEX at depth >= 2 (so top-level `{hash: "..."}` fields, which
 * are common in legitimate content, don't false-trigger). Returns the dotted
 * path and the matching value.
 */
function findHashField(value: unknown, path: string[]): { path: string; value: string } | null {
  if (typeof value === 'string') {
    if (path.length >= 2 && HASH_FIELD_REGEX.test(value)) {
      return { path: path.join('.'), value };
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (let k = 0; k < value.length; k += 1) {
      const found = findHashField(value[k], path.concat(String(k)));
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const found = findHashField(v, path.concat(k));
      if (found) return found;
    }
  }
  return null;
}

// ---- rotating-field detector ----
//
// Body contains a key whose name suggests it rotates per-request (timestamp,
// nonce, sequence id) with a value shape that matches the name. Flags that the
// field can't be hardcoded — needs a generator or page-extract.
const ROTATING_KEY_NAMES: ReadonlyArray<string> = [
  'timestamp',
  'ts',
  '_t',
  '_ts',
  'time',
  'client_time',
  'client_ts',
  'epoch',
  'now',
  'nonce',
  'request_id',
  'req_id',
  'request-id',
  'seq',
  'sequence',
  'sequence_id',
  'idempotency_key',
];
const EPOCH_DIGITS_REGEX = /^\d{10,13}$/; // 10-digit seconds through 13-digit ms
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_NONCE_REGEX = /^[a-f0-9]{16,}$/i;

function detectRotatingField({ httpEntries }: DetectorInput): EnvelopeAdvisory | null {
  for (const { entry, i } of httpEntries) {
    const body = bodyToString(entry.postData);
    if (!body) continue;
    const parsed = tryParseJson(body);
    if (!parsed) continue;
    const hit = findRotatingKey(parsed, []);
    if (!hit) continue;
    return {
      kind: 'body_rotating_field',
      i,
      evidence: {
        field_path: hit.path,
        value_shape: hit.shape,
      },
      refs: ['klura://reference#fetch-schema', 'klura://reference#fetch-schema'],
    };
  }
  return null;
}

function findRotatingKey(value: unknown, path: string[]): { path: string; shape: string } | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (let k = 0; k < value.length; k += 1) {
      const found = findRotatingKey(value[k], path.concat(String(k)));
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const key = k.toLowerCase();
      if (ROTATING_KEY_NAMES.includes(key)) {
        const shape = classifyRotatingValueShape(v);
        if (shape) return { path: path.concat(k).join('.'), shape };
      }
      const nested = findRotatingKey(v, path.concat(k));
      if (nested) return nested;
    }
  }
  return null;
}

function classifyRotatingValueShape(v: unknown): string | null {
  if (typeof v === 'number' && v > 1_000_000_000 && v < 10_000_000_000_000) {
    return 'epoch_number';
  }
  if (typeof v !== 'string') return null;
  if (EPOCH_DIGITS_REGEX.test(v)) return 'epoch_string';
  if (UUID_REGEX.test(v)) return 'uuid';
  if (HEX_NONCE_REGEX.test(v)) return 'hex_nonce';
  return null;
}

// ---- JWT-shape detector ----
//
// Any header or body string that matches three base64url segments joined by
// dots. Typical for session/access tokens that rotate per login. Hardcoding
// into a saved strategy will rot at the next token refresh.
const JWT_REGEX = /^[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{4,}$/;

function detectJwtShapedToken({ httpEntries }: DetectorInput): EnvelopeAdvisory | null {
  for (const { entry, i } of httpEntries) {
    for (const [hk, hv] of Object.entries(entry.headers)) {
      if (typeof hv !== 'string') continue;
      const stripped = hv.trim().replace(/^(Bearer|Token|JWT)\s+/i, '');
      if (JWT_REGEX.test(stripped)) {
        return {
          kind: 'jwt_shaped_token',
          i,
          evidence: {
            location: `header:${hk}`,
            value_length: stripped.length,
          },
          refs: ['klura://reference#capability-prereq', 'klura://reference#fetch-schema'],
        };
      }
    }
    const body = bodyToString(entry.postData);
    if (!body) continue;
    const parsed = tryParseJson(body);
    if (!parsed) continue;
    const hit = findJwtInJson(parsed, []);
    if (hit) {
      return {
        kind: 'jwt_shaped_token',
        i,
        evidence: {
          location: `body:${hit.path}`,
          value_length: hit.value.length,
        },
        refs: ['klura://reference#capability-prereq', 'klura://reference#fetch-schema'],
      };
    }
  }
  return null;
}

function findJwtInJson(value: unknown, path: string[]): { path: string; value: string } | null {
  if (typeof value === 'string') {
    if (JWT_REGEX.test(value)) return { path: path.join('.'), value };
    return null;
  }
  if (Array.isArray(value)) {
    for (let k = 0; k < value.length; k += 1) {
      const found = findJwtInJson(value[k], path.concat(String(k)));
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const found = findJwtInJson(v, path.concat(k));
      if (found) return found;
    }
  }
  return null;
}

// ---- double-submit CSRF detector ----
//
// The same opaque value appears in both a cookie and a request header (or body
// field). Structural fingerprint of a CSRF double-submit pattern; the paired
// value typically rotates per session, so hardcoding it into a saved strategy
// will reject at warm execute time.
function detectDoubleSubmitCsrf({ httpEntries }: DetectorInput): EnvelopeAdvisory | null {
  for (const { entry, i } of httpEntries) {
    const cookieHeader = pickHeaderValue(entry.headers, 'cookie');
    if (!cookieHeader) continue;
    const cookieValues = parseCookieValues(cookieHeader);
    if (cookieValues.length === 0) continue;
    for (const [hk, hv] of Object.entries(entry.headers)) {
      if (hk.toLowerCase() === 'cookie') continue;
      if (typeof hv !== 'string') continue;
      for (const cv of cookieValues) {
        if (cv.value.length < 16) continue;
        if (hv.includes(cv.value)) {
          return {
            kind: 'double_submit_csrf',
            i,
            evidence: {
              cookie_name: cv.name,
              header_name: hk,
              value_length: cv.value.length,
            },
            refs: ['klura://reference#capability-prereq'],
          };
        }
      }
    }
    const body = bodyToString(entry.postData);
    if (!body) continue;
    for (const cv of cookieValues) {
      if (cv.value.length < 16) continue;
      if (body.includes(cv.value)) {
        return {
          kind: 'double_submit_csrf',
          i,
          evidence: {
            cookie_name: cv.name,
            location: 'body',
            value_length: cv.value.length,
          },
          refs: ['klura://reference#capability-prereq'],
        };
      }
    }
  }
  return null;
}

function pickHeaderValue(headers: Record<string, string>, name: string): string | null {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name && typeof v === 'string') return v;
  }
  return null;
}

function parseCookieValues(header: string): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  for (const chunk of header.split(';')) {
    const eq = chunk.indexOf('=');
    if (eq === -1) continue;
    const name = chunk.slice(0, eq).trim();
    const value = chunk.slice(eq + 1).trim();
    if (name && value) out.push({ name, value });
  }
  return out;
}

// ---- cookie-rotation detector ----
//
// Same cookie name observed with two or more distinct values across the
// session's requests. Indicates rolling session tokens — capturing the cookie
// at one point and pasting it into a saved strategy will stale between runs.
function detectSessionCookieRotated({ httpEntries }: DetectorInput): EnvelopeAdvisory | null {
  const seen = new Map<string, { value: string; firstAt: number }>();
  for (const { entry, i } of httpEntries) {
    const cookieHeader = pickHeaderValue(entry.headers, 'cookie');
    if (!cookieHeader) continue;
    for (const cv of parseCookieValues(cookieHeader)) {
      if (cv.value.length < 8) continue;
      const prior = seen.get(cv.name);
      if (!prior) {
        seen.set(cv.name, { value: cv.value, firstAt: i });
        continue;
      }
      if (prior.value !== cv.value) {
        return {
          kind: 'session_cookie_rotated',
          i,
          evidence: {
            cookie_name: cv.name,
            first_seen_at: prior.firstAt,
            rotated_at: i,
            first_value_length: prior.value.length,
            rotated_value_length: cv.value.length,
          },
          refs: ['klura://reference#capability-prereq'],
        };
      }
    }
  }
  return null;
}

// Priority order. Binary frame/body detectors fire first: they identify traffic
// that can't be replayed without decoding, which is the most fundamental
// save-level decision. Envelope-shape detectors (escaped-JSON, signature
// header, high entropy, hash field) come next — each flags something the LLM
// must either extract at run time or regenerate. Rotating/JWT/CSRF/cookie
// detectors come last because the signal is "don't hardcode this value" rather
// than "use a different strategy tier."
const DETECTORS: ReadonlyArray<EnvelopeDetector> = [
  detectBinaryWsWrite,
  detectMultipartBinary,
  detectEscapedJsonEnvelope,
  detectBinaryHttpBody,
  detectSignedRequest,
  detectHighEntropyBody,
  detectBodyHashField,
  detectRotatingField,
  detectJwtShapedToken,
  detectDoubleSubmitCsrf,
  detectSessionCookieRotated,
];

/**
 * Run every detector against the entries that are about to surface in the
 * `get_network_log` response. Returns the first non-null advisory in priority
 * order, or null when no pattern fires (the simple-site case).
 */
export function detectComplexEnvelope(input: DetectorInput): EnvelopeAdvisory | null {
  for (const detector of DETECTORS) {
    const advisory = detector(input);
    if (advisory) return advisory;
  }
  return null;
}

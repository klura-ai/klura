// Byte-level inspection helpers for captured WebSocket frames. Used by the
// `inspect_ws_frame` and `find_in_ws_frame` MCP tools so agents can see what's
// actually in a binary envelope without writing JS scan-loops in their own
// generator drafts.
//
// All helpers take a WebSocketFrame.payload string (raw octets 0-255 as a JS
// string — the shape the driver's capture hook produces) and return a bounded,
// MCP-budget-safe shape.

import type { InspectStarter } from './ws-frame-starter';
import type { WsSendCallstack } from '../drivers/types/websocket';

// Default / max bytes per inspect_ws_frame call. 512 bytes in hex-dump format
// is ~2.5 KB of output — well under the tool-output budget, and enough to scan
// length prefixes + topic + payload head for typical length-prefixed envelopes.
// Agent can page with {offset, length}.
const INSPECT_DEFAULT_LENGTH = 512;
const INSPECT_MAX_LENGTH = 4096;

export type InspectFormat = 'hex' | 'utf8' | 'mixed';

export interface InspectWsFrameResult {
  /** Byte offset the view starts at (zero-indexed). */
  offset: number;
  /** Byte length actually returned. May be shorter than requested if the
   *  frame ends first. */
  length: number;
  /** Total frame length in bytes, regardless of offset/length. Lets the
   *  agent decide whether to page further. */
  total_length: number;
  format: InspectFormat;
  /** The formatted view. Hex = space-separated lowercase bytes; utf8 =
   *  decoded text with non-printable control bytes escaped as \xNN;
   *  mixed = classic hex-dump format with 16 bytes per line, offset on
   *  the left, hex in the middle, ASCII gutter on the right. */
  data: string;
  /** True when `length` was clamped below what the caller asked for
   *  because of the 4096-byte cap. */
  clamped?: boolean;
  /** When `text_contains` was passed AND the frame matches the binary-WS
   *  starter gate (binary header + literal past the header), a runnable
   *  iteration-1 generator that splices `args.text` into the captured
   *  envelope verbatim. Iteration 1 against captured args returns ok:true
   *  — the agent then refactors for variable-length text + dynamic fields
   *  (timestamps, per-send ids, sequence numbers, nonces) identified from
   *  the captured payload itself. */
  starter?: InspectStarter;
  /** When the captured `direction: 'sent'` frame correlates with a
   *  WebSocket.prototype.send call recorded by the page-side wrapper, the
   *  JS callstack at send time. Lets the agent skip byte-level reverse
   *  engineering and read the encoder's source directly: the top frame
   *  names the file:line of the send call; `get_js_source` reads the
   *  surrounding source. Absent for received frames and for sent frames
   *  the wrapper missed (e.g. site JS swapped WebSocket.prototype.send
   *  after our init script ran). */
  js_callstack?: WsSendCallstack;
  /** Runtime-picked next tool call, set when `js_callstack` is present
   *  and the top non-anonymous frame names a real URL + line. Pushes
   *  `get_js_source` as the explicit next move — "read the encoder" is
   *  the fast path, the starter's iteration loop is the fallback. Agents
   *  strongly honor this pattern; without it the two paths read as
   *  equally-weighted and the agent picks iteration because it's the
   *  familiar primitive. */
  next_tool_hint?: {
    primary: 'get_js_source';
    args: {
      session_id?: string;
      url: string;
      line: number;
      context_lines: number;
    };
    reason: string;
  };
}

function asOctets(payload: string): Uint8Array {
  return new Uint8Array(Buffer.from(payload, 'binary'));
}

function formatHex(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 1) {
    parts.push((bytes[i] ?? 0).toString(16).padStart(2, '0'));
  }
  return parts.join(' ');
}

function formatUtf8(bytes: Uint8Array): string {
  // Decode as utf-8 but escape non-printable / control bytes so the returned
  // string is safe to round-trip through JSON + the MCP layer without losing
  // information. Agents that need the raw bytes use the 'hex' or 'mixed'
  // format.
  const out: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i] ?? 0;
    if (b >= 0x20 && b < 0x7f) {
      out.push(String.fromCharCode(b));
      i += 1;
      continue;
    }
    if (b === 0x09) {
      out.push('\\t');
      i += 1;
      continue;
    }
    if (b === 0x0a) {
      out.push('\\n');
      i += 1;
      continue;
    }
    if (b === 0x0d) {
      out.push('\\r');
      i += 1;
      continue;
    }
    // Fast path for likely multi-byte utf-8 — let TextDecoder handle any run of
    // bytes >= 0x80, then escape anything it couldn't decode.
    if (b >= 0x80) {
      let j = i + 1;
      while (j < bytes.length && (bytes[j] ?? 0) >= 0x80) j += 1;
      const slice = bytes.subarray(i, j);
      try {
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(slice);
        out.push(decoded);
      } catch {
        for (let k = 0; k < slice.length; k += 1) {
          out.push('\\x' + (slice[k] ?? 0).toString(16).padStart(2, '0'));
        }
      }
      i = j;
      continue;
    }
    out.push('\\x' + b.toString(16).padStart(2, '0'));
    i += 1;
  }
  return out.join('');
}

function formatMixed(bytes: Uint8Array, offset: number): string {
  // Classic hex-dump format: offset (hex, 4-to-6 digits) | 16 bytes hex | ASCII
  // gutter with non-printable as '.'. Easy to eyeball for length prefixes,
  // topic strings, and JSON payload starts.
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = bytes.subarray(i, Math.min(i + 16, bytes.length));
    const off = (offset + i).toString(16).padStart(4, '0');
    const hexParts: string[] = [];
    const ascParts: string[] = [];
    for (let j = 0; j < 16; j += 1) {
      if (j < chunk.length) {
        const b = chunk[j] ?? 0;
        hexParts.push(b.toString(16).padStart(2, '0'));
        ascParts.push(b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.');
      } else {
        hexParts.push('  ');
        ascParts.push(' ');
      }
      if (j === 7) hexParts.push('');
    }
    lines.push(`${off}: ${hexParts.join(' ')}  ${ascParts.join('')}`);
  }
  return lines.join('\n');
}

export function inspectWsPayload(
  payload: string,
  opts: { offset?: number; length?: number; format?: InspectFormat } = {},
): InspectWsFrameResult {
  const bytes = asOctets(payload);
  const totalLength = bytes.length;
  const startOffset = Math.max(0, Math.floor(opts.offset ?? 0));
  if (startOffset >= totalLength) {
    return {
      offset: startOffset,
      length: 0,
      total_length: totalLength,
      format: opts.format ?? 'mixed',
      data: '',
    };
  }
  const requestedLength = Math.max(1, Math.floor(opts.length ?? INSPECT_DEFAULT_LENGTH));
  const clamped = requestedLength > INSPECT_MAX_LENGTH;
  const effectiveLength = Math.min(
    clamped ? INSPECT_MAX_LENGTH : requestedLength,
    totalLength - startOffset,
  );
  const slice = bytes.subarray(startOffset, startOffset + effectiveLength);
  const format: InspectFormat = opts.format ?? 'mixed';
  let data: string;
  if (format === 'hex') data = formatHex(slice);
  else if (format === 'utf8') data = formatUtf8(slice);
  else data = formatMixed(slice, startOffset);

  const result: InspectWsFrameResult = {
    offset: startOffset,
    length: effectiveLength,
    total_length: totalLength,
    format,
    data,
  };
  if (clamped) result.clamped = true;
  return result;
}

export interface FindInWsFrameResult {
  /** Byte offsets where `needle` appears in the frame's payload, treated
   *  as raw octets. All occurrences returned (agents usually care about
   *  the first one, but a site that echoes the user value in two places
   *  benefits from seeing both). */
  offsets: number[];
  /** Total byte length of the frame. Lets the agent convert offsets to
   *  "X bytes from the end" if that helps with length-prefix math. */
  total_length: number;
  /** True when `needle` occurred more than CAP times; `offsets` is
   *  truncated to the first CAP hits and this flag is set. */
  truncated?: boolean;
}

const FIND_OFFSETS_CAP = 32;

export function findInWsPayload(payload: string, needle: string): FindInWsFrameResult {
  const bytes = asOctets(payload);
  if (!needle) return { offsets: [], total_length: bytes.length };
  const needleBytes = new Uint8Array(Buffer.from(needle, 'utf-8'));
  if (needleBytes.length === 0) return { offsets: [], total_length: bytes.length };
  const offsets: number[] = [];
  let truncated = false;
  outer: for (let i = 0; i + needleBytes.length <= bytes.length; i += 1) {
    for (let j = 0; j < needleBytes.length; j += 1) {
      if (bytes[i + j] !== needleBytes[j]) continue outer;
    }
    offsets.push(i);
    if (offsets.length >= FIND_OFFSETS_CAP) {
      truncated = true;
      break;
    }
  }
  const out: FindInWsFrameResult = { offsets, total_length: bytes.length };
  if (truncated) out.truncated = true;
  return out;
}

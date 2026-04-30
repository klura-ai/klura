// Streaming chunk parsers for the `fetch-stream` listener transport. Pure
// functions — given a buffer slice + a push callback, emit zero or more
// parsed payloads and return the new buffer state. Decoupled from the
// network layer so the unit tests in
// `runtime/test/listeners-fetch-stream.test.js` exercise the framing
// without needing a server.
//
// Two modes:
//   - "sse" — Server-Sent Events. Lines split by `\n`; events delimited by
//     a blank line. Multi-line `data:` lines concatenate with `\n`.
//     Comment lines (starting with `:`) are ignored. The `data: [DONE]`
//     end-of-stream sentinel that streaming-completion endpoints emit is
//     recognised — instead of failing JSON.parse, we deliver
//     `{_done: true}` so downstream consumers see the boundary.
//   - "ndjson" — newline-delimited JSON. Each line is a complete JSON
//     value; per-line parse errors are tolerated (the line is dropped,
//     parsing continues).
//
// The chunked-bytes layer is the caller's responsibility. The expected
// shape is: caller maintains a `buffer: string` across chunks (built via
// `TextDecoder({ stream: true })` so multi-byte characters split across
// chunks decode cleanly), feeds each chunk into the appropriate parser
// with the running buffer + a push callback, and stores the returned
// buffer for the next call.

const SSE_DONE_SENTINEL = '[DONE]';

export type PushParsed = (value: unknown) => void;

/**
 * Parse SSE chunks from `buffer`, emitting each completed event via `push`.
 * Returns the residual buffer (incomplete trailing data) for the next call.
 *
 * Caller contract:
 *   let buffer = '';
 *   const decoder = new TextDecoder();
 *   for await (const chunk of reader) {
 *     buffer = parseSseChunk(buffer + decoder.decode(chunk, {stream: true}), push);
 *   }
 *
 * Returns parse-time JSON values — strings that aren't valid JSON pass
 * through as raw strings (matches the existing `handleIncomingData` shape:
 * upstream applies `events.match` filters either way).
 */
export function parseSseChunk(buffer: string, push: PushParsed): string {
  // SSE events are separated by a blank line. Find every `\n\n` boundary
  // and slice. The trailing portion (no terminator yet) is returned to
  // the caller as the next-call buffer.
  let cursor = 0;
  while (cursor < buffer.length) {
    const boundary = buffer.indexOf('\n\n', cursor);
    if (boundary === -1) break;
    const block = buffer.slice(cursor, boundary);
    cursor = boundary + 2;
    const dataLines: string[] = [];
    for (const rawLine of block.split('\n')) {
      // Comment lines (`:keepalive`) — skip per SSE spec.
      if (rawLine.startsWith(':')) continue;
      if (rawLine.startsWith('data: ')) {
        dataLines.push(rawLine.slice(6));
      } else if (rawLine.startsWith('data:')) {
        // Tolerate the `data:value` shape (no space after colon — some
        // servers emit it). SSE spec allows either.
        dataLines.push(rawLine.slice(5));
      }
      // Other SSE fields (`event:`, `id:`, `retry:`) — not surfaced by
      // klura's listener envelope. Adding them later is additive.
    }
    if (dataLines.length === 0) continue;
    const joined = dataLines.join('\n');
    // `[DONE]` end-of-stream marker the SSE convention uses on
    // streaming-completion endpoints. Never JSON; deliver as a synthetic
    // done envelope so consumers can see the boundary.
    if (joined === SSE_DONE_SENTINEL) {
      push({ _done: true });
      continue;
    }
    push(parseMaybeJson(joined));
  }
  return buffer.slice(cursor);
}

/**
 * Parse NDJSON chunks. Each line is a complete JSON value. Returns the
 * residual (trailing line without `\n`) for the next call. Empty lines are
 * skipped. Per-line parse errors are tolerated — the offending line is
 * dropped and parsing continues.
 */
export function parseNdjsonChunk(buffer: string, push: PushParsed): string {
  let cursor = 0;
  while (cursor < buffer.length) {
    const newline = buffer.indexOf('\n', cursor);
    if (newline === -1) break;
    const line = buffer.slice(cursor, newline).trim();
    cursor = newline + 1;
    if (line.length === 0) continue;
    try {
      push(JSON.parse(line));
    } catch {
      // Malformed line — drop and continue. One bad frame doesn't kill the
      // connection. Logging here would be noisy on lossy upstreams; the
      // listener emits its own diagnostics on disconnect.
    }
  }
  return buffer.slice(cursor);
}

function parseMaybeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

// Synthesises a one-call starter generator for binary-WS captures.
//
// The motivating problem: agents looking at a binary envelope (MQTT PUBLISH
// header + nested JSON body, Thrift framed, etc.) face a cold- start commit
// cost — writing a 30-line generator from scratch BEFORE any feedback signal.
// Across 5 recent messenger discovery runs, four folded to recorded-path
// without calling try_generator once. The fold-vs-iterate decision happened
// before iteration 1 because iteration 1 looked expensive.
//
// The starter inverts that. When the caller passes `text_contains` to
// `inspect_ws_frame`, the runtime locates the literal inside the captured
// payload, classifies the envelope as binary-WS-write-shaped, and returns a
// working splice-based generator that:
//
// - Embeds the captured payload bytes (base64) verbatim. - Finds the literal at
// a known offset. - Replaces those bytes with `args.text`. - Returns the
// spliced base64.
//
// Iteration 1 (`try_generator({code: starter.code, args:
// starter.args_for_iteration_1, verify_against: {ws_i}})`) returns ok:true
// because the splice preserves every other byte. That single call confirms the
// envelope shape is correct and turns the rest of the work into
// refactor-not-discover: the agent now knows what dynamic fields rotate
// (timestamps, sequence numbers, request ids) and templates each one in
// subsequent iterations.

export interface InspectStarter {
  /** A runnable try_generator code string. Returns base64 when paired
   *  with `args_for_iteration_1` and `verify_against: {ws_i}`. */
  code: string;
  /** Args that pair with `code` to produce ok:true on iteration 1. */
  args_for_iteration_1: Record<string, unknown>;
  /** Byte offset where the literal lives in the captured payload. */
  literal_at_offset: number;
  /** UTF-8 byte length of the captured literal. */
  literal_byte_length: number;
  /** ≤ 120 chars structural description of what the starter does. */
  what_this_does: string;
}

import {
  nonPrintableRatio,
  isNonPrintableByte,
  BINARY_WS_HEADER_PROBE_BYTES,
  BINARY_WS_HEADER_MIN_NON_PRINTABLE,
  BINARY_WS_NON_PRINTABLE_THRESHOLD,
} from './envelope-advisories';

/**
 * Returns true when the payload + literal-offset combination matches the
 * binary-WS-write detector. Mirrors the gate in `envelope-advisories.ts` so the
 * starter is emitted exactly when the inline `_advisory` would fire — agents
 * see them as a coupled pair.
 */
export function payloadMatchesBinaryWsStarterGate(payload: string, literalOffset: number): boolean {
  if (payload.length < 16) return false;
  if (literalOffset < 0) return false;

  const ratio = nonPrintableRatio(payload);
  const isHighRatio = ratio >= BINARY_WS_NON_PRINTABLE_THRESHOLD;

  const probeLen = Math.min(payload.length, BINARY_WS_HEADER_PROBE_BYTES);
  let headerNonPrintable = 0;
  for (let k = 0; k < probeLen; k += 1) {
    if (isNonPrintableByte(payload.charCodeAt(k) & 0xff)) headerNonPrintable += 1;
  }
  const isLeadingHeader =
    headerNonPrintable >= BINARY_WS_HEADER_MIN_NON_PRINTABLE &&
    literalOffset >= BINARY_WS_HEADER_PROBE_BYTES;

  return isHighRatio || isLeadingHeader;
}

/**
 * Build a starter from a captured payload + the literal the agent typed.
 * Returns null when the payload does not match the binary-WS gate, or when the
 * literal is not found in the payload.
 */
export function buildBinaryWsStarter(payload: string, literal: string): InspectStarter | null {
  if (!literal) return null;

  const literalBytes = Buffer.from(literal, 'utf-8');
  const literalLen = literalBytes.length;
  if (literalLen === 0) return null;

  // Locate the literal as raw octets in the payload (treat payload as binary
  // string — same shape as findInWsPayload).
  const payloadBytes = Buffer.from(payload, 'binary');
  let literalOffset = -1;
  outer: for (let i = 0; i + literalLen <= payloadBytes.length; i += 1) {
    for (let j = 0; j < literalLen; j += 1) {
      if (payloadBytes[i + j] !== literalBytes[j]) continue outer;
    }
    literalOffset = i;
    break;
  }
  if (literalOffset < 0) return null;

  if (!payloadMatchesBinaryWsStarterGate(payload, literalOffset)) return null;

  const capturedBase64 = payloadBytes.toString('base64');
  const literalJson = JSON.stringify(literal);
  // The body of code passed to runGeneratorCode runs inside a `function (args,
  // Buffer)` sandbox; only `args` and `Buffer` are in scope. Keep dependencies
  // minimal so the splice has zero hidden requirements.
  const code =
    `// Iteration-1 starter — splices args.text into the captured envelope verbatim.\n` +
    `// Returns ok:true against the captured frame for the captured-args case.\n` +
    `// Refactor for production: read the captured payload and template each rotating\n` +
    `// field (timestamps, sequence numbers, per-send ids, nonces) instead of embedding\n` +
    `// the base64 blob — see the rotating-field checklist in klura://reference.\n` +
    `const captured = Buffer.from('${capturedBase64}', 'base64');\n` +
    `const literalAt = ${literalOffset};\n` +
    `const oldText = ${literalJson};\n` +
    `const newText = String(args.text);\n` +
    `const oldBytes = Buffer.byteLength(oldText, 'utf-8');\n` +
    `const newBytes = Buffer.byteLength(newText, 'utf-8');\n` +
    `if (oldBytes !== newBytes) {\n` +
    `  throw new Error('iteration-1 starter requires args.text === captured literal (' + oldBytes + ' utf-8 bytes); for variable-length text, parse the envelope length-prefix and rewrite it before splicing — see inspect_ws_frame for the byte layout');\n` +
    `}\n` +
    `const before = captured.subarray(0, literalAt);\n` +
    `const after = captured.subarray(literalAt + oldBytes);\n` +
    `return Buffer.concat([before, Buffer.from(newText, 'utf-8'), after]).toString('base64');\n`;

  const starter: InspectStarter = {
    code,
    args_for_iteration_1: { text: literal },
    literal_at_offset: literalOffset,
    literal_byte_length: literalLen,
    what_this_does:
      'Splices args.text into the captured envelope at the literal offset; preserves every other byte verbatim.',
  };
  return starter;
}

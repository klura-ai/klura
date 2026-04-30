// Structural explainer for captured WebSocket frames. Turns ~20 rounds of
// hand-walking `inspect_ws_frame(format:utf8, offset:N, length:M)` into one
// call that returns:
//
// - detected wire protocol (MQTT PUBLISH, protobuf-unary, gRPC-Web,
// Thrift-compact, plain JSON, or `raw` when nothing matches) - envelope-JSON
// parse tree (keys, value types, nested-JSON detection) - json-path of every
// occurrence of an optional text_anchor (e.g. the typed literal the agent is
// tracking)
//
// No brand-specific hints. Detection is pure byte-pattern matching on known
// formats. Simple sites that use plain text/JSON frames produce `protocol:
// {kind:'raw'}` and fall back to raw-view gracefully.

type ProtocolDetection =
  | {
      kind: 'mqtt_publish';
      header_bytes: number;
      topic: string;
      packet_id: number;
      envelope_offset: number;
    }
  | { kind: 'protobuf_unary'; wire_type_counts: Record<string, number> }
  | { kind: 'grpc_web'; flag: number; length: number; payload_offset: number }
  | { kind: 'thrift_compact'; method?: string }
  | { kind: 'json'; offset: number }
  | { kind: 'raw' };

interface EnvelopeExplain {
  parse_ok: boolean;
  root_type?: 'object' | 'array';
  tree_preview?: string;
  keys_at_depth_1?: string[];
  literal_locations?: Array<{ json_path: string; value_preview: string }>;
  nested_json_fields?: Array<{ json_path: string; parsed_preview: string }>;
}
export interface WsFrameExplanation {
  byte_length: number;
  protocol: ProtocolDetection;
  envelope?: EnvelopeExplain;
  hints?: string[];
}

const TREE_PREVIEW_CAP = 2048;
const PARSED_PREVIEW_CAP = 512;
const MAX_NESTED_RECURSION = 3;

/**
 * Main entry. `payload` is the raw frame as a binary-encoded string (matches
 * the shape klura stores in session.wsFrames[].payload). `textAnchor` is an
 * optional literal (e.g. the typed message) — when present, its json_path
 * locations in parsed envelopes are returned in `envelope.literal_locations`.
 */
export function explainWsFrame(payload: string, textAnchor?: string): WsFrameExplanation {
  const byte_length = payload.length;
  const protocol = detectProtocol(payload);
  const envelope = extractEnvelope(payload, protocol, textAnchor);
  const hints = buildHints(protocol, envelope);
  const out: WsFrameExplanation = { byte_length, protocol };
  if (envelope) out.envelope = envelope;
  if (hints.length > 0) out.hints = hints;
  return out;
}

// ---- Protocol detectors ----

function detectProtocol(payload: string): ProtocolDetection {
  if (payload.length === 0) return { kind: 'raw' };
  const b0 = payload.charCodeAt(0) & 0xff;
  // MQTT PUBLISH: first byte is 0x30–0x3F (type=3, with varied flags). Most
  // commonly 0x30 (QoS 0), 0x32 (QoS 1), 0x34 (QoS 2).
  if ((b0 & 0xf0) === 0x30) {
    const parsed = tryParseMqttPublish(payload);
    if (parsed) return parsed;
  }
  // gRPC-Web: one-byte flag (0x00 trailer / 0x01 message) + 4-byte big- endian
  // length. If length matches remaining-bytes, we're confident.
  if ((b0 === 0x00 || b0 === 0x80) && payload.length >= 5) {
    const len =
      ((payload.charCodeAt(1) & 0xff) << 24) |
      ((payload.charCodeAt(2) & 0xff) << 16) |
      ((payload.charCodeAt(3) & 0xff) << 8) |
      (payload.charCodeAt(4) & 0xff);
    if (len === payload.length - 5) {
      return { kind: 'grpc_web', flag: b0, length: len, payload_offset: 5 };
    }
  }
  // Plain JSON (text-mode WS frame): starts with `{` or `[` and parses.
  const trimmed = payload.trimStart();
  if (trimmed.length > 0 && (trimmed[0] === '{' || trimmed[0] === '[')) {
    try {
      JSON.parse(trimmed);
      return { kind: 'json', offset: payload.length - trimmed.length };
    } catch {
      /* fall through */
    }
  }
  // protobuf-unary: first byte looks like field-tag with low wire type. The low
  // 3 bits are wire-type (0-5). If the first ~20 bytes parse as a sequence of
  // tag+varint pairs without exhausting, call it protobuf.
  const pb = tryDetectProtobuf(payload);
  if (pb) return pb;
  // Thrift-compact: version byte 0x82 or 0x84, next byte has type in
  // high-nibble. Very narrow detector.
  if ((b0 === 0x82 || b0 === 0x84) && payload.length >= 4) {
    return { kind: 'thrift_compact' };
  }
  return { kind: 'raw' };
}

function tryParseMqttPublish(
  payload: string,
): null | Extract<ProtocolDetection, { kind: 'mqtt_publish' }> {
  // Fixed header: byte 0 = 0x3X, then remaining-length (varint, 1-4 bytes).
  let i = 1;
  let mult = 1;
  let remaining = 0;
  for (let step = 0; step < 4; step += 1) {
    if (i >= payload.length) return null;
    const b = payload.charCodeAt(i) & 0xff;
    i += 1;
    remaining += (b & 0x7f) * mult;
    if ((b & 0x80) === 0) break;
    mult *= 128;
    if (step === 3) return null; // varint too long
  }
  if (i + remaining > payload.length) return null;
  // Topic: 2-byte big-endian length + UTF-8 bytes.
  if (i + 2 > payload.length) return null;
  const topicLen = ((payload.charCodeAt(i) & 0xff) << 8) | (payload.charCodeAt(i + 1) & 0xff);
  i += 2;
  if (i + topicLen > payload.length) return null;
  const topic = payload.slice(i, i + topicLen);
  i += topicLen;
  // For QoS > 0: 2-byte packet id.
  const qos = ((payload.charCodeAt(0) & 0xff) >> 1) & 0x03;
  let packet_id = 0;
  if (qos > 0) {
    if (i + 2 > payload.length) return null;
    packet_id = ((payload.charCodeAt(i) & 0xff) << 8) | (payload.charCodeAt(i + 1) & 0xff);
    i += 2;
  }
  return {
    kind: 'mqtt_publish',
    header_bytes: i,
    topic,
    packet_id,
    envelope_offset: i,
  };
}

function tryDetectProtobuf(
  payload: string,
): null | Extract<ProtocolDetection, { kind: 'protobuf_unary' }> {
  const wireTypeCounts: Record<string, number> = {};
  let i = 0;
  let fieldsSeen = 0;
  const limit = Math.min(payload.length, 64);
  while (i < limit && fieldsSeen < 8) {
    const tag = readVarint(payload, i);
    if (!tag || tag.value < 0n || tag.value > 0xffffffffn) return null;
    const wireType = Number(tag.value & 0x7n);
    if (wireType > 5) return null;
    const fieldNumber = Number(tag.value >> 3n);
    if (fieldNumber === 0) return null;
    i += tag.bytes;
    if (wireType === 0) {
      // varint
      const vi = readVarint(payload, i);
      if (!vi) return null;
      i += vi.bytes;
    } else if (wireType === 1) {
      // 64-bit
      if (i + 8 > payload.length) return null;
      i += 8;
    } else if (wireType === 2) {
      // length-delimited
      const lenV = readVarint(payload, i);
      if (!lenV) return null;
      i += lenV.bytes;
      const len = Number(lenV.value);
      if (len < 0 || i + len > payload.length) return null;
      i += len;
    } else if (wireType === 5) {
      // 32-bit
      if (i + 4 > payload.length) return null;
      i += 4;
    } else {
      // Unknown wire type for our simple detector
      return null;
    }
    const key = `wt${wireType}`;
    wireTypeCounts[key] = (wireTypeCounts[key] ?? 0) + 1;
    fieldsSeen += 1;
  }
  if (fieldsSeen < 2) return null;
  return { kind: 'protobuf_unary', wire_type_counts: wireTypeCounts };
}

function readVarint(payload: string, offset: number): null | { value: bigint; bytes: number } {
  let value = 0n;
  let shift = 0n;
  let bytes = 0;
  for (let j = 0; j < 10; j += 1) {
    if (offset + j >= payload.length) return null;
    const b = BigInt(payload.charCodeAt(offset + j) & 0xff);
    value |= (b & 0x7fn) << shift;
    bytes += 1;
    if ((b & 0x80n) === 0n) return { value, bytes };
    shift += 7n;
  }
  return null;
}

// ---- Envelope extraction ----

function extractEnvelope(
  payload: string,
  protocol: ProtocolDetection,
  textAnchor?: string,
): EnvelopeExplain | undefined {
  let envelopeStart: number;
  if (protocol.kind === 'mqtt_publish') envelopeStart = protocol.envelope_offset;
  else if (protocol.kind === 'json') envelopeStart = protocol.offset;
  else if (protocol.kind === 'grpc_web') envelopeStart = protocol.payload_offset;
  else if (protocol.kind === 'raw') envelopeStart = 0;
  else return undefined; // protobuf / thrift don't parse as JSON envelopes
  const candidate = payload.slice(envelopeStart);
  const parsed = tryParseJson(candidate);
  if (!parsed.ok) {
    if (protocol.kind === 'raw') return undefined;
    return { parse_ok: false };
  }
  const env: EnvelopeExplain = {
    parse_ok: true,
    root_type: Array.isArray(parsed.value) ? 'array' : 'object',
  };
  if (!Array.isArray(parsed.value) && parsed.value !== null && typeof parsed.value === 'object') {
    env.keys_at_depth_1 = Object.keys(parsed.value as Record<string, unknown>);
  }
  env.tree_preview = truncate(JSON.stringify(parsed.value, null, 2), TREE_PREVIEW_CAP);
  // Literal locations
  if (textAnchor && textAnchor.length > 0) {
    const locs: Array<{ json_path: string; value_preview: string }> = [];
    findLiteralInJson(parsed.value, '$', textAnchor, locs);
    if (locs.length > 0) env.literal_locations = locs;
  }
  // Nested-JSON-string fields (e.g. LS envelope's `payload` is a stringified
  // JSON).
  const nested: Array<{ json_path: string; parsed_preview: string }> = [];
  findNestedJson(parsed.value, '$', nested, 0);
  if (nested.length > 0) env.nested_json_fields = nested;
  return env;
}

function tryParseJson(s: string): { ok: true; value: unknown } | { ok: false } {
  // Strip leading XSSI prefixes and whitespace that's not part of JSON.
  const trimmed = s.replace(/^[^[{]+/, '');
  if (trimmed.length === 0) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return { ok: false };
  }
}

function findLiteralInJson(
  node: unknown,
  path: string,
  anchor: string,
  out: Array<{ json_path: string; value_preview: string }>,
): void {
  if (out.length >= 10) return;
  if (typeof node === 'string') {
    if (node.includes(anchor)) {
      out.push({ json_path: path, value_preview: truncate(node, 200) });
    }
    return;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1)
      findLiteralInJson(node[i], `${path}[${i}]`, anchor, out);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      findLiteralInJson(v, `${path}.${k}`, anchor, out);
    }
  }
}

function findNestedJson(
  node: unknown,
  path: string,
  out: Array<{ json_path: string; parsed_preview: string }>,
  depth: number,
): void {
  if (depth > MAX_NESTED_RECURSION || out.length >= 5) return;
  if (typeof node === 'string' && node.length > 4) {
    const trimmed = node.trimStart();
    if (trimmed[0] === '{' || trimmed[0] === '[') {
      try {
        const inner = JSON.parse(trimmed) as unknown;
        if (typeof inner === 'object') {
          out.push({
            json_path: path,
            parsed_preview: truncate(JSON.stringify(inner), PARSED_PREVIEW_CAP),
          });
          findNestedJson(inner, path, out, depth + 1);
          return;
        }
      } catch {
        /* not nested JSON — fall through */
      }
    }
    return;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) findNestedJson(node[i], `${path}[${i}]`, out, depth);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      findNestedJson(v, `${path}.${k}`, out, depth);
    }
  }
}

function buildHints(protocol: ProtocolDetection, envelope: EnvelopeExplain | undefined): string[] {
  const hints: string[] = [];
  if (protocol.kind === 'mqtt_publish') {
    hints.push(
      `MQTT PUBLISH frame (topic "${protocol.topic}", QoS-flag in the first byte). Header is ${protocol.header_bytes} bytes; envelope starts at offset ${protocol.envelope_offset}. To emit a frame, construct the inner JSON first, then prefix with 0x3X + varint(remaining_length) + big-endian topic + (QoS>0 ? packet_id : '') + body.`,
    );
  } else if (protocol.kind === 'grpc_web') {
    hints.push(
      `gRPC-Web frame (flag 0x${protocol.flag.toString(16).padStart(2, '0')}, length ${protocol.length}). Body is protobuf — content-type 'application/grpc-web+proto'. Payload starts at offset ${protocol.payload_offset}.`,
    );
  } else if (protocol.kind === 'protobuf_unary') {
    hints.push(
      'Protobuf frame. Fields decoded by wire type: 0=varint, 1=64-bit fixed, 2=length-delimited (strings/sub-messages), 5=32-bit fixed. Without an .proto schema the field numbers are opaque — compare byte positions across captures to infer which field carries your literal.',
    );
  } else if (protocol.kind === 'thrift_compact') {
    hints.push(
      'Thrift-compact frame. Version byte is 0x82 or 0x84 (binary/compact). Protocol docs: https://github.com/apache/thrift/blob/master/doc/specs/thrift-compact-protocol.md',
    );
  } else if (protocol.kind === 'json') {
    hints.push(
      `Plain JSON over WebSocket. Envelope starts at offset ${protocol.offset}. Emit fresh frames with JSON.stringify — no length prefix, no wire header.`,
    );
  }
  if (envelope?.nested_json_fields && envelope.nested_json_fields.length > 0) {
    hints.push(
      `Envelope contains ${envelope.nested_json_fields.length} nested-JSON-string field${envelope.nested_json_fields.length === 1 ? '' : 's'} (stringified JSON inside a JSON field, some GraphQL endpoints). When reconstructing, JSON.stringify twice for those paths.`,
    );
  }
  if (envelope?.literal_locations && envelope.literal_locations.length > 0) {
    hints.push(
      `Found the text anchor at JSON path${envelope.literal_locations.length === 1 ? '' : 's'} ${envelope.literal_locations.map((l) => l.json_path).join(', ')}. Parameterize those locations via {{placeholder}} when you save the frameFromPage expression.`,
    );
  }
  return hints;
}

function truncate(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return `${s.slice(0, cap)}… [+${s.length - cap} chars]`;
}

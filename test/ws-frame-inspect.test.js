// Unit tests for the inspect_ws_frame / find_in_ws_frame helpers —
// byte-level inspection of captured WebSocket frames so agents can
// eyeball length prefixes, topic strings, and user-literal offsets
// without writing ad-hoc scan loops inside generated.frame.code.

import test from 'node:test';
import assert from 'node:assert';

const { inspectWsPayload, findInWsPayload } = await import(
  '../dist/response/ws-frame-inspect.js'
);

// Helper: build a WebSocketFrame-style payload string (raw octets 0-255
// in a JS string, the shape the driver's capture hook produces).
function octetString(bytes) {
  return Buffer.from(bytes).toString('binary');
}

// ---- inspectWsPayload ----

test('inspectWsPayload: mixed format returns hex-dump style lines', () => {
  const payload = octetString([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0xff]);
  const r = inspectWsPayload(payload, { format: 'mixed' });
  assert.strictEqual(r.offset, 0);
  assert.strictEqual(r.length, 7);
  assert.strictEqual(r.total_length, 7);
  assert.strictEqual(r.format, 'mixed');
  assert.match(r.data, /^0000: /);
  assert.match(r.data, /48 65 6c 6c 6f/);
  assert.match(r.data, /Hello/);
});

test('inspectWsPayload: hex format is space-separated lowercase bytes', () => {
  const payload = octetString([0x00, 0x01, 0x10, 0xab, 0xff]);
  const r = inspectWsPayload(payload, { format: 'hex' });
  assert.strictEqual(r.data, '00 01 10 ab ff');
});

test('inspectWsPayload: utf8 format escapes non-printable bytes as \\xNN', () => {
  const payload = octetString([0x68, 0x69, 0x00, 0x01, 0x48]);
  const r = inspectWsPayload(payload, { format: 'utf8' });
  assert.strictEqual(r.data, 'hi\\x00\\x01H');
});

test('inspectWsPayload: utf8 format keeps tab/newline/cr as escape sequences', () => {
  const payload = octetString([0x61, 0x09, 0x62, 0x0a, 0x63, 0x0d, 0x64]);
  const r = inspectWsPayload(payload, { format: 'utf8' });
  assert.strictEqual(r.data, 'a\\tb\\nc\\rd');
});

test('inspectWsPayload: utf8 decodes multi-byte utf-8 correctly', () => {
  // "héllo" — é is 0xc3 0xa9 in utf-8.
  const payload = octetString([0x68, 0xc3, 0xa9, 0x6c, 0x6c, 0x6f]);
  const r = inspectWsPayload(payload, { format: 'utf8' });
  assert.strictEqual(r.data, 'héllo');
});

test('inspectWsPayload: utf8 falls back to \\xNN for invalid utf-8', () => {
  // 0xff 0xfe is not valid utf-8.
  const payload = octetString([0x61, 0xff, 0xfe, 0x62]);
  const r = inspectWsPayload(payload, { format: 'utf8' });
  // The high-byte run goes through TextDecoder with fatal:true, which throws,
  // so the bytes come back as \xNN escapes; the ASCII tail decodes cleanly.
  assert.strictEqual(r.data, 'a\\xff\\xfeb');
});

test('inspectWsPayload: offset skips leading bytes', () => {
  const payload = octetString([0x00, 0x01, 0x02, 0x03, 0x04]);
  const r = inspectWsPayload(payload, { offset: 2, format: 'hex' });
  assert.strictEqual(r.offset, 2);
  assert.strictEqual(r.length, 3);
  assert.strictEqual(r.total_length, 5);
  assert.strictEqual(r.data, '02 03 04');
});

test('inspectWsPayload: length clips view', () => {
  const payload = octetString([0x00, 0x01, 0x02, 0x03, 0x04]);
  const r = inspectWsPayload(payload, { length: 3, format: 'hex' });
  assert.strictEqual(r.length, 3);
  assert.strictEqual(r.total_length, 5);
  assert.strictEqual(r.data, '00 01 02');
});

test('inspectWsPayload: offset past end returns empty view with total_length', () => {
  const payload = octetString([0x00, 0x01, 0x02]);
  const r = inspectWsPayload(payload, { offset: 10, format: 'hex' });
  assert.strictEqual(r.offset, 10);
  assert.strictEqual(r.length, 0);
  assert.strictEqual(r.total_length, 3);
  assert.strictEqual(r.data, '');
});

test('inspectWsPayload: length > 4096 clamps with clamped:true flag', () => {
  const bytes = new Array(5000).fill(0x41);
  const payload = octetString(bytes);
  const r = inspectWsPayload(payload, { length: 10000, format: 'hex' });
  assert.strictEqual(r.length, 4096);
  assert.strictEqual(r.total_length, 5000);
  assert.strictEqual(r.clamped, true);
});

test('inspectWsPayload: length within cap does not set clamped', () => {
  const bytes = new Array(2000).fill(0x41);
  const payload = octetString(bytes);
  const r = inspectWsPayload(payload, { length: 2000, format: 'hex' });
  assert.strictEqual(r.length, 2000);
  assert.strictEqual(r.clamped, undefined);
});

test('inspectWsPayload: empty frame returns length:0', () => {
  const r = inspectWsPayload('', { format: 'mixed' });
  assert.strictEqual(r.offset, 0);
  assert.strictEqual(r.length, 0);
  assert.strictEqual(r.total_length, 0);
  assert.strictEqual(r.data, '');
});

test('inspectWsPayload: default format is mixed', () => {
  const payload = octetString([0x41, 0x42]);
  const r = inspectWsPayload(payload, {});
  assert.strictEqual(r.format, 'mixed');
});

test('inspectWsPayload: mixed format shows offset column when offset is non-zero', () => {
  const payload = octetString([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
  const r = inspectWsPayload(payload, { offset: 2, format: 'mixed' });
  // offset column should read 0002 for the start of the view
  assert.match(r.data, /^0002: /);
});

// ---- findInWsPayload ----

test('findInWsPayload: single match returns single offset', () => {
  const payload = octetString([0x00, 0x01, 0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x00]);
  const r = findInWsPayload(payload, 'Hello');
  assert.deepStrictEqual(r.offsets, [2]);
  assert.strictEqual(r.total_length, 8);
  assert.strictEqual(r.truncated, undefined);
});

test('findInWsPayload: multiple matches returns all offsets in order', () => {
  const payload = octetString(
    [...'abc', 0, 0, ...'abc', 0, ...'abc'].map((c) =>
      typeof c === 'string' ? c.charCodeAt(0) : c,
    ),
  );
  const r = findInWsPayload(payload, 'abc');
  assert.deepStrictEqual(r.offsets, [0, 5, 9]);
});

test('findInWsPayload: needle not found returns empty offsets', () => {
  const payload = octetString([0x01, 0x02, 0x03]);
  const r = findInWsPayload(payload, 'zzz');
  assert.deepStrictEqual(r.offsets, []);
  assert.strictEqual(r.total_length, 3);
});

test('findInWsPayload: empty needle returns empty offsets (not truncated)', () => {
  const payload = octetString([0x01, 0x02, 0x03]);
  const r = findInWsPayload(payload, '');
  assert.deepStrictEqual(r.offsets, []);
  assert.strictEqual(r.truncated, undefined);
});

test('findInWsPayload: truncates at 32 offsets and sets truncated:true', () => {
  const bytes = [];
  // 40 copies of "x" separated by zero bytes — more than the 32 cap.
  for (let i = 0; i < 40; i += 1) {
    bytes.push(0x78, 0x00);
  }
  const payload = octetString(bytes);
  const r = findInWsPayload(payload, 'x');
  assert.strictEqual(r.offsets.length, 32);
  assert.strictEqual(r.truncated, true);
});

test('findInWsPayload: utf-8 needle matches utf-8-encoded bytes in payload', () => {
  // Payload contains "héllo" in utf-8; needle "é" must match at byte offset 1.
  const payload = octetString([0x68, 0xc3, 0xa9, 0x6c, 0x6c, 0x6f]);
  const r = findInWsPayload(payload, 'é');
  assert.deepStrictEqual(r.offsets, [1]);
});

test('findInWsPayload: needle longer than payload returns empty', () => {
  const payload = octetString([0x68, 0x69]);
  const r = findInWsPayload(payload, 'long needle here');
  assert.deepStrictEqual(r.offsets, []);
  assert.strictEqual(r.total_length, 2);
});

test('findInWsPayload: overlapping matches are all reported', () => {
  // "aaaa" with needle "aa" matches at 0, 1, 2.
  const payload = octetString([0x61, 0x61, 0x61, 0x61]);
  const r = findInWsPayload(payload, 'aa');
  assert.deepStrictEqual(r.offsets, [0, 1, 2]);
});

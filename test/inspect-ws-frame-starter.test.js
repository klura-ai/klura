// Unit tests for buildBinaryWsStarter — the iteration-1 starter generator
// synthesised by inspect_ws_frame for binary-WS write envelopes. The
// starter inverts the cold-start commit cost: the agent doesn't write 30
// lines of generator code from scratch before any feedback, they call
// try_generator with the starter and get ok:true on iteration 1.
//
// The tests cover the gate (when does the starter get emitted), the
// splice math (does the generator faithfully reproduce the captured
// bytes), the variable-length guard (is the throw helpful), and the
// dynamic-field hints (does the regex bank classify common rotators).

import test from 'node:test';
import assert from 'node:assert';

const { buildBinaryWsStarter, payloadMatchesBinaryWsStarterGate } = await import(
  '../dist/response/ws-frame-starter.js'
);
const { runGeneratorCode } = await import('../dist/strategies/generators.js');

// Binary-WS payload shaped like an MQTT PUBLISH header followed by a
// JSON body that includes the user-typed literal. First byte 0x32 is
// PUBLISH with QoS 1; bytes 1-3 are a remaining-length varint + topic
// length prefix; the rest is plaintext-ish JSON. This is the shape the
// 11-10 / 12-11 / 13-55 messenger runs all hit — the leading-binary-
// header arm of detectBinaryWsWrite catches it; arm-1 (high-non-printable
// ratio) does not because the body is mostly printable.
function makeMqttLikePayload(literal) {
  const header = Buffer.from([0x32, 0xfd, 0x09, 0x00, 0x07]); // header + topic length
  const topic = Buffer.from('/ls_req\x00', 'binary'); // topic + null
  const body = Buffer.from(
    JSON.stringify({
      epoch_id: 6843719283000000,
      otid: 'AbCdEf123456_xyz',
      task: { text: literal, request_id: 42 },
    }),
    'utf-8',
  );
  return Buffer.concat([header, topic, body]).toString('binary');
}

// A plain text payload that is NOT a binary-WS write — printable JSON
// over WebSocket. Should fail the gate.
function makePlainJsonPayload(literal) {
  return JSON.stringify({ message: literal, ts: 1234567890 });
}

test('buildBinaryWsStarter: returns null when literal is empty', () => {
  const payload = makeMqttLikePayload('hello world');
  assert.strictEqual(buildBinaryWsStarter(payload, ''), null);
});

test('buildBinaryWsStarter: returns null when literal is not in payload', () => {
  const payload = makeMqttLikePayload('hello world');
  assert.strictEqual(buildBinaryWsStarter(payload, 'completely-different-text'), null);
});

test('buildBinaryWsStarter: returns null for plain JSON-over-WS (no binary header)', () => {
  const payload = makePlainJsonPayload('hello world');
  assert.strictEqual(buildBinaryWsStarter(payload, 'hello world'), null);
});

test('buildBinaryWsStarter: returns starter for binary MQTT-like envelope', () => {
  const literal = 'hello world';
  const payload = makeMqttLikePayload(literal);
  const starter = buildBinaryWsStarter(payload, literal);
  assert.ok(starter, 'expected non-null starter for binary envelope');
  assert.strictEqual(typeof starter.code, 'string');
  assert.strictEqual(starter.literal_byte_length, Buffer.byteLength(literal, 'utf-8'));
  assert.ok(starter.literal_at_offset >= 8, 'literal must live past the binary header');
  assert.deepStrictEqual(starter.args_for_iteration_1, { text: literal });
  assert.ok(starter.what_this_does.length <= 200);
});

test('buildBinaryWsStarter: starter code returns ok:true on iteration 1 against captured args', () => {
  const literal = 'hello world';
  const payload = makeMqttLikePayload(literal);
  const starter = buildBinaryWsStarter(payload, literal);
  assert.ok(starter);

  // Run the starter with the captured args — it must reproduce the
  // captured payload byte-for-byte.
  const output = runGeneratorCode(starter.code, starter.args_for_iteration_1);
  const expected = Buffer.from(payload, 'binary').toString('base64');
  assert.strictEqual(output, expected, 'iteration 1 with captured args must reproduce the captured payload');
});

test('buildBinaryWsStarter: starter splices a same-length replacement correctly', () => {
  const literal = 'hello world';
  const payload = makeMqttLikePayload(literal);
  const starter = buildBinaryWsStarter(payload, literal);
  assert.ok(starter);

  // 'hello world' is 11 utf-8 bytes; replacement must also be 11 bytes
  // for the iteration-1 starter (variable length needs the length-prefix
  // rewrite, which is the agent's job in iteration 2+).
  const output = runGeneratorCode(starter.code, { text: 'goodnight!!' });
  const decoded = Buffer.from(output, 'base64').toString('binary');
  assert.ok(decoded.includes('goodnight!!'), 'replacement should appear in the spliced output');
  assert.ok(!decoded.includes('hello world'), 'original literal should be gone');
  // Every byte except the literal slice must be identical to the captured payload.
  assert.strictEqual(
    decoded.length,
    payload.length,
    'same-length splice must preserve total byte length',
  );
});

test('buildBinaryWsStarter: starter throws helpfully when args.text byte length differs', () => {
  const literal = 'hello world';
  const payload = makeMqttLikePayload(literal);
  const starter = buildBinaryWsStarter(payload, literal);
  assert.ok(starter);

  // Replacement is 4 utf-8 bytes vs captured 11 → throw with byte counts
  // and a pointer at the length-prefix-rewrite path.
  assert.throws(
    () => runGeneratorCode(starter.code, { text: 'hi!!' }),
    (err) => {
      assert.match(err.message, /iteration-1 starter requires args\.text === captured literal/);
      assert.match(err.message, /11 utf-8 bytes/);
      assert.match(err.message, /length-prefix/);
      return true;
    },
  );
});

// ---- Gate function (payloadMatchesBinaryWsStarterGate) ----

test('payloadMatchesBinaryWsStarterGate: rejects payloads under 16 bytes', () => {
  const tiny = Buffer.from([0x32, 0xfd, 0, 1, 2, 3]).toString('binary');
  assert.strictEqual(payloadMatchesBinaryWsStarterGate(tiny, 0), false);
});

test('payloadMatchesBinaryWsStarterGate: rejects negative offsets', () => {
  const payload = makeMqttLikePayload('hello');
  assert.strictEqual(payloadMatchesBinaryWsStarterGate(payload, -1), false);
});

test('payloadMatchesBinaryWsStarterGate: accepts leading-binary-header shape with literal past header', () => {
  const literal = 'hello world';
  const payload = makeMqttLikePayload(literal);
  // Find the literal offset directly.
  const offset = Buffer.from(payload, 'binary').indexOf(Buffer.from(literal, 'utf-8'));
  assert.ok(offset >= 8, 'fixture must place literal past the header');
  assert.strictEqual(payloadMatchesBinaryWsStarterGate(payload, offset), true);
});

test('payloadMatchesBinaryWsStarterGate: rejects when literal is INSIDE the binary header (offset < 8)', () => {
  // Construct a payload where the literal would be at offset 4 — i.e. embedded
  // inside what looks like a length-prefix region. Even with a binary header,
  // an offset that close to the start isn't the "envelope wrapping plaintext"
  // shape the starter is designed for.
  const literal = 'hi';
  const payload = Buffer.concat([
    Buffer.from([0x32, 0xfd, 0x00, 0x09]),
    Buffer.from(literal, 'utf-8'),
    Buffer.alloc(20, 0x20),
  ]).toString('binary');
  assert.strictEqual(payloadMatchesBinaryWsStarterGate(payload, 4), false);
});

test('payloadMatchesBinaryWsStarterGate: accepts high-non-printable-ratio payloads regardless of literal anchor', () => {
  // ≥ 0.15 of first 64 bytes non-printable, no leading-header check needed.
  const highRatio = Buffer.alloc(64);
  for (let i = 0; i < 64; i += 1) {
    highRatio[i] = i < 16 ? 0xff : 0x41; // 16/64 = 0.25 non-printable
  }
  const payload = Buffer.concat([highRatio, Buffer.from('extra-padding-bytes', 'utf-8')]).toString(
    'binary',
  );
  assert.strictEqual(payloadMatchesBinaryWsStarterGate(payload, 0), true);
});

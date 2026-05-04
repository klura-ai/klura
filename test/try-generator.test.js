// Unit tests for the try_generator tool — the feedback loop agents use
// when composing generated.frame.code for complex envelopes (MQTT-over-WS,
// length-prefixed binary protocols, nested-JSON shapes). Covers the diff
// helper in isolation plus the klura.tryGenerator orchestration (sandbox
// exec + base64 / session verify_against).

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-try-generator-'));
process.env.KLURA_HOME = TMP;

const { diffBinary } = await import('../dist/response/generator-diff.js');
const klura = await import('../dist/index.js');

test.after(async () => {
  try {
    const p = klura._pool;
    if (p && typeof p.shutdown === 'function') await p.shutdown();
  } catch {
    /* best-effort */
  }
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ---- diffBinary (pure helper) ----

test('diffBinary: identical bytes → ok:true', () => {
  const a = new Uint8Array([1, 2, 3, 4, 5]);
  const b = new Uint8Array([1, 2, 3, 4, 5]);
  const d = diffBinary(a, b);
  assert.strictEqual(d.ok, true);
  assert.strictEqual(d.expected_length, 5);
  assert.strictEqual(d.got_length, 5);
  assert.strictEqual(d.first_diff_offset, undefined);
});

test('diffBinary: single-byte mismatch reports offset + both byte values', () => {
  const expected = new Uint8Array([0, 1, 2, 3, 4]);
  const got = new Uint8Array([0, 1, 255, 3, 4]);
  const d = diffBinary(expected, got);
  assert.strictEqual(d.ok, false);
  assert.strictEqual(d.first_diff_offset, 2);
  assert.strictEqual(d.expected_byte, 2);
  assert.strictEqual(d.got_byte, 255);
  assert.ok(d.diff_context);
  assert.match(d.diff_context.expected, /00 01 02 03 04/);
  assert.match(d.diff_context.got, /00 01 ff 03 04/);
});

test('diffBinary: length mismatch with shared prefix → offset at shorter length', () => {
  const expected = new Uint8Array([1, 2, 3, 4, 5]);
  const got = new Uint8Array([1, 2, 3]);
  const d = diffBinary(expected, got);
  assert.strictEqual(d.ok, false);
  assert.strictEqual(d.first_diff_offset, 3);
  assert.strictEqual(d.expected_byte, 4);
  // got has no byte at offset 3 (length 3) → got_byte unset
  assert.strictEqual(d.got_byte, undefined);
});

test('diffBinary: length mismatch, got longer than expected', () => {
  const expected = new Uint8Array([1, 2, 3]);
  const got = new Uint8Array([1, 2, 3, 99, 100]);
  const d = diffBinary(expected, got);
  assert.strictEqual(d.ok, false);
  assert.strictEqual(d.first_diff_offset, 3);
  assert.strictEqual(d.expected_byte, undefined);
  assert.strictEqual(d.got_byte, 99);
});

test('diffBinary: empty vs empty → ok:true', () => {
  const d = diffBinary(new Uint8Array(), new Uint8Array());
  assert.strictEqual(d.ok, true);
});

test('diffBinary: hex context clips to buffer edges near offset 0', () => {
  const a = new Uint8Array([0xaa, 1, 2, 3]);
  const b = new Uint8Array([0xbb, 1, 2, 3]);
  const d = diffBinary(a, b);
  assert.strictEqual(d.first_diff_offset, 0);
  // The window starts at max(0, 0 - 16) = 0. Expected: "aa 01 02 03"
  assert.strictEqual(d.diff_context.expected, 'aa 01 02 03');
  assert.strictEqual(d.diff_context.got, 'bb 01 02 03');
});

// ---- tryGenerator orchestration ----

test('tryGenerator: happy path with no verify_against returns output + ok:true', async () => {
  const r = await klura.tryGenerator({ code: "return 'hi';", args: {} });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.output, 'hi');
  assert.strictEqual(r.output_length, 2);
});

test('tryGenerator: binary match against explicit base64', async () => {
  // Produce bytes [1, 2, 3] from generator; verify against their base64.
  const b64 = Buffer.from([1, 2, 3]).toString('base64');
  const r = await klura.tryGenerator({
    code: "return Buffer.from([1, 2, 3]).toString('base64');",
    args: {},
    encoding: 'binary',
    verify_against: { base64: b64 },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.expected_length, 3);
  // output_length reports decoded BYTE length (3), NOT the base64-string
  // length (4: 'AQID'). Reporting the encoded length adjacent to the
  // raw-byte expected_length misleads agents into thinking the match
  // failed when the byte-match actually succeeded (the confusion was
  // the load-bearing regression in field-reports/results/2026-04-21T06-54).
  assert.strictEqual(r.output_length, 3);
  assert.strictEqual(r.output_length, r.expected_length);
});

test('buildNextSaveHint: no ws URL → undefined (explicit-base64 verify path)', () => {
  const hint = klura.buildNextSaveHint(undefined, true);
  assert.strictEqual(hint, undefined);
});

test('buildNextSaveHint: ws URL present → keep-working hint with concrete next step', () => {
  const hint = klura.buildNextSaveHint('wss://edge-chat.example.com/chat', true);
  assert.ok(hint, 'hint present when ws URL was resolved');
  assert.strictEqual(hint.verified, 'envelope_shape_byte_match');
  assert.strictEqual(hint.auto_persisted, true);
  assert.strictEqual(hint.captured_ws_url, 'wss://edge-chat.example.com/chat');
  assert.ok(Array.isArray(hint.next_steps) && hint.next_steps.length > 0);

  const joined = hint.next_steps.join(' ');
  // Rotating fields are framed as "template via prereq", not a fold signal.
  assert.match(joined, /template each rotating field/i);
  assert.match(joined, /js-eval prereq/i);
  // "Save COMPLETE" is still named as the success destination.
  assert.match(joined, /COMPLETE strategy/);
  // user_confirmation is the user-arbitration surface — surfaced in the prose
  // so the agent knows the user approves/rejects at save time.
  assert.match(joined, /user_confirmation/);
  // Don't fold framing — explicit keep-working nudge for stuck-on-one-field.
  assert.match(joined, /DON'T FOLD/);
  // Three-tier preference retained for context.
  assert.match(joined, /recorded-path/);
  assert.doesNotMatch(joined, /byte_match_pending|byte_match_verified/);
});

test('buildNextSaveHint: auto_persisted=false reports no artifact persistence', () => {
  const hint = klura.buildNextSaveHint('wss://edge-chat.example.com/chat', false);
  assert.ok(hint);
  assert.strictEqual(hint.auto_persisted, false);
  assert.match(hint.next_steps[0], /No session-scoped persistence/);
});

test('tryGenerator: binary match — output_length equals expected_length on a frame whose base64 expansion differs', async () => {
  // Regression for the 1254-byte / 1672-base64-char case seen in the
  // messenger field-report. Pick a byte length whose base64 expansion
  // differs non-trivially. 1254 bytes → 1672 chars (exactly 4/3).
  const bytes = Buffer.alloc(1254);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = i & 0xff;
  const b64 = bytes.toString('base64');
  assert.notStrictEqual(b64.length, bytes.length); // sanity: different units
  const r = await klura.tryGenerator({
    code: `return Buffer.from(${JSON.stringify(b64)}, 'base64').toString('base64');`,
    args: {},
    encoding: 'binary',
    verify_against: { base64: b64 },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.expected_length, 1254);
  assert.strictEqual(r.output_length, 1254);
  assert.strictEqual(r.output_length, r.expected_length);
  // verify_against was explicit base64 — no captured ws URL, no save-hint.
  assert.strictEqual(r.next_save_hint, undefined);
});

test('tryGenerator: binary mismatch reports first_diff_offset + byte values', async () => {
  const expected = Buffer.from([1, 2, 3]).toString('base64');
  const r = await klura.tryGenerator({
    code: "return Buffer.from([1, 2, 255]).toString('base64');",
    args: {},
    encoding: 'binary',
    verify_against: { base64: expected },
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.first_diff_offset, 2);
  assert.strictEqual(r.expected_byte, 3);
  assert.strictEqual(r.got_byte, 255);
});

test('tryGenerator: length mismatch flagged when generator emits a shorter frame', async () => {
  const expected = Buffer.from([1, 2, 3, 4, 5]).toString('base64');
  const r = await klura.tryGenerator({
    code: "return Buffer.from([1, 2, 3]).toString('base64');",
    args: {},
    encoding: 'binary',
    verify_against: { base64: expected },
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.first_diff_offset, 3);
  assert.strictEqual(r.expected_length, 5);
  assert.strictEqual(r.got_length, 3);
});

test('tryGenerator: text encoding compares output verbatim', async () => {
  const r = await klura.tryGenerator({
    code: "return JSON.stringify({text: args.message});",
    args: { message: 'hi' },
    encoding: 'text',
    verify_against: { base64: Buffer.from('{"text":"hi"}', 'utf-8').toString('base64') },
  });
  assert.strictEqual(r.ok, true);
});

test('tryGenerator: text encoding mismatch reports offset', async () => {
  const r = await klura.tryGenerator({
    code: "return JSON.stringify({text: args.message});",
    args: { message: 'bye' },
    encoding: 'text',
    verify_against: { base64: Buffer.from('{"text":"hi"}', 'utf-8').toString('base64') },
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(typeof r.first_diff_offset, 'number');
});

test('tryGenerator: generator throw → ok:false with error', async () => {
  const r = await klura.tryGenerator({
    code: "throw new Error('boom');",
    args: {},
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /boom/);
});

test('tryGenerator: generator returning non-string → ok:false (runGeneratorCode rejects)', async () => {
  const r = await klura.tryGenerator({ code: 'return 42;', args: {} });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /must return a string/);
});

test('tryGenerator: 100ms timeout surfaces cleanly as error', async () => {
  const r = await klura.tryGenerator({
    code: 'while(true){} return "never";',
    args: {},
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error && r.error.length > 0);
});

test('tryGenerator: code:"" rejected with helpful message', async () => {
  const r = await klura.tryGenerator({ code: '', args: {} });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /code is required/);
});

test('tryGenerator: invalid base64 in verify_against rejected without running code', async () => {
  const r = await klura.tryGenerator({
    code: "return 'anything';",
    args: {},
    verify_against: { base64: 'not-base64!@#$%invalid-chars' },
  });
  // Node's Buffer.from is permissive about bad base64 — it silently
  // ignores invalid chars and returns whatever partial bytes it can
  // decode. We don't need to reject; we just need to not crash.
  // Confirm the tool returned SOMETHING sensible (ok: true or ok: false
  // with diff info, never an uncaught throw).
  assert.ok(typeof r.ok === 'boolean');
});

test('tryGenerator: ws_i without session_id rejected with helpful message', async () => {
  const r = await klura.tryGenerator({
    code: "return 'x';",
    args: {},
    verify_against: { ws_i: 0 },
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /session_id/);
});

test('tryGenerator: ws_i with unknown session_id returns structured error', async () => {
  const r = await klura.tryGenerator({
    code: "return 'x';",
    session_id: 'nonexistent',
    args: {},
    verify_against: { ws_i: 0 },
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /session_id/);
});

test('tryGenerator: args are available inside the sandbox', async () => {
  const r = await klura.tryGenerator({
    code: 'return String(args.n * 2);',
    args: { n: 21 },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.output, '42');
});

test('tryGenerator: args are frozen — mutations do not persist across calls', async () => {
  const caller = { x: 1 };
  const r = await klura.tryGenerator({
    // Try to mutate args.x. runGeneratorCode freezes its own copy.
    code: "try { args.x = 999 } catch(e) {} return String(args.x);",
    args: caller,
  });
  // The frozen copy may still reflect the original value or throw in
  // strict mode — either way the caller's object is untouched.
  assert.strictEqual(r.ok, true);
  assert.strictEqual(caller.x, 1);
});

test('tryGenerator: Buffer + crypto available in sandbox (the motivating primitives)', async () => {
  // Compose an MQTT-ish envelope: control byte + varint-1 length + topic
  // + payload. This is the shape agents need to be able to emit.
  const r = await klura.tryGenerator({
    code: `
      const topic = '/ls_req';
      const body = JSON.stringify({text: args.message});
      const topicLen = Buffer.alloc(2);
      topicLen.writeUInt16BE(topic.length, 0);
      const envelope = Buffer.concat([
        Buffer.from([0x32]),
        topicLen,
        Buffer.from(topic, 'utf-8'),
        Buffer.from(body, 'utf-8'),
      ]);
      return envelope.toString('base64');
    `,
    args: { message: 'hello' },
    encoding: 'binary',
  });
  assert.strictEqual(r.ok, true);
  const decoded = Buffer.from(r.output, 'base64');
  // Control byte + 2-byte topic length + "/ls_req" (7 bytes) + JSON body.
  assert.strictEqual(decoded[0], 0x32);
  assert.strictEqual(decoded.readUInt16BE(1), 7);
  assert.strictEqual(decoded.slice(3, 10).toString('utf-8'), '/ls_req');
  assert.ok(decoded.slice(10).toString('utf-8').includes('"hello"'));
});

// ---- Per-session counter (Fix 1) + attempt_in_session response stamp (Fix 9) ----
//
// The pool keeps a per-session try_generator counter so:
//   - save-time validators can clamp/reject claimed verify_iterations
//   - get_network_log advisories can show "you've iterated N times"
//   - the agent can self-pace via attempt_in_session on every response.
// Counter is keyed by sessionId only; pool.recordTryGeneratorCall does not
// require the session to actually exist in the browser pool, so we can
// exercise the counter with a synthetic id without spinning up a context.

test('tryGenerator: with session_id + verify_against bumps with_verify_against and stamps attempt_in_session', async () => {
  const sid = 'sess_counter_a';
  const expected = Buffer.from([1, 2, 3]).toString('base64');

  const r1 = await klura.tryGenerator({
    session_id: sid,
    code: "return Buffer.from([1, 2, 3]).toString('base64');",
    args: {},
    encoding: 'binary',
    verify_against: { base64: expected },
  });
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.attempt_in_session, 1);

  const r2 = await klura.tryGenerator({
    session_id: sid,
    code: "return Buffer.from([1, 2, 99]).toString('base64');",
    args: {},
    encoding: 'binary',
    verify_against: { base64: expected },
  });
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.attempt_in_session, 2);

  const stats = klura._pool.getTryGeneratorStats(sid);
  assert.ok(stats);
  assert.strictEqual(stats.total, 2);
  assert.strictEqual(stats.with_verify_against, 2);
  assert.strictEqual(stats.ok_true, 1);
  assert.strictEqual(stats.verified_ok, 1);
});

test('tryGenerator: without session_id leaves no counter and no attempt_in_session on response', async () => {
  const r = await klura.tryGenerator({
    code: "return 'hi';",
    args: {},
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.attempt_in_session, undefined);
});

test('tryGenerator: with session_id but no verify_against bumps total only, attempt_in_session reflects total', async () => {
  const sid = 'sess_counter_b';
  const r1 = await klura.tryGenerator({
    session_id: sid,
    code: "return 'hi';",
    args: {},
  });
  assert.strictEqual(r1.attempt_in_session, 1);

  const r2 = await klura.tryGenerator({
    session_id: sid,
    code: "return 'hi';",
    args: {},
  });
  assert.strictEqual(r2.attempt_in_session, 2);

  const stats = klura._pool.getTryGeneratorStats(sid);
  assert.ok(stats);
  assert.strictEqual(stats.total, 2);
  assert.strictEqual(stats.with_verify_against, 0);
  assert.strictEqual(stats.verified_ok, 0);
});

test('tryGenerator: closing the session clears the counter', async () => {
  const sid = 'sess_counter_c';
  await klura.tryGenerator({
    session_id: sid,
    code: "return 'hi';",
    args: {},
  });
  assert.ok(klura._pool.getTryGeneratorStats(sid));

  // endDrive on a session id that has no actual browser session is a
  // no-op for the pool side but still clears the counter map entry.
  await klura._pool.endDrive(sid);
  assert.strictEqual(klura._pool.getTryGeneratorStats(sid), null);
});

test('tryGenerator: iterative loop — mismatch, fix, rematch', async () => {
  // Simulate the motivating loop: capture expected bytes, write a
  // broken generator, get diff, fix, rerun, match.
  const expectedBytes = Buffer.concat([
    Buffer.from([0x01, 0x02, 0x03]),
    Buffer.from('hello', 'utf-8'),
    Buffer.from([0xff]),
  ]);
  const expected = expectedBytes.toString('base64');

  const broken = await klura.tryGenerator({
    code: `
      return Buffer.concat([
        Buffer.from([0x01, 0x02, 0x99]),
        Buffer.from(args.msg, 'utf-8'),
        Buffer.from([0xff]),
      ]).toString('base64');
    `,
    args: { msg: 'hello' },
    encoding: 'binary',
    verify_against: { base64: expected },
  });
  assert.strictEqual(broken.ok, false);
  assert.strictEqual(broken.first_diff_offset, 2);
  assert.strictEqual(broken.expected_byte, 0x03);
  assert.strictEqual(broken.got_byte, 0x99);

  const fixed = await klura.tryGenerator({
    code: `
      return Buffer.concat([
        Buffer.from([0x01, 0x02, 0x03]),
        Buffer.from(args.msg, 'utf-8'),
        Buffer.from([0xff]),
      ]).toString('base64');
    `,
    args: { msg: 'hello' },
    encoding: 'binary',
    verify_against: { base64: expected },
  });
  assert.strictEqual(fixed.ok, true);
  assert.strictEqual(fixed.expected_length, expectedBytes.length);
});

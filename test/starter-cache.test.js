// Unit tests for the starter cache — the per-session memory of binary-WS
// starters issued by inspect_ws_frame. Used by tryGenerator's runtime_hint
// to detect the starter-ignore anti-pattern (agent inspects, gets a free
// iteration-1 generator, then writes their own from scratch).

import test from 'node:test';
import assert from 'node:assert';

const {
  recordStarterIssued,
  findIssuedStarter,
  codeReferencesStarter,
  clearStartersForSession,
} = await import('../dist/response/starter-cache.js');

const SESSION = 'test-session-1';

function makeStarter(prefix = 'AAAAAAAA') {
  return {
    code: `const captured = Buffer.from('${prefix}MoreOfThisIsTheCapturedBase64DataAtLeast64Chars==', 'base64');\n// rest`,
    args_for_iteration_1: { text: 'hello' },
    literal_at_offset: 50,
    literal_byte_length: 5,
    what_this_does: 'splice',
  };
}

test('starter-cache: records and retrieves by ws_i', () => {
  clearStartersForSession(SESSION);
  recordStarterIssued(SESSION, 471, 'hello', makeStarter());
  const found = findIssuedStarter(SESSION, 471);
  assert.ok(found);
  assert.strictEqual(found.ws_i, 471);
  assert.strictEqual(found.literal, 'hello');
  assert.ok(found.base64_head.length > 0);
});

test('starter-cache: returns null for unknown session', () => {
  assert.strictEqual(findIssuedStarter('never-seen', 0), null);
});

test('starter-cache: returns null for unknown ws_i', () => {
  clearStartersForSession(SESSION);
  recordStarterIssued(SESSION, 100, 'hi', makeStarter());
  assert.strictEqual(findIssuedStarter(SESSION, 999), null);
});

test('starter-cache: re-recording the same ws_i replaces the entry', () => {
  clearStartersForSession(SESSION);
  recordStarterIssued(SESSION, 50, 'first', makeStarter('FirstFFFF'));
  recordStarterIssued(SESSION, 50, 'second', makeStarter('SecondSSS'));
  const found = findIssuedStarter(SESSION, 50);
  assert.strictEqual(found.literal, 'second');
});

test('starter-cache: clearStartersForSession drops all entries', () => {
  recordStarterIssued(SESSION, 1, 'x', makeStarter());
  recordStarterIssued(SESSION, 2, 'y', makeStarter());
  clearStartersForSession(SESSION);
  assert.strictEqual(findIssuedStarter(SESSION, 1), null);
  assert.strictEqual(findIssuedStarter(SESSION, 2), null);
});

test('codeReferencesStarter: true when code embeds the captured-base64 head', () => {
  clearStartersForSession(SESSION);
  const starter = makeStarter('UniqueHead12345');
  recordStarterIssued(SESSION, 42, 'hi', starter);
  const entry = findIssuedStarter(SESSION, 42);
  // Code that splices using the captured base64 — same prefix as the starter
  const code = `const captured = Buffer.from('UniqueHead12345MoreOfThisIsTheCapturedBase64DataAtLeast64Chars==', 'base64');\nreturn captured.toString('base64');`;
  assert.strictEqual(codeReferencesStarter(code, entry), true);
});

test('codeReferencesStarter: false when agent wrote a fresh generator', () => {
  clearStartersForSession(SESSION);
  recordStarterIssued(SESSION, 42, 'hi', makeStarter('UniqueHead12345'));
  const entry = findIssuedStarter(SESSION, 42);
  const code = `const buf = Buffer.alloc(100); buf[0] = 0x32; return buf.toString('base64');`;
  assert.strictEqual(codeReferencesStarter(code, entry), false);
});

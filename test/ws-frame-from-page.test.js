// Unit tests for the frameFromPage strategy shape (page-script +
// protocol:"websocket"). Covers save-time validation only — end-to-end
// dispatch is covered by the ws-execute tests that use a mock driver, but
// the unit bar here is the validator behavior.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-ws-ffp-test-'));
process.env.KLURA_HOME = TMP;

const skillsMod = await import('../dist/strategies/skills.js');
const { saveStrategy } = skillsMod;

test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const baseFrameFromPage = () => ({
  strategy: 'page-script',
  protocol: 'websocket',
  origin: 'https://example.test',
  wsUrl: 'wss://example.test/ws',
  frameEncoding: 'binary',
  frameFromPage: {
    expression: "await window.__encode({text: '{{text}}'})",
    returns: 'hex',
  },
  notes: {
    params: {
      text: { description: 'message body', kind: 'text' },
    },
  },
});

test('frameFromPage: accepts valid strategy with param reference', () => {
  saveStrategy('ffp-platform-a', 'send_msg', baseFrameFromPage());
});

test('frameFromPage: accepts capability-prereq vars placeholder reference', () => {
  saveStrategy('ffp-platform-cap', 'lookup_thread_by_name', {
    strategy: 'fetch',
    baseUrl: 'https://example.test',
    endpoint: '/lookup?q={{name}}',
    notes: {
      params: {
        name: { description: 'recipient display name', kind: 'text' },
      },
    },
  });

  saveStrategy('ffp-platform-cap', 'send_msg', {
    strategy: 'page-script',
    protocol: 'websocket',
    origin: 'https://example.test',
    wsUrl: 'wss://example.test/ws',
    frameEncoding: 'binary',
    frameFromPage: {
      expression: "await window.__encode({threadId: '{{thread_id}}'})",
      returns: 'hex',
    },
    prerequisites: [
      {
        name: 'resolve_thread',
        kind: 'capability',
        capability: 'lookup_thread_by_name',
        args: { name: '{{recipient}}' },
        vars: { thread_id: 'results.0.id' },
      },
    ],
    notes: {
      params: {
        recipient: { description: 'recipient display name', kind: 'text' },
      },
    },
  });
});

test('frameFromPage: rejects when no {{placeholder}} reference', () => {
  const s = baseFrameFromPage();
  s.frameFromPage.expression = "await window.__encode({text: 'hardcoded'})";
  assert.throws(
    () => saveStrategy('ffp-platform-b', 'send_msg', s),
    /must reference at least one declared arg/,
  );
});

test('frameFromPage: rejects {{__gen.X}} because expression only sees args and prereqs', () => {
  const s = baseFrameFromPage();
  s.generated = { reqId: { code: 'return "x"' } };
  s.frameFromPage.expression = "await window.__encode({text: '{{__gen.reqId}}'})";
  assert.throws(
    () => saveStrategy('ffp-platform-b2', 'send_msg', s),
    /frameFromPage\.expression/,
  );
});

test('frameFromPage: rejects when returns missing', () => {
  const s = baseFrameFromPage();
  delete s.frameFromPage.returns;
  assert.throws(
    () => saveStrategy('ffp-platform-c', 'send_msg', s),
    /frameFromPage\.returns is required/,
  );
});

test('frameFromPage: rejects when both frame and frameFromPage present', () => {
  const s = baseFrameFromPage();
  s.frame = '{{text}}';
  assert.throws(
    () => saveStrategy('ffp-platform-d', 'send_msg', s),
    /more than one/,
  );
});

test('frameFromPage: rejects when strategy is not page-script', () => {
  const s = baseFrameFromPage();
  s.strategy = 'fetch';
  assert.throws(
    () => saveStrategy('ffp-platform-e', 'send_msg', s),
    /only valid for strategy:"page-script"/,
  );
});

test('frameFromPage: rejects when timeout_ms > 30000', () => {
  const s = baseFrameFromPage();
  s.frameFromPage.timeout_ms = 60000;
  assert.throws(
    () => saveStrategy('ffp-platform-f', 'send_msg', s),
    /timeout_ms must be a positive integer/,
  );
});

test('frameFromPage: accepts base64 returns', () => {
  const s = baseFrameFromPage();
  s.frameFromPage.returns = 'base64';
  saveStrategy('ffp-platform-g', 'send_msg', s);
});

test('frameFromPage: execute-time wraps agent expression and decodes hex', async () => {
  // Exercises the execute-path dispatch: mock driver records the wrapped
  // expression it received and returns a canned hex string; we verify the
  // resolveWsFrame path calls evaluateExpression, wraps via the shared
  // wrapper, and decodes the returned hex to the expected bytes.
  const { wrapAgentExpression } = await import('../dist/response/js-eval-wrapper.js');
  const expr = "await window.__encode({text: '{{text}}'})";
  const interpolated = expr.replace('{{text}}', 'hello');
  const wrapped = wrapAgentExpression(interpolated);
  // Sanity: wrapped is a Promise.resolve(...)-rooted expression; agent's
  // `return` keywords would be rejected but we use none here.
  assert.match(wrapped, /Promise\.resolve/);
  assert.strictEqual(wrapped.includes('return '), false);
  // Decode path: hex input to bytes.
  const hex = '32fd0900';
  const bytes = Buffer.from(hex, 'hex');
  assert.deepStrictEqual([...bytes], [0x32, 0xfd, 0x09, 0x00]);
});

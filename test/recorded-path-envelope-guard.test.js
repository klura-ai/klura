// Unit tests for verifyRecordedPathOverBinaryWs — the save-time guard
// that rejects recorded-path strategies when the discovery session
// captured a binary-WS write carrying the strategy's caller-arg literal.
// The capability is liftable; recorded-path is the wrong save.

import test from 'node:test';
import assert from 'node:assert';

const { verifyRecordedPathOverBinaryWs } = await import(
  '../dist/strategies/verify-observed.js'
);
const { setTryGeneratorStatsProvider } = await import('../dist/strategies/skills.js');

// Build a binary-WS sent frame whose payload starts with a leading 0x32
// (MQTT PUBLISH-shaped) and embeds the literal past the header. Mirrors
// the real-world Messenger frame the addendum's detector targets.
function binaryWsFrameWithLiteral(literal) {
  const header = Buffer.from([0x32, 0xfd, 0x09, 0x00, 0x07]);
  const topic = Buffer.from('/ls_req\x00', 'binary');
  const body = Buffer.from(JSON.stringify({ task: { text: literal } }), 'utf-8');
  const payload = Buffer.concat([header, topic, body]).toString('binary');
  return {
    url: 'wss://chat.example.com/ws',
    direction: 'sent',
    payload,
    timestamp: Date.now(),
  };
}

function plainTextWsFrame(text) {
  return {
    url: 'wss://chat.example.com/ws',
    direction: 'sent',
    payload: JSON.stringify({ message: text }),
    timestamp: Date.now(),
  };
}

const RECORDED_PATH_BASE = {
  strategy: 'recorded-path',
  startUrl: 'https://example.com',
  steps: [
    { id: 'navigate_chat', action: 'navigate', url: 'https://example.com/chat' },
    {
      id: 'type_message',
      action: 'fill_editor',
      locators: { css: '[contenteditable]' },
      value: 'klura-test-message',
    },
    {
      id: 'key_enter',
      action: 'key_press',
      locators: { css: '[contenteditable]' },
      value: 'Enter',
    },
  ],
};

test('recorded-path-guard: no-op when strategy is not recorded-path', () => {
  const fetchStrategy = { strategy: 'fetch', baseUrl: 'https://x', endpoint: '/y' };
  // Even with a binary-WS frame matching, fetch saves are unaffected.
  verifyRecordedPathOverBinaryWs(
    fetchStrategy,
    [],
    [binaryWsFrameWithLiteral('klura-test-message')],
    'sess-1',
  );
});

test('recorded-path-guard: no-op when sessionId is undefined', () => {
  setTryGeneratorStatsProvider(null);
  verifyRecordedPathOverBinaryWs(
    RECORDED_PATH_BASE,
    [],
    [binaryWsFrameWithLiteral('klura-test-message')],
    undefined,
  );
});

test('recorded-path-guard: no-op when wsFrames is empty', () => {
  setTryGeneratorStatsProvider(() => ({ total: 0, with_verify_against: 0, ok_true: 0, verified_ok: 0 }));
  verifyRecordedPathOverBinaryWs(RECORDED_PATH_BASE, [], [], 'sess-2');
});

test('recorded-path-guard: rejects when a binary-WS write carries a step value literal', () => {
  setTryGeneratorStatsProvider(() => ({ total: 0, with_verify_against: 0, ok_true: 0, verified_ok: 0 }));
  assert.throws(
    () =>
      verifyRecordedPathOverBinaryWs(
        RECORDED_PATH_BASE,
        [],
        [binaryWsFrameWithLiteral('klura-test-message')],
        'sess-3',
      ),
    (err) => {
      assert.match(err.message, /^invalid_strategy: recorded-path saved/);
      assert.match(err.message, /binary WebSocket frame/);
      // Evidence payload points at the captured frame index and shape so the
      // agent can pull it up via get_network_log / inspect_ws_frame.
      assert.match(err.message, /ws_i:/);
      assert.match(err.message, /evidence/);
      return true;
    },
  );
});

test('recorded-path-guard: bypassed when verified_ok >= 1 (agent at least tried)', () => {
  setTryGeneratorStatsProvider(() => ({ total: 5, with_verify_against: 5, ok_true: 1, verified_ok: 1 }));
  verifyRecordedPathOverBinaryWs(
    RECORDED_PATH_BASE,
    [],
    [binaryWsFrameWithLiteral('klura-test-message')],
    'sess-4',
  );
});

test('recorded-path-guard: silent when ws frames are plain text (no binary envelope)', () => {
  setTryGeneratorStatsProvider(() => ({ total: 0, with_verify_against: 0, ok_true: 0, verified_ok: 0 }));
  verifyRecordedPathOverBinaryWs(
    RECORDED_PATH_BASE,
    [],
    [plainTextWsFrame('klura-test-message')],
    'sess-5',
  );
});

test('recorded-path-guard: silent when binary frame literal does not match any step value', () => {
  // The frame carries a different literal — agent's recorded-path is
  // genuinely DOM-only relative to the captured ws traffic.
  setTryGeneratorStatsProvider(() => ({ total: 0, with_verify_against: 0, ok_true: 0, verified_ok: 0 }));
  verifyRecordedPathOverBinaryWs(
    RECORDED_PATH_BASE,
    [],
    [binaryWsFrameWithLiteral('completely-unrelated-text')],
    'sess-6',
  );
});

test('recorded-path-guard: anchors on notes.params[X].example too (not just step values)', () => {
  // Step value uses {{message}}; the literal is in notes.params.message.example.
  const data = {
    strategy: 'recorded-path',
    startUrl: 'https://example.com',
    steps: [{ id: 'type_message', action: 'fill_editor', locators: { css: '[contenteditable]' }, value: '{{message}}' }],
    notes: {
      params: {
        message: {
          description: 'message body',
          kind: 'text',
          example: 'klura-param-example',
          source: 'caller-supplied',
        },
      },
    },
  };
  setTryGeneratorStatsProvider(() => ({ total: 0, with_verify_against: 0, ok_true: 0, verified_ok: 0 }));
  assert.throws(
    () =>
      verifyRecordedPathOverBinaryWs(
        data,
        [],
        [binaryWsFrameWithLiteral('klura-param-example')],
        'sess-7',
      ),
    /binary WebSocket frame/,
  );
});

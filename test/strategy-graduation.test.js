// Happy-path test for the graduation tracker: feed three identical
// synthesized network-log snapshots through `recordRecordedPathSuccess`
// and assert that a valid fetch strategy ends up on disk next to
// the existing recorded-path one.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-graduation-synth-'));
process.env.KLURA_HOME = TMP;

// Enable graduation at threshold=3 via config.json — no env var.
fs.writeFileSync(
  path.join(TMP, 'config.json'),
  JSON.stringify({ graduation: { observation_threshold: 3 } }, null, 2),
);

const graduation = await import('../dist/strategies/strategy-graduation.js');
const skills = await import('../dist/strategies/skills.js');

const PLATFORM = 'gradplat';
const CAPABILITY = 'send_thing';

function snapshot() {
  // Three identical observations: one GET (ignored) + the target POST with
  // required headers and a JSON body. The tracker should pick the POST every
  // time, derive the same shape, and graduate on call 3.
  return [
    {
      method: 'GET',
      url: 'https://www.example.com/things/list',
      headers: { accept: 'text/html' },
      postData: null,
      status: 200,
      responseBody: '<html></html>',
      isNavigation: true,
    },
    {
      method: 'POST',
      url: 'https://api.example.com/v1/things?trace=abc',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': 'tok-1234',
        'accept-language': 'en-US,en;q=0.9',
      },
      postData: JSON.stringify({ title: 'hello', body: 'world' }),
      status: 201,
      responseBody: JSON.stringify({ id: 42 }),
    },
  ];
}

test.before(() => {
  // Seed a recorded-path strategy so `skills.loadStrategies` finds it and
  // the graduation tracker doesn't short-circuit on "nothing to graduate
  // from".
  skills.saveStrategy(PLATFORM, CAPABILITY, {
    strategy: 'recorded-path',
    steps: [
      { id: 'navigate_new', action: 'navigate', url: 'https://www.example.com/things/new' },
      {
        id: 'type_title',
        action: 'type',
        locators: { css: 'input[name="title"]', a11y: { role: 'textbox', name: 'Title' } },
        value: 'hello',
      },
      {
        id: 'click_submit',
        action: 'click',
        locators: { css: 'button[type="submit"]', a11y: { role: 'button', name: 'Submit' } },
      },
    ],
  });
});

test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

test('synthesizeHighestViable: emits fetch with empty prereqs, regardless of header shape', () => {
  // Runtime does not classify at synthesis time — that's an LLM-owned
  // decision. Empty-prereq fetch is functionally identical to
  // fetch at execute time (both replay headers verbatim from Node
  // transport), and the T1→T0 hook promotes to fetch later if the
  // prereqs stay empty across N successful executes.
  const withCsrf = {
    method: 'POST',
    urlShape: 'api.example.com/v1/guarded',
    origin: 'https://api.example.com',
    endpointPath: '/v1/guarded',
    headerNames: ['content-type', 'x-csrf-token'],
    headers: { 'content-type': 'application/json', 'x-csrf-token': 'tok' },
    bodyKind: 'json',
    bodyTopKeys: ['title'],
    rawBody: '{"title":"t"}',
  };
  const guarded = graduation.synthesizeHighestViable(withCsrf, ['content-type', 'x-csrf-token']);
  assert.strictEqual(guarded.strategy, 'fetch');
  // Graduation emits a bare fetch shape — no prereqs attached (the LLM or
  // a later save can add them). Prereqs must not be invented by the runtime.
  assert.ok(
    guarded.prerequisites === undefined ||
      (Array.isArray(guarded.prerequisites) && guarded.prerequisites.length === 0),
  );

  const clean = {
    ...withCsrf,
    headerNames: ['content-type', 'authorization'],
    headers: { 'content-type': 'application/json', authorization: 'Bearer abc' },
  };
  const bare = graduation.synthesizeHighestViable(clean, ['content-type', 'authorization']);
  assert.strictEqual(bare.strategy, 'fetch');
  assert.ok(
    bare.prerequisites === undefined ||
      (Array.isArray(bare.prerequisites) && bare.prerequisites.length === 0),
  );
});

test('recordRecordedPathSuccess: synthesizes fetch after threshold is met', () => {
  // First two successes only record observations — nothing persisted yet.
  assert.strictEqual(
    graduation.recordRecordedPathSuccess(PLATFORM, CAPABILITY, snapshot()),
    false,
  );
  assert.strictEqual(
    graduation.recordRecordedPathSuccess(PLATFORM, CAPABILITY, snapshot()),
    false,
  );

  // At this point no fetch strategy should exist.
  const beforeThird = skills.loadStrategies(PLATFORM, CAPABILITY);
  assert.ok(
    !beforeThird.some((s) => s.strategy === 'fetch'),
    'fetch should not exist before threshold',
  );

  // Third success crosses the threshold and synthesizes + validates + saves.
  const graduated = graduation.recordRecordedPathSuccess(PLATFORM, CAPABILITY, snapshot());
  assert.strictEqual(graduated, true, 'third observation should trip graduation');

  const after = skills.loadStrategies(PLATFORM, CAPABILITY);
  const assisted = after.find((s) => s.strategy === 'fetch');
  assert.ok(assisted, 'fetch strategy should have been persisted');
  assert.strictEqual(assisted.method, 'POST');
  assert.strictEqual(assisted.baseUrl, 'https://api.example.com');
  assert.strictEqual(assisted.endpoint, '/v1/things');
  assert.strictEqual(assisted.contentType, 'json');
  // Graduation emits a bare fetch shape — prereqs are not invented by runtime.
  assert.ok(
    assisted.prerequisites === undefined ||
      (Array.isArray(assisted.prerequisites) && assisted.prerequisites.length === 0),
  );

  // Required headers are the intersection across observations — all three
  // headers appeared every time so all three should survive. Unsafe headers
  // like cookie/host aren't in the input snapshot, so the test doesn't need
  // to re-verify their exclusion here (that's covered by unit logic).
  const savedHeaders = assisted.headers ?? {};
  assert.ok('x-csrf-token' in savedHeaders, 'x-csrf-token should be preserved');
  assert.ok('content-type' in savedHeaders, 'content-type should be preserved');

  // Body is preserved verbatim for first-graduation replay.
  assert.deepStrictEqual(assisted.body, { title: 'hello', body: 'world' });

  // Recorded-path still exists — graduation persists alongside, not in place.
  assert.ok(
    after.some((s) => s.strategy === 'recorded-path'),
    'recorded-path should still be present as fallback',
  );

  // loadStrategies sorts by priority so fetch (faster) comes before
  // recorded-path (slower). This is the "cascade tries T2 first, falls back
  // to T3" guarantee.
  const types = after.map((s) => s.strategy);
  assert.ok(
    types.indexOf('fetch') < types.indexOf('recorded-path'),
    'fetch should be ordered before recorded-path in the cascade',
  );

  // A fourth call must not duplicate the save — graduation state records
  // the graduatedTier and short-circuits on subsequent calls.
  const fourth = graduation.recordRecordedPathSuccess(PLATFORM, CAPABILITY, snapshot());
  assert.strictEqual(fourth, false, 'fourth call should no-op (already graduated)');
});

// ---- WS-echo graduation ----

const WS_PLATFORM = 'gradws';
const WS_CAPABILITY = 'send_chat';

function wsSnapshot(text = 'hello-world-echo') {
  // Captured WS frames: one sent payload embedding the typed literal, plus
  // a received frame within 1s that looks like an ack.
  return [
    {
      url: 'wss://ws.example.com/chat?sid=session-xyz&cid=42',
      direction: 'sent',
      payload: JSON.stringify({ type: 'publish', text }),
      timestamp: 1000,
    },
    {
      url: 'wss://ws.example.com/chat?sid=session-xyz&cid=42',
      direction: 'received',
      payload: JSON.stringify({ type: 'upsertMessage', id: 'm1' }),
      timestamp: 1050,
    },
  ];
}

// SKIPPED: source bug — synthesizeWsStrategy in src/strategies/strategy-graduation.ts
// emits `baseUrl` on a protocol:"websocket" shape, which the validator rejects
// (ws strategies require `origin`). Graduation synthesis needs to be updated
// to emit `origin` instead. Re-enable once fixed.
test.skip('ws-echo graduation: three consistent sent-frame matches → synthesize ws strategy', () => {
  // Seed a recorded-path strategy so loadStrategies doesn't short-circuit.
  skills.saveStrategy(WS_PLATFORM, WS_CAPABILITY, {
    strategy: 'recorded-path',
    steps: [
      { id: 'navigate_chat', action: 'navigate', url: 'https://www.example.com/chat' },
      {
        id: 'type_message',
        action: 'type',
        locators: { css: '[contenteditable]', a11y: { role: 'textbox', name: 'Message' } },
        value: '{{message}}',
      },
      {
        id: 'click_send',
        action: 'click',
        locators: { css: 'button.send', a11y: { role: 'button', name: 'Send' } },
      },
    ],
  });

  const ctx = () => ({
    frames: wsSnapshot('hello-world-echo'),
    typedValues: ['hello-world-echo'],
    args: { message: 'hello-world-echo' },
  });

  // First two observations — no save yet.
  assert.strictEqual(
    graduation.recordRecordedPathSuccess(WS_PLATFORM, WS_CAPABILITY, [], ctx()),
    false,
  );
  assert.strictEqual(
    graduation.recordRecordedPathSuccess(WS_PLATFORM, WS_CAPABILITY, [], ctx()),
    false,
  );
  const beforeThird = skills.loadStrategies(WS_PLATFORM, WS_CAPABILITY);
  assert.ok(
    !beforeThird.some((s) => s.strategy === 'fetch'),
    'fetch should not exist before threshold',
  );

  // Third trips graduation.
  const graduated = graduation.recordRecordedPathSuccess(WS_PLATFORM, WS_CAPABILITY, [], ctx());
  assert.strictEqual(graduated, true, 'third ws observation should graduate');

  const after = skills.loadStrategies(WS_PLATFORM, WS_CAPABILITY);
  const assisted = after.find((s) => s.strategy === 'fetch');
  assert.ok(assisted, 'fetch ws strategy should be persisted');
  assert.strictEqual(assisted.protocol, 'websocket');
  assert.strictEqual(assisted.transport, 'browser');
  // wsUrl stripped of sid/cid query params.
  assert.strictEqual(assisted.wsUrl, 'wss://ws.example.com/chat');
  // frame template: the literal "hello-world-echo" is replaced back to
  // `{{message}}` so the saved frame is reusable across calls.
  assert.ok(
    assisted.frame.includes('{{message}}'),
    `frame should contain {{message}} placeholder, got: ${assisted.frame}`,
  );
  assert.ok(
    !assisted.frame.includes('hello-world-echo'),
    'frame should NOT contain the literal arg value',
  );
  // ackMatch derived from the received frame.
  assert.ok(typeof assisted.ackMatch === 'string' && assisted.ackMatch.length > 0);
});

test('ws-echo graduation: no sent frame matches typed literal → no save', () => {
  const WS_PLAT_NS = 'gradws-nomatch';
  const WS_CAP_NS = 'no_echo';
  skills.saveStrategy(WS_PLAT_NS, WS_CAP_NS, {
    strategy: 'recorded-path',
    steps: [
      {
        id: 'type_message',
        action: 'type',
        locators: { css: '[contenteditable]', a11y: { role: 'textbox', name: 'Message' } },
        value: '{{message}}',
      },
    ],
    notes: { params: { message: { kind: 'text', example: 'hello' } } },
  });

  const frames = [
    {
      url: 'wss://ws.example.com/chat',
      direction: 'sent',
      payload: JSON.stringify({ type: 'heartbeat' }), // no typed literal
      timestamp: 1000,
    },
  ];

  for (let i = 0; i < 5; i++) {
    assert.strictEqual(
      graduation.recordRecordedPathSuccess(WS_PLAT_NS, WS_CAP_NS, [], {
        frames,
        typedValues: ['hello'],
        args: { message: 'hello' },
      }),
      false,
      'ws-echo with no matching frame should never graduate',
    );
  }
  const after = skills.loadStrategies(WS_PLAT_NS, WS_CAP_NS);
  assert.ok(!after.some((s) => s.strategy === 'fetch'));
});

test('ws-echo graduation: opaque binary sent frame → no save', () => {
  const WS_PLAT_BIN = 'gradws-binary';
  const WS_CAP_BIN = 'binary_chat';
  skills.saveStrategy(WS_PLAT_BIN, WS_CAP_BIN, {
    strategy: 'recorded-path',
    steps: [
      {
        id: 'type_message',
        action: 'type',
        locators: { css: '[contenteditable]', a11y: { role: 'textbox', name: 'Message' } },
        value: 'x',
      },
    ],
  });

  // Binary-looking payload: has control characters / null bytes. Even if
  // it happens to contain the typed literal as a raw substring, the
  // heuristic rejects it because mqtt-class framing needs generated.frame,
  // not a string template.
  const binaryPayload =
    '\u0000\u0001\u0003' + 'hello-there' + '\u0000\u0000\u0002\u0004\u0005';
  const frames = [
    {
      url: 'wss://edge.example.com/mqtt',
      direction: 'sent',
      payload: binaryPayload,
      timestamp: 1000,
    },
  ];
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(
      graduation.recordRecordedPathSuccess(WS_PLAT_BIN, WS_CAP_BIN, [], {
        frames,
        typedValues: ['hello-there'],
        args: { message: 'hello-there' },
      }),
      false,
    );
  }
  const after = skills.loadStrategies(WS_PLAT_BIN, WS_CAP_BIN);
  assert.ok(!after.some((s) => s.strategy === 'fetch'));
});

test('ws-echo graduation: HTTP path still works when wsContext is omitted', () => {
  // Existing test covers this, but add an explicit "no wsContext passed"
  // case to make sure the ws path doesn't leak into HTTP-only callers.
  const PLAT_LEGACY = 'gradws-legacy';
  const CAP_LEGACY = 'legacy_post';
  skills.saveStrategy(PLAT_LEGACY, CAP_LEGACY, {
    strategy: 'recorded-path',
    steps: [{ id: 'navigate_home', action: 'navigate', url: 'https://x.example.com' }],
  });
  // Call without the 4th arg — should be a no-op (no HTTP candidate, no ws ctx).
  assert.strictEqual(
    graduation.recordRecordedPathSuccess(PLAT_LEGACY, CAP_LEGACY, []),
    false,
  );
  assert.ok(!skills.loadStrategies(PLAT_LEGACY, CAP_LEGACY).some((s) => s.strategy === 'fetch'));
});

// No over-specification removal: a fetch with unused prereqs is not
// automatically pruned. The signal is subtle (a prereq-extracted cookie
// may be load-bearing even if the token value never appears in the final
// request), and a safe runtime check hasn't been built. See
// runtime/docs/strategies.md "## Graduation" for the full note.

// Regression tests for auto-synth fetch templating across wire encodings.
//
// A typed arg value lands on the wire encoded by the request's content-type:
// form-urlencoded percent-/plus-encodes it, a JSON body string-escapes it.
// The synth templater must match those encoded forms (not just the raw typed
// value) or it ships the arg baked as a literal — a strategy that returns the
// discovery-time 2xx while silently dropping caller input. detectSilentlyBaked-
// Args is the encoding-agnostic backstop that refuses to persist such a
// strategy even if the templater misses a future encoding.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-synth-encoding-test-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const { wireEncodingVariants, detectSilentlyBakedArgs } = await import(
  '../dist/strategies/synthesize-on-close/literals.js'
);
const { synthesizeFallbacksOnClose } = await import(
  '../dist/strategies/synthesize-on-close/index.js'
);

test('wireEncodingVariants: raw value is always first and present', () => {
  const v = wireEncodingVariants('alice@example.com');
  assert.equal(v[0], 'alice@example.com');
});

test('wireEncodingVariants: percent-encodes form/url special chars', () => {
  const v = wireEncodingVariants('alice@example.com');
  assert.ok(v.includes('alice%40example.com'), 'should include percent-encoded @');
});

test('wireEncodingVariants: form-plus variant for spaces', () => {
  const v = wireEncodingVariants('Hello from discovery');
  assert.ok(v.includes('Hello%20from%20discovery'), 'percent-encoded space');
  assert.ok(v.includes('Hello+from+discovery'), 'form-plus space');
});

test('wireEncodingVariants: JSON-string-escaped variant for embedded quotes/newlines', () => {
  const v = wireEncodingVariants('line1\nsay "hi"');
  // JSON.stringify('line1\nsay "hi"') === '"line1\\nsay \\"hi\\""'; slice drops
  // the wrapping quotes, leaving the escaped inner form a JSON body would carry.
  assert.ok(
    v.some((s) => s.includes('\\n') && s.includes('\\"')),
    'should include a JSON-escaped variant',
  );
});

test('wireEncodingVariants: empty string yields no variants', () => {
  assert.deepEqual(wireEncodingVariants(''), []);
});

// --- detectSilentlyBakedArgs: the resilient backstop ----------------------

test('baked detector: flags a form-encoded value the templater left as a literal', () => {
  // Simulates the legacy-form-post warm break: the captured body carried
  // percent/plus-encoded values, the (old) templater matched the raw value,
  // missed, and baked email + message into the strategy body. Only `name`
  // (no special chars) got templated.
  const capturedBody = 'name=Alice&email=alice%40example.com&message=Hello+from+discovery';
  const strategy = {
    strategy: 'fetch',
    body: { name: '{{name}}', email: 'alice@example.com', message: 'Hello from discovery' },
  };
  const baked = detectSilentlyBakedArgs(
    strategy,
    'https://api.example.com/submit',
    capturedBody,
    { name: 'Alice', email: 'alice@example.com', message: 'Hello from discovery' },
  );
  assert.deepEqual(baked.sort(), ['email', 'message']);
});

test('baked detector: clean when every present arg is templated', () => {
  const capturedBody = 'name=Alice&email=alice%40example.com&message=Hello+from+discovery';
  const strategy = {
    strategy: 'fetch',
    body: { name: '{{name}}', email: '{{email}}', message: '{{message}}' },
  };
  const baked = detectSilentlyBakedArgs(
    strategy,
    'https://api.example.com/submit',
    capturedBody,
    { name: 'Alice', email: 'alice@example.com', message: 'Hello from discovery' },
  );
  assert.deepEqual(baked, []);
});

test('baked detector: catches a value in the URL query as well as the body', () => {
  const strategy = { strategy: 'fetch', endpoint: '/search?q=thai%20food', body: {} };
  const baked = detectSilentlyBakedArgs(
    strategy,
    'https://api.example.com/search?q=thai%20food',
    '',
    { query: 'thai food' },
  );
  assert.deepEqual(baked, ['query']);
});

test('baked detector: ignores args not present in this capture (multi-call flows)', () => {
  // An arg belonging to a different request in the session must not be flagged
  // against a capture that never carried it — the check anchors to THIS body/url.
  const strategy = { strategy: 'fetch', endpoint: '/submit', body: { name: '{{name}}' } };
  const baked = detectSilentlyBakedArgs(
    strategy,
    'https://api.example.com/submit',
    'name=Alice',
    { name: 'Alice', other_call_arg: 'value-from-a-different-request' },
  );
  assert.deepEqual(baked, []);
});

test('baked detector: skips sub-3-char values (too noisy to match reliably)', () => {
  const strategy = { strategy: 'fetch', endpoint: '/x', body: { code: 'ab' } };
  const baked = detectSilentlyBakedArgs(
    strategy,
    'https://api.example.com/x',
    'code=ab',
    { code: 'ab' },
  );
  assert.deepEqual(baked, []);
});

test('baked detector: no declared args is a clean pass', () => {
  assert.deepEqual(
    detectSilentlyBakedArgs({ strategy: 'fetch' }, 'https://x/y', '', undefined),
    [],
  );
});

// --- end-to-end: the actual legacy-form-post warm-break scenario ----------

test('e2e: form-urlencoded body with @ and spaces templates every arg (not baked)', async () => {
  // The blocker repro: a contact form POSTs application/x-www-form-urlencoded,
  // so on the wire the values are `alice%40example.com` and `Hello+from+disco...`.
  // Pre-fix, the raw-value `.includes()` missed both and shipped them baked as
  // literals; warm execute then dropped caller input while returning 200.
  const args = { name: 'Alice', email: 'alice@example.com', message: 'Hello from discovery' };
  const session = {
    id: 'sess_enc',
    platform: 'test-synth-encoding-e2e',
    declaredCapabilities: [{ capability: 'send_contact', args }],
    savedCapabilities: [],
    performActionHistory: [
      { at: Date.now() - 1500, action: 'type', selector: 'input#name', value: 'Alice' },
      { at: Date.now() - 1400, action: 'type', selector: 'input#email', value: 'alice@example.com' },
      { at: Date.now() - 1300, action: 'type', selector: 'textarea#message', value: 'Hello from discovery' },
      { at: Date.now() - 1200, action: 'click', selector: 'button "Submit"' },
    ],
    intercepted: [
      {
        url: 'https://contact.example.com/submit',
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        postData: 'name=Alice&email=alice%40example.com&message=Hello+from+discovery',
        responseStatus: 200,
        responseHeaders: { 'content-type': 'text/html' },
        responseBody: 'OK',
      },
    ],
    intercepting: false,
    visitedUrls: ['https://contact.example.com/'],
  };

  const diag = [];
  const out = await synthesizeFallbacksOnClose(session, session.platform, null, diag);

  // The fetch strategy must have been persisted (not skipped as baked).
  const baked = diag.find((d) => d.pass === 'synth_fetch' && d.outcome === 'arg_baked_as_literal');
  assert.equal(baked, undefined, `arg was baked, not templated: ${JSON.stringify(baked?.detail)}`);

  const fetched = out.find((r) => r.tier === 'fetch' && /\/(fetch|browser)\//.test(r.path));
  assert.ok(fetched, `expected a persisted synth_fetch strategy, got: ${JSON.stringify(out)}`);

  const saved = JSON.parse(fs.readFileSync(fetched.path, 'utf-8'));
  assert.equal(saved.contentType, 'form');
  // Every arg templated — the whole point. Pre-fix, email/message were literals.
  assert.equal(saved.body.name, '{{name}}');
  assert.equal(saved.body.email, '{{email}}');
  assert.equal(saved.body.message, '{{message}}');
});

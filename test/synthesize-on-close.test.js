// Regression guard for the auto-synth `notes.discovery` bug:
// synthesizeFallbacksOnClose was writing a provenance string into
// notes.discovery, which the validator then rejected because `discovery`
// isn't in the notes allowlist. Net effect: zero strategies landed from
// an otherwise-successful close-session flow (observed in the
// 2026-04-21T11-24 wikipedia CAPTCHA run).
//
// These tests assert the write is gone AND that auto-synth actually
// lands a recorded-path on disk for a minimal type+click flow.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-synth-on-close-test-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const { synthesizeFallbacksOnClose } = await import('../dist/strategies/synthesize-on-close/index.js');

function mkSession({
  declaredCapabilities = [{ capability: 'edit_page', args: { text: 'hello world' } }],
  performActionHistory = [],
  intercepted = [],
} = {}) {
  return {
    id: 'sess_synth',
    platform: 'test-synth',
    declaredCapabilities,
    savedCapabilities: [],
    performActionHistory,
    intercepted,
    intercepting: false,
    visitedUrls: ['https://example.com/'],
  };
}

// A minimal type + click flow that buildStepsFromHistory will emit as
// valid steps (non-empty selector → {css} locator), and that passes the
// synth_recorded gate (has a type step followed by a click).
function mkTypeThenClickHistory() {
  const now = Date.now() - 1000;
  return [
    { at: now, action: 'type', selector: 'textarea#content', value: 'hello world' },
    { at: now + 100, action: 'click', selector: 'button#publish' },
  ];
}

test('synth_recorded: no notes.discovery, no validation_rejected, strategy lands on disk', async () => {
  const session = mkSession({ performActionHistory: mkTypeThenClickHistory() });
  const diag = [];
  const out = await synthesizeFallbacksOnClose(session, session.platform, null, diag);

  // Must have actually landed a strategy — the whole bug was that this
  // list stayed empty because the validator rejected the synthesized
  // recorded-path for the unknown notes field.
  const recorded = out.find((r) => r.tier === 'recorded-path');
  assert.ok(recorded, `expected a recorded-path synth result, got: ${JSON.stringify(out)}`);
  assert.match(recorded.path, /\.json$/);

  // Diagnostics must not report validation_rejected for synth_recorded
  // (that's the exact failure mode from the wikipedia run).
  const recordedDiag = diag.filter((d) => d.pass === 'synth_recorded');
  for (const d of recordedDiag) {
    assert.notEqual(
      d.outcome,
      'validation_rejected',
      `synth_recorded reported validation_rejected: ${JSON.stringify(d.detail)}`,
    );
  }

  // Re-read the saved strategy from disk and verify notes.discovery is
  // absent (the canonical notes allowlist forbids it; the
  // writer must not emit it).
  const raw = fs.readFileSync(recorded.path, 'utf-8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.strategy, 'recorded-path');
  assert.ok(parsed.notes, 'notes object expected');
  assert.ok(
    !('discovery' in parsed.notes),
    `notes.discovery should not be present on auto-synth recorded-path; got notes = ${JSON.stringify(parsed.notes)}`,
  );
});

test('synth_recorded prepends a navigate step so warm execute lands on the right page', async () => {
  // Without a navigate prelude, warm execute from a cold browser session
  // starts on about:blank and step[0] (click / type) fails immediately.
  // The discovery session's last-visited URL is the correct destination.
  const targetUrl = 'https://en.wikipedia.org/wiki/Wikipedia:Sandbox';
  // Distinct platform per test so the "skip when recorded-path already
  // exists" guard in synthesizeRecordedPaths doesn't filter us out.
  const session = mkSession({
    performActionHistory: mkTypeThenClickHistory(),
  });
  session.platform = 'test-synth-navigate';
  session.visitedUrls = ['https://en.wikipedia.org/', targetUrl];

  const out = await synthesizeFallbacksOnClose(session, session.platform, null, []);
  const recorded = out.find((r) => r.tier === 'recorded-path');
  assert.ok(recorded, 'expected a recorded-path synth result');
  const parsed = JSON.parse(fs.readFileSync(recorded.path, 'utf-8'));
  assert.equal(parsed.steps[0]?.action, 'navigate', 'step[0] must be navigate');
  assert.equal(parsed.steps[0]?.url, targetUrl, 'navigate must use the last-visited URL');
});

test('synth_recorded: stamps runtime_meta.discovered_from_url from last-visited URL', async () => {
  const targetUrl = 'https://en.wikipedia.org/wiki/Wikipedia:Sandbox?edit=1#section-top';
  const session = mkSession({
    performActionHistory: mkTypeThenClickHistory(),
  });
  session.platform = 'test-synth-discovered-from';
  session.visitedUrls = ['https://en.wikipedia.org/', targetUrl];

  const out = await synthesizeFallbacksOnClose(session, session.platform, null, []);
  const recorded = out.find((r) => r.tier === 'recorded-path');
  assert.ok(recorded, 'expected a recorded-path synth result');
  const parsed = JSON.parse(fs.readFileSync(recorded.path, 'utf-8'));
  assert.equal(
    parsed.runtime_meta?.discovered_from_url,
    targetUrl,
    `expected full URL including search + hash; got ${JSON.stringify(parsed.runtime_meta)}`,
  );
});

test('synth_recorded: stamps runtime_meta.discovered_at_step_id with the last emitted step id', async () => {
  // The anchor is the last recorded-path step that was live when the save
  // marker fired — in the write-shaped type→click flow that's the confirm
  // click. assignAutoStepIds derives "click_publish" from locator shape.
  const session = mkSession({
    performActionHistory: mkTypeThenClickHistory(),
  });
  session.platform = 'test-synth-anchor-id';
  session.visitedUrls = ['https://example.com/edit'];

  const out = await synthesizeFallbacksOnClose(session, session.platform, null, []);
  const recorded = out.find((r) => r.tier === 'recorded-path');
  assert.ok(recorded, 'expected a recorded-path synth result');
  const parsed = JSON.parse(fs.readFileSync(recorded.path, 'utf-8'));
  assert.ok(
    parsed.runtime_meta?.discovered_at_step_id,
    'discovered_at_step_id must be stamped',
  );
  const anchor = parsed.runtime_meta.discovered_at_step_id;
  const lastStep = parsed.steps[parsed.steps.length - 1];
  assert.equal(
    anchor,
    lastStep?.id,
    'anchor id must match the last emitted step id',
  );
  // Anchor must be a valid slug (the validator would reject at save time if
  // not).
  assert.match(anchor, /^[a-z][a-z0-9_]{2,39}$/);
});

test('synth_recorded: assigns unique slug ids to every step', async () => {
  const session = mkSession({
    performActionHistory: mkTypeThenClickHistory(),
  });
  session.platform = 'test-synth-auto-ids';
  session.visitedUrls = ['https://example.com/edit'];

  const out = await synthesizeFallbacksOnClose(session, session.platform, null, []);
  const recorded = out.find((r) => r.tier === 'recorded-path');
  assert.ok(recorded);
  const parsed = JSON.parse(fs.readFileSync(recorded.path, 'utf-8'));
  const ids = parsed.steps.map((s) => s.id);
  const unique = new Set(ids);
  assert.equal(unique.size, ids.length, `ids must be unique, got: ${ids.join(', ')}`);
  for (const id of ids) {
    assert.match(id, /^[a-z][a-z0-9_]{2,39}$/, `id "${id}" must be a valid slug`);
  }
});

test('synth_recorded does not add a second navigate when history already starts with one', async () => {
  const session = mkSession({
    performActionHistory: [
      { at: Date.now() - 2000, action: 'navigate', url: 'https://example.com/edit' },
      { at: Date.now() - 1000, action: 'type', selector: 'textarea#body', value: 'x' },
      { at: Date.now() - 500, action: 'click', selector: 'button#publish' },
    ],
  });
  session.platform = 'test-synth-nodup';

  const out = await synthesizeFallbacksOnClose(session, session.platform, null, []);
  const recorded = out.find((r) => r.tier === 'recorded-path');
  assert.ok(recorded, 'expected a recorded-path synth result');
  const parsed = JSON.parse(fs.readFileSync(recorded.path, 'utf-8'));
  // Only ONE navigate — the agent's own, not a runtime-prepended duplicate.
  const navigates = parsed.steps.filter((s) => s.action === 'navigate');
  assert.equal(navigates.length, 1, 'no duplicate navigate');
  assert.equal(parsed.steps[0]?.url, 'https://example.com/edit');
});

// Body-shape regression: synth_fetch templated the captured postData as a
// string and saved `body: "<string>"`, which the validator rejects with
// "fetch.body must be an object" — observed in the 2026-04-25 chatgpt run
// against /backend-anon/f/conversation. The fix parses the templated body
// back to an object (JSON or form-urlencoded) before saving.

function mkPostReq({ url, postData, contentType = 'application/json' }) {
  return {
    url,
    method: 'POST',
    headers: { 'content-type': contentType },
    postData,
    responseStatus: 200,
    responseHeaders: { 'content-type': contentType },
    responseBody: '{}',
  };
}

test('synth_fetch saves body as a parsed object for JSON requests (not a string)', async () => {
  const literal = 'hello world #klura-test';
  const session = mkSession({
    declaredCapabilities: [{ capability: 'send_message', args: { text: literal } }],
    performActionHistory: [
      { at: Date.now() - 1000, action: 'type', selector: 'textbox', value: literal },
      { at: Date.now() - 500, action: 'click', selector: 'button "Send"' },
    ],
    intercepted: [
      mkPostReq({
        url: 'https://api.example.com/v1/conversation',
        postData: JSON.stringify({
          action: 'next',
          messages: [{ role: 'user', content: { parts: [literal] } }],
        }),
      }),
    ],
  });
  session.platform = 'test-synth-fetch-json';

  const diag = [];
  const out = await synthesizeFallbacksOnClose(session, session.platform, null, diag);
  const fetched = out.find((r) => r.tier === 'fetch' && /\/(fetch|browser)\//.test(r.path));
  assert.ok(fetched, `expected a synth_fetch save, got: ${JSON.stringify(out)}`);

  const rejected = diag.filter((d) => d.pass === 'synth_fetch' && d.outcome === 'validation_rejected');
  assert.equal(rejected.length, 0, `synth_fetch validation rejected: ${JSON.stringify(rejected)}`);

  const saved = JSON.parse(fs.readFileSync(fetched.path, 'utf-8'));
  assert.equal(saved.endpoint, '/v1/conversation');
  assert.equal(typeof saved.body, 'object', `body must be an object, got: ${typeof saved.body}`);
  assert.ok(!Array.isArray(saved.body));
  // Templated value lives inside the JSON tree at the original position.
  assert.equal(saved.body.messages[0].content.parts[0], '{{text}}');
});

test('synth_fetch saves body as object + contentType:"form" for form-urlencoded requests', async () => {
  const literal = 'helloworld';
  const session = mkSession({
    declaredCapabilities: [{ capability: 'send_form', args: { text: literal } }],
    performActionHistory: [
      { at: Date.now() - 1000, action: 'type', selector: 'input', value: literal },
      { at: Date.now() - 500, action: 'click', selector: 'button "Submit"' },
    ],
    intercepted: [
      mkPostReq({
        url: 'https://api.example.com/v1/submit',
        postData: `text=${literal}&id=42`,
        contentType: 'application/x-www-form-urlencoded',
      }),
    ],
  });
  session.platform = 'test-synth-fetch-form';

  const diag = [];
  const out = await synthesizeFallbacksOnClose(session, session.platform, null, diag);
  const fetched = out.find((r) => r.tier === 'fetch' && /\/(fetch|browser)\//.test(r.path));
  assert.ok(fetched, `expected a synth_fetch save, got: ${JSON.stringify(out)}`);

  const saved = JSON.parse(fs.readFileSync(fetched.path, 'utf-8'));
  assert.equal(saved.contentType, 'form');
  assert.deepEqual(saved.body, { text: '{{text}}', id: '42' });
});

test('synth_fetch skips auto-save with body_unparseable diagnostic when body is neither JSON nor form', async () => {
  // Templating the literal into a non-string JSON position breaks the JSON
  // shape: `{"id":12345}` + literal `12345` becomes `{"id":{{id}}}` which
  // is invalid JSON. Auto-save must skip with a structured diagnostic so
  // the agent / recorded-path fallback can take it from there, not save a
  // string body the validator rejects.
  const literal = '12345';
  const session = mkSession({
    declaredCapabilities: [{ capability: 'send_int', args: { id: literal } }],
    performActionHistory: [
      { at: Date.now() - 1000, action: 'type', selector: 'input', value: literal },
      { at: Date.now() - 500, action: 'click', selector: 'button "Go"' },
    ],
    intercepted: [
      mkPostReq({
        url: 'https://api.example.com/v1/submit',
        postData: `{"id":${literal}}`,
      }),
    ],
  });
  session.platform = 'test-synth-fetch-unparseable';

  const diag = [];
  await synthesizeFallbacksOnClose(session, session.platform, null, diag);

  const skipped = diag.filter((d) => d.pass === 'synth_fetch' && d.outcome === 'body_unparseable');
  assert.equal(skipped.length, 1, `expected one body_unparseable diagnostic, got: ${JSON.stringify(diag)}`);

  const rejected = diag.filter((d) => d.pass === 'synth_fetch' && d.outcome === 'validation_rejected');
  assert.equal(rejected.length, 0, `validator must not be reached: ${JSON.stringify(rejected)}`);
});

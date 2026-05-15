// Regression guard for trimOversizedObjectBody — the canonical
// "structured response body → size-aware trim" helper used by the
// `execute` tool + `start_session` auto-execute to keep `networkLog`
// from blowing past the MCP output budget.
//
// Contract: drop ONLY the named field (so application-specific
// success markers like `edit.result`, `receipt.status` survive and
// the agent can tell success from failure). Leave a `<dropField>_available`
// advisory pointing the agent at the follow-up tool call.

import test from 'node:test';
import assert from 'node:assert/strict';

const { trimOversizedObjectBody, MAX_TOOL_OUTPUT_CHARS } = await import(
  '../dist/response/response-size.js'
);

const HINT = 'networkLog omitted. Fetch via get_network_log({session_id}) or call execute({full: true}).';

test('mode=full passes through unchanged even when oversized', () => {
  const bigLog = new Array(500).fill({ method: 'GET', url: 'x'.repeat(100) });
  const result = { status: 200, body: { ok: true, networkLog: bigLog } };
  const out = trimOversizedObjectBody(result, {
    dropField: 'networkLog',
    mode: 'full',
    availableHint: HINT,
  });
  assert.equal(out, result);
  assert.ok('networkLog' in out.body);
});

test('mode=smart passes through when under budget', () => {
  const result = {
    status: 200,
    body: {
      ok: true,
      url: 'https://example.com/x',
      edit: { result: 'Success' },
      networkLog: { total: 1, requests: [{ method: 'GET', url: 'x' }] },
    },
  };
  assert.ok(JSON.stringify(result).length < MAX_TOOL_OUTPUT_CHARS);
  const out = trimOversizedObjectBody(result, {
    dropField: 'networkLog',
    mode: 'smart',
    availableHint: HINT,
  });
  assert.ok('networkLog' in out.body, 'small body keeps networkLog');
  assert.deepEqual(out.body.edit, { result: 'Success' });
});

test('mode=smart drops only networkLog when oversized; other fields survive', () => {
  const bigLog = {
    total: 300,
    requests: new Array(300).fill({
      method: 'GET',
      url: 'https://example.com/api/endpoint?with=lots&of=queryParams',
      headers: { 'x-a': 'v'.repeat(80) },
    }),
  };
  const result = {
    status: 200,
    body: {
      ok: true,
      url: 'https://example.com/done',
      edit: { result: 'Success', newrevid: 42 },
      receipt: { status: 'ok' },
      interrupts_fired: ['captcha_gate'],
      networkLog: bigLog,
    },
  };
  assert.ok(JSON.stringify(result).length > MAX_TOOL_OUTPUT_CHARS, 'fixture triggers trim');

  const out = trimOversizedObjectBody(result, {
    dropField: 'networkLog',
    mode: 'smart',
    availableHint: HINT,
  });

  assert.equal(out.body.ok, true);
  assert.equal(out.body.url, 'https://example.com/done');
  assert.deepEqual(out.body.edit, { result: 'Success', newrevid: 42 }, 'app success marker survives');
  assert.deepEqual(out.body.receipt, { status: 'ok' });
  assert.deepEqual(out.body.interrupts_fired, ['captcha_gate']);
  assert.ok(!('networkLog' in out.body), 'networkLog dropped');
  assert.equal(out.body.networkLog_available, HINT);
});

test('mode=force-compact drops the field even when under budget', () => {
  const result = {
    status: 200,
    body: { ok: true, networkLog: { total: 1, requests: [] } },
  };
  const out = trimOversizedObjectBody(result, {
    dropField: 'networkLog',
    mode: 'force-compact',
    availableHint: HINT,
  });
  assert.ok(!('networkLog' in out.body));
  assert.equal(out.body.networkLog_available, HINT);
});

test('no-op when field is absent', () => {
  const result = { status: 200, body: { ok: true } };
  const out = trimOversizedObjectBody(result, {
    dropField: 'networkLog',
    mode: 'force-compact',
    availableHint: HINT,
  });
  assert.equal(out, result);
});

test('no-op when body is missing / not an object', () => {
  for (const shape of [
    { status: 200 },
    { status: 200, body: null },
    { status: 200, body: 'plain-string' },
    { status: 200, body: [1, 2, 3] },
  ]) {
    const out = trimOversizedObjectBody(shape, {
      dropField: 'networkLog',
      mode: 'force-compact',
      availableHint: HINT,
    });
    assert.equal(out, shape);
  }
});

test('outer result fields (status, tier, ...) pass through', () => {
  const result = {
    status: 200,
    tier: 'page-script',
    duration_ms: 1234,
    body: {
      ok: true,
      networkLog: new Array(1000).fill('x'.repeat(50)),
    },
  };
  const out = trimOversizedObjectBody(result, {
    dropField: 'networkLog',
    mode: 'smart',
    availableHint: HINT,
  });
  assert.equal(out.status, 200);
  assert.equal(out.tier, 'page-script');
  assert.equal(out.duration_ms, 1234);
});

// ---- compactExecuteResultBody — the start_session-side body cap that runs
// regardless of `executed`-state. Handles string / array / object body shapes
// so the response never blows the MCP transport ceiling.

const { compactExecuteResultBody } = await import('../dist/tools/start-session.js');

test('compact: string body over budget is sliced + sibling preview attached', () => {
  const er = { status: 200, body: 'x'.repeat(500_000) };
  compactExecuteResultBody(er);
  assert.equal(er.status, 200);
  assert.equal(er.body_truncated, true);
  assert.equal(er.body_total_chars, 500_000);
  assert.ok(typeof er.body_preview === 'string');
  assert.ok(er.body_preview.length <= MAX_TOOL_OUTPUT_CHARS / 2);
  assert.ok(typeof er.body === 'string' && er.body.startsWith('<truncated string body:'));
});

test('compact: short string body left alone', () => {
  const er = { status: 200, body: 'hello world' };
  compactExecuteResultBody(er);
  assert.equal(er.body, 'hello world');
  assert.equal(er.body_truncated, undefined);
});

test('compact: array body over KEEP threshold is head-sliced + total_entries attached', () => {
  const er = { status: 200, body: new Array(5000).fill({ id: 1, name: 'x' }) };
  compactExecuteResultBody(er);
  assert.ok(Array.isArray(er.body));
  assert.equal(er.body.length, 50);
  assert.equal(er.body_total_entries, 5000);
  assert.equal(er.body_truncated_entries, true);
});

test('compact: small array of small entries left alone', () => {
  const er = { status: 200, body: [1, 2, 3, 4, 5] };
  compactExecuteResultBody(er);
  assert.deepEqual(er.body, [1, 2, 3, 4, 5]);
  assert.equal(er.body_truncated_entries, undefined);
});

test('compact: small array of huge entries triggers JSON preview path', () => {
  const er = {
    status: 200,
    body: new Array(5).fill({ huge: 'x'.repeat(10_000) }),
  };
  compactExecuteResultBody(er);
  assert.equal(er.body_truncated, true);
  assert.ok(er.body_total_chars > MAX_TOOL_OUTPUT_CHARS / 2);
  assert.ok(typeof er.body === 'string' && er.body.startsWith('<truncated array body:'));
});

test('compact: object body over budget is JSON-preview-replaced + status survives', () => {
  const er = {
    status: 200,
    body: { ok: true, original_body: 'x'.repeat(500_000) },
  };
  compactExecuteResultBody(er);
  assert.equal(er.status, 200);
  assert.equal(er.body_truncated, true);
  assert.ok(typeof er.body === 'string' && er.body.startsWith('<truncated:'));
  assert.ok(er.body_preview.length <= MAX_TOOL_OUTPUT_CHARS / 2);
});

test('compact: small object body left alone', () => {
  const er = { status: 200, body: { ok: true, count: 3 } };
  compactExecuteResultBody(er);
  assert.deepEqual(er.body, { ok: true, count: 3 });
  assert.equal(er.body_truncated, undefined);
});

test('compact: null / undefined body is a no-op', () => {
  for (const body of [null, undefined]) {
    const er = { status: 200, body };
    compactExecuteResultBody(er);
    assert.equal(er.body, body);
    assert.equal(er.body_truncated, undefined);
  }
});

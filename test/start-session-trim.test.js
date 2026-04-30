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

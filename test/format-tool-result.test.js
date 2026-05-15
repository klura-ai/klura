// formatToolResult — content-block emission for the MCP layer.
// Covers the obligation-hoist path: when result has _session_obligation,
// the message lands as a leading [klura obligation]: <msg> text block,
// stripped from the JSON-stringified rest so the model reads it once
// as a directive rather than buried in a serialized payload.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { formatToolResult } = await import('../dist/public-api.js');

const obligation = {
  kind: 'lift_required',
  session_id: 'sess_x',
  mutating_actions: 1,
  message: 'TESTMSG: call end_drive next.',
};

test('hoists obligation into a leading text block (default branch)', () => {
  const blocks = formatToolResult('perform_action', {
    ok: true,
    _session_obligation: obligation,
  });
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], {
    type: 'text',
    text: '[klura obligation]: TESTMSG: call end_drive next.',
  });
  assert.equal(blocks[1].type, 'text');
  assert.match(blocks[1].text, /^\[Tool result for perform_action\]:/);
  assert.doesNotMatch(blocks[1].text, /_session_obligation/);
  assert.doesNotMatch(blocks[1].text, /TESTMSG/);
});

test('hoists obligation ahead of embedded screenshot (text + image)', () => {
  const blocks = formatToolResult('perform_action', {
    ok: true,
    screenshot: 'A'.repeat(200),
    _session_obligation: obligation,
  });
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].text, '[klura obligation]: TESTMSG: call end_drive next.');
  assert.equal(blocks[1].type, 'text');
  assert.match(blocks[1].text, /^\[Tool result for perform_action\]:/);
  assert.doesNotMatch(blocks[1].text, /_session_obligation/);
  assert.doesNotMatch(blocks[1].text, /screenshot/);
  assert.equal(blocks[2].type, 'image');
  assert.equal(blocks[2].mediaType, 'image/png');
});

test('passes through unchanged when result has no obligation', () => {
  const blocks = formatToolResult('get_a11y_tree', { tree: { role: 'document' } });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  assert.match(blocks[0].text, /^\[Tool result for get_a11y_tree\]:/);
  assert.match(blocks[0].text, /"role":"document"/);
});

test('get_screenshot raw-string path emits text+image with no obligation lookup', () => {
  // mcp/index.js only attaches _session_obligation to object results, so a
  // string screenshot result never carries one. The fast path short-circuits
  // before extractObligation runs and emits the existing two-block shape.
  const blocks = formatToolResult('get_screenshot', 'B'.repeat(200));
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0], blocks[0]); // self-equality, nothing fancy
  assert.equal(blocks[0].type, 'text');
  assert.equal(blocks[0].text, '[Screenshot from get_screenshot]:');
  assert.equal(blocks[1].type, 'image');
});

test('ignores malformed obligation (missing message string)', () => {
  const blocks = formatToolResult('perform_action', {
    ok: true,
    _session_obligation: { kind: 'lift_required', session_id: 's', mutating_actions: 1 },
  });
  // No leading obligation block; the malformed sub-field passes through into
  // the JSON. Validating shape is the producer's job; formatToolResult is
  // defensive but not a schema enforcer.
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  assert.match(blocks[0].text, /^\[Tool result for perform_action\]:/);
});

test('hoists _render_verbatim_block into a leading text block with preface', () => {
  const blocks = formatToolResult('start_remote_session', {
    viewerUrl: 'http://localhost:54000?token=abc',
    _render_verbatim_block: {
      preface: 'Surface this URL to the user verbatim:',
      content: 'http://localhost:54000?token=abc',
    },
  });
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, 'text');
  assert.match(blocks[0].text, /Surface this URL to the user verbatim:/);
  assert.match(blocks[0].text, /http:\/\/localhost:54000\?token=abc/);
  assert.equal(blocks[1].type, 'text');
  assert.match(blocks[1].text, /^\[Tool result for start_remote_session\]:/);
  assert.doesNotMatch(blocks[1].text, /_render_verbatim_block/);
});

test('default render-verbatim preface fires when none supplied', () => {
  const blocks = formatToolResult('start_remote_session', {
    viewerUrl: 'http://x',
    _render_verbatim_block: { content: 'http://x' },
  });
  assert.equal(blocks.length, 2);
  assert.match(blocks[0].text, /verbatim/i);
  assert.match(blocks[0].text, /http:\/\/x/);
});

test('obligation + render-verbatim coexist as two leading blocks', () => {
  const blocks = formatToolResult('start_remote_session', {
    viewerUrl: 'http://x',
    _session_obligation: obligation,
    _render_verbatim_block: { content: 'http://x' },
  });
  assert.equal(blocks.length, 3);
  assert.match(blocks[0].text, /^\[klura obligation\]:/);
  assert.match(blocks[1].text, /verbatim/i);
  assert.match(blocks[2].text, /^\[Tool result for start_remote_session\]:/);
});

// ---- Transport-cap enforcement (last-resort backstop in formatToolResult) ----

const { MAX_TOOL_OUTPUT_CHARS, enforceFinalBudget } = await import(
  '../dist/response/response-size.js'
);
const FORMAT_CEILING = MAX_TOOL_OUTPUT_CHARS * 2; // matches FORMAT_TOOL_RESULT_CEILING

test('transport-cap: 1.5MB synthetic result is clipped under ceiling', () => {
  // Mimic the 2026-05-15 amazon failure: saved strategy returns a huge
  // `body.results` array that overshoots MCP's 1 MB transport ceiling.
  const cards = [];
  for (let i = 0; i < 60; i++) {
    cards.push('Card #' + i + ' ' + 'lorem ipsum dolor sit amet '.repeat(800));
  }
  const result = {
    sessionId: 'abc',
    executed: true,
    execute_result: { status: 200, body: { results: cards }, tier: 'fetch' },
  };
  assert.ok(JSON.stringify(result).length > 1_000_000, 'fixture really is huge');
  const blocks = formatToolResult('start_session', result);
  const text = blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  assert.ok(
    text.length <= FORMAT_CEILING + 1_000,
    `formatted text ${text.length} chars should fit ceiling ${FORMAT_CEILING} + small overhead`,
  );
  assert.match(text, /_runtime_oversize_warning/);
  assert.match(text, /truncated_paths/);
});

test('transport-cap: warning names the offending leaf path', () => {
  const result = {
    sessionId: 'abc',
    executed: true,
    execute_result: {
      status: 200,
      body: { small_field: 'ok', original_body: 'x'.repeat(500_000) },
    },
  };
  const blocks = formatToolResult('start_session', result);
  const text = blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  assert.match(text, /_runtime_oversize_warning/);
  assert.match(text, /original_body/);
});

test('transport-cap: small result passes through, no warning injected', () => {
  const result = { ok: true, items: [1, 2, 3], status: 200 };
  const blocks = formatToolResult('list_items', result);
  assert.equal(blocks.length, 1);
  assert.doesNotMatch(blocks[0].text, /_runtime_oversize_warning/);
});

test('transport-cap: screenshot image block survives backstop on oversized siblings', () => {
  const fakeImage = 'A'.repeat(200);
  const result = {
    screenshot: fakeImage,
    note: 'small',
    payload: { detail: 'y'.repeat(100_000) },
  };
  const blocks = formatToolResult('perform_action', result);
  const images = blocks.filter((b) => b.type === 'image');
  assert.equal(images.length, 1);
  assert.equal(images[0].data, fakeImage);
  const text = blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  assert.ok(text.length <= FORMAT_CEILING + 1_000);
});

// ---- enforceFinalBudget unit tests ----

test('enforceFinalBudget: small value untouched, truncations empty', () => {
  const out = enforceFinalBudget(
    { ok: true, items: [1, 2, 3] },
    { ceiling: FORMAT_CEILING, toolName: 't' },
  );
  assert.deepEqual(out.value, { ok: true, items: [1, 2, 3] });
  assert.equal(out.truncations.length, 0);
});

test('enforceFinalBudget: oversized string leaf is truncated with path marker', () => {
  const out = enforceFinalBudget(
    { ok: true, blob: 'x'.repeat(100_000) },
    { ceiling: 10_000, toolName: 't' },
  );
  assert.ok(out.truncations.length > 0);
  assert.equal(out.truncations[0].path, 'blob');
  assert.match(out.value.blob, /<truncated path=blob>/);
  assert.ok(JSON.stringify(out.value).length <= 10_000);
});

test('enforceFinalBudget: oversized array leaf head-sliced with sentinel', () => {
  const big = new Array(2000).fill({
    id: 1,
    name: 'lorem ipsum dolor sit amet'.repeat(10),
  });
  const out = enforceFinalBudget({ rows: big }, { ceiling: 10_000, toolName: 't' });
  assert.ok(out.truncations.length > 0);
  assert.equal(out.truncations[0].path, 'rows');
  assert.ok(Array.isArray(out.value.rows));
  const last = out.value.rows[out.value.rows.length - 1];
  assert.equal(last.__truncated, true);
  assert.equal(last.original_length, 2000);
  assert.ok(JSON.stringify(out.value).length <= 10_000);
});

test('enforceFinalBudget: input value not mutated when truncation fires', () => {
  const original = { blob: 'x'.repeat(100_000), keep: 'me' };
  const snapshot = JSON.stringify(original);
  enforceFinalBudget(original, { ceiling: 10_000, toolName: 't' });
  assert.equal(JSON.stringify(original), snapshot, 'caller reference unchanged');
});

test('enforceFinalBudget: deeply nested leaf path is dotted correctly', () => {
  const out = enforceFinalBudget(
    { execute_result: { body: { original_body: 'y'.repeat(60_000) } } },
    { ceiling: 10_000, toolName: 't' },
  );
  assert.equal(out.truncations[0].path, 'execute_result.body.original_body');
});

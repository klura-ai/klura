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
  message: 'TESTMSG: call close_session next.',
};

test('hoists obligation into a leading text block (default branch)', () => {
  const blocks = formatToolResult('perform_action', {
    ok: true,
    _session_obligation: obligation,
  });
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], {
    type: 'text',
    text: '[klura obligation]: TESTMSG: call close_session next.',
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
  assert.equal(blocks[0].text, '[klura obligation]: TESTMSG: call close_session next.');
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

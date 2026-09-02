// A rejection the agent cannot read is worse than no rejection: it retries
// blind against an error it never saw. One YouTube save produced a 2,067,711
// character save_strategy rejection from base64 prefetch URLs — it exceeded the
// tool-output budget, arrived truncated, and burned all 70 turns.
//
// Length is the unbounded dimension: collectUnsavedHotXhrEndpoints already caps
// the endpoint count at 20, so 20 half-megabyte URLs is all it takes.

import test from 'node:test';
import assert from 'node:assert';

import { collectObservedSiblingsForAudit } from '../dist/tools/save-strategy.js';
import { validateObservedSiblings } from '../dist/gate/save-audit.js';

const strategy = { strategy: 'fetch', method: 'GET', baseUrl: 'https://x.example', endpoint: '/own' };

/** A session whose capture inventory holds `n` endpoints of `urlChars` each. */
function sessionWith(n, urlChars) {
  const intercepted = [];
  for (let i = 0; i < n; i++) {
    const blob = 'A'.repeat(Math.max(0, urlChars));
    intercepted.push({
      method: 'GET',
      url: `https://x.example/api/ep${i}?data=${blob}`,
      resourceType: 'xhr',
      status: 200,
      responseBody: '{"ok":true}',
    });
  }
  return { intercepted, savedCapabilities: [], surfaceMap: {} };
}

test('a single enormous URL is truncated in the checklist', () => {
  const siblings = collectObservedSiblingsForAudit(sessionWith(1, 500_000), 'x', strategy);
  assert.ok(siblings.length >= 1);
  for (const s of siblings) {
    assert.ok(s.url.length < 400, `url still ${s.url.length} chars`);
    assert.ok(s.key.length < 400, `key still ${s.key.length} chars`);
  }
});

test('the truncation says how much was cut rather than hiding it', () => {
  const [first] = collectObservedSiblingsForAudit(sessionWith(1, 500_000), 'x', strategy);
  if (first && first.url.length > 0) assert.match(first.url, /…\[\d+ chars\]/);
});

test('the endpoint count stays bounded by the collector', () => {
  // Asserted here so the rendering budget below cannot be quietly invalidated
  // by a change to that upstream cap.
  const siblings = collectObservedSiblingsForAudit(sessionWith(5000, 10), 'x', strategy);
  assert.ok(siblings.length <= 20, `got ${siblings.length} checklist items`);
});

test('the whole rejection stays inside a readable budget', () => {
  // The property that actually failed: total rendered size.
  const siblings = collectObservedSiblingsForAudit(sessionWith(5000, 50_000), 'x', strategy);
  const rendered = validateObservedSiblings(siblings, {}).join('\n');
  assert.ok(
    rendered.length < 40_000,
    `rejection is ${rendered.length} chars — the failure was 2,067,711`,
  );
});

test('an ordinary small capture is unchanged', () => {
  const siblings = collectObservedSiblingsForAudit(sessionWith(3, 20), 'x', strategy);
  assert.ok(siblings.length <= 3);
  assert.ok(siblings.every((s) => !s.url.includes('…')));
});

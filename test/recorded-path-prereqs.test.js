// Recorded-path schema accepts `prerequisites: [...]` so capability prereqs
// can compose multi-capability flows (e.g. side-effect-only login →
// post-login action). Pre-fix the recorded-path schema omitted the field
// entirely, forcing agents to either inline the entire flow into one
// capability (multi-surface friction) or jump tiers unnecessarily.
//
// Covers:
//   - schema accepts a recorded-path with `prerequisites: [{kind: capability, ...}]`
//   - schema accepts a recorded-path with `prerequisites: []`
//   - schema accepts a recorded-path with no `prerequisites` field
//   - the catalog renders the prereq kinds section for the recorded-path tier

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-recorded-path-prereqs-'));
process.env.KLURA_HOME = TMP;

const { validateStrategyShape, saveStrategy } = await import('../dist/strategies/skills.js');
const { recordedPathSchema } = await import('../dist/strategies/schemas/strategy.js');
const { renderSaveStrategySchemaMarkdown } = await import(
  '../dist/strategies/schema-catalog.js'
);

test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test('recordedPathSchema accepts prerequisites: [{kind: "capability", ...}]', () => {
  const result = recordedPathSchema.safeParse({
    strategy: 'recorded-path',
    prerequisites: [
      {
        name: 'ensure_logged_in',
        kind: 'capability',
        capability: 'site_login',
      },
    ],
    steps: [
      {
        id: 'navigate_dashboard',
        action: 'navigate',
        url: 'https://example.com/dashboard',
      },
    ],
  });
  assert.equal(result.success, true, JSON.stringify(result.error?.issues ?? null));
});

test('recordedPathSchema accepts an empty prerequisites array', () => {
  const result = recordedPathSchema.safeParse({
    strategy: 'recorded-path',
    prerequisites: [],
    steps: [
      { id: 'navigate_home', action: 'navigate', url: 'https://example.com/' },
    ],
  });
  assert.equal(result.success, true);
});

test('recordedPathSchema still accepts no prerequisites field (backwards-shape)', () => {
  const result = recordedPathSchema.safeParse({
    strategy: 'recorded-path',
    steps: [
      { id: 'navigate_home', action: 'navigate', url: 'https://example.com/' },
    ],
  });
  assert.equal(result.success, true);
});

test('validateStrategyShape accepts a recorded-path with capability prereq', () => {
  // Save a target capability first so the capability-prereq self-loop /
  // missing-target check has something to resolve. Programmatic save bypasses
  // the audit (no session), so this is just on-disk schema validation.
  saveStrategy('prereq-test-platform', 'site_login', {
    strategy: 'recorded-path',
    steps: [
      { id: 'navigate_login', action: 'navigate', url: 'https://example.com/login' },
    ],
  });
  // Now the caller capability with the prereq should validate.
  validateStrategyShape({
    strategy: 'recorded-path',
    prerequisites: [
      { name: 'login_first', kind: 'capability', capability: 'site_login' },
    ],
    steps: [
      { id: 'navigate_dashboard', action: 'navigate', url: 'https://example.com/dashboard' },
    ],
  });
});

test('catalog renders prereq kinds section for the recorded-path tier', () => {
  const md = renderSaveStrategySchemaMarkdown({ tier: 'recorded-path' });
  assert.match(md, /Prereq kinds/);
  assert.match(md, /capability/);
  // Recorded-path-specific surface still shows the step list.
  assert.match(md, /Recorded-path step/);
});

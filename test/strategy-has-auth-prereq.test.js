// strategyHasAuthPrereq is the discriminator that routes a just-saved strategy
// into the "skip post-save probe, stamp post_save_validation: 'skipped'" branch
// (an auth-prereq strategy can't be probed cold — its credentials are caller-input
// on the login, not on this capability's args). It must recognize BOTH ways a
// strategy declares an auth dependency: a `{kind:'tag', tag:'auth'}` prereq, and a
// `{kind:'capability'}` prereq pointing at a capability that `provides: ['auth']`.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-auth-prereq-'));
process.env.KLURA_HOME = tmp;

const { saveStrategy } = await import('../dist/strategies/skills.js');
const { strategyHasAuthPrereq } = await import('../dist/tools/save-strategy.js');

const PLATFORM = 'auth-prereq-test';

test('tag:auth prereq → true (no disk lookup needed)', () => {
  const strat = { strategy: 'fetch', prerequisites: [{ kind: 'tag', tag: 'auth' }] };
  assert.equal(strategyHasAuthPrereq(strat, PLATFORM), true);
});

test('no prerequisites → false', () => {
  assert.equal(strategyHasAuthPrereq({ strategy: 'fetch' }, PLATFORM), false);
  assert.equal(strategyHasAuthPrereq({ strategy: 'fetch', prerequisites: [] }, PLATFORM), false);
});

test('non-auth tag + non-auth capability prereq → false', () => {
  const strat = {
    strategy: 'fetch',
    prerequisites: [
      { kind: 'tag', tag: 'csrf' },
      { kind: 'capability', capability: 'lookup_user_by_name' },
    ],
  };
  assert.equal(strategyHasAuthPrereq(strat, PLATFORM), false);
});

test('capability prereq pointing at an auth-providing capability → true', () => {
  // Seed a saved capability that advertises provides:['auth'] on this platform.
  saveStrategy(PLATFORM, 'login', {
    schema_version: 1,
    strategy: 'fetch',
    method: 'POST',
    baseUrl: 'http://example.test',
    endpoint: '/login',
    provides: ['auth'],
    notes: { params: {} },
  });
  const strat = {
    strategy: 'fetch',
    prerequisites: [{ kind: 'capability', capability: 'login' }],
  };
  assert.equal(strategyHasAuthPrereq(strat, PLATFORM), true);
});

test('capability prereq pointing at a NON-existent capability → false', () => {
  const strat = {
    strategy: 'fetch',
    prerequisites: [{ kind: 'capability', capability: 'does_not_exist' }],
  };
  assert.equal(strategyHasAuthPrereq(strat, PLATFORM), false);
});

test('malformed prereq entries are ignored, not thrown on', () => {
  const strat = {
    strategy: 'fetch',
    prerequisites: [null, 'oops', 42, { kind: 'tag' }, { kind: 'capability' }],
  };
  assert.equal(strategyHasAuthPrereq(strat, PLATFORM), false);
});

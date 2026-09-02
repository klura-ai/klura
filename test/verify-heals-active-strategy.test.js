// C3b: post-save verification of an ACTIVE strategy must heal its health.
//
// The candidate path already called markHealed on promotion; the active path
// stamped the proof and left the record alone. Health is keyed by capability +
// tier, so a re-saved strategy inherits the broken record of the bytes it
// replaced — and a broken tier is skipped before it runs. Verifying
// end-to-end and then being quarantined on the first real call is the freeze
// path this test pins shut.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-verify-heal-'));
process.env.KLURA_HOME = TMP;

const skills = await import('../dist/strategies/skills.js');
const { verifySavedStrategy } = await import('../dist/strategies/verify-saved-strategy.js');
const {
  markFailed,
  getHealth,
  silenceCapability,
  isSilenced,
  shouldSkipBrokenTier,
} = await import('../dist/strategies/health.js');

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

function pageScriptStrategy(payload) {
  return {
    strategy: 'page-script',
    baseUrl: 'https://example.test',
    prerequisites: [
      {
        name: 'result',
        kind: 'js-eval',
        url: 'https://example.test/list',
        expression: `JSON.stringify(${JSON.stringify(payload)})`,
        binds: 'result',
        return_shape: { kind: 'string' },
      },
    ],
    response: { from: 'result', format: 'json' },
  };
}

function makePool(payload) {
  const urls = new Map();
  let nextSession = 0;
  const driver = {
    async getUrl(session) {
      return urls.get(session.id) ?? 'about:blank';
    },
    async navigate(session, url) {
      urls.set(session.id, url);
    },
    async evaluateExpression() {
      return JSON.stringify(payload);
    },
  };
  return {
    async createSession() {
      const session = { id: `s-${++nextSession}`, intercepted: [], intercepting: false };
      urls.set(session.id, 'about:blank');
      return session;
    },
    createNodeOnlySession() {
      throw new Error('unexpected node-only session');
    },
    async endDrive() {},
    getSession(sessionId) {
      return { id: sessionId, intercepted: [], intercepting: false };
    },
    driverFor() {
      return driver;
    },
    async shutdown() {},
    get activeSessions() {
      return 0;
    },
    get activeSessionIds() {
      return [];
    },
    get idleSince() {
      return 0;
    },
    get connectEnabled() {
      return false;
    },
  };
}

function breakTier(platform, capability, type) {
  for (let i = 0; i < 5; i++) markFailed(platform, capability, type, 'site moved the endpoint');
  assert.equal(getHealth(platform, capability, type).status, 'broken');
}

test('verifySavedStrategy: an explicit success heals the inherited broken record', async () => {
  const platform = 'verify-heal';
  const capability = 'list_things';
  skills.commitValidatedStrategy(platform, capability, pageScriptStrategy({ ok: true, items: [{ id: 1 }] }));
  breakTier(platform, capability, 'page-script');

  const result = await verifySavedStrategy(
    platform,
    capability,
    {},
    makePool({ ok: true, items: [{ id: 1 }] }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.classification, 'explicit_success');
  const healed = getHealth(platform, capability, 'page-script');
  assert.equal(healed.status, 'healthy');
  assert.equal(healed.failureCount, 0);
  assert.equal(healed.healCount, 1, 'the heal is recorded, not silently folded into markHealthy');
  assert.equal(
    shouldSkipBrokenTier(platform, capability, 'page-script').action,
    'run',
    'the next execute must reach the tier it just verified',
  );
});

test('verifySavedStrategy: the heal clears a stale rediscover silence', async () => {
  const platform = 'verify-heal-silence';
  const capability = 'list_things';
  skills.commitValidatedStrategy(platform, capability, pageScriptStrategy({ ok: true, items: [{ id: 1 }] }));
  breakTier(platform, capability, 'page-script');
  silenceCapability(platform, capability);
  assert.equal(isSilenced(platform, capability), true);

  await verifySavedStrategy(platform, capability, {}, makePool({ ok: true, items: [{ id: 1 }] }));

  assert.equal(
    isSilenced(platform, capability),
    false,
    "a working capability must not carry the user's don't-ask answer about a strategy that no longer exists",
  );
});

test('verifySavedStrategy: an empty declared collection does NOT heal', async () => {
  // The empty-collection downgrade routes to semantic review. Healing there
  // would promote "the request went through" to "the capability works".
  const platform = 'verify-heal-empty';
  const capability = 'list_things';
  skills.commitValidatedStrategy(platform, capability, pageScriptStrategy({ ok: true, items: [] }));
  breakTier(platform, capability, 'page-script');

  const result = await verifySavedStrategy(
    platform,
    capability,
    {},
    makePool({ ok: true, items: [] }),
  );

  assert.equal(result.classification, 'transport_accepted');
  assert.equal(result.semantic_review_reason, 'declared_collection_empty');
  const after = getHealth(platform, capability, 'page-script');
  assert.equal(after.status, 'broken');
  assert.equal(after.healCount, undefined);
});

test('verifySavedStrategy: a failed verification does not heal', async () => {
  const platform = 'verify-heal-failure';
  const capability = 'list_things';
  skills.commitValidatedStrategy(
    platform,
    capability,
    pageScriptStrategy({ ok: false, outcome: 'blocked' }),
  );
  breakTier(platform, capability, 'page-script');

  const result = await verifySavedStrategy(
    platform,
    capability,
    {},
    makePool({ ok: false, outcome: 'blocked' }),
  );

  assert.equal(result.ok, false);
  const after = getHealth(platform, capability, 'page-script');
  assert.equal(after.status, 'broken');
  assert.equal(after.healCount, undefined);
});

test('verification traffic still does not touch health on its own', async () => {
  // `_suppressStrategyState` keeps the verification execute health-silent;
  // markHealed is the one deliberate write through that wall. A degraded
  // record must therefore show exactly one heal, not a heal plus the
  // executor's own markHealthy.
  const platform = 'verify-heal-single-write';
  const capability = 'list_things';
  skills.commitValidatedStrategy(platform, capability, pageScriptStrategy({ ok: true, items: [{ id: 1 }] }));
  markFailed(platform, capability, 'page-script', 'one blip');

  await verifySavedStrategy(platform, capability, {}, makePool({ ok: true, items: [{ id: 1 }] }));

  const after = getHealth(platform, capability, 'page-script');
  assert.equal(after.status, 'healthy');
  assert.equal(after.healCount, 1);
  assert.deepEqual(after.recent, [false, true]);
});

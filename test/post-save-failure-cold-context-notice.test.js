// Post-save verification: an explicit_failure on a browser-backed candidate
// must say the run was cold.
//
// The runtime cannot know why a strategy reported its own typed failure, but
// it does know one structural fact the agent often does not: verification ran
// in a fresh context with persisted cookies and storage stripped. A mechanism
// that only exists once the page is an established session — an in-page module
// the app registers on some routes only, a logged-in variant, a token minted
// on first visit — is present in the authoring session and absent here, which
// reads as an inexplicable failure unless the contract is stated. Saying it in
// the rejection is the difference between one measurement and several wasted
// candidates.
//
// Scoped to browser-backed tiers: a node `fetch` carries no page state, so the
// notice would be noise there.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-post-save-cold-notice-'));
process.env.KLURA_HOME = TMP;

const skills = await import('../dist/strategies/skills.js');
const { verifyStrategyCandidate } = await import('../dist/strategies/verify-saved-strategy.js');

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

/** A page-script whose expression reports its own typed failure — the shape a
 *  strategy emits when the mechanism it depends on is not there. */
function failingPageScript() {
  return {
    strategy: 'page-script',
    baseUrl: 'https://example.test',
    prerequisites: [
      {
        name: 'result',
        kind: 'js-eval',
        url: 'https://example.test/target',
        expression: 'JSON.stringify({ ok: false, code: "query_module_absent" })',
        binds: 'result',
        return_shape: { kind: 'string' },
      },
    ],
    response: { from: 'result', format: 'json' },
  };
}

function makePool() {
  let nextSession = 0;
  const urls = new Map();
  const driver = {
    async getUrl(session) {
      return urls.get(session.id) ?? 'about:blank';
    },
    async navigate(session, url) {
      urls.set(session.id, url);
    },
    async evaluateExpression() {
      // The strategy under test reports its own typed failure.
      return JSON.stringify({ ok: false, code: 'query_module_absent' });
    },
  };
  return {
    async createSession() {
      return { id: `fresh-${++nextSession}`, intercepted: [], intercepting: false };
    },
    createNodeOnlySession() {
      throw new Error('browser verification must not create a node-only session');
    },
    async endDrive() {},
    getSession(id) {
      return { id, intercepted: [], intercepting: false };
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

test('explicit_failure on a page-script names the cold context and where the fix belongs', async () => {
  const candidate = skills.stageValidatedStrategyCandidate(
    'coldnotice',
    'get_thing',
    failingPageScript(),
  );
  const result = await verifyStrategyCandidate(candidate, {}, makePool());

  assert.equal(result.ok, false);
  assert.equal(result.classification, 'explicit_failure');
  assert.equal(result.active, false);

  // The pre-existing contract still holds.
  assert.match(result.message, /strategy_candidate_failed/);
  assert.match(result.message, /prior active strategy is unchanged/);

  // The addition: state the run was cold, and assign the fix to a prereq.
  assert.match(result.message, /fresh browser context/);
  assert.match(
    result.message,
    /empty cookie jar/,
    'the jar is stripped for the Node fire path too, and the notice has to say so',
  );
  assert.match(result.message, /prereq/);
  assert.match(
    result.message,
    /this same run/,
    'must say prereq side effects persist for the run, or the remedy is unactionable',
  );
});

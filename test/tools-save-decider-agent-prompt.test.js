// The tools-path save (`tools/save-strategy.ts`) synthesizes the
// user_confirmation answer from a registered SaveConfirmationDecider the
// same way `skills.saveStrategy` does — including a deterministic
// composeUserPrompt rendering as `agent_prompt`. On the branches where the
// classifier stays active (decider rejects), Stage-2 validation must
// surface the decider's verdict, not a spurious missing-agent_prompt
// bullet ahead of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-tools-decider-prompt-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const { pool } = await import('../dist/runtime-state/index.js');
const { saveStrategy, SaveStrategyRejection } = await import('../dist/tools/save-strategy.js');
const { registerSaveConfirmationDecider, unregisterSaveConfirmationDecider } = await import(
  '../dist/audit/lift/save-confirmation-decider.js'
);

const PLATFORM = 'tools-decider-prompt-test';
const CAPABILITY = 'list_items';
const SESSION_ID = 'sess_tools_decider_prompt';

const fakeSession = {
  id: SESSION_ID,
  platform: PLATFORM,
  intercepted: [],
  visitedUrls: [],
  performActionHistory: [],
};

const fakeDriver = {
  getInterceptedRequests: async () => [
    { url: 'https://site.example.com/api/items', headers: {} },
  ],
  getInterceptedWebSocketFrames: async () => [],
  saveStorageState: async () => {},
};

function strategyPayload() {
  return {
    strategy: 'page-script',
    baseUrl: 'https://site.example.com',
    endpoint: '/api/items',
    method: 'GET',
    notes: {
      params: { cursor: { description: 'pagination', kind: 'text', example: '' } },
      anchor_type: 'dom',
    },
  };
}

test('decider reject on the tools path: verdict surfaces without a spurious agent_prompt bullet', async () => {
  const originalGetSession = pool.getSession.bind(pool);
  const originalDriverFor = pool.driverFor.bind(pool);
  pool.getSession = (id) => (id === SESSION_ID ? fakeSession : originalGetSession(id));
  pool.driverFor = (id) => (id === SESSION_ID ? fakeDriver : originalDriverFor(id));
  registerSaveConfirmationDecider({
    name: 'tools-decider-prompt-reject',
    decide() {
      return { decision: 'reject', quote: 'harness declined this save' };
    },
  });
  try {
    // First call: token-minting rejection.
    let token;
    try {
      await saveStrategy(PLATFORM, CAPABILITY, strategyPayload(), undefined, SESSION_ID);
      assert.fail('first call should have rejected with an audit token');
    } catch (err) {
      assert.ok(err instanceof SaveStrategyRejection, `unexpected error: ${err.message}`);
      const match = err.message.match(/audit_token:\s*(\S+)/);
      assert.ok(match, `no audit_token in: ${err.message}`);
      token = match[1];
    }

    // Second call: echo the token + detector answers. The decider's reject
    // verdict must be the user_confirmation issue — the synthesized answer
    // carries agent_prompt, so the fact-check cannot emit its
    // missing-agent_prompt bullet ahead of the verdict.
    try {
      await saveStrategy(PLATFORM, CAPABILITY, strategyPayload(), undefined, SESSION_ID, {
        token,
        answers: {
          literal_provenance: { endpoint: 'static' },
          observed_siblings: {},
        },
      });
      assert.fail('second call should have rejected on the decider verdict');
    } catch (err) {
      assert.ok(err instanceof SaveStrategyRejection, `unexpected error: ${err.message}`);
      assert.match(err.message, /Go back to LIFT/);
      assert.doesNotMatch(err.message, /agent_prompt must be a non-empty string/);
    }
  } finally {
    unregisterSaveConfirmationDecider('tools-decider-prompt-reject');
    pool.getSession = originalGetSession;
    pool.driverFor = originalDriverFor;
  }
});

// getSessionObligation suppresses the sticky LIFT banner on the LIFT-flow
// tools (save_strategy, update_strategy, end_drive, submit_triage_plan,
// declare_capability) whose own response envelope already carries the
// authoritative next step. Prepending the banner there buries the actionable
// rejection text below the fold and repeats verbatim on every retry. The
// banner still fires on read / perform_action responses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-obligation-suppress-'));
process.env.KLURA_HOME = tmp;

const { getSessionObligation } = await import('../dist/tools/session-envelopes.js');
const { pool } = await import('../dist/runtime-state/index.js');

// A session that has typed (write action) into a declared capability with no
// save yet — computeSessionObligation returns a non-null lift obligation.
function mkCommittedSession(id) {
  return {
    id,
    graph: 'discover',
    status: 'active',
    phase: 'lift',
    platform: 'p',
    declaredCapabilities: [{ capability: 'send_message', args: {}, declared_at: 0 }],
    performActionHistory: [{ action: 'type', at: 100 }],
    domNavigations: [],
    savedCapabilities: [],
    saveAttemptCount: 1,
  };
}

function patchPool(session) {
  const origGet = pool.getSession;
  pool.getSession = (id) => (id === session.id ? session : origGet.call(pool, id));
  return () => {
    pool.getSession = origGet;
  };
}

test('obligation fires on perform_action / read tool responses', () => {
  const session = mkCommittedSession('sess-ob-1');
  const restore = patchPool(session);
  try {
    const ob = getSessionObligation(session.id, 'perform_action');
    assert.ok(ob, 'obligation should fire on perform_action');
    assert.match(ob.message, /save_strategy/);
  } finally {
    restore();
  }
});

test('obligation is suppressed on LIFT-flow tools', () => {
  const session = mkCommittedSession('sess-ob-2');
  const restore = patchPool(session);
  try {
    for (const tool of [
      'save_strategy',
      'update_strategy',
      'end_drive',
      'submit_triage_plan',
      'declare_capability',
    ]) {
      assert.equal(
        getSessionObligation(session.id, tool),
        null,
        `obligation should be suppressed on ${tool}`,
      );
    }
  } finally {
    restore();
  }
});

test('obligation still fires when no toolName is passed (back-compat)', () => {
  const session = mkCommittedSession('sess-ob-3');
  const restore = patchPool(session);
  try {
    assert.ok(getSessionObligation(session.id));
  } finally {
    restore();
  }
});

// Regression: session_summary.observed_unlifted_this_session must reflect the
// capabilities observed-but-not-lifted this session. buildSessionSummary reads
// the per-session observed-names map (getObservedNamesForSession). The
// end-drive orchestrator wipes that map via clearObservedSessionTracking as
// part of teardown — so buildSessionSummary MUST be called BEFORE the clear.
// When the order was reversed, observed_unlifted_this_session was structurally
// always [], silently erasing the under-saving signal the field exists to
// carry (the retro template tells the agent "anything not in session_summary
// did not happen this session", so the agent faithfully reports nothing).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-session-summary-test-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const { buildSessionSummary, countPerformActionCalls } = await import(
  '../dist/phases/drive/session-summary.js'
);
const { recordObservedCapability, clearObservedSessionTracking } = await import(
  '../dist/working-dir/logbook.js'
);

const PLATFORM = 'example';
const SESSION_ID = 'sess-summary-1';

function seedObserved(name) {
  recordObservedCapability(PLATFORM, {
    name,
    evidence: { source: 'network_log', detail: `${name} XHR observed` },
    why_not_lifted: 'turn_budget',
    session_id: SESSION_ID,
  });
}

function makeSession() {
  return {
    id: SESSION_ID,
    savedCapabilities: [{ capability: 'lifted_one', at: 1, tier: 'fetch' }],
    declaredCapabilities: [{ capability: 'lifted_one', args: {}, declared_at: 1 }],
    visitedUrls: ['https://example.com/a'],
    intercepted: [],
    abandonedSaveAttempts: [],
    performActionHistory: [],
  };
}

test('observed-but-unlifted slugs surface in session_summary when built before the clear', () => {
  seedObserved('lifted_one'); // saved + declared → must NOT appear as unlifted
  seedObserved('observed_unlifted_a'); // observed, never lifted → must appear
  seedObserved('observed_unlifted_b');

  const session = makeSession();
  const summary = buildSessionSummary(session, [], countPerformActionCalls(session));

  assert.deepEqual(
    [...summary.observed_unlifted_this_session].sort(),
    ['observed_unlifted_a', 'observed_unlifted_b'],
    'unlifted observations (minus saved/declared) must be reported',
  );
});

test('clearObservedSessionTracking empties the field — proves summary must precede the clear', () => {
  // Re-uses the map seeded above (same SESSION_ID). After the teardown clear,
  // a summary build reads an empty map. This is exactly the orchestrator
  // ordering hazard the regression guards: clear-then-summarize loses the data.
  clearObservedSessionTracking(SESSION_ID);

  const session = makeSession();
  const summary = buildSessionSummary(session, [], countPerformActionCalls(session));

  assert.deepEqual(
    summary.observed_unlifted_this_session,
    [],
    'after the tracking map is cleared, the summary can no longer report unlifted slugs',
  );
});

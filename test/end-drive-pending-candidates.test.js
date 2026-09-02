// A staged candidate is written but inactive. Close stays admissible with one
// pending — `save_attempted_none_landed` counts it as landed, correctly, since
// something did reach disk — so the agent gets no rejection to read. A session
// that stops at the stage step closes clean while the capability has nothing to
// execute and the work sits one call away. The close response is the surface the
// agent is reading at that exact moment, so it names them there.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-pending-candidates-test-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const { collectPendingCandidates } = await import(
  '../dist/phases/drive/end-drive-orchestrator.js'
);
const skills = await import('../dist/strategies/skills.js');

const PLATFORM = 'cand-test';

function candidate(capability, candidateId, tier = 'page-script') {
  return { capability, at: Date.now(), tier, candidateId };
}

function fetchStrategy() {
  return {
    schema_version: 1,
    strategy: 'fetch',
    method: 'GET',
    baseUrl: 'http://example.test',
    endpoint: '/api/places',
    notes: { params: {} },
  };
}

test('a staged candidate with no active strategy is reported', () => {
  const out = collectPendingCandidates(
    { savedCandidates: [candidate('search_places', 'cand_a1')] },
    PLATFORM,
  );

  assert.ok(out, 'expected a pending-candidates advisory');
  assert.deepEqual(out.candidates, [
    { capability: 'search_places', tier: 'page-script', candidate_id: 'cand_a1' },
  ]);
  assert.match(out.advisory, /review_strategy_candidate/);
  assert.match(out.advisory, /no active\s+strategy to execute/);
});

test('a staged candidate is still reported when the capability has an active strategy', () => {
  // The observed loss: one save went active without its pagination cursor, then
  // eight corrected candidates were staged and never reviewed. Suppressing on
  // "something is active" hid every one of them and left callers on the worse
  // strategy — so an active sibling changes the wording, not the reporting.
  skills.saveStrategy(PLATFORM, 'already_active', fetchStrategy());

  const out = collectPendingCandidates(
    { savedCandidates: [candidate('already_active', 'cand_b2', 'fetch')] },
    PLATFORM,
  );

  assert.ok(out, 'staged work must not be dropped because some strategy is active');
  assert.deepEqual(out.candidates.map((c) => c.candidate_id), ['cand_b2']);
  assert.match(
    out.advisory,
    /callers still get the older strategy/,
    'the advisory has to name the consequence the agent cannot see',
  );
});

test('with nothing active, the advisory says the capability is unrunnable', () => {
  const out = collectPendingCandidates(
    { savedCandidates: [candidate('never_active', 'cand_c2')] },
    PLATFORM,
  );

  assert.ok(out);
  assert.match(out.advisory, /no active\s+strategy to execute/);
  assert.doesNotMatch(out.advisory, /older strategy/);
});

test('no candidates and no platform both yield no advisory', () => {
  assert.equal(collectPendingCandidates({ savedCandidates: [] }, PLATFORM), undefined);
  assert.equal(collectPendingCandidates({}, PLATFORM), undefined);
  assert.equal(
    collectPendingCandidates({ savedCandidates: [candidate('x', 'cand_d1')] }, undefined),
    undefined,
  );
});

test('the advisory pluralizes across several pending candidates', () => {
  const out = collectPendingCandidates(
    {
      savedCandidates: [candidate('search_places', 'cand_e1'), candidate('get_place', 'cand_e2')],
    },
    PLATFORM,
  );

  assert.ok(out);
  assert.equal(out.candidates.length, 2);
  assert.match(out.advisory, /those capabilities have/);
  assert.deepEqual(
    out.candidates.map((c) => c.candidate_id).sort(),
    ['cand_e1', 'cand_e2'],
  );
});

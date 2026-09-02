// Unit tests for the save policy (`evaluateSavePolicy`) and the Audit
// class's unattended pipeline (`runUnattended`).
//
// One SavePolicy entry serves EVERY strategy producer; differences between
// producers are expressed via origin, never by skipping the audit:
//   - agent_explicit delegates to `saveStrategyAudit.process` (token flow).
//   - auto_synth_* / graduation run Stage-0 shape + Stage-1 detectors per
//     each detector's `unattendedPolicy`; blocking issues throw
//     `SavePolicyBlockedError`.
//   - programmatic (embedder code, not LLM-emitted) demotes blocking
//     issues to warnings in the returned AuditResult.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-save-policy-test-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const { Audit } = await import('../dist/audit/index.js');
const { evaluateSavePolicy, SavePolicyBlockedError } = await import(
  '../dist/audit/lift/save-policy.js'
);
const { saveStrategyAudit } = await import('../dist/audit/lift/save-strategy.js');
const { SAVE_ORIGINS, AUDIT_KINDS } = await import('../dist/vocab/index.js');
const skills = await import('../dist/strategies/skills.js');

// ---------- Audit.runUnattended (unit) ----------

function issue(kind) {
  return [{ kind, message: `${kind} fired` }];
}

test('runUnattended: ackReason none → blocking, required → warning by default', () => {
  const audit = new Audit({
    kind: 'unit_test_audit',
    detectors: [
      { kind: 'hard_invariant', ackReason: 'none', detect: () => issue('hard_invariant') },
      { kind: 'advisory', ackReason: 'required', detect: () => issue('advisory') },
    ],
    classifiers: [],
  });
  const { blocking, warnings } = audit.runUnattended({}, {});
  assert.deepEqual(
    blocking.map((i) => i.kind),
    ['hard_invariant'],
  );
  assert.deepEqual(
    warnings.map((i) => i.kind),
    ['advisory'],
  );
});

test('runUnattended: explicit unattendedPolicy overrides the ackReason default', () => {
  const audit = new Audit({
    kind: 'unit_test_audit',
    detectors: [
      {
        kind: 'agent_workflow_check',
        ackReason: 'none',
        unattendedPolicy: 'skip',
        detect: () => issue('agent_workflow_check'),
      },
      {
        kind: 'downgraded_invariant',
        ackReason: 'none',
        unattendedPolicy: 'warn',
        detect: () => issue('downgraded_invariant'),
      },
    ],
    classifiers: [],
  });
  const { blocking, warnings } = audit.runUnattended({}, {});
  assert.deepEqual(blocking, []);
  assert.deepEqual(
    warnings.map((i) => i.kind),
    ['downgraded_invariant'],
  );
});

test('runUnattended: classifiers project only via unattendedWarnings (warn-tier, never blocking)', () => {
  const audit = new Audit({
    kind: 'unit_test_audit',
    detectors: [],
    classifiers: [
      {
        kind: 'silent_classifier',
        buildItems: () => ({ items: ['a'] }),
        validate: () => [],
        expectedAnswerShape: 'silent_classifier: "<x>"',
        remedy: () => ({ kind: 'no_programmatic_remedy', reason: 'unit fixture' }),
      },
      {
        kind: 'projecting_classifier',
        buildItems: () => ({ items: ['a'] }),
        validate: () => [],
        expectedAnswerShape: 'projecting_classifier: "<x>"',
        remedy: () => ({ kind: 'no_programmatic_remedy', reason: 'unit fixture' }),
        unattendedWarnings: () => issue('projecting_classifier'),
      },
    ],
  });
  const { blocking, warnings } = audit.runUnattended({}, {});
  assert.deepEqual(blocking, []);
  assert.deepEqual(
    warnings.map((i) => i.kind),
    ['projecting_classifier'],
  );
});

test('detectorKinds / classifierKinds enumerate the composed spec', () => {
  const audit = new Audit({
    kind: 'unit_test_audit',
    detectors: [{ kind: 'd1', ackReason: 'none', detect: () => [] }],
    classifiers: [
      {
        kind: 'c1',
        buildItems: () => null,
        validate: () => [],
        expectedAnswerShape: 'c1: "<x>"',
        remedy: () => ({ kind: 'no_programmatic_remedy', reason: 'unit fixture' }),
      },
    ],
  });
  assert.deepEqual(audit.detectorKinds(), ['d1']);
  assert.deepEqual(audit.classifierKinds(), ['c1']);
});

// ---------- evaluateSavePolicy over the real saveStrategyAudit ----------

function sensitiveFetchStrategy() {
  return {
    strategy: 'fetch',
    method: 'POST',
    baseUrl: 'https://shop.example.test',
    endpoint: '/api/checkout',
    contentType: 'json',
    headers: {},
    body: { card_number: '4111111111111111', cvv: '123' },
  };
}

function paramlessRecordedPath() {
  return {
    strategy: 'recorded-path',
    steps: [{ id: 'nav_home', action: 'navigate', url: 'https://example.test/' }],
    notes: {},
  };
}

test('policy: auto-synth origin blocks sensitive-shaped strategies', () => {
  const strategy = sensitiveFetchStrategy();
  assert.throws(
    () =>
      evaluateSavePolicy({
        origin: SAVE_ORIGINS.autoSynthFetch,
        platform: 'save-policy-test',
        capability: 'place_order',
        strategy,
        evidence: {},
      }),
    (err) => {
      assert.ok(err instanceof SavePolicyBlockedError);
      assert.match(err.message, /^save_policy_blocked:/);
      assert.ok(
        err.issues.some((i) => i.kind === AUDIT_KINDS.sensitiveActionMustBeRecordedNotSaved),
        `expected sensitive kind among: ${err.issues.map((i) => i.kind).join(', ')}`,
      );
      return true;
    },
  );
  // A blocked save must not decorate the strategy either.
  assert.equal(strategy.runtime_meta, undefined);
});

test('policy: graduation origin blocks sensitive-shaped strategies too', () => {
  assert.throws(
    () =>
      evaluateSavePolicy({
        origin: SAVE_ORIGINS.graduation,
        platform: 'save-policy-test',
        capability: 'place_order',
        strategy: sensitiveFetchStrategy(),
        evidence: {},
      }),
    SavePolicyBlockedError,
  );
});

test('policy: programmatic origin demotes blocking issues to returned warnings, undecorated', () => {
  // Programmatic saves are embedder code persisting a hand-constructed
  // strategy — not LLM-emitted. Blocking demotes to warnings in the
  // AuditResult; runtime_meta stays untouched.
  const strategy = sensitiveFetchStrategy();
  const result = evaluateSavePolicy({
    origin: SAVE_ORIGINS.programmatic,
    platform: 'save-policy-test',
    capability: 'place_order',
    strategy,
    evidence: {},
  });
  assert.equal(result.status, 'committed');
  assert.ok(
    result.warnings.some((w) => w.kind === AUDIT_KINDS.sensitiveActionMustBeRecordedNotSaved),
  );
  assert.equal(strategy.runtime_meta, undefined);
});

test('policy: auto-synth origin persists warn-tier issues on runtime_meta.save_warnings', () => {
  // A paramless strategy trips the parameterization classifier's
  // unattended projection — the advisory must land on the artifact for
  // the next attended session to read.
  const strategy = paramlessRecordedPath();
  const result = evaluateSavePolicy({
    origin: SAVE_ORIGINS.autoSynthRecorded,
    platform: 'save-policy-test',
    capability: 'open_home',
    strategy,
    evidence: {},
  });
  assert.equal(result.status, 'committed');
  const persisted = (strategy.runtime_meta?.save_warnings ?? []).map((w) => w.kind);
  assert.ok(
    persisted.includes('parameterization_disclosure_required'),
    `expected parameterization advisory on runtime_meta, got: ${persisted.join(', ')}`,
  );
});

test('policy: observedUrls undefined means "no evidence"; empty list means "captured nothing"', () => {
  const paramlessFetch = () => ({
    strategy: 'fetch',
    method: 'GET',
    baseUrl: 'https://example.test',
    endpoint: '/api/data',
    headers: {},
    notes: {},
  });
  // undefined → the unobserved_url detector skips entirely.
  const noEvidence = paramlessFetch();
  evaluateSavePolicy({
    origin: SAVE_ORIGINS.autoSynthFetch,
    platform: 'save-policy-test',
    capability: 'read_no_evidence',
    strategy: noEvidence,
    evidence: {},
  });
  const noEvidenceKinds = (noEvidence.runtime_meta?.save_warnings ?? []).map((w) => w.kind);
  assert.ok(!noEvidenceKinds.includes(AUDIT_KINDS.unobservedUrl));

  // [] → every strategy URL is unobserved; warn-tier on unattended saves
  // (synth URLs are legitimately templated), so the save still commits
  // with the advisory attached.
  const emptyCapture = paramlessFetch();
  const result = evaluateSavePolicy({
    origin: SAVE_ORIGINS.autoSynthFetch,
    platform: 'save-policy-test',
    capability: 'read_empty_capture',
    strategy: emptyCapture,
    evidence: { observedUrls: [] },
  });
  assert.equal(result.status, 'committed');
  const emptyKinds = (emptyCapture.runtime_meta?.save_warnings ?? []).map((w) => w.kind);
  assert.ok(
    emptyKinds.includes(AUDIT_KINDS.unobservedUrl),
    `expected unobserved_url advisory, got: ${emptyKinds.join(', ')}`,
  );
});

test('policy: agent_explicit delegates to saveStrategyAudit.process (token flow intact)', () => {
  // A clean minimal strategy with a live classifier (user_confirmation)
  // must reject `pending` with a token on first call — exactly what
  // process() does. The policy adds no parallel gate on the agent path.
  const strategy = paramlessRecordedPath();
  const viaPolicy = evaluateSavePolicy({
    origin: SAVE_ORIGINS.agentExplicit,
    platform: 'save-policy-test',
    capability: 'open_home_explicit',
    strategy,
    evidence: { sessionId: 'sess_policy_explicit' },
    auditInput: {},
  });
  const direct = saveStrategyAudit.process(
    strategy,
    {
      sessionId: 'sess_policy_explicit',
      platform: 'save-policy-test',
      capability: 'open_home_explicit',
      session: null,
      observedSiblings: [],
      observedParamValues: {},
      capturedEndpointPaths: new Set(),
    },
    {},
  );
  assert.equal(viaPolicy.status, 'rejected');
  assert.equal(direct.status, 'rejected');
  assert.equal(viaPolicy.rejection.reason, direct.rejection.reason);
});

// ---------- skills.saveStrategy routing ----------

test('skills.saveStrategy: auto-synth origin refuses sensitive saves; nothing lands on disk', () => {
  const platform = 'save-policy-skills-blocked';
  const strategy = {
    strategy: 'recorded-path',
    steps: [{ id: 'nav_pay', action: 'navigate', url: 'https://shop.example.test/pay' }],
    notes: {
      params: {
        card_number: { description: 'payment card', kind: 'text', example: '4111111111111111' },
      },
    },
  };
  assert.throws(
    () =>
      skills.saveStrategy(platform, 'place_order', strategy, undefined, undefined, undefined, {
        origin: SAVE_ORIGINS.autoSynthRecorded,
        evidence: {},
      }),
    /save_policy_blocked/,
  );
  assert.deepEqual(skills.loadStrategies(platform, 'place_order'), []);
});

test('skills.saveStrategy: sessionId-less default is programmatic — embedder saves land', () => {
  // Compatibility pin: programmatic callers (tests, host applications)
  // keep landing hand-constructed strategies; the policy runs (shape +
  // detectors) but demotes blocking to warnings for this origin.
  const platform = 'save-policy-skills-programmatic';
  const strategy = sensitiveFetchStrategy();
  const savedPath = skills.saveStrategy(platform, 'place_order', strategy);
  assert.match(savedPath, /\.json$/);
  assert.equal(skills.loadStrategies(platform, 'place_order').length, 1);
});

test('tools.saveStrategy: sessionId-less save commits and surfaces demoted policy warnings on the response', async () => {
  // The tool's sessionId-less branch runs the policy at the programmatic
  // origin, which demotes blocking issues to warnings and leaves
  // runtime_meta undecorated — the tool response is the only surface that
  // carries them to the embedder.
  const { saveStrategy: saveStrategyTool } = await import('../dist/tools/save-strategy.js');
  const platform = 'save-policy-tool-programmatic';
  const result = await saveStrategyTool(platform, 'place_order', sensitiveFetchStrategy());
  assert.equal(result.ok, true);
  const kinds = (result.save_warnings ?? []).map((w) => w.kind);
  assert.ok(
    kinds.includes(AUDIT_KINDS.sensitiveActionMustBeRecordedNotSaved),
    `expected demoted sensitive-shape warning on the tool response, got: ${kinds.join(', ')}`,
  );
  const saved = skills.loadStrategies(platform, 'place_order')[0];
  assert.equal(saved.runtime_meta?.save_warnings, undefined);
});

test('skills.saveStrategy: unattended evidence.sessionId feeds the enum snapshot at commit', async () => {
  // Passing evidence with a sessionId activates snapshotEnumObservationsIntoSave
  // for unattended saves — enum params gain observed_values from session
  // observations, the same data-quality path explicit saves get.
  const { recordParamObservation } = await import('../dist/response/session-observations.js');
  const sessionId = 'sess_policy_enum_snapshot';
  recordParamObservation(sessionId, {
    param_name: 'category',
    value: 'italian',
    source: { kind: 'ui_click', label: 'Italian' },
    observed_at: Date.now(),
  });
  const platform = 'save-policy-enum-snapshot';
  const strategy = {
    strategy: 'fetch',
    method: 'GET',
    baseUrl: 'https://food.example.test',
    endpoint: '/api/list?category={{category}}',
    headers: {},
    notes: {
      params: {
        category: { description: 'cuisine filter', kind: 'enum', example: 'italian' },
      },
    },
  };
  skills.saveStrategy(platform, 'list_restaurants', strategy, undefined, undefined, undefined, {
    origin: SAVE_ORIGINS.autoSynthFetch,
    evidence: { sessionId, observedUrls: ['https://food.example.test/api/list?category=italian'] },
  });
  const saved = skills.loadStrategies(platform, 'list_restaurants')[0];
  const observed = saved?.notes?.params?.category?.observed_values ?? [];
  assert.ok(
    observed.some((v) => v.value === 'italian'),
    `expected snapshotted observed_values, got: ${JSON.stringify(observed)}`,
  );
});

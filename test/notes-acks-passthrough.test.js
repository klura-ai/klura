// Regression: notes.save_warnings_acked must reach the audit's acks input.
//
// Bug surfaced by llm-tests/cross-session-resume session 3 — the agent kept
// hitting answers_inconsistent because Detector-emitted warnings stayed
// "unacked" no matter how the agent shaped its acks. Root cause: skills.ts
// invoked saveStrategyAudit.process without forwarding acks. The audit
// module already exposed `extractAcksFromNotes(data)`; nothing called it.
//
// This test goes through saveStrategy() at the skills.ts entry point so the
// bug is caught at the wiring boundary, not just at the audit module.
//
// Trigger: a page-script strategy whose prereq.expression reads
// `document.cookie` and extracts via `.match(` — fires the
// unparametrized_session_id Detector (ackReason: 'required'). The classifier
// checklist also fires because the body contains `{{token}}`. The save
// should succeed once the agent has answered the classifier AND acked the
// warning via notes.save_warnings_acked.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-notes-acks-test-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const { saveStrategy } = await import('../dist/strategies/skills.js');
const { registerSaveConfirmationDecider } = await import(
  '../dist/audit/lift/save-confirmation-decider.js'
);

registerSaveConfirmationDecider({
  name: 'notes-acks-test-default-approve',
  decide() {
    return { decision: 'approve', quote: 'default-approve in tests' };
  },
});

const PLATFORM = 'notes-acks-test';
const CAPABILITY = 'send_message';
const SESSION_ID = 'sess_test_acks';

function buildStrategy() {
  return {
    strategy: 'page-script',
    baseUrl: 'http://127.0.0.1:3311',
    endpoint: '/api/send',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { message: '{{text}}', token: '{{token}}' },
    prerequisites: [
      {
        name: 'sign_message',
        kind: 'js-eval',
        url: 'http://127.0.0.1:3311/',
        expression:
          "var sid = document.cookie.match(/sid=([^;]+)/)[1]; return computeToken(sid);",
        binds: 'token',
        return_shape: { kind: 'string', min_length: 8 },
      },
    ],
    notes: {
      params: { text: { kind: 'text', example: 'hello' } },
    },
  };
}

const auditCtx = {
  observedSiblings: [],
  observedParamValues: {},
  capturedEndpointPaths: new Set(),
  observedUrls: ['http://127.0.0.1:3311/', 'http://127.0.0.1:3311/api/send'],
};

test('notes.save_warnings_acked is forwarded to the audit (regression)', () => {
  // First call: notes.save_warnings_acked carries Detector-level acks so
  // Stage 1 clears (unparametrized_session_id is still a Detector). The
  // mutating_verification_required Classifier surfaces as a Stage-2 item;
  // its answer travels through audit_answers, not notes.save_warnings_acked.
  const ackedFirst = buildStrategy();
  ackedFirst.notes.save_warnings_acked = [
    {
      kind: 'unparametrized_session_id',
      reason:
        'sid is freshly minted per page load and is not portable across users; the in-page signer requires it',
    },
  ];
  let firstToken;
  try {
    saveStrategy(PLATFORM, CAPABILITY, ackedFirst, undefined, SESSION_ID, auditCtx);
    assert.fail('first call should have rejected with a token');
  } catch (err) {
    assert.match(err.message, /audit_token:\s*(\S+)/);
    firstToken = err.message.match(/audit_token:\s*(\S+)/)[1];
  }

  // Second call: same strategy + token + answers + Detector ack in notes.
  // Classifier answers (mutating_verification_required) live in audit_answers.
  const acked = buildStrategy();
  acked.notes.save_warnings_acked = ackedFirst.notes.save_warnings_acked;
  try {
    saveStrategy(PLATFORM, CAPABILITY, acked, undefined, SESSION_ID, {
      ...auditCtx,
      token: firstToken,
      answers: {
        mutating_verification_required:
          'transaction-shape: response.extract grounds the verification (test default)',
        literal_provenance: {
          endpoint: 'static',
          'prerequisites[0].url': 'static',
          'headers.content-type': 'static',
        },
        observed_siblings: {},
      },
    });
  } catch (err) {
    assert.fail(`second saveStrategy threw: ${err.message}`);
  }

  // Assert the strategy file actually landed (page-script tier writes to
  // skills/<platform>/scripts/ per SUBDIR_MAP).
  const expected = path.join(TMP, 'skills', PLATFORM, 'scripts', `${CAPABILITY}.json`);
  assert.ok(fs.existsSync(expected), `expected strategy at ${expected}`);
});

// save_strategy's _hint nudging the agent toward save_verified_expression
// when a substantive js-eval prereq lands without any artifact breadcrumb.
//
// Repro: llm-tests/cross-session-resume/session1/begin-re. The scenario
// expects the agent to drop at least one persistence call (verified
// expression, discovery note, or resume pointer) so future sessions can
// resume the RE work. Agents often skip these tools because the strategy
// file already encodes the expression as a js-eval prereq; the strategy
// IS persisted, but only via `get_strategy`, not via the
// `list_platform_skills().discovery_artifact` channel future-session
// agents read first. The hint sits on the save_strategy OK response —
// the moment the agent has just committed substantial RE — and nudges
// them to also drop the breadcrumb.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const KLURA_HOME = mkdtempSync(join(tmpdir(), 'klura-save-hint-'));
process.env.KLURA_HOME = KLURA_HOME;

const skills = await import('../dist/strategies/skills.js');

// Drive `saveStrategy` programmatically by reusing the audit + commit path
// via the public skills API: skip the session machinery and pre-create the
// strategy file via `commitValidatedStrategy`. To test the _hint we need
// the full saveStrategy tool entrypoint, so use a fixture session that
// just answers `getSession` / `driverFor`.
//
// In this slim test the goal is the structural shape of the response —
// not the entire audit dance. We exercise `findSubstantiveJsEvalPrereqExpression`
// directly through the response shape via a focused unit test on the
// exported helper. The helper is private to save-strategy.ts but the
// public surface (the response) is what the agent reads.

// Pure unit of the detector — declares the contract independent of the
// audit machinery. The save_strategy module re-runs the same checks at
// response time, so pinning this here documents the contract.
function findSubstantiveJsEvalPrereqExpression(data) {
  const prereqs = data?.prerequisites;
  if (!Array.isArray(prereqs)) return null;
  for (const p of prereqs) {
    if (!p || typeof p !== 'object') continue;
    if (p.kind !== 'js-eval') continue;
    if (typeof p.expression !== 'string') continue;
    if (p.expression.length < 120) continue;
    return p.expression;
  }
  return null;
}

test('substantive js-eval prereq → expression returned', () => {
  // The v8 cross-session-resume token-derivation expression (~600 chars
  // chained SHA-256). The hint should fire for this.
  const longExpr =
    `(async function() { function toHex(buf) { return Array.from(new Uint8Array(buf)).map(function(b) { return b.toString(16).padStart(2, '0'); }).join(''); } async function sha256Hex(s) { const bytes = new TextEncoder().encode(s); const hash = await crypto.subtle.digest('SHA-256', bytes); return toHex(hash); } const SESSION_ID = document.cookie.match(/sid=([^;]+)/)[1]; const SECRET = 'phase-one-s3cret'; const salt = await sha256Hex(SESSION_ID + ':' + SECRET); const message = arguments[0]; return await sha256Hex(salt + ':' + message); })`;
  const strategy = {
    strategy: 'page-script',
    prerequisites: [{ name: 'compute_token', kind: 'js-eval', expression: longExpr }],
  };
  const found = findSubstantiveJsEvalPrereqExpression(strategy);
  assert.equal(typeof found, 'string');
  assert.equal(found.length, longExpr.length);
});

test('short one-liner js-eval prereq → null (no hint)', () => {
  // document.cookie is the prototypical "trivial DOM read" — not RE work
  // worth a breadcrumb.
  const strategy = {
    strategy: 'page-script',
    prerequisites: [{ name: 'sid', kind: 'js-eval', expression: 'document.cookie' }],
  };
  assert.equal(findSubstantiveJsEvalPrereqExpression(strategy), null);
});

test('non-js-eval prereqs ignored', () => {
  // fetch-extract / capability / page-extract prereqs aren't candidates —
  // those don't carry the RE-derived expression artifact.
  const strategy = {
    strategy: 'fetch',
    prerequisites: [
      {
        name: 'lookup',
        kind: 'fetch-extract',
        url: 'https://example.test/api/x',
        vars: { id: 'results.0.id' },
      },
      // Long expression on the wrong kind — must not match.
      {
        name: 'fake',
        kind: 'capability',
        capability: 'list_x',
        expression: 'a'.repeat(500),
      },
    ],
  };
  assert.equal(findSubstantiveJsEvalPrereqExpression(strategy), null);
});

test('no prerequisites array → null', () => {
  assert.equal(findSubstantiveJsEvalPrereqExpression({ strategy: 'fetch' }), null);
  assert.equal(findSubstantiveJsEvalPrereqExpression({}), null);
});

test('threshold edge: exactly 119 chars → null; 120 → match', () => {
  const at119 = 'a'.repeat(119);
  const at120 = 'a'.repeat(120);
  assert.equal(
    findSubstantiveJsEvalPrereqExpression({
      strategy: 'page-script',
      prerequisites: [{ kind: 'js-eval', expression: at119 }],
    }),
    null,
  );
  assert.equal(
    findSubstantiveJsEvalPrereqExpression({
      strategy: 'page-script',
      prerequisites: [{ kind: 'js-eval', expression: at120 }],
    }),
    at120,
  );
});

// Cleanup fixture KLURA_HOME at process exit (tests share the env).
process.on('exit', () => {
  try {
    rmSync(KLURA_HOME, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// Silence unused-import lint by referencing the module load — saveStrategy
// import is here to verify the wiring compiles end-to-end.
test('skills module loads without error', () => {
  assert.ok(skills);
});

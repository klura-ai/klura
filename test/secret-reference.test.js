import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-secret-reference-'));
const SECRET_DIR = path.join(TMP, 'account-secrets');
const SECRET_REF = 'demo.default';
const SECRET_VALUE = 'synthetic-password-for-runtime-test';
const SECRET_TOKEN = `{{secret:file-local:${SECRET_REF}}}`;

process.env.KLURA_HOME = TMP;
fs.mkdirSync(SECRET_DIR, { recursive: true });
fs.writeFileSync(path.join(SECRET_DIR, `${SECRET_REF}.password`), SECRET_VALUE, { mode: 0o600 });
fs.writeFileSync(
  path.join(TMP, 'config.json'),
  JSON.stringify({
    secrets: {
      'file-local': `/bin/cat ${SECRET_DIR}/{{ref}}.password`,
    },
  }),
  { mode: 0o600 },
);

const { resolveVariables } = await import('../dist/execution/vars.js');
const { literalProvenanceClassifier } =
  await import('../dist/audit/lift/save-strategy-classifiers.js');
const { saveStrategy, validateStrategyShape } = await import('../dist/strategies/skills.js');

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

function loginStrategy(passwordValue = SECRET_TOKEN) {
  return {
    strategy: 'recorded-path',
    steps: [
      {
        id: 'navigate_login',
        action: 'navigate',
        url: 'https://example.test/login',
      },
      {
        id: 'type_email',
        action: 'type',
        locators: {
          a11y: { role: 'textbox', name: 'Email' },
          css: 'input[name="email"]',
        },
        value: '{{email}}',
      },
      {
        id: 'type_password',
        action: 'type',
        locators: {
          a11y: { role: 'textbox', name: 'Password' },
          css: 'input[type="password"]',
        },
        value: passwordValue,
      },
    ],
    notes: {
      params: {
        email: {
          description: 'Account email',
          kind: 'text',
          source: 'identities.example.email',
        },
      },
    },
  };
}

test('portable save validation accepts an exact secret reference without a configured scheme', () => {
  assert.doesNotThrow(() =>
    validateStrategyShape(loginStrategy('{{secret:not-configured:portable.account}}')),
  );
});

test('recorded-path login persists the reference without surfacing reference or secret bytes', () => {
  const savedPath = saveStrategy('secret-ref-demo', 'login', loginStrategy());
  const saved = fs.readFileSync(savedPath, 'utf8');

  assert.equal(saved.includes(SECRET_TOKEN), true);
  assert.equal(saved.includes(SECRET_VALUE), false);
  assert.equal(savedPath.includes(SECRET_REF), false);
  assert.equal(savedPath.includes(SECRET_VALUE), false);

  const ctx = {
    sessionId: 'secret_ref_audit',
    platform: 'secret-ref-demo',
    capability: 'login',
    session: null,
    observedSiblings: [],
    observedParamValues: {},
    capturedEndpointPaths: new Set(),
    observedUrls: ['https://example.test/login'],
  };
  const items = literalProvenanceClassifier.buildItems(loginStrategy(), ctx);
  const hashFields = literalProvenanceClassifier.hashFields(loginStrategy(), ctx);
  const renderedAudit = JSON.stringify({ items, hashFields });

  assert.ok(items.some((item) => item.path === 'steps[1].value'));
  assert.ok(items.every((item) => item.path !== 'steps[2].value'));
  assert.equal(renderedAudit.includes(SECRET_REF), false);
  assert.equal(renderedAudit.includes('secret:file-local'), false);
  assert.equal(renderedAudit.includes(SECRET_VALUE), false);
});

test('execution resolves a hyphenated file-backed scheme', () => {
  const resolved = resolveVariables({ value: SECRET_TOKEN }, {});
  const actualDigest = crypto.createHash('sha256').update(resolved.value).digest('hex');
  const expectedDigest = crypto.createHash('sha256').update(SECRET_VALUE).digest('hex');
  assert.equal(actualDigest, expectedDigest);
});

test('mixed and malformed secret-reference syntax rejects without echoing the ref', () => {
  const malformed = [
    `prefix ${SECRET_TOKEN}`,
    `${SECRET_TOKEN} suffix`,
    '{{secret:file-local:}}',
    `{{secret:file local:${SECRET_REF}}}`,
    `{{secret:file-local:${SECRET_REF}`,
  ];

  for (const value of malformed) {
    assert.throws(
      () => validateStrategyShape(loginStrategy(value)),
      (error) =>
        error instanceof Error &&
        error.message.includes('{{secret:<scheme>:<ref>}}') &&
        !error.message.includes(SECRET_REF) &&
        !error.message.includes(SECRET_VALUE),
    );
  }
});

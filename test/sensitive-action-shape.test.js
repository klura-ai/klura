// Detector: refuse save_strategy when the strategy body / notes.params
// surface sensitive-shape field names (card_number, cvv, ssn, bank_account,
// password-in-body, pin-in-body). The right tool for those endpoints is
// `record_observed_capability` — save_strategy persists a runnable strategy
// the runtime fires on every warm execute, which on payment / identity /
// credential surfaces means firing the real action.
//
// Repro: llm-tests/platform-map/map-lift-safe v8 — agent saved a
// `place_order` strategy with body {address, card_number, exp, cvv}. The
// audit accepted it because the bench harness's auto-approve decider
// satisfied the user_confirmation Classifier. The strategy on disk would
// fire the real checkout endpoint on warm execute. This Detector closes
// that bypass at the audit layer.

import test from 'node:test';
import assert from 'node:assert/strict';

const { detectSensitiveActionShape } = await import(
  '../dist/gate/save-warnings-sensitive-shape.js'
);

test('v8 platform-map repro: body {address, card_number, exp, cvv} → fires', () => {
  const strategy = {
    strategy: 'fetch',
    baseUrl: 'http://example.test',
    endpoint: '/api/checkout',
    method: 'POST',
    body: {
      address: '{{address}}',
      card_number: '{{card_number}}',
      exp: '{{exp}}',
      cvv: '{{cvv}}',
    },
  };
  const w = detectSensitiveActionShape(strategy);
  assert.equal(w.length, 1);
  assert.equal(w[0].kind, 'sensitive_action_must_be_recorded_not_saved');
  // Names all three sensitive-shape categories matched.
  assert.match(w[0].message, /card_number/);
  assert.match(w[0].message, /cvv/);
  assert.match(w[0].message, /card_expiry/);
  // Hint redirects to the right tool.
  assert.match(w[0].hint, /record_observed_capability/);
  // No ack path advertised.
  assert.match(w[0].hint, /no ack path/);
});

test('case-insensitive field-name matching: camelCase variants flagged', () => {
  // Real APIs use mixed casing — `cardNumber`, `Card_Number`, `CARDNUMBER`.
  // All structurally the same sensitive shape.
  const variants = ['cardNumber', 'CardNumber', 'CARD_NUMBER', 'card-number'];
  for (const fieldName of variants) {
    const strategy = {
      strategy: 'fetch',
      method: 'POST',
      body: { [fieldName]: '{{x}}' },
    };
    const w = detectSensitiveActionShape(strategy);
    assert.equal(w.length, 1, `expected fire on "${fieldName}", got: ${JSON.stringify(w)}`);
  }
});

test('ssn / tax_id / passport: identity-shape fields flagged', () => {
  for (const fieldName of ['ssn', 'tax_id', 'social_security', 'passport_number']) {
    const strategy = {
      strategy: 'fetch',
      method: 'POST',
      body: { [fieldName]: '{{x}}' },
    };
    const w = detectSensitiveActionShape(strategy);
    assert.equal(w.length, 1, `expected fire on "${fieldName}"`);
  }
});

test('bank_account / routing_number / iban: banking-shape fields flagged', () => {
  for (const fieldName of ['bank_account', 'account_number', 'routing_number', 'iban']) {
    const strategy = {
      strategy: 'fetch',
      method: 'POST',
      body: { [fieldName]: '{{x}}' },
    };
    const w = detectSensitiveActionShape(strategy);
    assert.equal(w.length, 1, `expected fire on "${fieldName}"`);
  }
});

test('password / pin in body: credential-submit shape flagged', () => {
  // Password in BODY means the strategy itself is a sign-in/credential
  // submission. That belongs in a login capability with explicit auth-flow
  // ownership, not a generic save.
  const strategy = {
    strategy: 'fetch',
    method: 'POST',
    body: { username: '{{u}}', password: '{{p}}' },
  };
  const w = detectSensitiveActionShape(strategy);
  assert.equal(w.length, 1);
  assert.match(w[0].message, /password_in_body/);
});

test('benign body shapes do NOT fire (false-positive guard)', () => {
  // Read-only / safe-action shapes — search, list, message-send — should
  // pass through cleanly.
  const benign = [
    { body: { query: '{{q}}' } }, // search
    { body: { text: '{{text}}' } }, // chat message
    { body: { name: '{{n}}', description: '{{d}}' } }, // create item
    { body: { recipient: '{{r}}', amount: '{{a}}' } }, // payment-shape but no card fields
    { body: { user_id: '{{u}}' } }, // generic identifier
  ];
  for (const b of benign) {
    const strategy = { strategy: 'fetch', method: 'POST', ...b };
    const w = detectSensitiveActionShape(strategy);
    assert.deepEqual(w, [], `unexpected fire on ${JSON.stringify(b)}; got: ${JSON.stringify(w)}`);
  }
});

test('notes.params keys also walked (sensitive fields can be templated anywhere)', () => {
  // The agent might template a sensitive field name into the URL / headers
  // instead of body. notes.params keys carry the same signal — flag it.
  const strategy = {
    strategy: 'fetch',
    method: 'POST',
    endpoint: '/api/charge?cvv={{cvv}}', // CVV in URL — unusual but real
    notes: { params: { cvv: { kind: 'text' } } },
  };
  const w = detectSensitiveActionShape(strategy);
  assert.equal(w.length, 1);
  assert.match(w[0].message, /cvv/);
});

test('nested body objects walked recursively', () => {
  // Real APIs nest payment data inside `payment_method.card.number`.
  const strategy = {
    strategy: 'fetch',
    method: 'POST',
    body: {
      order: { items: [{ id: 'x' }] },
      payment: { card: { number: '{{cn}}', cvv: '{{cvv}}' } },
    },
  };
  const w = detectSensitiveActionShape(strategy);
  assert.equal(w.length, 1);
  // Both card-number and cvv matched.
  assert.match(w[0].context.matched_labels.join(','), /cvv/);
});

test('single warning emitted regardless of how many fields match', () => {
  // One save_strategy call = at most one warning of this kind, even if
  // every flagged category fires. The corrective action is identical.
  const strategy = {
    strategy: 'fetch',
    method: 'POST',
    body: {
      card_number: 'x',
      cvv: 'x',
      ssn: 'x',
      account_number: 'x',
      password: 'x',
    },
  };
  const w = detectSensitiveActionShape(strategy);
  assert.equal(w.length, 1);
  // All five categories surfaced in matched_labels for visibility.
  assert.ok(w[0].context.matched_labels.length >= 5);
});

test('no body, no params → no fire (sanity check on bare-shell strategies)', () => {
  const strategy = { strategy: 'fetch', method: 'GET', endpoint: '/api/x' };
  assert.deepEqual(detectSensitiveActionShape(strategy), []);
});

test('provides: ["auth"] suppresses the detector (login capability is the canonical credential-submit)', () => {
  // The login capability HAS to carry username + password in body — that's
  // the shape of an authenticate-with-credentials submission. Declaring
  // `provides: ["auth"]` is the agent's explicit ownership of the auth
  // flow; sibling capabilities chain through {kind: "tag", tag: "auth"}.
  // The detector must skip this case or it blocks the canonical pattern.
  // Repro from v9 login-sharing: detector fired on a legit login save,
  // agent pivoted to record_observed_capability, downstream list/create
  // strategies lost their auth-prereq chain.
  const strategy = {
    strategy: 'fetch',
    method: 'POST',
    baseUrl: 'http://example.test',
    endpoint: '/login',
    contentType: 'form',
    body: {
      username: '{{username}}',
      password: '{{password}}',
    },
    provides: ['auth'],
  };
  assert.deepEqual(
    detectSensitiveActionShape(strategy),
    [],
    'provides: ["auth"] must suppress the credential-submit warning',
  );
});

test('provides: ["something-else"] still fires (only "auth" gets the escape)', () => {
  // The auth escape is specific to declared auth-providing capabilities.
  // A strategy declaring some other `provides:` value (e.g. for a
  // hypothetical typed prereq tag) doesn't get the credential-submit pass.
  const strategy = {
    strategy: 'fetch',
    method: 'POST',
    body: { card_number: '{{cn}}', cvv: '{{cvv}}' },
    provides: ['payment'], // not an existing klura tag; treated as not "auth"
  };
  const w = detectSensitiveActionShape(strategy);
  assert.equal(w.length, 1);
});

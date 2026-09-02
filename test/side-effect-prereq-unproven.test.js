// detectSideEffectPrereqUnproven: the exact complement of
// detectUselessCapabilityPrereq. Same prereq shape (kind capability/tag, no
// `vars`), same saved-target domain, opposite side of the same pure-read
// partition. The load-bearing property is that the two never double-fire and
// never both stay silent on a prereq inside that domain.

import test from 'node:test';
import assert from 'node:assert/strict';

const { detectSideEffectPrereqUnproven } = await import(
  '../dist/gate/save-warnings-side-effect-prereq.js'
);
const { detectUselessCapabilityPrereq } = await import(
  '../dist/gate/save-warnings-useless-prereq.js'
);

const noVarsPrereq = (capability) => ({
  strategy: 'fetch',
  baseUrl: 'https://x.test',
  endpoint: '/api/thing',
  method: 'POST',
  prerequisites: [{ name: capability, kind: 'capability', capability }],
});

const noVarsTagPrereq = (tag) => ({
  strategy: 'fetch',
  baseUrl: 'https://x.test',
  endpoint: '/api/thing',
  method: 'POST',
  prerequisites: [{ name: 'authed', kind: 'tag', tag }],
});

function loaderFor(map) {
  return (cap) => map[cap] ?? [];
}

function targetsFor(map, tagMap = {}) {
  return {
    loadStrategiesForCapability: loaderFor(map),
    resolveTagProviders: (tag) => tagMap[tag] ?? [],
  };
}

// ---- POSITIVE: effects the runtime cannot see ----

test('flags a no-vars capability prereq whose target is a mutating POST', () => {
  const targets = targetsFor({
    accept_consent: [
      { strategy: 'fetch', method: 'POST', baseUrl: 'https://x.test', endpoint: '/consent' },
    ],
  });
  const warnings = detectSideEffectPrereqUnproven(noVarsPrereq('accept_consent'), targets);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, 'side_effect_prereq_unproven');
  assert.match(warnings[0].message, /no structural evidence/);
  assert.match(warnings[0].hint, /vars/);
  assert.equal(warnings[0].context.capability, 'accept_consent');
});

test('flags a no-vars capability prereq whose target declares provides (login)', () => {
  const targets = targetsFor({
    login: [
      {
        strategy: 'fetch',
        method: 'POST',
        baseUrl: 'https://x.test',
        endpoint: '/login',
        provides: ['auth'],
      },
    ],
  });
  const warnings = detectSideEffectPrereqUnproven(noVarsPrereq('login'), targets);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].context.capability, 'login');
});

test('flags a no-vars capability prereq whose target is a recorded path', () => {
  const targets = targetsFor({
    dismiss_banner: [
      {
        strategy: 'recorded-path',
        steps: [
          { id: 'open', action: 'navigate', url: 'https://x.test' },
          { id: 'accept', action: 'click', locators: { css: 'button' } },
        ],
      },
    ],
  });
  const warnings = detectSideEffectPrereqUnproven(noVarsPrereq('dismiss_banner'), targets);
  assert.equal(warnings.length, 1);
});

test('resolves a tag prereq through its single provider', () => {
  const targets = targetsFor(
    {
      login_password: [
        {
          strategy: 'fetch',
          method: 'POST',
          baseUrl: 'https://x.test',
          endpoint: '/login',
          provides: ['auth'],
        },
      ],
    },
    { auth: ['login_password'] },
  );
  const warnings = detectSideEffectPrereqUnproven(noVarsTagPrereq('auth'), targets);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].context.capability, 'login_password');
  assert.equal(warnings[0].context.tag, 'auth');
  assert.match(warnings[0].message, /tag "auth"/);
});

// ---- GUARDS ----

test('GUARD: a prereq WITH vars already binds proof → never flagged', () => {
  const targets = targetsFor({
    login: [
      {
        strategy: 'fetch',
        method: 'POST',
        baseUrl: 'https://x.test',
        endpoint: '/login',
        provides: ['auth'],
      },
    ],
  });
  const strategy = {
    strategy: 'fetch',
    baseUrl: 'https://x.test',
    endpoint: '/api/thing/{{sid}}',
    method: 'POST',
    prerequisites: [
      { name: 'login', kind: 'capability', capability: 'login', vars: { sid: 'session.id' } },
    ],
  };
  assert.deepEqual(detectSideEffectPrereqUnproven(strategy, targets), []);
});

test('GUARD: target not saved (unverifiable) → never flagged', () => {
  assert.deepEqual(detectSideEffectPrereqUnproven(noVarsPrereq('login'), targetsFor({})), []);
});

test('GUARD: no target resolver → never flagged', () => {
  assert.deepEqual(detectSideEffectPrereqUnproven(noVarsPrereq('login'), undefined), []);
});

test('GUARD: an ambiguous tag (multiple providers) → never flagged', () => {
  const targets = targetsFor(
    {
      login_password: [
        { strategy: 'fetch', method: 'POST', baseUrl: 'https://x.test', endpoint: '/login' },
      ],
      login_gmail: [
        { strategy: 'fetch', method: 'POST', baseUrl: 'https://x.test', endpoint: '/oauth' },
      ],
    },
    { auth: ['login_password', 'login_gmail'] },
  );
  assert.deepEqual(detectSideEffectPrereqUnproven(noVarsTagPrereq('auth'), targets), []);
});

test('GUARD: an unresolvable tag → never flagged', () => {
  assert.deepEqual(detectSideEffectPrereqUnproven(noVarsTagPrereq('auth'), targetsFor({})), []);
});

test('GUARD: non-capability prereq kinds are out of scope', () => {
  const strategy = {
    strategy: 'fetch',
    baseUrl: 'https://x.test',
    endpoint: '/api',
    prerequisites: [{ name: 'tok', kind: 'cached' }],
  };
  assert.deepEqual(detectSideEffectPrereqUnproven(strategy, targetsFor({})), []);
});

// ---- The partition: exactly one detector owns each in-domain prereq ----

const PARTITION_CASES = [
  {
    name: 'pure-read GET target',
    capability: 'list_products',
    tiers: [{ strategy: 'fetch', method: 'GET', baseUrl: 'https://x.test', endpoint: '/products' }],
    owner: 'useless',
  },
  {
    name: 'mutating POST target',
    capability: 'accept_consent',
    tiers: [{ strategy: 'fetch', method: 'POST', baseUrl: 'https://x.test', endpoint: '/consent' }],
    owner: 'side_effect',
  },
  {
    name: 'GET target that declares provides',
    capability: 'warm_session',
    tiers: [
      {
        strategy: 'fetch',
        method: 'GET',
        baseUrl: 'https://x.test',
        endpoint: '/home',
        provides: ['session'],
      },
    ],
    owner: 'side_effect',
  },
  {
    name: 'recorded-path target',
    capability: 'dismiss_banner',
    tiers: [
      {
        strategy: 'recorded-path',
        steps: [{ id: 'open', action: 'navigate', url: 'https://x.test' }],
      },
    ],
    owner: 'side_effect',
  },
  {
    name: 'mixed GET + POST tiers',
    capability: 'mixed',
    tiers: [
      { strategy: 'fetch', method: 'GET', baseUrl: 'https://x.test', endpoint: '/a' },
      { strategy: 'page-script', method: 'POST', baseUrl: 'https://x.test', endpoint: '/b' },
    ],
    owner: 'side_effect',
  },
];

for (const testCase of PARTITION_CASES) {
  test(`partition: ${testCase.name} → exactly one detector fires`, () => {
    const map = { [testCase.capability]: testCase.tiers };
    const strategy = noVarsPrereq(testCase.capability);
    const useless = detectUselessCapabilityPrereq(strategy, loaderFor(map));
    const sideEffect = detectSideEffectPrereqUnproven(strategy, targetsFor(map));
    assert.equal(
      useless.length + sideEffect.length,
      1,
      'the two detectors must partition the saved-target domain, not overlap or leave a hole',
    );
    assert.equal(useless.length === 1 ? 'useless' : 'side_effect', testCase.owner);
  });
}

test('partition: an unsaved target fires neither detector', () => {
  const strategy = noVarsPrereq('unknown_thing');
  assert.deepEqual(detectUselessCapabilityPrereq(strategy, loaderFor({})), []);
  assert.deepEqual(detectSideEffectPrereqUnproven(strategy, targetsFor({})), []);
});

// detectUselessCapabilityPrereq: flags a side-effect-only (no-vars) capability
// prereq whose target is a pure READ. The load-bearing safety property — the one
// that protects against re-creating the login-sharing failure — is that it NEVER
// flags a legitimate auth / session / mutation / unverifiable prereq.

import test from 'node:test';
import assert from 'node:assert/strict';

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

function loaderFor(map) {
  return (cap) => map[cap] ?? [];
}

// ---- SAFETY GUARDS: must NOT flag legit prereqs ----

test('GUARD: provides:["auth"] login target → never flagged', () => {
  const loader = loaderFor({
    login: [{ strategy: 'fetch', method: 'POST', baseUrl: 'https://x.test', endpoint: '/login', provides: ['auth'] }],
  });
  assert.deepEqual(detectUselessCapabilityPrereq(noVarsPrereq('login'), loader), []);
});

test('GUARD: a GET target that declares provides → never flagged', () => {
  const loader = loaderFor({
    warm_session: [{ strategy: 'fetch', method: 'GET', baseUrl: 'https://x.test', endpoint: '/home', provides: ['session'] }],
  });
  assert.deepEqual(detectUselessCapabilityPrereq(noVarsPrereq('warm_session'), loader), []);
});

test('GUARD: target not saved (unverifiable) → never flagged', () => {
  const loader = loaderFor({}); // login returns []
  assert.deepEqual(detectUselessCapabilityPrereq(noVarsPrereq('login'), loader), []);
});

test('GUARD: mutating (POST) target → never flagged (real server side effect)', () => {
  const loader = loaderFor({
    refresh_cart: [{ strategy: 'fetch', method: 'POST', baseUrl: 'https://x.test', endpoint: '/cart/refresh' }],
  });
  assert.deepEqual(detectUselessCapabilityPrereq(noVarsPrereq('refresh_cart'), loader), []);
});

test('GUARD: any single non-GET tier among the target tiers → never flagged', () => {
  const loader = loaderFor({
    mixed: [
      { strategy: 'fetch', method: 'GET', baseUrl: 'https://x.test', endpoint: '/a' },
      { strategy: 'page-script', method: 'POST', baseUrl: 'https://x.test', endpoint: '/b' },
    ],
  });
  assert.deepEqual(detectUselessCapabilityPrereq(noVarsPrereq('mixed'), loader), []);
});

test('GUARD: no loader → never flagged', () => {
  assert.deepEqual(detectUselessCapabilityPrereq(noVarsPrereq('login'), undefined), []);
});

test('GUARD: capability prereq WITH vars → out of scope (not flagged here)', () => {
  const loader = loaderFor({
    list_users: [{ strategy: 'fetch', method: 'GET', baseUrl: 'https://x.test', endpoint: '/users' }],
  });
  const strategy = {
    strategy: 'fetch',
    baseUrl: 'https://x.test',
    endpoint: '/api/thing/{{uid}}',
    method: 'POST',
    prerequisites: [
      { name: 'list_users', kind: 'capability', capability: 'list_users', vars: { uid: 'users.0.id' } },
    ],
  };
  assert.deepEqual(detectUselessCapabilityPrereq(strategy, loader), []);
});

// ---- POSITIVE: the genuine pure-read dead fetch ----

test('flags a no-vars capability prereq whose target is a saved pure-read GET (no provides)', () => {
  const loader = loaderFor({
    list_products: [{ strategy: 'fetch', method: 'GET', baseUrl: 'https://x.test', endpoint: '/products' }],
  });
  const warnings = detectUselessCapabilityPrereq(noVarsPrereq('list_products'), loader);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, 'useless_capability_prereq');
  assert.match(warnings[0].message, /pure READ/);
  assert.equal(warnings[0].context.capability, 'list_products');
});

test('does not classify a recorded-path prerequisite as a pure-read GET', () => {
  const loader = loaderFor({
    prepare_browser: [
      {
        strategy: 'recorded-path',
        steps: [
          { id: 'open', action: 'navigate', url: 'https://x.test' },
          { id: 'prepare', action: 'click', locators: { css: 'button' } },
        ],
      },
    ],
  });
  assert.deepEqual(detectUselessCapabilityPrereq(noVarsPrereq('prepare_browser'), loader), []);
});

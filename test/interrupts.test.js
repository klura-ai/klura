// Unit tests for strategy.interrupts — the reactive observer / handler
// system. Covers schema validation via registry lookups, registry
// extension points, per-kind predicate evaluation, and aggregated-
// rejection pattern parity with the other canonical shape helpers.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-interrupts-test-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const { saveStrategy } = await import('../dist/strategies/skills.js');
const { evaluatePredicate } = await import('../dist/execution/index.js');
const predicateRegistry = await import('../dist/strategies/predicate-registry.js');
const handlerRegistry = await import('../dist/strategies/interrupt-registry.js');
const { z } = await import('zod');

function expectReject(data, matcher) {
  assert.throws(
    () => saveStrategy('test-interrupts', 'cap', data),
    (err) => {
      assert.match(err.message, /^invalid_strategy:/);
      if (matcher instanceof RegExp) assert.match(err.message, matcher);
      else if (typeof matcher === 'string') assert.ok(err.message.includes(matcher), err.message);
      return true;
    },
  );
}

const BASE_PAGE_SCRIPT = {
  strategy: 'page-script',
  baseUrl: 'https://example.com',
  endpoint: '/api/write',
  method: 'POST',
  body: { text: '{{text}}' },
  notes: { params: { text: { example: 'hi' } } },
};

// ---- Bundled-kind availability ----

test('bundled predicate kinds are registered at module load', () => {
  const kinds = predicateRegistry.listPredicateKinds();
  assert.ok(kinds.includes('selector_visible'), 'selector_visible registered');
  assert.ok(kinds.includes('response_body_matches'), 'response_body_matches registered');
  assert.ok(kinds.includes('js_eval'), 'js_eval registered');
});

test('bundled user-assist handler is registered at module load', () => {
  const kinds = handlerRegistry.listInterruptHandlerKinds();
  assert.ok(kinds.includes('user-assist'), 'user-assist registered');
});

// ---- Schema: top-level shape ----

test('interrupts array accepted on page-script with minimal valid entry', () => {
  assert.doesNotThrow(() =>
    saveStrategy('test-interrupts', 'ok_minimal', {
      ...BASE_PAGE_SCRIPT,
      interrupts: [
        {
          name: 'gate',
          at: 'pre_execution',
          handler: { kind: 'user-assist', message: 'solve it' },
        },
      ],
    }),
  );
});

test('interrupts array accepted on recorded-path', () => {
  assert.doesNotThrow(() =>
    saveStrategy('test-interrupts', 'ok_recorded', {
      schema_version: 1,
      strategy: 'recorded-path',
      steps: [
        { id: 'navigate_edit', action: 'navigate', url: 'https://example.com/edit' },
        { id: 'type_body', action: 'type', locators: { css: 'textarea#body' }, value: 'hello' },
        { id: 'click_publish', action: 'click', locators: { css: 'button#publish' } },
      ],
      interrupts: [
        {
          name: 'captcha_between_steps',
          at: 'between_steps',
          observe: { kind: 'selector_visible', selector: 'iframe[src*="hcaptcha"]' },
          handler: { kind: 'user-assist', message: 'solve captcha' },
        },
      ],
    }),
  );
});

test('interrupts must be an array', () => {
  expectReject(
    { ...BASE_PAGE_SCRIPT, interrupts: { not: 'an array' } },
    /"interrupts" must be an array/,
  );
});

test('interrupts[i] must be an object', () => {
  expectReject(
    { ...BASE_PAGE_SCRIPT, interrupts: ['not-an-object'] },
    /interrupts\[0\] must be a plain object/,
  );
});

test('interrupts[i].name is required', () => {
  expectReject(
    {
      ...BASE_PAGE_SCRIPT,
      interrupts: [{ at: 'pre_execution', handler: { kind: 'user-assist', message: 'x' } }],
    },
    /interrupts\[0\]\.name must be a non-empty string/,
  );
});

test('duplicate interrupts[i].name is rejected', () => {
  expectReject(
    {
      ...BASE_PAGE_SCRIPT,
      interrupts: [
        { name: 'same', at: 'pre_execution', handler: { kind: 'user-assist', message: 'a' } },
        { name: 'same', at: 'between_steps', handler: { kind: 'user-assist', message: 'b' } },
      ],
    },
    /interrupts\[1\]\.name.*is a duplicate/s,
  );
});

test('interrupts[i].at must be a valid lifecycle edge', () => {
  expectReject(
    {
      ...BASE_PAGE_SCRIPT,
      interrupts: [{ name: 'x', at: 'never', handler: { kind: 'user-assist', message: 'x' } }],
    },
    /must be one of/,
  );
});

test('unknown top-level field on interrupt entry is rejected (e.g. after_step, stray prompt)', () => {
  expectReject(
    {
      ...BASE_PAGE_SCRIPT,
      interrupts: [
        {
          name: 'x',
          at: 'between_steps',
          after_step: 6,
          prompt: 'stray top-level',
          observe: { kind: 'selector_visible', selector: '.c' },
          handler: { kind: 'user-assist', message: 'x' },
        },
      ],
    },
    /has unknown field "after_step".*has unknown field "prompt"/s,
  );
});

test('unknown field on handler body is rejected (per handler registry shape)', () => {
  expectReject(
    {
      ...BASE_PAGE_SCRIPT,
      interrupts: [
        {
          name: 'x',
          at: 'pre_execution',
          handler: { kind: 'user-assist', message: 'x', eager_retry: true },
        },
      ],
    },
    /handler has unknown field "eager_retry"/,
  );
});

test('unknown field on observe predicate is rejected (per predicate registry shape)', () => {
  expectReject(
    {
      ...BASE_PAGE_SCRIPT,
      interrupts: [
        {
          name: 'x',
          at: 'pre_execution',
          observe: { kind: 'selector_visible', selector: '.c', invert: true },
          handler: { kind: 'user-assist', message: 'x' },
        },
      ],
    },
    /observe has unknown field "invert"/,
  );
});

test('multiple issues on one interrupt entry aggregate into ONE rejection', () => {
  // Bad: missing handler.message + unknown entry field + bad priority
  // → one rejection listing all three, not three sequential saves.
  expectReject(
    {
      ...BASE_PAGE_SCRIPT,
      interrupts: [
        {
          name: 'x',
          at: 'pre_execution',
          priority: 'low',
          after_step: 6,
          handler: { kind: 'user-assist' },
        },
      ],
    },
    /has 3 issues.*priority must be an integer.*handler\.message is required.*has unknown field "after_step"/s,
  );
});

test('interrupts[i].priority must be an integer when present', () => {
  expectReject(
    {
      ...BASE_PAGE_SCRIPT,
      interrupts: [
        {
          name: 'x',
          at: 'pre_execution',
          priority: 'high',
          handler: { kind: 'user-assist', message: 'x' },
        },
      ],
    },
    /priority must be an integer/,
  );
});

// ---- Observer shape via registry ----

test('unknown observe.kind is rejected with did-you-mean from the registry', () => {
  expectReject(
    {
      ...BASE_PAGE_SCRIPT,
      interrupts: [
        {
          name: 'x',
          at: 'pre_execution',
          observe: { kind: 'selector_vsible', selector: '.c' },
          handler: { kind: 'user-assist', message: 'x' },
        },
      ],
    },
    /did you mean "selector_visible"/,
  );
});

test('observe.selector_visible with missing selector surfaces one aggregated rejection', () => {
  expectReject(
    {
      ...BASE_PAGE_SCRIPT,
      interrupts: [
        {
          name: 'x',
          at: 'pre_execution',
          observe: { kind: 'selector_visible' },
          handler: { kind: 'user-assist', message: 'x' },
        },
      ],
    },
    /interrupts\[0\]\.observe\.selector is required/s,
  );
});

test('observe.js_eval with unbalanced expression rejected via predicate registry validator', () => {
  expectReject(
    {
      ...BASE_PAGE_SCRIPT,
      interrupts: [
        {
          name: 'x',
          at: 'pre_execution',
          observe: { kind: 'js_eval', expression: 'window.foo(' },
          handler: { kind: 'user-assist', message: 'x' },
        },
      ],
    },
    /unbalanced brackets or quotes/,
  );
});

// ---- Handler shape via registry ----

test('unknown handler.kind is rejected with registry listing', () => {
  expectReject(
    {
      ...BASE_PAGE_SCRIPT,
      interrupts: [
        {
          name: 'x',
          at: 'pre_execution',
          handler: { kind: 'auto-fix' },
        },
      ],
    },
    /must be one of: "user-assist"/,
  );
});

test('user-assist handler missing message surfaces one aggregated rejection', () => {
  expectReject(
    {
      ...BASE_PAGE_SCRIPT,
      interrupts: [{ name: 'x', at: 'pre_execution', handler: { kind: 'user-assist' } }],
    },
    /interrupts\[0\]\.handler\.message is required/,
  );
});

test('user-assist handler timeout_ms over hard cap rejected', () => {
  expectReject(
    {
      ...BASE_PAGE_SCRIPT,
      interrupts: [
        {
          name: 'x',
          at: 'pre_execution',
          handler: { kind: 'user-assist', message: 'x', timeout_ms: 900_000 },
        },
      ],
    },
    /exceeds the hard cap/,
  );
});

test('user-assist bind_from cookie requires name', () => {
  expectReject(
    {
      ...BASE_PAGE_SCRIPT,
      interrupts: [
        {
          name: 'x',
          at: 'pre_execution',
          handler: {
            kind: 'user-assist',
            message: 'x',
            binds: 'tok',
            bind_from: { kind: 'cookie' },
          },
        },
      ],
    },
    /bind_from\.name is required/,
  );
});

// ---- Registry extension ----

test('registering a custom predicate kind makes it valid in the validator', () => {
  predicateRegistry.registerPredicateKind({
    kind: 'test_always_true',
    shape: z.object({ kind: z.literal('test_always_true') }).strict(),
    async evaluate() {
      return true;
    },
  });
  assert.doesNotThrow(() =>
    saveStrategy('test-interrupts', 'custom_pred', {
      ...BASE_PAGE_SCRIPT,
      interrupts: [
        {
          name: 'x',
          at: 'pre_execution',
          observe: { kind: 'test_always_true' },
          handler: { kind: 'user-assist', message: 'x' },
        },
      ],
    }),
  );
});

test('registering a custom handler kind makes it valid in the validator', () => {
  handlerRegistry.registerInterruptHandler({
    kind: 'test_noop_handler',
    shape: z.object({ kind: z.literal('test_noop_handler'), note: z.string() }).strict(),
    async run() {
      return {};
    },
  });
  assert.doesNotThrow(() =>
    saveStrategy('test-interrupts', 'custom_handler', {
      ...BASE_PAGE_SCRIPT,
      interrupts: [
        {
          name: 'x',
          at: 'pre_execution',
          handler: { kind: 'test_noop_handler', note: 'hello' },
        },
      ],
    }),
  );
});

test('re-registering a predicate kind throws', () => {
  assert.throws(() =>
    predicateRegistry.registerPredicateKind({
      kind: 'selector_visible',
      shape: z.object({ kind: z.literal('selector_visible') }).strict(),
      async evaluate() {
        return false;
      },
    }),
  );
});

// ---- evaluatePredicate dispatcher (unchanged behavior; sanity) ----

function mkStubDriver(responses) {
  return {
    async evaluateExpression(_session, expression) {
      for (const r of responses) {
        if (r.match(expression)) return r.value;
      }
      throw new Error(`no stub for: ${expression.slice(0, 80)}`);
    },
  };
}

test('evaluatePredicate selector_visible truthy on non-zero rect', async () => {
  const driver = mkStubDriver([{ match: (e) => e.includes('.captcha'), value: { w: 300, h: 80 } }]);
  const hit = await evaluatePredicate(
    { kind: 'selector_visible', selector: '.captcha' },
    { session: { id: 'stub' }, driver },
  );
  assert.strictEqual(hit, true);
});

test('evaluatePredicate unknown kind → false (never throws)', async () => {
  const driver = mkStubDriver([]);
  const hit = await evaluatePredicate({ kind: 'bogus_kind' }, { session: { id: 'stub' }, driver });
  assert.strictEqual(hit, false);
});

test('evaluatePredicate undefined predicate → false', async () => {
  const hit = await evaluatePredicate(undefined, { session: { id: 'stub' }, driver: {} });
  assert.strictEqual(hit, false);
});

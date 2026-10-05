// "Saved" and "can be packaged" used to be decided by two different gates, the
// second one long after the session that could act on its answer had closed.
// Under `audit.packageReadiness: "require"` the exporter's own checks run
// inside the save: structure before anything is committed, the response once
// verification has one. These tests pin both questions, the two places they
// are asked, and that nothing changes for a save that never asked.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-package-readiness-'));
process.env.KLURA_HOME = TMP;

const { inferOutcomeSchema, isHollowRecord, boundedListing, OutcomeShapeError } =
  await import('../dist/factory/public-package/outcome-shape.js');
const { packageStructureIssues, packageResultIssues, isPackageCandidate, inputSchemaFromParams } =
  await import('../dist/factory/public-package/package-readiness.js');
const { packageStructureCheck } = await import('../dist/audit/lift/package-readiness-check.js');
const skills = await import('../dist/strategies/skills.js');
const { verifySavedStrategy } = await import('../dist/strategies/verify-saved-strategy.js');
const { CONFIG_FIELDS } = await import('../dist/config/schema.js');

const CONFIG_PATH = path.join(TMP, 'config.json');
const requirePackaging = () =>
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ audit: { packageReadiness: 'require' } }));
const clearConfig = () => fs.rmSync(CONFIG_PATH, { force: true });

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const pageProgram = (over = {}) => ({
  strategy: 'page-script',
  effect: 'read',
  origin: 'https://acme.test',
  prerequisites: [
    {
      name: 'result',
      kind: 'js-eval',
      url: 'https://acme.test/items/{{id}}',
      expression: "(async () => ({ title: document.querySelector('h1').textContent }))()",
      binds: 'result',
      return_shape: { kind: 'object', required_keys: ['title'] },
      args_template: { id: '{{id}}' },
    },
  ],
  response: { from: 'result' },
  notes: { params: { id: { example: 'i42' } } },
  ...over,
});

const staticRequest = (over = {}) => ({
  strategy: 'fetch',
  effect: 'read',
  method: 'GET',
  baseUrl: 'https://acme.test',
  endpoint: '/api/items/{{id}}',
  response: { format: 'json' },
  notes: { params: { id: { example: 6493208 } } },
  ...over,
});

// ---------- structure, from the strategy alone ----------

test('a strategy the exporter compiles has no structure issues', () => {
  assert.deepEqual(packageStructureIssues(pageProgram(), 'get_item'), []);
  assert.deepEqual(packageStructureIssues(staticRequest(), 'get_item'), []);
});

test("the reasons are the exporter's own, named for the author", () => {
  const second = { ...pageProgram().prerequisites[0], name: 'warm', binds: 'warm' };
  const twoSteps = pageProgram({ prerequisites: [second, pageProgram().prerequisites[0]] });
  assert.match(
    packageStructureIssues(twoSteps, 'get_item').join('\n'),
    /exactly one js-eval prerequisite/,
  );

  const withPrerequisite = staticRequest({ prerequisites: [pageProgram().prerequisites[0]] });
  assert.match(packageStructureIssues(withPrerequisite, 'get_item').join('\n'), /prerequisites/);

  const wholeUrl = pageProgram();
  wholeUrl.prerequisites[0].url = '{{place_url}}';
  wholeUrl.prerequisites[0].args_template = {};
  wholeUrl.notes = { params: { place_url: { example: 'https://acme.test/p/1' } } };
  assert.match(
    packageStructureIssues(wholeUrl, 'get_item').join('\n'),
    /names no page with a literal https origin/,
  );

  const noOrigin = staticRequest({ baseUrl: '{{host}}' });
  assert.match(packageStructureIssues(noOrigin, 'get_item').join('\n'), /no literal https origin/);

  assert.match(
    packageStructureIssues({ strategy: 'recorded-path', steps: [] }, 'get_item').join('\n'),
    /replays interface actions/,
  );
});

test('a strategy that changes something on the site is never a candidate', () => {
  assert.equal(isPackageCandidate(staticRequest()), true);
  assert.equal(isPackageCandidate({ strategy: 'fetch' }), true);
  assert.equal(isPackageCandidate(staticRequest({ effect: 'write' })), false);
});

test('the declared input schema follows the documented examples', () => {
  const schema = inputSchemaFromParams(
    pageProgram({
      notes: { params: { id: { example: 7 }, lang: { example: 'en', optional: true } } },
    }),
  );
  assert.deepEqual(schema.properties, { id: { type: 'number' }, lang: { type: 'string' } });
  // `id` fills the page URL, so a package caller must supply it; `lang` fills nothing.
  assert.deepEqual(schema.required, ['id']);
});

// ---------- result, from the response a run returned ----------

test("a response inside the contract's bounds has no result issues", () => {
  const body = { title: 'Lamp', price: 12.5, tags: [{ label: 'new' }], seller: null };
  assert.deepEqual(packageResultIssues(pageProgram(), body, { id: 'i42' }), []);
});

test('each bound is refused with what to change', () => {
  const issue = (body, strategy = pageProgram()) =>
    packageResultIssues(strategy, body, { id: 'i42' })[0];
  assert.match(
    issue({
      rows: [
        { id: 1, labels: [] },
        { id: 2, labels: [] },
      ],
    }),
    /rows\[\]\.labels is an empty list/,
  );
  assert.match(
    issue(Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`k${i}`, i]))),
    /carries 70 keys/,
  );
  let deep = 'leaf';
  for (let i = 0; i < 14; i += 1) deep = { next: deep };
  assert.match(issue(deep), /nests deeper than 12 levels/);
  assert.match(
    issue({ rows: [{ v: 'a' }, { v: ['a'] }] }),
    /string in one row and array in another/,
  );
  assert.match(
    issue({ text: 'x'.repeat(20_000) }),
    /returned \d+ bytes and a packaged capability may return 16384/,
  );
  assert.match(
    issue({ title: null, price: null, id: 'i42', not_found: true }),
    /every field came back empty/,
  );
});

test('a list empty in one row is described by a row that fills it', () => {
  const schema = inferOutcomeSchema({ ads: [{ cards: [] }, { cards: [{ title: 'Coffee' }] }] });
  assert.equal(schema.properties.ads.items.properties.cards.items.properties.title.type, 'string');
  assert.equal(JSON.stringify(schema).includes('undescribed_at'), false);
  assert.throws(() => inferOutcomeSchema([]), OutcomeShapeError);
});

test('an oversized listing passes on a static request, where the package cuts rows', () => {
  const rows = Array.from({ length: 400 }, (_, i) => ({
    id: i,
    name: `item ${i}`,
    note: 'x'.repeat(60),
  }));
  assert.deepEqual(packageResultIssues(staticRequest(), { total: 400, rows }, {}), []);
  const bounded = boundedListing({ total: 400, rows });
  assert.ok(bounded.limit > 0 && bounded.limit < 400);
  // A page program's result is bounded before any cut, so the same listing is refused there.
  assert.match(packageResultIssues(pageProgram(), { total: 400, rows }, {})[0], /may return 16384/);
});

test('a hollow record is told apart from a real one and from a flag', () => {
  assert.equal(isHollowRecord({ title: null, id: 'i42' }, { id: 'i42' }), true);
  assert.equal(isHollowRecord({ title: 'Lamp', id: 'i42' }, { id: 'i42' }), false);
  assert.equal(isHollowRecord({ exists: true }, {}), false);
});

// ---------- where the questions are asked ----------

test('the save gate refuses an unpackagable structure only when packaging is required', () => {
  const second = { ...pageProgram().prerequisites[0], name: 'warm', binds: 'warm' };
  const twoSteps = pageProgram({ prerequisites: [second, pageProgram().prerequisites[0]] });
  clearConfig();
  packageStructureCheck.check(twoSteps, { capability: 'get_item' });

  requirePackaging();
  assert.throws(
    () => packageStructureCheck.check(twoSteps, { capability: 'get_item' }),
    /invalid_strategy: .*exactly one js-eval prerequisite[\s\S]*klura:\/\/reference#package-export/,
  );
  // A strategy that compiles, and one that is not a read, pass.
  packageStructureCheck.check(pageProgram(), { capability: 'get_item' });
  packageStructureCheck.check({ ...twoSteps, effect: 'write' }, { capability: 'send_item' });
  clearConfig();
});

// Serves every navigated URL one payload through a fake driver.
function makePool(payload) {
  const urls = new Map();
  let nextSession = 0;
  const driver = {
    async getUrl(session) {
      return urls.get(session.id) ?? 'about:blank';
    },
    async navigate(session, url) {
      urls.set(session.id, url);
    },
    async evaluateExpression(_session, expression) {
      if (expression === 'document.readyState') return 'complete';
      return JSON.stringify(payload);
    },
  };
  return {
    async createSession() {
      const session = { id: `s-${++nextSession}`, intercepted: [], intercepting: false };
      urls.set(session.id, 'about:blank');
      return session;
    },
    createNodeOnlySession() {
      throw new Error('unexpected node-only session');
    },
    async endDrive() {},
    getSession(sessionId) {
      return { id: sessionId, intercepted: [], intercepting: false };
    },
    driverFor() {
      return driver;
    },
    async shutdown() {},
    get activeSessions() {
      return 0;
    },
    get activeSessionIds() {
      return [];
    },
    get idleSince() {
      return 0;
    },
    get connectEnabled() {
      return false;
    },
  };
}

function readStrategy() {
  return {
    strategy: 'page-script',
    effect: 'read',
    baseUrl: 'https://example.test',
    prerequisites: [
      {
        name: 'result',
        kind: 'js-eval',
        url: 'https://example.test/item',
        expression: 'document.body.innerText',
        binds: 'result',
        return_shape: { kind: 'string' },
      },
    ],
    response: { from: 'result', format: 'json' },
  };
}

test('verification reports a response a package cannot carry, and does not stamp it passed', async () => {
  requirePackaging();
  const platform = 'readiness-oversized';
  skills.commitValidatedStrategy(platform, 'get_item', readStrategy());
  const result = await verifySavedStrategy(
    platform,
    'get_item',
    {},
    makePool({ ok: true, title: 'Lamp', blob: 'x'.repeat(20_000) }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.classification, 'transport_accepted');
  assert.equal(result.package_readiness.length, 1);
  assert.match(result.message, /post_save_validation_not_packagable/);
  assert.match(result.message, /Change what the strategy returns and re-save this session/);
  assert.equal(
    skills.loadStrategy(platform, 'get_item').runtime_meta.post_save_validation,
    'transport_passed',
  );
  clearConfig();
});

test('verification is unchanged when packaging is not required, or the response fits', async () => {
  const oversized = { ok: true, title: 'Lamp', blob: 'x'.repeat(20_000) };
  clearConfig();
  skills.commitValidatedStrategy('readiness-off', 'get_item', readStrategy());
  const off = await verifySavedStrategy('readiness-off', 'get_item', {}, makePool(oversized));
  assert.equal(off.ok, true);
  assert.equal(off.package_readiness, undefined);

  requirePackaging();
  skills.commitValidatedStrategy('readiness-fits', 'get_item', readStrategy());
  const fits = await verifySavedStrategy(
    'readiness-fits',
    'get_item',
    {},
    makePool({ ok: true, title: 'Lamp', price: 12.5 }),
  );
  assert.equal(fits.ok, true);
  assert.equal(fits.classification, 'explicit_success');
  assert.equal(fits.package_readiness, undefined);
  clearConfig();
});

test('the setting is a described config field that defaults to off', () => {
  const field = CONFIG_FIELDS.find((entry) => entry.path === 'audit.packageReadiness');
  assert.ok(field, 'audit.packageReadiness is described');
  assert.equal(field.default, 'off');
  assert.deepEqual([...field.enum], ['off', 'require']);
});

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Per-platform health.json lives under KLURA_HOME/workdir/<platform>/.
// Point everything at a throwaway dir BEFORE the first import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-graduation-test-'));
process.env.KLURA_HOME = TMP;

const graduation = await import('../dist/strategies/health.js');
const { markHealthy, markFailed, getHealth, isBroken, markHealed, resetHealth } = graduation;

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

// Each test uses a unique platform name so the module-level state doesn't
// bleed between tests.
let counter = 0;
function fresh() {
  counter += 1;
  return { platform: `plat${counter}`, capability: 'cap', type: 'fetch' };
}

test('initial state: unseen strategy is healthy, zero failures', () => {
  const { platform, capability, type } = fresh();
  const h = getHealth(platform, capability, type);
  assert.strictEqual(h.status, 'healthy');
  assert.strictEqual(h.failureCount, 0);
});

test('markHealthy: sets status, records lastSuccess, resets failureCount', () => {
  const { platform, capability, type } = fresh();
  markFailed(platform, capability, type, 'whatever');
  markFailed(platform, capability, type, 'whatever');
  const before = getHealth(platform, capability, type);
  assert.strictEqual(before.failureCount, 2);
  assert.strictEqual(before.status, 'degraded');

  markHealthy(platform, capability, type);
  const after = getHealth(platform, capability, type);
  assert.strictEqual(after.status, 'healthy');
  assert.strictEqual(after.failureCount, 0);
  assert.ok(typeof after.lastSuccess === 'number' && after.lastSuccess > 0);
});

test('markFailed: first failure transitions healthy → degraded', () => {
  const { platform, capability, type } = fresh();
  markFailed(platform, capability, type, 'http 500');
  const h = getHealth(platform, capability, type);
  assert.strictEqual(h.status, 'degraded');
  assert.strictEqual(h.failureCount, 1);
  assert.strictEqual(h.lastError, 'http 500');
  assert.ok(typeof h.lastFailure === 'number' && h.lastFailure > 0);
});

test('markFailed: reaches broken at BROKEN_THRESHOLD=5 consecutive failures', () => {
  const { platform, capability, type } = fresh();
  for (let i = 0; i < 4; i++) markFailed(platform, capability, type, `fail ${i}`);
  assert.strictEqual(getHealth(platform, capability, type).status, 'degraded');
  assert.strictEqual(getHealth(platform, capability, type).failureCount, 4);

  markFailed(platform, capability, type, 'fail 5');
  assert.strictEqual(getHealth(platform, capability, type).status, 'broken');
  assert.strictEqual(getHealth(platform, capability, type).failureCount, 5);
});

test('markFailed: further failures past threshold stay broken and increment count', () => {
  const { platform, capability, type } = fresh();
  for (let i = 0; i < 7; i++) markFailed(platform, capability, type, `fail ${i}`);
  const h = getHealth(platform, capability, type);
  assert.strictEqual(h.status, 'broken');
  assert.strictEqual(h.failureCount, 7);
  assert.strictEqual(h.lastError, 'fail 6');
});

test('markFailed: preserves prior lastSuccess (the happy path snapshot)', () => {
  const { platform, capability, type } = fresh();
  markHealthy(platform, capability, type);
  const successAt = getHealth(platform, capability, type).lastSuccess;
  assert.ok(typeof successAt === 'number');

  markFailed(platform, capability, type, 'oops');
  const after = getHealth(platform, capability, type);
  assert.strictEqual(after.lastSuccess, successAt, 'lastSuccess is preserved on failure');
});

test('isBroken: true only when status === broken', () => {
  const { platform, capability, type } = fresh();
  assert.strictEqual(isBroken(platform, capability, type), false, 'healthy');

  markFailed(platform, capability, type, 'e');
  assert.strictEqual(isBroken(platform, capability, type), false, 'degraded');

  for (let i = 0; i < 4; i++) markFailed(platform, capability, type, 'e');
  assert.strictEqual(isBroken(platform, capability, type), true, 'broken after 5');
});

test('markHealed: resets failureCount, bumps healCount, transitions back to healthy', () => {
  const { platform, capability, type } = fresh();
  for (let i = 0; i < 5; i++) markFailed(platform, capability, type, 'e');
  assert.strictEqual(getHealth(platform, capability, type).status, 'broken');

  markHealed(platform, capability, type);
  const h = getHealth(platform, capability, type);
  assert.strictEqual(h.status, 'healthy');
  assert.strictEqual(h.failureCount, 0);
  assert.strictEqual(h.healCount, 1);
  assert.ok(typeof h.lastHeal === 'number' && h.lastHeal > 0);
});

test('markHealed: preserves lastError from the break (useful for post-mortem)', () => {
  const { platform, capability, type } = fresh();
  markFailed(platform, capability, type, 'specific failure');
  markHealed(platform, capability, type);
  assert.strictEqual(getHealth(platform, capability, type).lastError, 'specific failure');
});

test('markHealed: increments healCount across multiple heal cycles', () => {
  const { platform, capability, type } = fresh();
  markFailed(platform, capability, type, 'e');
  markHealed(platform, capability, type);
  markFailed(platform, capability, type, 'e');
  markHealed(platform, capability, type);
  markFailed(platform, capability, type, 'e');
  markHealed(platform, capability, type);
  assert.strictEqual(getHealth(platform, capability, type).healCount, 3);
});

test('markHealed: appends a strategy_events entry (healed kind) to the logbook', async () => {
  const { platform, capability, type } = fresh();
  markHealed(platform, capability, type);
  const { readStrategyEvents } = await import('../dist/working-dir/logbook.js');
  const events = readStrategyEvents(platform, capability);
  assert.ok(events.length >= 1, 'expected at least one strategy event');
  const last = events[0];
  assert.strictEqual(last.kind, 'healed');
  assert.strictEqual(last.capability, capability);
  assert.strictEqual(last.strategy, type);
  assert.match(last.detail, /count: 1/);
});

test('resetHealth: removes the entry entirely (next read is healthy default)', () => {
  const { platform, capability, type } = fresh();
  for (let i = 0; i < 5; i++) markFailed(platform, capability, type, 'e');
  assert.strictEqual(getHealth(platform, capability, type).status, 'broken');

  resetHealth(platform, capability, type);
  const after = getHealth(platform, capability, type);
  assert.strictEqual(after.status, 'healthy', 'reset returns default');
  assert.strictEqual(after.failureCount, 0);
  assert.strictEqual(after.lastFailure, undefined);
});

test('persistence: per-platform health.json is written under working/', () => {
  const { platform, capability, type } = fresh();
  markFailed(platform, capability, type, 'persisted error');
  const healthPath = path.join(TMP, 'workdir', platform, 'health.json');
  assert.ok(fs.existsSync(healthPath), `expected ${healthPath} to exist`);
  const data = JSON.parse(fs.readFileSync(healthPath, 'utf-8'));
  const entry = data[`${capability}/${type}`];
  assert.ok(entry, 'entry written to disk');
  assert.strictEqual(entry.status, 'degraded');
  assert.strictEqual(entry.failureCount, 1);
  assert.strictEqual(entry.lastError, 'persisted error');
});

test('isolation: different (platform, capability, type) tuples track independently', () => {
  const a = fresh();
  const b = fresh();

  for (let i = 0; i < 5; i++) markFailed(a.platform, a.capability, a.type, 'e');
  markHealthy(b.platform, b.capability, b.type);

  assert.strictEqual(getHealth(a.platform, a.capability, a.type).status, 'broken');
  assert.strictEqual(getHealth(b.platform, b.capability, b.type).status, 'healthy');
});

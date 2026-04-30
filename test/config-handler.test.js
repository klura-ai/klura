// Tests for the unified config handler: load / save / validate / configureOne.
// Every test isolates KLURA_HOME so we don't touch the user's real config.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-config-'));
process.env.KLURA_HOME = tmpHome;

const configPath = path.join(tmpHome, 'config.json');

const {
  loadConfig,
  saveConfig,
  configureOne,
  describeConfig,
  validateConfig,
  CONFIG_DEFAULTS,
  CONFIG_FIELDS,
} = await import('../dist/config/handler.js');

test('loadConfig returns defaults when no file exists', () => {
  try { fs.unlinkSync(configPath); } catch { /* not present */ }
  const cfg = loadConfig();
  assert.strictEqual(cfg.runtime.listen, 'unix');
  assert.strictEqual(cfg.pool.warm.enabled, false);
});

test('loadConfig merges partial file with defaults', () => {
  fs.writeFileSync(configPath, JSON.stringify({ pool: { driver: 'custom' } }));
  const cfg = loadConfig();
  assert.strictEqual(cfg.pool.driver, 'custom');
  assert.strictEqual(cfg.pool.warm.max_contexts, 3); // nested default
});

test('saveConfig writes atomically and round-trips', () => {
  const next = JSON.parse(JSON.stringify(CONFIG_DEFAULTS));
  next.pool.driver = 'klura-driver-playwright-stealth';
  saveConfig(next);
  assert.ok(!fs.existsSync(`${configPath}.tmp`), 'tmp file should be renamed');
  const reloaded = loadConfig();
  assert.strictEqual(reloaded.pool.driver, 'klura-driver-playwright-stealth');
});

test('configureOne sets a live field and reports no restart', () => {
  const result = configureOne('pool.driver', 'klura-driver-playwright-stealth');
  assert.deepStrictEqual(result.changed, ['pool.driver']);
  assert.strictEqual(result.runtime_restart_required, false);
  assert.strictEqual(result.suggested_user_prompt, '');
  assert.strictEqual(loadConfig().pool.driver, 'klura-driver-playwright-stealth');
});

test('configureOne on a runtime.* field flags restart + prompt', () => {
  const result = configureOne('runtime.listen', '0.0.0.0:7777');
  assert.strictEqual(result.runtime_restart_required, true);
  assert.deepStrictEqual(result.runtime_restart_fields, ['runtime.listen']);
  assert.match(result.suggested_user_prompt, /restart/i);
});

test('configureOne coerces string numerics for numeric fields', () => {
  const result = configureOne('pool.maxSessions', '16');
  assert.strictEqual(result.config.pool.maxSessions, 16);
});

test('configureOne coerces string booleans', () => {
  const result = configureOne('pool.warm.enabled', 'true');
  assert.strictEqual(result.config.pool.warm.enabled, true);
});

test('configureOne rejects unknown dot-path', () => {
  assert.throws(
    () => configureOne('pool.noSuchField', 1),
    (err) => /not a known config field/.test(err.message),
  );
});

test('configureOne rejects bad enum value', () => {
  assert.throws(
    () => configureOne('pool.channel', 'bogus'),
    (err) => /must be one of|must be/i.test(err.message),
  );
});

test('configureOne rejects out-of-range numeric', () => {
  assert.throws(
    () => configureOne('graduation.observation_threshold', 99999),
    (err) => /range|\[2, 50\]/.test(err.message),
  );
});

test('validateConfig catches bad merged state', () => {
  const bad = JSON.parse(JSON.stringify(CONFIG_DEFAULTS));
  bad.pool.channel = 'sideways';
  const { ok, errors } = validateConfig(bad);
  assert.strictEqual(ok, false);
  assert.ok(errors.some((e) => e.includes('pool.channel')));
});

test('describeConfig returns every registered field', () => {
  const desc = describeConfig();
  assert.strictEqual(desc.fields.length, CONFIG_FIELDS.length);
  const paths = desc.fields.map((f) => f.path);
  assert.ok(paths.includes('pool.driver'));
  assert.ok(paths.includes('runtime.listen'));
  assert.ok(paths.includes('remote.mode'));
  const driverField = desc.fields.find((f) => f.path === 'pool.driver');
  assert.strictEqual(driverField.optional, true);
  assert.strictEqual(driverField.needsRestart, false);
  const listenField = desc.fields.find((f) => f.path === 'runtime.listen');
  assert.strictEqual(listenField.needsRestart, true);
  assert.ok(desc.dynamic_paths['secrets.<scheme>']);
});

test('secrets field is validated as a string map', () => {
  const cfg = JSON.parse(JSON.stringify(CONFIG_DEFAULTS));
  cfg.secrets = { op: '' };
  assert.throws(() => saveConfig(cfg), /secrets\.op/);

  cfg.secrets = { op: 'op read {{ref}}' };
  saveConfig(cfg); // should not throw
  assert.deepStrictEqual(loadConfig().secrets, { op: 'op read {{ref}}' });
});

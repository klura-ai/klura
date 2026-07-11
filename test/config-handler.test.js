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

test('configureOne on a driver/warm pool field flags restart (captured at pool construction)', () => {
  // pool.{driver,headful,channel,driver_config,warm.*} are frozen when the Pool
  // builds its driver, so a live daemon can't apply them — configure must say so
  // rather than falsely reporting the change as effective.
  for (const path of [
    'pool.headful',
    'pool.channel',
    'pool.driver',
    'pool.driver_config',
    'pool.warm.enabled',
    'pool.warm.max_contexts',
    'pool.warm.idle_ttl_seconds',
  ]) {
    const value =
      path === 'pool.driver'
        ? 'playwright'
        : path === 'pool.channel'
          ? 'chromium'
          : path === 'pool.driver_config'
            ? { k: 'v' }
            : path === 'pool.warm.max_contexts'
              ? 2
              : path === 'pool.warm.idle_ttl_seconds'
                ? 120
                : true;
    const result = configureOne(path, value);
    assert.strictEqual(result.runtime_restart_required, true, `${path} must flag restart`);
    assert.deepStrictEqual(result.runtime_restart_fields, [path], `${path} names itself`);
    assert.match(result.suggested_user_prompt, /restart|relaunch|exit/i, `${path} prompts to restart`);
  }
});

test('configureOne rejects an unloadable pool.driver before persisting it', () => {
  assert.throws(
    () => configureOne('pool.driver', 'playwright-stealth'),
    (err) => /can't be loaded/.test(err.message) && /playwright/.test(err.message),
  );
  // Rejected write must not have touched config.json.
  assert.notStrictEqual(loadConfig().pool.driver, 'playwright-stealth');
});

test('configureOne on a runtime.* field flags restart + prompt', () => {
  const result = configureOne('runtime.listen', '0.0.0.0:7777');
  assert.strictEqual(result.runtime_restart_required, true);
  assert.deepStrictEqual(result.runtime_restart_fields, ['runtime.listen']);
  assert.match(result.suggested_user_prompt, /restart/i);
});

test('embedded runtime: boot-time prompt says relaunch-by-hand, not restart_runtime', () => {
  // Tests run embedded (isStandaloneDaemon() is false), so a boot-time field must
  // not offer an in-place restart the embedded runtime would refuse.
  const result = configureOne('runtime.listen', '0.0.0.0:7788');
  assert.strictEqual(result.runtime_restart_required, true);
  assert.match(result.suggested_user_prompt, /embedded/i);
  assert.match(result.suggested_user_prompt, /relaunch|exit/i);
  assert.match(result.suggested_user_prompt, /restart_runtime/);
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
  assert.strictEqual(driverField.needsRestart, true);
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

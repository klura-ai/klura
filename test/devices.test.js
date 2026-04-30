import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// devices.ts resolves KLURA_HOME dynamically on each call. We still
// reset the module-scope cache between tests because it keys on
// (resolved path, file mtime).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-devices-test-'));
process.env.KLURA_HOME = TMP;

const {
  getDeviceProfile,
  setDeviceProfile,
  resetDeviceProfile,
  DEVICE_PRESETS,
  _resetDeviceProfileCacheForTests,
} = await import('../dist/identity/devices.js');

test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function freshHome(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `klura-devices-${label}-`));
  process.env.KLURA_HOME = dir;
  _resetDeviceProfileCacheForTests();
  return dir;
}

test('getDeviceProfile() with no device.json returns desktop preset', () => {
  freshHome('no-file');
  const profile = getDeviceProfile();
  assert.strictEqual(profile.viewport.width, 1280);
  assert.strictEqual(profile.viewport.height, 720);
  // Default desktop is compat-mode: accepts touch so a mobile viewer client
  // can interact with the already-rendered page without a context reload.
  assert.strictEqual(profile.hasTouch, true);
  assert.strictEqual(profile.isMobile, false);
});

test('DEVICE_PRESETS contains desktop, desktop-strict, iphone-15, pixel-8', () => {
  assert.ok(DEVICE_PRESETS.desktop);
  assert.ok(DEVICE_PRESETS['desktop-strict']);
  assert.ok(DEVICE_PRESETS['iphone-15']);
  assert.ok(DEVICE_PRESETS['pixel-8']);
  assert.strictEqual(DEVICE_PRESETS['iphone-15'].isMobile, true);
  assert.strictEqual(DEVICE_PRESETS['iphone-15'].hasTouch, true);
  assert.strictEqual(DEVICE_PRESETS.desktop.isMobile, false);
  assert.strictEqual(DEVICE_PRESETS.desktop.hasTouch, true);
  assert.strictEqual(DEVICE_PRESETS['desktop-strict'].isMobile, false);
  assert.strictEqual(DEVICE_PRESETS['desktop-strict'].hasTouch, false);
  // desktop-strict otherwise matches desktop dimensions / UA.
  assert.deepStrictEqual(
    DEVICE_PRESETS['desktop-strict'].viewport,
    DEVICE_PRESETS.desktop.viewport,
  );
});

test('setDeviceProfile() writes device.json with mode 0600', () => {
  const dir = freshHome('set-profile');
  const filePath = path.join(dir, 'device.json');
  setDeviceProfile(DEVICE_PRESETS['iphone-15']);
  assert.ok(fs.existsSync(filePath));
  const stat = fs.statSync(filePath);
  assert.strictEqual(stat.mode & 0o777, 0o600);
});

test('setDeviceProfile() round-trips through getDeviceProfile()', () => {
  freshHome('roundtrip');
  const profile = {
    name: 'test device',
    userAgent: 'Mozilla/5.0 (custom)',
    viewport: { width: 800, height: 600 },
    hasTouch: true,
    isMobile: false,
    deviceScaleFactor: 2,
  };
  setDeviceProfile(profile);
  const got = getDeviceProfile();
  assert.deepStrictEqual(got, profile);
});

test('preset application: set + get reproduces iphone-15 exactly', () => {
  freshHome('preset-iphone');
  setDeviceProfile(DEVICE_PRESETS['iphone-15']);
  const got = getDeviceProfile();
  assert.deepStrictEqual(got, DEVICE_PRESETS['iphone-15']);
});

test('resetDeviceProfile() deletes file and reverts to desktop default', () => {
  const dir = freshHome('reset');
  setDeviceProfile(DEVICE_PRESETS['iphone-15']);
  assert.ok(fs.existsSync(path.join(dir, 'device.json')));
  resetDeviceProfile();
  assert.strictEqual(fs.existsSync(path.join(dir, 'device.json')), false);
  const profile = getDeviceProfile();
  assert.strictEqual(profile.viewport.width, 1280);
  assert.strictEqual(profile.hasTouch, true);
});

test('corrupt device.json falls back to desktop default without throwing', () => {
  const dir = freshHome('corrupt');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'device.json'), '{ not json', { mode: 0o600 });
  _resetDeviceProfileCacheForTests();
  const profile = getDeviceProfile();
  assert.strictEqual(profile.viewport.width, 1280);
});

test('malformed device.json (missing required fields) falls back to desktop default', () => {
  const dir = freshHome('malformed');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'device.json'), JSON.stringify({ name: 'oops' }), {
    mode: 0o600,
  });
  _resetDeviceProfileCacheForTests();
  const profile = getDeviceProfile();
  assert.strictEqual(profile.viewport.width, 1280);
});

test('cache invalidates when KLURA_HOME changes', () => {
  const dir1 = freshHome('cache-dir1');
  setDeviceProfile(DEVICE_PRESETS['iphone-15']);
  const profile1 = getDeviceProfile();
  assert.strictEqual(profile1.isMobile, true);

  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-devices-cache-dir2-'));
  process.env.KLURA_HOME = dir2;
  const profile2 = getDeviceProfile();
  // dir2 has no device.json → desktop default
  assert.strictEqual(profile2.isMobile, false);
  assert.strictEqual(profile2.viewport.width, 1280);

  try {
    fs.rmSync(dir2, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test('cache invalidates when file mtime changes (set from a stale read)', () => {
  freshHome('cache-mtime');
  setDeviceProfile(DEVICE_PRESETS['desktop-strict']);
  const first = getDeviceProfile();
  assert.strictEqual(first.hasTouch, false);
  // A subsequent set should produce a fresh file; next get should reflect it.
  setDeviceProfile(DEVICE_PRESETS['pixel-8']);
  const second = getDeviceProfile();
  assert.strictEqual(second.hasTouch, true);
  assert.strictEqual(second.viewport.width, 412);
});

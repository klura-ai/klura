// start_session policy bootstrap.
//
// MCP has no post-creation policy setter. A caller may create permanent policy
// while opening the first session for a platform, but later mutation belongs to
// the user-owned CLI / policy.json path.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-start-policy-'));
process.env.KLURA_HOME = TMP;
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
});

const { startSession, loadPolicy } = await import('../dist/index.js');
const { pool } = await import('../dist/runtime-state/index.js');

function patchPoolForFakeBrowser() {
  const fakeDriver = {
    navigate: async () => {},
    getAccessibilityTree: async () => '<root />',
    getUrl: async () => 'https://x.example/',
    consumePendingNavs: async () => [],
    captureFormSummary: async () => [],
  };
  const origCreate = pool.createSession;
  const origDriver = pool.driverFor;
  pool.createSession = async () => ({
    id: 'sess-policy-' + Math.random().toString(36).slice(2, 8),
    domNavigations: [],
    domFormsObserved: [],
    visitedUrls: [],
  });
  pool.driverFor = () => fakeDriver;
  return () => {
    pool.createSession = origCreate;
    pool.driverFor = origDriver;
  };
}

test('start_session can create per-capability permanent policy before driving', async () => {
  const restore = patchPoolForFakeBrowser();
  try {
    await startSession('https://x.example/', {
      platform: 'policy-start',
      capability: 'send_message',
      policy: { max_tier: 'recorded-path', reason: 'operator cap' },
    });

    const saved = loadPolicy('policy-start');
    assert.equal(saved.per_capability?.send_message?.max_strategy_tier, 'recorded-path');
    assert.equal(saved.per_capability?.send_message?.reason, 'operator cap');
  } finally {
    restore();
  }
});

test('start_session policy is create-only once policy.json exists', async () => {
  await assert.rejects(
    () =>
      startSession('https://x.example/', {
        platform: 'policy-start',
        capability: 'send_message',
        policy: { max_tier: 'page-script' },
      }),
    /policy already exists/,
  );
});

test('start_session policy without capability sets platform default', async () => {
  const restore = patchPoolForFakeBrowser();
  try {
    await startSession('https://x.example/', {
      platform: 'policy-default',
      policy: { max_tier: 'page-script' },
    });

    const saved = loadPolicy('policy-default');
    assert.equal(saved.default_max_strategy_tier, 'page-script');
  } finally {
    restore();
  }
});

test('start_session policy requires platform', async () => {
  await assert.rejects(
    () => startSession('https://x.example/', { policy: { max_tier: 'recorded-path' } }),
    /policy requires platform/,
  );
});

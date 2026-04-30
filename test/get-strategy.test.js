// Unit tests for getStrategy() — the detail-on-demand tool that lets a
// continuation agent read a prior save's full body (including
// generated.frame.code and notes.params).

import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-get-strategy-test-'));
process.env.KLURA_HOME = HOME;

const { getStrategy } = await import('../dist/index.js');

const SUBDIRS = {
  'fetch': 'fetch',
  'page-script': 'scripts',
  'recorded-path': 'paths',
};

function writeStrategy(platform, capability, body) {
  const subdir = SUBDIRS[body.strategy];
  const dir = path.join(HOME, 'skills', platform, subdir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${capability}.json`), JSON.stringify(body));
}

function wipe() {
  const dir = path.join(HOME, 'skills');
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

test('nonexistent platform/capability returns null', () => {
  wipe();
  assert.strictEqual(getStrategy({ platform: 'p', capability: 'c' }), null);
});

test('single-tier save: returns the saved strategy', () => {
  wipe();
  writeStrategy('p', 'c', {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/x',
  });
  const s = getStrategy({ platform: 'p', capability: 'c' });
  assert.strictEqual(s.strategy, 'fetch');
  assert.strictEqual(s.baseUrl, 'https://api.example.com');
});

test('multiple tiers: returns the fastest (fetch > page-script > recorded-path)', () => {
  wipe();
  writeStrategy('p', 'c', {
    strategy: 'recorded-path',
    steps: [{ action: 'navigate', url: 'https://x' }],
  });
  writeStrategy('p', 'c', {
    strategy: 'page-script',
    baseUrl: 'https://api.example.com',
    endpoint: '/y',
  });
  writeStrategy('p', 'c', {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/x',
  });
  const s = getStrategy({ platform: 'p', capability: 'c' });
  assert.strictEqual(s.strategy, 'fetch');
});

test('tier filter returns exact tier or null', () => {
  wipe();
  writeStrategy('p', 'c', {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/x',
  });
  writeStrategy('p', 'c', {
    strategy: 'recorded-path',
    steps: [{ action: 'navigate', url: 'https://x' }],
  });
  assert.strictEqual(
    getStrategy({ platform: 'p', capability: 'c', tier: 'fetch' }).strategy,
    'fetch',
  );
  assert.strictEqual(
    getStrategy({ platform: 'p', capability: 'c', tier: 'recorded-path' }).strategy,
    'recorded-path',
  );
  assert.strictEqual(
    getStrategy({ platform: 'p', capability: 'c', tier: 'page-script' }),
    null,
  );
});

test('returns full strategy body (generated.frame.code + notes.params)', () => {
  wipe();
  const body = {
    strategy: 'page-script',
    protocol: 'websocket',
    origin: 'https://chat.example.com',
    wsUrl: 'wss://edge.example.com/chat',
    frameEncoding: 'binary',
    generated: {
      frame: { code: 'return Buffer.from("hi").toString("base64")' },
    },
    notes: {
      params: {
        thread_id: { description: 'target thread id', kind: 'id', example: 'abc123' },
      },
    },
  };
  writeStrategy('p', 'send', body);
  const s = getStrategy({ platform: 'p', capability: 'send' });
  assert.ok(s, 'strategy should be loaded');
  assert.strictEqual(s.generated.frame.code, body.generated.frame.code);
  assert.deepStrictEqual(s.notes.params, body.notes.params);
});

test('rejects missing platform with invalid_get_strategy_args', () => {
  assert.throws(
    () => getStrategy({ capability: 'c' }),
    /invalid_get_strategy_args:.*platform/,
  );
});

test('rejects missing capability with invalid_get_strategy_args', () => {
  assert.throws(
    () => getStrategy({ platform: 'p' }),
    /invalid_get_strategy_args:.*capability/,
  );
});

test('rejects invalid tier with enum message', () => {
  assert.throws(
    () => getStrategy({ platform: 'p', capability: 'c', tier: 'flying' }),
    /invalid_get_strategy_args:.*tier.*is not allowed; must be one of/,
  );
});

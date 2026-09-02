import test from 'node:test';
import assert from 'node:assert';

import { BrowserDriver } from '../dist/drivers/interface.js';

test('BrowserDriver script fallback reads and validates Resource Timing entries once', async () => {
  const driver = Object.create(BrowserDriver.prototype);
  const calls = [];
  driver.evaluateExpression = async (_session, expression, options) => {
    calls.push({ expression, options });
    return [
      {
        url: 'https://assets.example.test/app.js',
        bytes: 2048,
        loaded_at: 1_700_000_000_125,
      },
      { url: '', bytes: 3 },
      { url: 'https://assets.example.test/chunk', bytes: Number.NaN },
      null,
    ];
  };

  const scripts = await driver.getLoadedScripts({ id: 'session' });

  assert.equal(calls.length, 1);
  assert.match(calls[0].expression, /entry\.initiatorType === "script"/);
  assert.deepEqual(calls[0].options, { timeoutMs: 5000 });
  assert.deepEqual(scripts, [
    {
      url: 'https://assets.example.test/app.js',
      bytes: 2048,
      loaded_at: 1_700_000_000_125,
    },
    { url: 'https://assets.example.test/chunk' },
  ]);
});

test('BrowserDriver script fallback rejects a non-array page result', async () => {
  const driver = Object.create(BrowserDriver.prototype);
  driver.evaluateExpression = async () => ({ url: 'https://assets.example.test/app.js' });

  assert.deepEqual(await driver.getLoadedScripts({ id: 'session' }), []);
});

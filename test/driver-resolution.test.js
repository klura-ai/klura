// Unit tests for pool.ts:resolveDriverClass — the named-driver lookup that
// picks between the built-in 'playwright' driver and BYO drivers loaded by
// require() (absolute path or bare npm module name).

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveDriverClass, Pool } from '../dist/pool/pool.js';
import { PlaywrightDriver } from '../dist/drivers/playwright.js';

test('resolveDriverClass(undefined) returns null', () => {
  assert.equal(resolveDriverClass(undefined), null);
});

test('resolveDriverClass("") returns null', () => {
  assert.equal(resolveDriverClass(''), null);
});

test('resolveDriverClass("playwright") returns PlaywrightDriver', () => {
  const cls = resolveDriverClass('playwright');
  assert.ok(cls, 'playwright resolved to a class');
  assert.equal(cls, PlaywrightDriver);
  const instance = new cls();
  assert.ok(instance instanceof PlaywrightDriver);
});

test('resolveDriverClass returns identical class object on repeat calls', () => {
  const a = resolveDriverClass('playwright');
  const b = resolveDriverClass('playwright');
  assert.equal(a, b);
});

test('resolveDriverClass("/nonexistent/file.js") throws', () => {
  assert.throws(() => resolveDriverClass('/tmp/definitely-not-a-real-driver.js'), /Cannot find/);
});

test('resolveDriverClass loads a BYO driver from an absolute path', () => {
  // Write a tiny CommonJS driver to a tmp file and resolve it by path.
  const tmp = path.join(os.tmpdir(), `klura-byo-${Date.now()}.cjs`);
  const code = `
    const { PlaywrightDriver } = require(${JSON.stringify(path.join(process.cwd(), 'dist/drivers/playwright.js'))});
    class MyDriver extends PlaywrightDriver {}
    module.exports = MyDriver;
  `;
  fs.writeFileSync(tmp, code);
  try {
    const cls = resolveDriverClass(tmp);
    assert.ok(cls);
    const instance = new cls();
    assert.ok(instance instanceof PlaywrightDriver);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* tmp cleanup */
    }
  }
});

test('resolveDriverClass accepts a module with a default export', () => {
  const tmp = path.join(os.tmpdir(), `klura-byo-default-${Date.now()}.cjs`);
  const code = `
    const { PlaywrightDriver } = require(${JSON.stringify(path.join(process.cwd(), 'dist/drivers/playwright.js'))});
    class MyDriver extends PlaywrightDriver {}
    module.exports = { default: MyDriver };
  `;
  fs.writeFileSync(tmp, code);
  try {
    const cls = resolveDriverClass(tmp);
    assert.ok(cls);
    const instance = new cls();
    assert.ok(instance instanceof PlaywrightDriver);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* tmp cleanup */
    }
  }
});

test('resolveDriverClass rejects a module that does not export a class', () => {
  const tmp = path.join(os.tmpdir(), `klura-byo-bad-${Date.now()}.cjs`);
  fs.writeFileSync(tmp, `module.exports = { notADriver: true };`);
  try {
    assert.throws(() => resolveDriverClass(tmp), /did not export a BrowserDriver/);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* tmp cleanup */
    }
  }
});

test('new Pool() with no driver option defaults to PlaywrightDriver', () => {
  const pool = new Pool();
  assert.ok(pool.driver instanceof PlaywrightDriver);
});

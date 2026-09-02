import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseCssSelector } = require('../dist/public/contracts/css-selector.js');

test('public CSS selector parser accepts bounded standards-mode selectors', () => {
  assert.equal(
    parseCssSelector('main > article:is(.product, .item) a[href]', 'selector'),
    'main > article:is(.product, .item) a[href]',
  );
  assert.equal(parseCssSelector('li:nth-child(2n + 1)', 'selector'), 'li:nth-child(2n + 1)');
});

test('public CSS selector parser rejects non-standard driver selector dialects', () => {
  for (const selector of ['xpath=//main', 'button:visible', ':has-text("chair")', 'a::before']) {
    assert.throws(() => parseCssSelector(selector, 'selector'), /CSS|selector/);
  }
});

// Layer A: every execute() call site passes `platform` through to
// pool.createSession so the warm-slot fast-path at pool.ts:239 actually
// fires. Without this, warm pool (when enabled) is unreachable — the
// if (opts.platform) guard fails for every execute call.
//
// Structural test: read the compiled JS at the three known call sites
// and assert `platform` is in the opts bag. This is a forward-looking
// guard — if the call site signature ever drifts (createSession signature
// changes, opts bag is spread-inline, etc.) these assertions catch it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const distDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'dist');

function readCompiled(relPath) {
  return fs.readFileSync(path.join(distDir, relPath), 'utf-8');
}

test('execution/*.js: every pool.createSession call carries platform in its opts', () => {
  // createSession call sites live in the per-tier execution files
  // (fetch-browser, recorded-path, websocket). Read each and assert every
  // call threads platform through the opts bag so pool.ts's warm-slot
  // fast-path is reachable.
  const files = ['execution/fetch-browser.js', 'execution/recorded-path.js'];
  let total = 0;
  for (const rel of files) {
    const src = readCompiled(rel);
    const re = /pool\.createSession\(\s*\{([^{}]*|\{[^{}]*\})*\}\s*\)/g;
    const matches = src.match(re) ?? [];
    total += matches.length;
    for (const call of matches) {
      assert.match(call, /\bplatform\b/, `createSession call in ${rel} missing platform: ${call.slice(0, 120)}`);
    }
  }
  assert.ok(total >= 2, `expected ≥2 createSession calls across execution/*, got ${total}`);
});

test('execution/websocket.js: pool.createSession call carries platform', () => {
  const src = readCompiled('execution/websocket.js');
  const re = /pool\.createSession\(\s*\{([^{}]*|\{[^{}]*\})*\}\s*\)/g;
  const matches = src.match(re) ?? [];
  assert.ok(matches.length >= 1, `expected ≥1 createSession call, got ${matches.length}`);
  for (const call of matches) {
    assert.match(call, /\bplatform\b/, `createSession call missing platform: ${call.slice(0, 120)}`);
  }
});

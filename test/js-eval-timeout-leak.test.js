// Regression: driver.evaluateExpression must clear its race timeout when the
// eval settles. A lingering timer roots the pending timeout promise and, via
// Promise.race's reaction chain, pins the resolved result until the timer
// fires — so a burst of evals inside one timeout window retains every result
// at once, growing the heap linearly with the burst size.
//
// The only faithful signal is retained heap, which needs a forced GC, so the
// burst runs in a `--expose-gc` child: it fires a burst of large-return evals,
// collects, and reports heap growth. Pre-fix that grows ~payload×burst; the
// fix keeps it flat. Skips when chromium isn't installed.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-js-eval-timeout-leak-'));
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js');

const BURST_SRC = `
import { startSession, jsEval, _pool } from ${JSON.stringify(DIST)};
const started = await startSession('data:text/html,<html><body>leak</body></html>', {});
if (started._startFailed) { console.log('SKIP:' + started._startFailed); process.exit(0); }
const heap = () => Math.round(process.memoryUsage().heapUsed / 1048576);
// Warm one call so lazy driver/page allocations aren't counted as growth.
await jsEval({ session_id: started.sessionId, expression: "'x'.repeat(2000000)" });
global.gc(); global.gc();
const before = heap();
for (let i = 0; i < 25; i++) await jsEval({ session_id: started.sessionId, expression: "'x'.repeat(2000000)" });
global.gc(); global.gc();
console.log('GROWTH:' + (heap() - before));
try { await _pool.shutdown(); } catch {}
process.exit(0);
`;

test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test('evaluateExpression clears its timeout — a burst of large-return evals does not grow the heap', (t) => {
  const burstFile = path.join(TMP, 'burst.mjs');
  fs.writeFileSync(burstFile, BURST_SRC);
  const res = spawnSync(process.execPath, ['--expose-gc', burstFile], {
    env: { ...process.env, KLURA_HOME: TMP },
    encoding: 'utf8',
    timeout: 120_000,
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const skip = out.match(/SKIP:(.*)/);
  if (skip) {
    t.skip(`browser unavailable: ${skip[1].trim()}`);
    return;
  }
  assert.strictEqual(res.status, 0, `burst child exited ${res.status}: ${out}`);
  const m = out.match(/GROWTH:(-?\d+)/);
  assert.ok(m, `burst child did not report heap growth: ${out}`);
  const growthMB = Number(m[1]);
  // 25 evals × ~2MB. Uncleared timers pin every result → ~50MB growth; the
  // fix keeps retained heap flat. 20MB cleanly separates the two regimes.
  assert.ok(growthMB < 20, `heap grew ${growthMB}MB across 25 large-return evals — timeout timer not cleared?`);
});

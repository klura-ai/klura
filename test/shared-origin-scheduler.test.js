import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { getSharedOriginScheduler } = await import('../dist/execution/shared-origin-scheduler.js');
const { getConsumerOriginScheduler } = await import('../dist/consumer/execution/shared-scheduler.js');

test('consumer and core resolve the same scheduler for one local home', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-shared-scheduler-'));
  try {
    assert.strictEqual(getConsumerOriginScheduler(home), getSharedOriginScheduler(home));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

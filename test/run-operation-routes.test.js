import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ConsumerDaemonRoutesV1 } = require('../dist/consumer/daemon-routes.js');
const { ConsumerRunServiceV1 } = require('../dist/consumer/runs.js');
const { PackageStoreV1 } = require('../dist/consumer/store/package-store.js');
const { RunOperationStoreV1 } = require('../dist/consumer/scrape/run-operations.js');
const { RunOutputError } = require('../dist/consumer/scrape/output.js');

const startOperationId = 'op_v1_11111111111111111111111111111111';
const resumeOperationId = 'op_v1_22222222222222222222222222222222';
const cancelOperationId = 'op_v1_33333333333333333333333333333333';
const discardOperationId = 'op_v1_44444444444444444444444444444444';
const rejectedOperationId = 'op_v1_55555555555555555555555555555555';
const resumeRunId = 'run_v1_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

test('daemon run operations replay durable outcomes without repeating traffic', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'klura-run-operation-routes-'));
  try {
    const operations = new RunOperationStoreV1(home);
    let starts = 0;
    let resumes = 0;
    let cancellations = 0;
    let discards = 0;

    const services = {
      startDetached(input) {
        starts += 1;
        return {
          package_id: 'ikea',
          version: '1.0.0',
          package_digest: 'a'.repeat(64),
          capability: 'get_product',
          run_id: input.run_id,
          completion: new Promise(() => undefined),
          cancel() {
            cancellations += 1;
            return true;
          },
        };
      },
      resume(input) {
        resumes += 1;
        input.signal.addEventListener(
          'abort',
          () => {
            cancellations += 1;
          },
          { once: true },
        );
        return new Promise(() => undefined);
      },
    };
    const firstRoutes = createRoutes(home, operations, services);
    const started = await firstRoutes.invoke('POST', '/consumer/run', startBody({ id: '42' }));
    assert.equal(started.kind, 'run_accepted');
    assert.equal(started.operation_id, startOperationId);
    assert.match(started.run_id, /^run_v1_[0-9a-f]{32}$/);
    const startedRunId = started.run_id;
    assert.equal(starts, 1);

    const restartedRoutes = createRoutes(home, operations, services);
    assert.deepEqual(
      await restartedRoutes.invoke('POST', '/consumer/run', startBody({ id: '42' })),
      started,
    );
    assert.equal(starts, 1);
    assert.deepEqual(
      await restartedRoutes.invoke('POST', '/consumer/run', startBody({ id: 'different' })),
      { kind: 'consumer_run_operation_failure', code: 'operation_conflict' },
    );
    assert.equal(starts, 1);

    const resumed = await restartedRoutes.invoke('POST', '/consumer/runs/resume', {
      run_id: resumeRunId,
      operation_id: resumeOperationId,
    });
    assert.deepEqual(resumed, {
      kind: 'run_resume_accepted',
      operation_id: resumeOperationId,
      run_id: resumeRunId,
    });
    assert.deepEqual(
      await restartedRoutes.invoke('POST', '/consumer/runs/resume', {
        run_id: resumeRunId,
        operation_id: resumeOperationId,
      }),
      resumed,
    );
    assert.equal(resumes, 1);
    assert.deepEqual(
      await restartedRoutes.invoke('POST', '/consumer/runs/resume', {
        run_id: resumeRunId,
        operation_id: 'op_v1_55555555555555555555555555555555',
      }),
      { kind: 'consumer_run_operation_failure', code: 'operation_conflict' },
    );
    assert.equal(operations.read('op_v1_55555555555555555555555555555555'), null);
    assert.equal(resumes, 1);

    const cancelled = await restartedRoutes.invoke('POST', '/consumer/runs/cancel', {
      run_id: resumeRunId,
      source: 'sdk_cancel',
      operation_id: cancelOperationId,
    });
    assert.deepEqual(cancelled, {
      kind: 'run_cancellation_requested',
      operation_id: cancelOperationId,
      run_id: resumeRunId,
    });
    assert.deepEqual(
      await restartedRoutes.invoke('POST', '/consumer/runs/cancel', {
        run_id: resumeRunId,
        source: 'sdk_cancel',
        operation_id: cancelOperationId,
      }),
      cancelled,
    );
    assert.equal(cancellations, 1);

    const discardRoutes = new ConsumerDaemonRoutesV1(
      {},
      {
        home,
        discard(runId) {
          discards += 1;
          return { kind: 'discarded', run_id: runId };
        },
      },
      undefined,
      undefined,
      null,
      undefined,
      operations,
    );
    const discarded = await discardRoutes.invoke('POST', '/consumer/runs/discard', {
      run_id: startedRunId,
      operation_id: discardOperationId,
    });
    assert.deepEqual(discarded, {
      kind: 'discarded',
      operation_id: discardOperationId,
      run_id: startedRunId,
    });
    assert.deepEqual(
      await discardRoutes.invoke('POST', '/consumer/runs/discard', {
        run_id: startedRunId,
        operation_id: discardOperationId,
      }),
      discarded,
    );
    assert.equal(discards, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('inline output preflight failure is typed and releases its operation reservation', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'klura-run-output-preflight-'));
  try {
    const operations = new RunOperationStoreV1(home);
    let starts = 0;
    const routes = createRoutes(home, operations, {
      startDetached() {
        starts += 1;
        throw new RunOutputError('output_sink_required', 'inline response exceeds adapter budget');
      },
      resume() {
        return Promise.resolve();
      },
    });

    assert.deepEqual(
      await routes.invoke(
        'POST',
        '/consumer/run',
        startBody({ id: '42' }, rejectedOperationId),
      ),
      { kind: 'consumer_run_output_failure', code: 'output_sink_required' },
    );
    assert.equal(starts, 1);
    assert.equal(operations.read(rejectedOperationId), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

function createRoutes(home, operations, services) {
  return new ConsumerDaemonRoutesV1(
    services,
    new ConsumerRunServiceV1(new PackageStoreV1(home)),
    undefined,
    undefined,
    null,
    undefined,
    operations,
  );
}

function startBody(input, operationId = startOperationId) {
  return {
    package_id: 'ikea',
    capability: 'get_product',
    input,
    caller_bounds: {},
    input_mode_id: null,
    output: null,
    inline_output_max_bytes: 1_048_576,
    session_name: null,
    detach: true,
    operation_id: operationId,
  };
}

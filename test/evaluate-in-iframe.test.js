// evaluate_in_iframe / evaluate_in_iframe_chain / evaluate_in_worker
// entry-point validation. End-to-end browser semantics are covered by
// the field-reports retail-site-a scenario — this suite covers argument
// shape + ArtifactAccumulator recording so the signer-discovery gate
// credits agents who use these tools.

import test from 'node:test';
import assert from 'node:assert/strict';

const { evaluateInIframe, evaluateInIframeChain, evaluateInWorker } = await import(
  '../dist/tools/context-bound-eval.js'
);
const { pool } = await import('../dist/runtime-state/index.js');

function patchPool(session, driverStub) {
  const origGet = pool.getSession;
  const origDriver = pool.driverFor;
  pool.getSession = (id) => (id === session.id ? session : origGet.call(pool, id));
  pool.driverFor = (id) => (id === session.id ? driverStub : origDriver.call(pool, id));
  return () => {
    pool.getSession = origGet;
    pool.driverFor = origDriver;
  };
}

test('evaluate_in_iframe: missing iframe_src → throws', async () => {
  await assert.rejects(
    () => evaluateInIframe({ session_id: 'sess_x', iframe_src: '', expression: '1' }),
    /iframe_src is required/,
  );
});

test('evaluate_in_iframe: missing expression → throws', async () => {
  await assert.rejects(
    () => evaluateInIframe({ session_id: 'sess_x', iframe_src: '/', expression: '' }),
    /expression is required/,
  );
});

test('evaluate_in_iframe: success records accumulator entry', async () => {
  const session = { id: 'sess_iframe', intercepted: [], intercepting: false };
  const driver = {
    evaluateInIframe: async () => 200,
  };
  const restore = patchPool(session, driver);
  try {
    const result = await evaluateInIframe({
      session_id: session.id,
      iframe_src: '/',
      expression: 'fetch("/api").then(r => r.status)',
    });
    assert.equal(result.ok, true);
    assert.equal(result.value ?? result.result ?? result, 200, JSON.stringify(result));
    assert.equal(session.artifactAccumulator.evaluateInIframeCalls.length, 1);
    assert.ok(session.artifactAccumulator.evaluateInIframeCalls[0].src_digest.length === 16);
    assert.ok(session.artifactAccumulator.evaluateInIframeCalls[0].expression_digest.length === 16);
  } finally {
    restore();
  }
});

test('evaluate_in_iframe: driver throws → ok:false with error message', async () => {
  const session = { id: 'sess_iframe_err', intercepted: [], intercepting: false };
  const driver = {
    evaluateInIframe: async () => {
      throw new Error('iframe_load_failed: cross-origin');
    },
  };
  const restore = patchPool(session, driver);
  try {
    const result = await evaluateInIframe({
      session_id: session.id,
      iframe_src: 'https://other.test/',
      expression: '1',
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /iframe_load_failed/);
  } finally {
    restore();
  }
});

test('evaluate_in_iframe_chain: empty steps → throws', async () => {
  await assert.rejects(
    () => evaluateInIframeChain({ session_id: 'sess_x', iframe_src: '/', steps: [] }),
    /steps is required/,
  );
});

test('evaluate_in_iframe_chain: steps >10 → throws', async () => {
  const steps = Array.from({ length: 11 }, () => ({ expression: '1' }));
  await assert.rejects(
    () => evaluateInIframeChain({ session_id: 'sess_x', iframe_src: '/', steps }),
    /steps capped at 10/,
  );
});

test('evaluate_in_iframe_chain: success records accumulator entry with step_count', async () => {
  const session = { id: 'sess_chain', intercepted: [], intercepting: false };
  let receivedSteps;
  const driver = {
    evaluateInIframeChain: async (_s, params) => {
      receivedSteps = params.steps;
      return { status: 200, body: 'ok' };
    },
  };
  const restore = patchPool(session, driver);
  try {
    const result = await evaluateInIframeChain({
      session_id: session.id,
      iframe_src: '/',
      steps: [
        { expression: 'await window.ready' },
        { expression: 'fetch("/api").then(r => r.status)' },
      ],
    });
    assert.equal(result.ok, true);
    assert.equal(receivedSteps.length, 2);
    assert.equal(session.artifactAccumulator.evaluateInIframeChainCalls.length, 1);
    assert.equal(session.artifactAccumulator.evaluateInIframeChainCalls[0].step_count, 2);
  } finally {
    restore();
  }
});

test('evaluate_in_worker: missing worker_source → throws', async () => {
  await assert.rejects(
    () => evaluateInWorker({ session_id: 'sess_x', worker_source: '' }),
    /worker_source is required/,
  );
});

test('evaluate_in_worker: worker_source >16384 chars → throws', async () => {
  const big = 'x'.repeat(16_385);
  await assert.rejects(
    () => evaluateInWorker({ session_id: 'sess_x', worker_source: big }),
    /worker_source must be ≤ 16384/,
  );
});

test('evaluate_in_worker: success records accumulator entry', async () => {
  const session = { id: 'sess_worker', intercepted: [], intercepting: false };
  const driver = {
    evaluateInWorker: async () => 42,
  };
  const restore = patchPool(session, driver);
  try {
    const result = await evaluateInWorker({
      session_id: session.id,
      worker_source: 'self.onmessage = e => self.postMessage(e.data + 1);',
      message: 41,
    });
    assert.equal(result.ok, true);
    assert.equal(session.artifactAccumulator.evaluateInWorkerCalls.length, 1);
    assert.ok(session.artifactAccumulator.evaluateInWorkerCalls[0].source_digest.length === 16);
  } finally {
    restore();
  }
});

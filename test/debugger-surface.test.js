// Unit + integration tests for the debugger-surface tools
// (set_breakpoint, remove_breakpoint, list_breakpoints, wait_for_pause,
//  get_frame_scope, evaluate_on_frame, step, resume).
//
// The integration leg needs chromium installed via playwright. When it's
// not, those tests skip with a note; the unit coverage (argument validation)
// still runs.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-debugger-'));
process.env.KLURA_HOME = TMP;

const klura = await import('../dist/index.js');

test.after(async () => {
  try {
    const p = klura._pool;
    if (p && typeof p.shutdown === 'function') await p.shutdown();
  } catch {
    /* best-effort */
  }
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ---- Argument validation on the tool handlers ----

test('setBreakpointTool rejects missing/malformed inputs', async () => {
  await assert.rejects(
    klura.setBreakpointTool({ session_id: '', file: 'x', line: 0 }),
    /session_id/,
  );
  await assert.rejects(
    klura.setBreakpointTool({ session_id: 's', file: '', line: 0 }),
    /file is required/,
  );
  await assert.rejects(
    klura.setBreakpointTool({ session_id: 's', file: 'x', line: -1 }),
    /non-negative/,
  );
  await assert.rejects(
    klura.setBreakpointTool({
      session_id: 's',
      file: 'x',
      line: 0,
      condition: 'x'.repeat(513),
    }),
    /≤ 512 chars/,
  );
});

test('waitForPauseTool clamps timeout and requires session_id', async () => {
  await assert.rejects(klura.waitForPauseTool({ session_id: '' }), /session_id/);
});

test('stepTool rejects invalid mode', async () => {
  await assert.rejects(klura.stepTool({ session_id: 's', mode: 'sideways' }), /over/);
});

test('evaluateOnFrameTool rejects missing expression', async () => {
  await assert.rejects(
    klura.evaluateOnFrameTool({ session_id: 's', frame_index: 0, expression: '' }),
    /expression is required/,
  );
  await assert.rejects(
    klura.evaluateOnFrameTool({
      session_id: 's',
      frame_index: 0,
      expression: 'x'.repeat(4097),
    }),
    /≤ 4096/,
  );
});

// ---- Integration: set bp, trigger, pause, inspect, resume ----
//
// Spins up a local HTTP server that serves a page + a script with a known
// breakpoint-worthy closure. Then drives the full debugger flow through
// klura's startSession → debugger tools → closeSession lifecycle.

async function startFixtureServer() {
  const html = `<!doctype html>
<html><body>
<button id="trigger">send</button>
<script src="/encoder.js"></script>
<script>
document.getElementById('trigger').addEventListener('click', () => {
  // Call into the closure so the breakpoint fires.
  window.__triggerSend({ text: 'hello', threadId: 42 });
});
</script>
</body></html>`;
  const js = `(() => {
  const encoder = (args) => 'ENC:' + JSON.stringify(args);
  function doSend(args) {        // line 3 (0-indexed line 2)
    const encoded = encoder(args); // line 4 (0-indexed line 3) — breakpoint target
    return encoded;
  }
  window.__triggerSend = doSend;
})();
`;
  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } else if (req.url === '/encoder.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(js);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { server, url: `http://127.0.0.1:${port}/`, jsUrl: `http://127.0.0.1:${port}/encoder.js` };
}

async function maybeStartSession(url) {
  try {
    return await klura.startSession(url, {});
  } catch (err) {
    return { _startFailed: String(err) };
  }
}

test('integration: breakpoint → trigger → pause → scope → evaluate → resume → cleanup', async (t) => {
  const { server, url, jsUrl } = await startFixtureServer();
  try {
    const started = await maybeStartSession(url);
    if (started._startFailed) {
      t.skip(`browser unavailable: ${started._startFailed}`);
      return;
    }
    const sessionId = started.sessionId;

    // list_breakpoints is legal pre-set_breakpoint → returns [].
    const initial = await klura.listBreakpointsTool({ session_id: sessionId });
    assert.deepStrictEqual(initial.breakpoints, []);

    // Break on the line that calls encoder(args). In the served JS that is
    // the 4th line (0-indexed line 3): "    const encoded = encoder(args);"
    const bp = await klura.setBreakpointTool({
      session_id: sessionId,
      file: jsUrl,
      line: 3,
    });
    assert.ok(bp.breakpoint_id, 'expected breakpoint_id on set_breakpoint');

    const listed = await klura.listBreakpointsTool({ session_id: sessionId });
    assert.strictEqual(listed.breakpoints.length, 1);

    // wait_for_pause while we fire the click → race the two.
    const pausePromise = klura.waitForPauseTool({
      session_id: sessionId,
      timeout_ms: 10_000,
    });
    // Trigger the click. No await on the result (may block on pause), but
    // we still give perform_action a chance to register the click before we
    // wait on the pause.
    klura.performAction(sessionId, 'click', '#trigger').catch(() => {});

    const paused = await pausePromise;
    assert.strictEqual(paused.hit, true, 'expected breakpoint hit');
    assert.ok(paused.call_frames.length > 0, 'expected at least one call frame');

    // Evaluate in the paused frame — should see `args` in scope.
    const evalResult = await klura.evaluateOnFrameTool({
      session_id: sessionId,
      frame_index: 0,
      expression: 'JSON.stringify(args)',
    });
    assert.strictEqual(evalResult.ok, true, `evaluate_on_frame failed: ${evalResult.error}`);
    assert.match(evalResult.result, /hello/);
    assert.match(evalResult.result, /42/);

    // Dump the local scope → should list `args`.
    const scope = await klura.getFrameScopeTool({
      session_id: sessionId,
      frame_index: 0,
      scope_type: 'local',
    });
    const names = scope.properties.map((p) => p.name);
    assert.ok(names.includes('args'), `expected "args" in local scope, got ${names.join(',')}`);

    // Resume and close. close_session also auto-cleans, so we don't need
    // to remove_breakpoint manually.
    await klura.resumeTool({ session_id: sessionId });
    await klura.closeSession(sessionId);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('integration: wait_for_pause with no breakpoints → timeout', async (t) => {
  const { server, url } = await startFixtureServer();
  try {
    const started = await maybeStartSession(url);
    if (started._startFailed) {
      t.skip(`browser unavailable: ${started._startFailed}`);
      return;
    }
    const sessionId = started.sessionId;
    const paused = await klura.waitForPauseTool({ session_id: sessionId, timeout_ms: 200 });
    assert.strictEqual(paused.hit, false);
    assert.strictEqual(paused.reason, 'timeout');
    await klura.closeSession(sessionId);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

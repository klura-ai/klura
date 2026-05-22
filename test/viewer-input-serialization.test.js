// Regression test: the viewer's WS message handler must process input
// messages strictly in arrival order. A click is a stream (pointer_move* →
// pointer_down → pointer_up) and each pointer_move expands to several
// sequential mouseMove calls (Catmull-Rom). When the handler ran each message
// in a non-awaited `void (async()=>{})()`, those handlers overlapped — the
// interpolated moves dragged the shared `page.mouse` off-target between
// mouse.down() and mouse.up(), so viewer clicks never landed.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

// Isolated KLURA_HOME so the remote-secret keyfile lands in a tmpdir.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-viewer-ser-'));
process.env.KLURA_HOME = tmpHome;

const { startViewer, stopViewer } = await import('../dist/remote/viewer.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('viewer serialises WS input handlers — pointer ops never interleave', async () => {
  const ops = [];
  let active = 0;
  let maxConcurrent = 0;
  // Each guarded driver op holds `active` for 10ms. If two handlers run
  // concurrently, `active` exceeds 1 and the test fails.
  const guard = (name) => async () => {
    active++;
    maxConcurrent = Math.max(maxConcurrent, active);
    ops.push(name);
    await sleep(10);
    active--;
  };
  const driver = /** @type {any} */ ({
    screenshotJpeg: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    onFocusChange: async () => () => {},
    onSubPagesChange: async () => () => {},
    viewportSize: () => ({ width: 1280, height: 720 }),
    setViewport: async () => {},
    mouseDown: guard('down'),
    mouseUp: guard('up'),
    mouseMove: guard('move'),
    mouseClick: guard('click'),
    touchStart: guard('tdown'),
    touchMove: guard('tmove'),
    touchEnd: guard('tup'),
    touchTap: guard('ttap'),
    keyPress: guard('key'),
    typeText: guard('type'),
    scroll: guard('scroll'),
  });
  const session = /** @type {any} */ ({ id: 's1', hasTouch: false, subPages: [] });

  const viewer = await startViewer('ser-test', driver, session, {});
  const ws = new WebSocket(
    `ws://localhost:${viewer.port}/ws?token=${encodeURIComponent(viewer.token)}&v=${encodeURIComponent(viewer.integrity)}`,
  );
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });
  ws.send(
    JSON.stringify({
      type: 'capabilities',
      hasTouch: false,
      maxTouchPoints: 0,
      screenWidth: 1280,
      screenHeight: 720,
      devicePixelRatio: 1,
    }),
  );
  await sleep(100);

  // A realistic click stream: a move-stream priming Catmull-Rom, then down, a
  // move during the click, then up — all fired back-to-back.
  for (const m of [
    { type: 'pointer_move', x: 0.4, y: 0.5 },
    { type: 'pointer_move', x: 0.45, y: 0.5 },
    { type: 'pointer_move', x: 0.49, y: 0.5 },
    { type: 'pointer_move', x: 0.5, y: 0.5 },
    { type: 'pointer_down', x: 0.5, y: 0.5 },
    { type: 'pointer_move', x: 0.5, y: 0.5 },
    { type: 'pointer_up', x: 0.5, y: 0.5 },
  ]) {
    ws.send(JSON.stringify(m));
  }

  await sleep(800);
  ws.close();
  await stopViewer('ser-test');

  assert.strictEqual(
    maxConcurrent,
    1,
    `pointer ops overlapped (maxConcurrent=${maxConcurrent}) — handlers not serialised`,
  );
  const di = ops.indexOf('down');
  const ui = ops.lastIndexOf('up');
  assert.ok(di >= 0 && ui >= 0, `expected down+up in ops, got [${ops.join(',')}]`);
  assert.ok(di < ui, `down must precede up, got [${ops.join(',')}]`);
});

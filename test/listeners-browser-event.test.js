// Browser-event listener integration test.
//
// Exercises ListenerManager.connectBrowserEvent through a mock pool + mock
// driver whose `streamWebSocketFrames` returns a controllable handle. The
// test can manually invoke the frame callback (to simulate WebSocket frames
// arriving from a page) and resolve the `closed` deferred (to simulate the
// stream terminating, which should trigger the auto-reconnect path).
//
// What this catches that the other tests don't:
//   - The browser-event branch in startTransport actually creates a session
//   - Frame callback → handleIncomingData → match filter → event queue chain
//   - On-stop: dispose called + pool session closed
//   - On-close: scheduleReconnect re-enters connectBrowserEvent and creates
//     a new session (the dead one is torn down first)
//   - Max-retries: listener gives up after exponential backoff exhausts

import test from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

// Use a temp KLURA_HOME so saveStrategy / loadStrategy don't pollute real state.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-bevtest-'));
process.env.KLURA_HOME = HOME;

const { ListenerManager } = await import('../dist/listeners.js');

// ---- Mock pool + driver ----

let mockSessionCounter = 0;
let activeSessions = new Set();
let mockDriverInstances = []; // one per session, so tests can poke them

function createMockPool() {
  const driverFor = (id) => mockDriverInstances.find((d) => d._sessionId === id);

  return {
    createSession: async (_opts) => {
      const id = `mock_sess_${++mockSessionCounter}`;
      activeSessions.add(id);
      const driver = createMockDriver(id);
      mockDriverInstances.push(driver);
      return { id, intercepted: [], intercepting: false };
    },
    closeSession: async (id) => {
      activeSessions.delete(id);
      const idx = mockDriverInstances.findIndex((d) => d._sessionId === id);
      if (idx >= 0) {
        const driver = mockDriverInstances[idx];
        driver._closed = true;
        mockDriverInstances.splice(idx, 1);
      }
    },
    getSession: (id) => {
      if (!activeSessions.has(id)) throw new Error(`session not found: ${id}`);
      return { id, intercepted: [], intercepting: false };
    },
    driverFor,
  };
}

function createMockDriver(sessionId) {
  let frameCallback = null;
  let closeResolve = null;
  let disposed = false;
  const closed = new Promise((resolve) => {
    closeResolve = resolve;
  });

  return {
    _sessionId: sessionId,
    _closed: false,
    _navigateCalls: [],
    _emitFrame: (frame) => {
      if (frameCallback) frameCallback(frame);
    },
    _triggerClose: (reason = 'mock_close') => {
      if (closeResolve) closeResolve({ reason });
    },
    _wasDisposed: () => disposed,
    navigate: async (_session, url) => {
      mockDriverInstances.find((d) => d._sessionId === sessionId)._navigateCalls.push(url);
    },
    streamWebSocketFrames: async (_session, onFrame) => {
      frameCallback = onFrame;
      return {
        dispose: async () => {
          disposed = true;
          frameCallback = null;
          if (closeResolve) closeResolve({ reason: 'disposed' });
        },
        closed,
      };
    },
  };
}

function resetState() {
  mockSessionCounter = 0;
  activeSessions = new Set();
  mockDriverInstances = [];
}

// Save a browser-event listener strategy under a unique platform/capability
// per test so tests don't interfere with each other.
//
// Listener strategies live under recorded-path as a carrier and declare
// `type: 'listener'` + a `transport: 'browser-event'` discriminator. The
// schema validator still rejects the `transport` top-level field before it
// reaches the listener early-return branch, so bypass the validator by
// writing directly to disk — this is what the ListenerManager reads at
// startup anyway. See `src/strategies/validate.ts:validateWebSocketShape`
// for the ordering issue and `src/listeners.ts:ListenerStrategy` for the
// on-disk shape the manager expects.
function saveListenerStrategy(platform, capability, overrides = {}) {
  const strategy = {
    strategy: 'recorded-path',
    type: 'listener',
    steps: [],
    transport: 'browser-event',
    pageUrl: 'http://test.local/feed/{{room_id}}',
    endpoint: '',
    events: { match: { type: 'message' } },
    ...overrides,
  };
  const dir = path.join(HOME, 'skills', platform, 'paths');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${capability}.json`), JSON.stringify(strategy));
}

// ---- Tests ----

test('browser-event: happy path delivers frames through match filter to event queue', async () => {
  resetState();
  saveListenerStrategy('beapp1', 'on_msg');

  const mgr = new ListenerManager();
  mgr.setPool(createMockPool());

  const { listenerId } = await mgr.start('beapp1', 'on_msg', { room_id: 'general' });

  // Wait for connectBrowserEvent's async chain to register the callback.
  await new Promise((r) => setTimeout(r, 20));

  const driver = mockDriverInstances[0];
  assert.strictEqual(driver._navigateCalls[0], 'http://test.local/feed/general');

  // Inject 3 frames: one matching, one non-matching, one outgoing.
  driver._emitFrame({
    url: 'wss://test.local/ws',
    direction: 'received',
    payload: JSON.stringify({ type: 'message', text: 'hi' }),
    timestamp: Date.now(),
  });
  driver._emitFrame({
    url: 'wss://test.local/ws',
    direction: 'received',
    payload: JSON.stringify({ type: 'typing', user: 'a' }),
    timestamp: Date.now(),
  });
  driver._emitFrame({
    url: 'wss://test.local/ws',
    direction: 'sent',
    payload: JSON.stringify({ type: 'message', text: 'should be ignored — outgoing' }),
    timestamp: Date.now(),
  });

  const events = mgr.getEvents();
  assert.strictEqual(events.length, 1, `expected 1 event after match filter, got ${events.length}`);
  assert.deepStrictEqual(events[0].data, { type: 'message', text: 'hi' });

  await mgr.stop(listenerId);
  assert.strictEqual(activeSessions.size, 0, 'session should be closed on stop');
});

test('browser-event: stop disposes stream and closes pool session', async () => {
  resetState();
  saveListenerStrategy('beapp2', 'on_msg');

  const mgr = new ListenerManager();
  mgr.setPool(createMockPool());

  const { listenerId } = await mgr.start('beapp2', 'on_msg', { room_id: 'r' });
  await new Promise((r) => setTimeout(r, 20));

  const driverBeforeStop = mockDriverInstances[0];
  assert.strictEqual(driverBeforeStop._wasDisposed(), false);

  await mgr.stop(listenerId);

  assert.strictEqual(driverBeforeStop._wasDisposed(), true);
  assert.strictEqual(activeSessions.size, 0);
});

test('browser-event: stream close triggers reconnect with fresh session', async () => {
  resetState();
  saveListenerStrategy('beapp3', 'on_msg', {
    reconnect: { initialDelay: 10, maxRetries: 3, maxDelay: 100 },
  });

  const mgr = new ListenerManager();
  mgr.setPool(createMockPool());

  const { listenerId } = await mgr.start('beapp3', 'on_msg', { room_id: 'r' });
  await new Promise((r) => setTimeout(r, 20));

  assert.strictEqual(mockDriverInstances.length, 1, 'one session at start');
  const firstDriver = mockDriverInstances[0];

  // Simulate the stream terminating (server crash, connection drop, etc).
  firstDriver._triggerClose('connection_lost');

  // Wait long enough for the reconnect timer (initialDelay=10ms) to fire and
  // connectBrowserEvent to create a fresh session + register a new stream.
  await new Promise((r) => setTimeout(r, 100));

  // The old session should be torn down; a new one should be active.
  assert.strictEqual(activeSessions.size, 1, 'one active session after reconnect');
  assert.ok(mockDriverInstances.length >= 1, 'has a fresh driver');
  // The fresh driver is a new instance (the old one was removed in closeSession).
  assert.notStrictEqual(mockDriverInstances[0], firstDriver, 'new driver after reconnect');

  await mgr.stop(listenerId);
});

test('browser-event: gives up after maxRetries consecutive failed reconnects', async () => {
  resetState();
  saveListenerStrategy('beapp4', 'on_msg', {
    reconnect: { initialDelay: 5, maxRetries: 2, maxDelay: 20 },
  });

  // Pool whose createSession FAILS — simulates the container constantly
  // dying mid-startup. connectBrowserEvent's catch path calls scheduleReconnect
  // each time, accumulating attempts until max_retries fires.
  const failingPool = {
    createSession: () => Promise.reject(new Error('mock create failure')),
    closeSession: () => Promise.resolve(),
    getSession: () => {
      throw new Error('not implemented');
    },
    driverFor: () => {
      throw new Error('not implemented');
    },
  };

  const mgr = new ListenerManager();
  const disconnected = [];
  mgr.on('disconnected', (info) => disconnected.push(info));
  mgr.setPool(failingPool);

  const { listenerId } = await mgr.start('beapp4', 'on_msg', { room_id: 'r' });

  // Wait long enough for: initial attempt + 2 reconnect attempts (each
  // with up to ~25ms delay including jitter + maxDelay cap) + max_retries.
  await new Promise((r) => setTimeout(r, 250));

  const maxRetriesEvent = disconnected.find((d) => d.reason === 'max_retries');
  assert.ok(maxRetriesEvent, 'should emit disconnected:max_retries after exhausting retries');
  assert.strictEqual(maxRetriesEvent.listenerId, listenerId);
});

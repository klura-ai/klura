// Proactive listener token refresh — ListenerManager watcher fires a
// prereq re-run + reconnect when cached tokens approach TTL, ahead of the
// reactive 401 path. We construct ActiveListener objects directly and
// exercise the watcher methods so we don't have to mock a browser pool or
// a skills JSON file.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { ListenerManager } = await import('../dist/listeners.js');

function mockTokenCache(needsRefreshByName) {
  return {
    needsRefresh(_platform, name) {
      return needsRefreshByName[name] === true;
    },
    get() {
      return null;
    },
    set() {},
    getAllForPlatform() {
      return [];
    },
    startRefreshLoop() {},
    stopRefreshLoop() {},
  };
}

function makeListener(strategy, args = {}) {
  return {
    id: 'test-listener',
    platform: 'example',
    capability: 'on_msg',
    args,
    strategy,
    startedAt: Date.now(),
    reconnectAttempts: 2, // non-zero — refresh should reset to 0
  };
}

test('tickTokenWatch fires prereq runner + reconnect when cache reports needsRefresh', async () => {
  const mgr = new ListenerManager();
  mgr.setTokenCache(mockTokenCache({ session_token: true }));

  let prereqCalls = 0;
  mgr.setPrereqRunner(async () => {
    prereqCalls++;
    return { tokens: {} };
  });

  let reconnectCalls = 0;
  mgr.scheduleReconnect = () => {
    reconnectCalls++;
  };

  const strategy = {
    strategy: 'fetch',
    type: 'listener',
    transport: 'websocket',
    endpoint: 'wss://example.com/chat?token={{session_token}}',
    auth: { type: 'query-param', param: 'token', value: '{{session_token}}' },
  };
  const listener = makeListener(strategy, { session_token: 'stale' });
  mgr.active.set(listener.id, listener);

  await mgr.tickTokenWatch(listener);

  assert.equal(prereqCalls, 1, 'prereq runner fired once');
  assert.equal(reconnectCalls, 1, 'reconnect scheduled once');
  assert.equal(listener.reconnectAttempts, 0, 'backoff reset for preemptive refresh');
  assert.equal(listener.refreshInFlight, false, 'in-flight flag cleared');
});

test('tickTokenWatch is a no-op when all cached tokens are fresh', async () => {
  const mgr = new ListenerManager();
  mgr.setTokenCache(mockTokenCache({ session_token: false }));

  let prereqCalls = 0;
  mgr.setPrereqRunner(async () => {
    prereqCalls++;
    return { tokens: {} };
  });
  let reconnectCalls = 0;
  mgr.scheduleReconnect = () => {
    reconnectCalls++;
  };

  const strategy = {
    strategy: 'fetch',
    type: 'listener',
    transport: 'websocket',
    endpoint: 'wss://example.com/chat?token={{session_token}}',
    auth: { type: 'query-param', param: 'token', value: '{{session_token}}' },
  };
  const listener = makeListener(strategy);
  mgr.active.set(listener.id, listener);

  await mgr.tickTokenWatch(listener);

  assert.equal(prereqCalls, 0);
  assert.equal(reconnectCalls, 0);
});

test('tickTokenWatch skips when a refresh is already in flight', async () => {
  const mgr = new ListenerManager();
  mgr.setTokenCache(mockTokenCache({ session_token: true }));

  let prereqCalls = 0;
  mgr.setPrereqRunner(async () => {
    prereqCalls++;
    return { tokens: {} };
  });
  mgr.scheduleReconnect = () => {};

  const strategy = {
    strategy: 'fetch',
    type: 'listener',
    transport: 'websocket',
    endpoint: 'wss://example.com/chat?token={{session_token}}',
    auth: { type: 'query-param', param: 'token', value: '{{session_token}}' },
  };
  const listener = makeListener(strategy);
  listener.refreshInFlight = true;
  mgr.active.set(listener.id, listener);

  await mgr.tickTokenWatch(listener);

  assert.equal(prereqCalls, 0, 'in-flight guard suppresses the tick');
});

test('startTokenWatch does not schedule a timer when the strategy has no {{templates}}', () => {
  const mgr = new ListenerManager();
  mgr.setTokenCache(mockTokenCache({}));
  mgr.setPrereqRunner(async () => ({ tokens: {} }));

  const strategy = {
    strategy: 'fetch',
    type: 'listener',
    transport: 'websocket',
    endpoint: 'wss://example.com/chat',
  };
  const listener = makeListener(strategy);
  mgr.startTokenWatch(listener);

  assert.equal(
    listener.tokenWatchTimer,
    undefined,
    'static-endpoint listeners skip the watcher',
  );
});

test('startTokenWatch does not schedule a timer when no prereq runner is wired', () => {
  const mgr = new ListenerManager();
  mgr.setTokenCache(mockTokenCache({}));
  // no setPrereqRunner

  const strategy = {
    strategy: 'fetch',
    type: 'listener',
    transport: 'websocket',
    endpoint: 'wss://example.com/chat?token={{session_token}}',
  };
  const listener = makeListener(strategy);
  mgr.startTokenWatch(listener);

  assert.equal(listener.tokenWatchTimer, undefined);
});

test('tickTokenWatch leaves listener alive when the prereq run throws', async () => {
  const mgr = new ListenerManager();
  mgr.setTokenCache(mockTokenCache({ session_token: true }));
  mgr.setPrereqRunner(async () => {
    throw new Error('prereq failed');
  });
  let reconnectCalls = 0;
  mgr.scheduleReconnect = () => {
    reconnectCalls++;
  };

  const strategy = {
    strategy: 'fetch',
    type: 'listener',
    transport: 'websocket',
    endpoint: 'wss://example.com/chat?token={{session_token}}',
    auth: { type: 'query-param', param: 'token', value: '{{session_token}}' },
  };
  const listener = makeListener(strategy);
  mgr.active.set(listener.id, listener);

  await mgr.tickTokenWatch(listener);

  assert.equal(reconnectCalls, 0, 'no reconnect on prereq failure');
  assert.equal(listener.refreshInFlight, false, 'in-flight flag cleared even on throw');
  assert.ok(mgr.active.has(listener.id), 'listener still registered');
});

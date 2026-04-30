// ws-pin module: hash stability + pinned-map LRU + resolveWsFrame lookup order.
//
// Does NOT exercise the tool surface — that's covered by the integration
// tests. These are unit checks on the primitives.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { hashWsFrame, pinWsFrame, resolveWsFrame, WS_PINNED_FRAMES_CAP } =
  await import('../dist/response/ws-pin.js');

function frame(dir, url, payload) {
  return { direction: dir, url, payload, timestamp: 0 };
}

function sess(ringFrames = []) {
  return { id: 's', intercepted: [], intercepting: false, wsFrames: ringFrames };
}

test('hashWsFrame: deterministic', () => {
  const a = frame('sent', 'wss://x', 'hello');
  const b = frame('sent', 'wss://x', 'hello');
  assert.equal(hashWsFrame(a), hashWsFrame(b));
});

test('hashWsFrame: direction distinguishes', () => {
  const a = frame('sent', 'wss://x', 'p');
  const b = frame('received', 'wss://x', 'p');
  assert.notEqual(hashWsFrame(a), hashWsFrame(b));
});

test('hashWsFrame: url distinguishes', () => {
  const a = frame('sent', 'wss://x', 'p');
  const b = frame('sent', 'wss://y', 'p');
  assert.notEqual(hashWsFrame(a), hashWsFrame(b));
});

test('hashWsFrame: payload distinguishes', () => {
  const a = frame('sent', 'wss://x', 'p1');
  const b = frame('sent', 'wss://x', 'p2');
  assert.notEqual(hashWsFrame(a), hashWsFrame(b));
});

test('pinWsFrame: stores and returns hash', () => {
  const s = sess();
  const f = frame('sent', 'wss://x', 'hello');
  const hash = pinWsFrame(s, f);
  assert.equal(s.pinnedWsFrames?.size, 1);
  assert.equal(s.pinnedWsFrames?.get(hash), f);
});

test('pinWsFrame: idempotent on same hash', () => {
  const s = sess();
  const f = frame('sent', 'wss://x', 'hello');
  pinWsFrame(s, f);
  pinWsFrame(s, f);
  assert.equal(s.pinnedWsFrames.size, 1);
});

test('pinWsFrame: LRU eviction at cap', () => {
  const s = sess();
  for (let i = 0; i < WS_PINNED_FRAMES_CAP; i++) {
    pinWsFrame(s, frame('sent', 'wss://x', `p${i}`));
  }
  assert.equal(s.pinnedWsFrames.size, WS_PINNED_FRAMES_CAP);
  // One more → size stays at cap, oldest evicted
  const firstHash = hashWsFrame(frame('sent', 'wss://x', 'p0'));
  assert(s.pinnedWsFrames.has(firstHash), 'oldest still present before overflow');
  pinWsFrame(s, frame('sent', 'wss://x', 'p_new'));
  assert.equal(s.pinnedWsFrames.size, WS_PINNED_FRAMES_CAP);
  assert(!s.pinnedWsFrames.has(firstHash), 'oldest evicted');
});

test('resolveWsFrame: by ws_hash finds pinned', () => {
  const s = sess();
  const f = frame('sent', 'wss://x', 'hello');
  const hash = pinWsFrame(s, f);
  const r = resolveWsFrame(s, { ws_hash: hash });
  assert(r);
  assert.equal(r.frame, f);
  assert.equal(r.from, 'pinned');
  assert.equal(r.hash, hash);
});

test('resolveWsFrame: by ws_i finds ring', () => {
  const f = frame('sent', 'wss://x', 'hello');
  const s = sess([f]);
  const r = resolveWsFrame(s, { ws_i: 0 });
  assert(r);
  assert.equal(r.frame, f);
  assert.equal(r.from, 'ring');
  assert.equal(r.i, 0);
});

test('resolveWsFrame: ws_hash wins over ws_i when both given', () => {
  const pinned = frame('sent', 'wss://x', 'pinned-bytes');
  const ringFrame = frame('sent', 'wss://x', 'ring-bytes');
  const s = sess([ringFrame]);
  const hash = pinWsFrame(s, pinned);
  const r = resolveWsFrame(s, { ws_i: 0, ws_hash: hash });
  assert.equal(r.frame, pinned);
  assert.equal(r.from, 'pinned');
});

test('resolveWsFrame: pinned survives ring rotation', () => {
  const target = frame('sent', 'wss://x', 'target');
  const s = sess([target]);
  const hash = pinWsFrame(s, target);
  // Simulate ring rotation — new frames push target out.
  s.wsFrames = [
    frame('sent', 'wss://x', 'a'),
    frame('sent', 'wss://x', 'b'),
    frame('sent', 'wss://x', 'c'),
  ];
  const r = resolveWsFrame(s, { ws_hash: hash });
  assert(r, 'pinned frame still resolvable after ring rotation');
  assert.equal(r.frame, target);
  assert.equal(r.from, 'pinned');
});

test('resolveWsFrame: ws_hash scans ring when not pinned', () => {
  const target = frame('sent', 'wss://x', 'target');
  const s = sess([frame('sent', 'wss://x', 'a'), target]);
  const hash = hashWsFrame(target);
  const r = resolveWsFrame(s, { ws_hash: hash });
  assert(r);
  assert.equal(r.frame, target);
  assert.equal(r.from, 'ring');
  assert.equal(r.i, 1);
});

test('resolveWsFrame: returns null when neither pinned nor ring matches', () => {
  const s = sess();
  assert.equal(resolveWsFrame(s, { ws_hash: 'deadbeef' }), null);
  assert.equal(resolveWsFrame(s, { ws_i: 99 }), null);
});

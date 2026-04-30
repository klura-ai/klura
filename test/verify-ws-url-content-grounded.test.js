// Save-time grounding: wsUrl must match the WebSocket URL that actually
// carried the strategy's referenced content. Catches the "agent probed the
// wrong `window.__kluraSendEncoders[X].ws.url`" class of mistake where the
// site opens several WebSockets and the encoder entry the agent inspected
// isn't the one carrying the payload.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { verifyWsUrlObserved } = await import('../dist/strategies/verify-observed.js');

function mkSentFrame(url, payload) {
  return { url, direction: 'sent', payload };
}

test('ws url matches carrier: accepted', () => {
  const strategy = {
    strategy: 'page-script',
    protocol: 'websocket',
    wsUrl: 'wss://chat.example.com/chat',
    frameFromPage: {
      expression: "(function(){return 'encoded'})()",
      returns: 'hex',
    },
    notes: { params: { text: { example: 'hello world' } } },
  };
  const frames = [
    mkSentFrame('wss://chat.example.com/chat?sid=abc', 'binary /topic_send hello world more'),
    mkSentFrame('wss://gateway.example.com/ws/realtime?sid=abc', 'presence ping'),
  ];
  // Should not throw.
  verifyWsUrlObserved(strategy, frames);
});

test('ws url points at wrong carrier: rejected with correct-url hint', () => {
  const strategy = {
    strategy: 'page-script',
    protocol: 'websocket',
    wsUrl: 'wss://gateway.example.com/ws/realtime',
    frameFromPage: {
      expression: "(function(){return 'bytes'})()",
      returns: 'hex',
    },
    notes: { params: { text: { example: 'the typed content' } } },
  };
  const frames = [
    // The typed content actually rode the chat WS, not gateway.
    mkSentFrame('wss://chat.example.com/chat?sid=abc', 'envelope /x the typed content body'),
    // gateway is open and observed, but carries other stuff.
    mkSentFrame('wss://gateway.example.com/ws/realtime?sid=abc', 'ping frame'),
  ];
  assert.throws(
    () => verifyWsUrlObserved(strategy, frames),
    /invalid_strategy: wsUrl.*does not match the WebSocket URL that actually carried.*chat\.example\.com\/chat/,
  );
});

test('protocol-topic literal in frameFromPage expression grounds the check', () => {
  const strategy = {
    strategy: 'page-script',
    protocol: 'websocket',
    wsUrl: 'wss://gateway.example.com/ws/realtime',
    frameFromPage: {
      expression: "(function(){var pub=new Codec.Publish('/ls_req', msg, 1); return pub.encode();})()",
      returns: 'hex',
    },
  };
  const frames = [
    mkSentFrame('wss://chat.example.com/chat?sid=abc', 'binary/ls_req payload bytes'),
    mkSentFrame('wss://gateway.example.com/ws/realtime?sid=abc', 'ping'),
  ];
  assert.throws(
    () => verifyWsUrlObserved(strategy, frames),
    /\/ls_req/,
  );
});

test('no literals extractable: falls back to observation check (url was observed)', () => {
  const strategy = {
    strategy: 'page-script',
    protocol: 'websocket',
    wsUrl: 'wss://gateway.example.com/ws/realtime',
    frameFromPage: { expression: "x", returns: 'hex' },
  };
  const frames = [
    mkSentFrame('wss://gateway.example.com/ws/realtime?sid=abc', 'any bytes'),
  ];
  // No content literal to ground; wsUrl IS observed in frames — accept.
  verifyWsUrlObserved(strategy, frames);
});

test('no literals extractable: url NOT observed anywhere → reject (existing check)', () => {
  const strategy = {
    strategy: 'page-script',
    protocol: 'websocket',
    wsUrl: 'wss://imaginary.example.com/ws',
    frameFromPage: { expression: 'x', returns: 'hex' },
  };
  const frames = [
    mkSentFrame('wss://real.example.com/chat?sid=abc', 'bytes'),
  ];
  assert.throws(
    () => verifyWsUrlObserved(strategy, frames),
    /was NOT observed/,
  );
});

test('literal never appeared in any frame: falls back to observation check (no basis to judge)', () => {
  const strategy = {
    strategy: 'page-script',
    protocol: 'websocket',
    wsUrl: 'wss://chat.example.com/chat',
    frameFromPage: { expression: "x", returns: 'hex' },
    notes: { params: { text: { example: 'never-sent-literal' } } },
  };
  const frames = [
    // Literal never appeared; but wsUrl IS observed — fall-through accepts.
    mkSentFrame('wss://chat.example.com/chat?sid=abc', 'unrelated bytes'),
  ];
  verifyWsUrlObserved(strategy, frames);
});

test('ws strategy with {{placeholder}} wsUrl is skipped', () => {
  const strategy = {
    strategy: 'page-script',
    protocol: 'websocket',
    wsUrl: 'wss://{{host}}/chat',
  };
  const frames = [mkSentFrame('wss://foo/chat', 'x')];
  verifyWsUrlObserved(strategy, frames);
});

test('non-ws strategy is skipped regardless of wsUrl', () => {
  const strategy = {
    strategy: 'fetch',
    method: 'POST',
    baseUrl: 'https://api.example.com',
    endpoint: '/x',
    // wsUrl stray is ignored because protocol !== 'websocket'
    wsUrl: 'wss://never-matches.example.com/ws',
  };
  verifyWsUrlObserved(strategy, [mkSentFrame('wss://other.example.com/x', 'y')]);
});

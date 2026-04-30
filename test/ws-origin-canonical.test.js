// WS strategies: `origin` is the canonical field name; `baseUrl` is
// accepted as an alias (back-compat with strategies saved before the
// rename) and normalized to `origin`. HTTP strategies keep `baseUrl`
// canonical with `origin` accepted as an alias.
//
// This tests the save-time validator's alias normalization and
// required-fields behavior.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { validateStrategyShape } = await import('../dist/strategies/validate.js');

function mkPageScriptWs(extra = {}) {
  return {
    strategy: 'page-script',
    protocol: 'websocket',
    wsUrl: 'wss://example.com/chat',
    frameEncoding: 'binary',
    frameFromPage: { expression: '"{{text}}"', returns: 'hex' },
    notes: { params: { text: { example: 'hello' } } },
    ...extra,
  };
}

function mkFetchHttp(extra = {}) {
  return {
    strategy: 'fetch',
    method: 'POST',
    endpoint: '/api/x',
    headers: {},
    body: {},
    prerequisites: [],
    ...extra,
  };
}

test('ws strategy: origin accepted as canonical field', () => {
  const s = mkPageScriptWs({ origin: 'https://example.com' });
  validateStrategyShape(s);
  assert.equal(s.origin, 'https://example.com');
  assert.equal(s.baseUrl, undefined);
});

test('ws strategy: baseUrl rejected (no back-compat, hard rename)', () => {
  const s = mkPageScriptWs({ baseUrl: 'https://example.com' });
  assert.throws(
    () => validateStrategyShape(s),
    /baseUrl is not a valid field for websocket strategies.*origin/,
  );
});

test('ws strategy: baseUrl rejected even when origin is also set', () => {
  const s = mkPageScriptWs({ origin: 'https://x.com', baseUrl: 'https://x.com' });
  assert.throws(() => validateStrategyShape(s), /baseUrl is not a valid field for websocket/);
});

test('ws strategy: missing both origin and baseUrl with wsOpen:"navigate" → rejected', () => {
  const s = mkPageScriptWs(); // no origin, no baseUrl, no wsOpen
  assert.throws(() => validateStrategyShape(s), /requires "origin"/);
});

test('ws strategy: missing origin allowed with wsOpen:"none"', () => {
  const s = mkPageScriptWs({ wsOpen: 'none' });
  validateStrategyShape(s);
  assert.equal(s.origin, undefined);
});

test('HTTP strategy: baseUrl remains canonical', () => {
  const s = mkFetchHttp({ baseUrl: 'https://api.example.com' });
  validateStrategyShape(s);
  assert.equal(s.baseUrl, 'https://api.example.com');
  assert.equal(s.origin, undefined);
});

test('HTTP fetch strategy: origin rejected outright (no alias — baseUrl is the canonical name)', () => {
  const s = mkFetchHttp({ origin: 'https://api.example.com' });
  assert.throws(() => validateStrategyShape(s), /origin is not a field on HTTP fetch strategies/);
});

test('HTTP page-script strategy: origin accepted (signer page differs from API host)', () => {
  const s = {
    strategy: 'page-script',
    baseUrl: 'https://api.example.com',
    endpoint: '/v1/x',
    origin: 'https://signer.example.com',
  };
  validateStrategyShape(s);
  assert.equal(s.origin, 'https://signer.example.com');
  assert.equal(s.baseUrl, 'https://api.example.com');
});

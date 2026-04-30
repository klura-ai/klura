// page-script HTTP strategies accept an optional `origin` field naming the
// page the in-page fetch must run inside, when that page lives on a different
// host than the API's `baseUrl` (e.g. a signer page on signer.example.com
// minting tokens for an API on api.example.com).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { validateStrategyShape } = await import('../dist/strategies/validate.js');

test('page-script: origin accepted alongside baseUrl', () => {
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

test('page-script: origin alone (no baseUrl) still rejected — baseUrl is required', () => {
  const s = {
    strategy: 'page-script',
    endpoint: '/v1/x',
    origin: 'https://signer.example.com',
  };
  assert.throws(() => validateStrategyShape(s), /baseUrl is required/);
});

test('fetch tier: origin still rejected (no signer-page concept)', () => {
  const s = {
    strategy: 'fetch',
    baseUrl: 'https://api.example.com',
    endpoint: '/v1/x',
    origin: 'https://signer.example.com',
  };
  assert.throws(() => validateStrategyShape(s), /origin is not a field on HTTP fetch strategies/);
});

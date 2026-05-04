// Pool-level conformance test.
//
// Pool must satisfy the BrowserPool interface declared in
// src/drivers/interface.ts. TypeScript enforces this at build time via
// `implements BrowserPool`; this file is the runtime safety net that catches
// someone deleting a method without updating callers.

import test from 'node:test';
import assert from 'node:assert';
import { Pool } from '../dist/pool/pool.js';

// Method surface every BrowserPool implementation must expose. Sourced from
// the interface in src/drivers/interface.ts — keep in lockstep when adding
// new members.
const REQUIRED_METHODS = [
  'createSession',
  'endDrive',
  'getSession',
  'driverFor',
  'shutdown',
];

const REQUIRED_GETTERS = ['activeSessions', 'idleSince'];

function methodSurface(obj) {
  const seen = new Set();
  let proto = Object.getPrototypeOf(obj);
  while (proto && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue;
      if (typeof obj[name] === 'function') seen.add(name);
    }
    proto = Object.getPrototypeOf(proto);
  }
  return seen;
}

function assertConforms(pool, label) {
  const surface = methodSurface(pool);
  for (const name of REQUIRED_METHODS) {
    assert.ok(
      surface.has(name),
      `${label} is missing BrowserPool method "${name}" — every implementation must expose it`,
    );
  }
  for (const name of REQUIRED_GETTERS) {
    const value = pool[name];
    assert.strictEqual(
      typeof value,
      'number',
      `${label}.${name} must be a number (getter), got ${typeof value}`,
    );
  }
}

test('Pool conforms to BrowserPool interface', () => {
  // Pass a no-op driver class to avoid requiring playwright at test time.
  class NoopDriver {
    get capabilities() {
      return [];
    }
    async createSession() {
      return { id: 'x', intercepted: [], intercepting: false };
    }
    async destroySession() {}
    async closeBrowser() {}
  }
  const pool = new Pool(NoopDriver, { idleTimeout: 1 });
  assertConforms(pool, 'Pool');
});

// readInitialNavStatus: walks the intercepted ring in REVERSE so a long-lived
// session's perform_action navigate doesn't read the stale session-start
// status. Earlier behavior (forward-walk, return first match) masked the
// just-fired status with whatever the original start_session captured —
// agents moved on assuming success and missed real 4xx on the new target.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { readInitialNavStatus } = await import('../dist/tools/start-session.js');

function req(url, status, isNavigation) {
  return { url, status, isNavigation };
}

test('reverse-walk: latest matching-host status wins over earlier same-host status', () => {
  const session = {
    intercepted: [
      req('https://example.com/', 200, true),
      req('https://example.com/api/x', 200, false),
      req('https://example.com/product/123', 403, true),
    ],
  };
  assert.equal(
    readInitialNavStatus(session, 'https://example.com/product/123', 'https://example.com/product/123'),
    403,
  );
});

test('isNavigation:true preferred over plain matching-host entry', () => {
  const session = {
    intercepted: [
      req('https://example.com/api/precheck', 500, false),
      req('https://example.com/', 200, true),
      req('https://example.com/api/postcheck', 500, false),
    ],
  };
  assert.equal(
    readInitialNavStatus(session, 'https://example.com/', 'https://example.com/'),
    200,
  );
});

test('falls back to any matching-host status when no isNavigation entry exists', () => {
  const session = {
    intercepted: [req('https://example.com/foo', 451, false)],
  };
  assert.equal(
    readInitialNavStatus(session, 'https://example.com/foo', 'https://example.com/foo'),
    451,
  );
});

test('empty intercepted → null', () => {
  assert.equal(
    readInitialNavStatus({ intercepted: [] }, 'https://example.com/', 'https://example.com/'),
    null,
  );
});

test('host mismatch → null', () => {
  const session = {
    intercepted: [req('https://other.com/', 200, true)],
  };
  assert.equal(
    readInitialNavStatus(session, 'https://example.com/', 'https://example.com/'),
    null,
  );
});

test('matches against currentUrl host when requested-host has no matches', () => {
  const session = {
    intercepted: [req('https://resolved.com/', 200, true)],
  };
  assert.equal(
    readInitialNavStatus(session, 'https://requested.com/', 'https://resolved.com/'),
    200,
  );
});

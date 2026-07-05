// Confirms the fix for the mirror-loop bug: the remote viewer's own page must
// never appear in the sub-page tab strip (selecting it would stream the viewer
// into itself). A page is "self" when its URL carries the session's unique
// viewer token or is served from the viewer's port.

import test from 'node:test';
import assert from 'node:assert';
import { isViewerSelfPage, sendSubPagesSnapshot } from '../dist/remote/viewer.js';

const VIEWER = { token: 'eyJhbGciJWT-UNIQUE-abc123', port: 14747, activePage: 'main' };

test('isViewerSelfPage: matches the viewer by token, port, and nothing else', () => {
  // token in the URL (tunnel exposure — no matching port)
  assert.strictEqual(
    isViewerSelfPage('https://x.trycloudflare.com/?token=eyJhbGciJWT-UNIQUE-abc123&v=z', VIEWER),
    true,
  );
  // served from the viewer's own port (short-url redirect, pre-resolve)
  assert.strictEqual(isViewerSelfPage('http://localhost:14747/r/abcdef0123456789', VIEWER), true);
  // a real site page — must NOT be filtered
  assert.strictEqual(isViewerSelfPage('https://example.com/profile', VIEWER), false);
  // different port, no token
  assert.strictEqual(isViewerSelfPage('http://localhost:3000/app', VIEWER), false);
  // undefined / junk
  assert.strictEqual(isViewerSelfPage(undefined, VIEWER), false);
  assert.strictEqual(isViewerSelfPage('not a url', VIEWER), false);
});

test('sendSubPagesSnapshot: drops the viewer self-page, keeps real pages', () => {
  const sent = [];
  const ws = { readyState: 1 /* OPEN */, send: (d) => sent.push(JSON.parse(d)) };
  const subPages = [
    { id: 'popup-1', url: 'https://example.com/inbox', title: 'Inbox' },
    { id: 'popup-2', url: 'https://x.trycloudflare.com/?token=eyJhbGciJWT-UNIQUE-abc123&v=z', title: 'klura viewer' },
    { id: 'popup-3', url: 'http://localhost:14747/r/deadbeefdeadbeef', title: 'redirect' },
    { id: 'popup-4', url: 'https://example.com/settings', title: 'Settings' },
  ];
  sendSubPagesSnapshot(ws, VIEWER, subPages);
  assert.strictEqual(sent.length, 1);
  const ids = sent[0].list.map((p) => p.id);
  assert.deepStrictEqual(ids, ['popup-1', 'popup-4'], `self-pages must be filtered; got ${ids}`);
});

// Viewer HTTP-route tests — short-link redirect lifecycle (302 → 410), URL
// integrity-check failure page (URL_CORRUPTED_HTML), and the no-short-URL
// opt-out path. The viewer's WebSocket / capture-interval surface needs a
// full BrowserDriver, so these tests stub the driver minimally and only
// exercise the HTTP routes that the integrity-check flow lives on.

import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolated KLURA_HOME so the remote-secret keyfile lands in a tmpdir.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-viewer-'));
process.env.KLURA_HOME = tmpHome;

const { startViewer, stopViewer } = await import('../dist/remote/viewer.js');
const { startRemoteSession, stopRemoteSession } = await import('../dist/remote/index.js');

// Minimal BrowserDriver stub. The HTTP routes we test never touch the driver
// — driver methods are only invoked from the WebSocket connection handler.
const stubDriver = /** @type {any} */ ({});
function stubSession(id) {
  return /** @type {any} */ ({ id, hasTouch: false, subPages: [] });
}

async function fetchJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', ...opts }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('startViewer mints a short token when enableShortUrl=true', async () => {
  const sid = 'sess_short_url_on';
  const v = await startViewer(sid, stubDriver, stubSession(sid), { enableShortUrl: true });
  try {
    assert.ok(v.shortToken, 'shortToken should be set');
    assert.strictEqual(typeof v.shortToken, 'string');
    // 16-char base32 (Crockford-like, no I/L/O/U).
    assert.match(v.shortToken, /^[0-9A-HJKMNPQRSTVWXYZ]{16}$/);
  } finally {
    await stopViewer(sid);
  }
});

test('startViewer returns shortToken=null when enableShortUrl=false', async () => {
  const sid = 'sess_short_url_off';
  const v = await startViewer(sid, stubDriver, stubSession(sid), {
    enableShortUrl: false,
  });
  try {
    assert.strictEqual(v.shortToken, null);
  } finally {
    await stopViewer(sid);
  }
});

test('GET /r/<short> redirects to /?token=...&v=... on first hit', async () => {
  const sid = 'sess_redirect_first';
  const v = await startViewer(sid, stubDriver, stubSession(sid), { enableShortUrl: true });
  try {
    const res = await fetchJson(`http://localhost:${v.port}/r/${v.shortToken}`);
    assert.strictEqual(res.status, 302);
    const loc = res.headers.location;
    assert.ok(loc, 'Location header should be present');
    assert.match(loc, /^\/\?token=/);
    assert.match(loc, /&v=/);
    // Location carries the full JWT URL — agent never had to.
    assert.ok(loc.includes(v.token), 'Location should embed the JWT token');
    assert.ok(loc.includes(v.integrity), 'Location should embed the integrity hash');
  } finally {
    await stopViewer(sid);
  }
});

test('GET /r/<short> 410s on second hit (single-use)', async () => {
  const sid = 'sess_redirect_second';
  const v = await startViewer(sid, stubDriver, stubSession(sid), { enableShortUrl: true });
  try {
    const first = await fetchJson(`http://localhost:${v.port}/r/${v.shortToken}`);
    assert.strictEqual(first.status, 302);
    const second = await fetchJson(`http://localhost:${v.port}/r/${v.shortToken}`);
    assert.strictEqual(second.status, 410);
    assert.match(second.body, /already consumed|expired/);
    assert.match(second.body, /refresh the remote viewer/);
  } finally {
    await stopViewer(sid);
  }
});

test('GET /r/<unknown> 404s', async () => {
  const sid = 'sess_redirect_unknown';
  const v = await startViewer(sid, stubDriver, stubSession(sid), { enableShortUrl: true });
  try {
    const res = await fetchJson(`http://localhost:${v.port}/r/0123456789ABCDEF`);
    assert.strictEqual(res.status, 404);
  } finally {
    await stopViewer(sid);
  }
});

test('GET /r/<anything> 404s when short URL is disabled', async () => {
  const sid = 'sess_redirect_disabled';
  const v = await startViewer(sid, stubDriver, stubSession(sid), { enableShortUrl: false });
  try {
    const res = await fetchJson(`http://localhost:${v.port}/r/0123456789ABCDEF`);
    assert.strictEqual(res.status, 404);
  } finally {
    await stopViewer(sid);
  }
});

test('GET / with mismatched ?v serves URL_CORRUPTED_HTML with refresh-the-viewer hint', async () => {
  const sid = 'sess_integrity_fail';
  const v = await startViewer(sid, stubDriver, stubSession(sid), { enableShortUrl: false });
  try {
    // Use the real token but a wrong integrity hash — this is exactly the
    // "agent garbled the URL" scenario.
    const res = await fetchJson(`http://localhost:${v.port}/?token=${v.token}&v=deadbeef`);
    assert.strictEqual(res.status, 400);
    assert.match(res.body, /URL got corrupted in transit/);
    // New copy-paste recovery hint: literal "refresh the remote viewer" plus
    // the right tool sequence so the user knows the drive isn't lost.
    assert.match(res.body, /refresh the remote viewer/);
    assert.match(res.body, /stop_remote_session/);
    assert.match(res.body, /start_remote_session/);
    assert.match(res.body, /does NOT end your drive/);
    // Mention of auto_open and short_url as longer-term remedies.
    assert.match(res.body, /auto_open/);
    assert.match(res.body, /short_url/);
  } finally {
    await stopViewer(sid);
  }
});

test('GET /?token=<good>&v=<correct> serves the viewer HTML (regression)', async () => {
  const sid = 'sess_happy_path';
  const v = await startViewer(sid, stubDriver, stubSession(sid), { enableShortUrl: false });
  try {
    const res = await fetchJson(`http://localhost:${v.port}/?token=${v.token}&v=${v.integrity}`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers['content-type'] || '', /text\/html/);
    // Sanity: it's the viewer page, not the corrupted page.
    assert.doesNotMatch(res.body, /URL got corrupted in transit/);
  } finally {
    await stopViewer(sid);
  }
});

test('GET /health returns 200 ok regardless of short-URL state', async () => {
  const sid = 'sess_health';
  const v = await startViewer(sid, stubDriver, stubSession(sid), { enableShortUrl: true });
  try {
    const res = await fetchJson(`http://localhost:${v.port}/health`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body, 'ok');
  } finally {
    await stopViewer(sid);
  }
});

// --- startRemoteSession refresh-flag invariant ---

const localCfg = { mode: 'local', auto_open: 'never', short_url: false };

test('startRemoteSession is idempotent on second call (same URL)', async () => {
  const sid = 'sess_refresh_idempotent';
  const a = await startRemoteSession(sid, stubDriver, stubSession(sid), localCfg);
  try {
    const b = await startRemoteSession(sid, stubDriver, stubSession(sid), localCfg);
    assert.strictEqual(a.viewerUrl, b.viewerUrl, 'second call should return the cached URL');
  } finally {
    await stopRemoteSession(sid);
  }
});

test('startRemoteSession with refresh:true tears down and remints (different URL)', async () => {
  const sid = 'sess_refresh_remints';
  const a = await startRemoteSession(sid, stubDriver, stubSession(sid), localCfg);
  try {
    const b = await startRemoteSession(sid, stubDriver, stubSession(sid), localCfg, {
      refresh: true,
    });
    assert.notStrictEqual(
      a.viewerUrl,
      b.viewerUrl,
      'refresh:true should remint — URL must change (port + JWT both fresh)',
    );
  } finally {
    await stopRemoteSession(sid);
  }
});

test('stop_remote_session then start_remote_session yields a fresh URL (the public refresh path)', async () => {
  const sid = 'sess_refresh_via_stop';
  const a = await startRemoteSession(sid, stubDriver, stubSession(sid), localCfg);
  await stopRemoteSession(sid);
  const b = await startRemoteSession(sid, stubDriver, stubSession(sid), localCfg);
  try {
    assert.notStrictEqual(
      a.viewerUrl,
      b.viewerUrl,
      'after stop+start cycle, URL must change',
    );
  } finally {
    await stopRemoteSession(sid);
  }
});

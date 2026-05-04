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

test('GET /r/<short> succeeds on multiple hits within TTL (multi-use)', async () => {
  const sid = 'sess_redirect_multi';
  const v = await startViewer(sid, stubDriver, stubSession(sid), { enableShortUrl: true });
  try {
    // Three consecutive clicks within the 60s window all redirect — a
    // failed page-load (browser quirk, password-manager popup) is
    // recoverable by re-clicking the same URL.
    for (let i = 0; i < 3; i++) {
      const res = await fetchJson(`http://localhost:${v.port}/r/${v.shortToken}`);
      assert.strictEqual(res.status, 302, `hit ${i + 1} should redirect`);
      assert.ok(res.headers.location, `hit ${i + 1} should set Location`);
    }
  } finally {
    await stopViewer(sid);
  }
});

test('GET /r/<short> 410s after TTL expires', async () => {
  const sid = 'sess_redirect_expired';
  const v = await startViewer(sid, stubDriver, stubSession(sid), { enableShortUrl: true });
  const realNow = Date.now;
  try {
    // Time-warp 61s into the future so the redirect handler's expiry
    // check (Date.now() > expiresAt) fires.
    Date.now = () => realNow() + 61_000;
    const res = await fetchJson(`http://localhost:${v.port}/r/${v.shortToken}`);
    assert.strictEqual(res.status, 410);
    assert.match(res.body, /expired/);
    assert.match(res.body, /refresh the remote viewer/);
  } finally {
    Date.now = realNow;
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

// --- Short-token auto-remint on cache hit ---

const localShortCfg = { mode: 'local', auto_open: 'never', short_url: true };

test('startRemoteSession: within TTL, second call returns same shortUrl (idempotent)', async () => {
  const sid = 'sess_short_idempotent';
  const a = await startRemoteSession(sid, stubDriver, stubSession(sid), localShortCfg);
  try {
    assert.ok(a.shortUrl, 'first call should mint a short URL');
    const b = await startRemoteSession(sid, stubDriver, stubSession(sid), localShortCfg);
    assert.strictEqual(b.shortUrl, a.shortUrl, 'second call within TTL: same short URL');
    assert.strictEqual(b.viewerUrl, a.viewerUrl, 'second call within TTL: same full URL');
  } finally {
    await stopRemoteSession(sid);
  }
});

test('startRemoteSession: after TTL expires, next call mints a fresh short token', async () => {
  const sid = 'sess_short_ttl_remint';
  const a = await startRemoteSession(sid, stubDriver, stubSession(sid), localShortCfg);
  const realNow = Date.now;
  try {
    assert.ok(a.shortUrl);
    // Snapshot URL strings BEFORE the second call — the cached
    // RemoteSession is mutated in-place on remint, and shared object
    // references would otherwise see the post-refresh value.
    const shortUrlBefore = a.shortUrl;
    const viewerUrlBefore = a.viewerUrl;

    const portMatch = /:(\d+)\/r\//.exec(shortUrlBefore);
    assert.ok(portMatch, `shortUrl should embed a port: ${shortUrlBefore}`);
    const port = portMatch[1];
    const tokenMatch = /\/r\/([0-9A-HJKMNPQRSTVWXYZ]+)$/.exec(shortUrlBefore);
    assert.ok(tokenMatch);

    // Time-warp 61s into the future so the cached short token is past TTL.
    Date.now = () => realNow() + 61_000;

    // Second start_remote_session call: cache hit detects TTL expiry and rotates.
    const b = await startRemoteSession(sid, stubDriver, stubSession(sid), localShortCfg);
    assert.notStrictEqual(b.shortUrl, shortUrlBefore, 'expired TTL → fresh short URL');
    // Full URL stays stable: only the relay channel rotates, the JWT
    // session continues unchanged.
    assert.strictEqual(b.viewerUrl, viewerUrlBefore, 'full JWT URL stays stable across remint');

    // Old short URL no longer routes (the cached token was replaced).
    const deadRes = await fetchJson(`http://localhost:${port}/r/${tokenMatch[1]}`);
    assert.strictEqual(deadRes.status, 404, 'old short token no longer routes');

    // New short URL redirects (fresh TTL extends the window).
    const newTokenMatch = /\/r\/([0-9A-HJKMNPQRSTVWXYZ]+)$/.exec(b.shortUrl);
    assert.ok(newTokenMatch);
    const liveRes = await fetchJson(`http://localhost:${port}/r/${newTokenMatch[1]}`);
    assert.strictEqual(liveRes.status, 302, 'fresh short token redirects');
  } finally {
    Date.now = realNow;
    await stopRemoteSession(sid);
  }
});

test('startRemoteSession: enableShortUrl=false stays no-op on second call', async () => {
  const sid = 'sess_short_disabled_idempotent';
  const a = await startRemoteSession(sid, stubDriver, stubSession(sid), localCfg);
  try {
    assert.strictEqual(a.shortUrl, null, 'short URL disabled');
    const b = await startRemoteSession(sid, stubDriver, stubSession(sid), localCfg);
    assert.strictEqual(b.shortUrl, null, 'still null on second call');
    assert.strictEqual(b.viewerUrl, a.viewerUrl, 'full URL stable');
  } finally {
    await stopRemoteSession(sid);
  }
});

test('refreshShortToken (direct): mints fresh token + resets stale state after TTL expires', async () => {
  const sid = 'sess_refresh_direct';
  const v = await startViewer(sid, stubDriver, stubSession(sid), { enableShortUrl: true });
  const realNow = Date.now;
  try {
    const t1 = v.shortToken;
    assert.ok(t1);
    assert.strictEqual(v.shortTokenStale(), false, 'fresh viewer is not stale');

    // Verify the link is multi-use within the TTL: two redirects in a row.
    const a = await fetchJson(`http://localhost:${v.port}/r/${t1}`);
    assert.strictEqual(a.status, 302, 'multi-use redirect: hit 1');
    const b = await fetchJson(`http://localhost:${v.port}/r/${t1}`);
    assert.strictEqual(b.status, 302, 'multi-use redirect: hit 2');
    assert.strictEqual(v.shortTokenStale(), false, 'redirects do not stale');

    // Time-warp past TTL → stale.
    Date.now = () => realNow() + 61_000;
    assert.strictEqual(v.shortTokenStale(), true, 'past TTL → stale');

    // Refresh: mints fresh token + extends TTL.
    const t2 = v.refreshShortToken();
    assert.ok(t2);
    assert.notStrictEqual(t2, t1, 'fresh token differs from prior');
    assert.strictEqual(v.shortTokenStale(), false, 'post-refresh is not stale');

    // Old token 404s, new token 302s.
    const oldRes = await fetchJson(`http://localhost:${v.port}/r/${t1}`);
    assert.strictEqual(oldRes.status, 404);
    const newRes = await fetchJson(`http://localhost:${v.port}/r/${t2}`);
    assert.strictEqual(newRes.status, 302);
  } finally {
    Date.now = realNow;
    await stopViewer(sid);
  }
});

test('refreshShortToken: returns null when enableShortUrl=false', async () => {
  const sid = 'sess_refresh_disabled';
  const v = await startViewer(sid, stubDriver, stubSession(sid), { enableShortUrl: false });
  try {
    assert.strictEqual(v.refreshShortToken(), null);
    assert.strictEqual(v.shortTokenStale(), false, 'no-short-URL session is never stale');
  } finally {
    await stopViewer(sid);
  }
});

// --- WebSocket handshake integrity check ---

const { WebSocket: WsClient } = await import('ws');

/**
 * Open a WS and wait for the SERVER's verdict — either it closes us with
 * a 4xxx code (auth fail), or it accepts the connection and stays open
 * past a short grace period (auth pass). Both `open` and `close` fire on
 * a successful upgrade-then-server-reject, so resolving on `open` would
 * race past the rejection — the grace period is the structural fix.
 */
function probeWsAuth(port, query) {
  return new Promise((resolve) => {
    const ws = new WsClient(`ws://localhost:${port}/ws${query}`);
    let resolved = false;
    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      try { ws.close(); } catch { /* already closed */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ opened: true }), 200);
    ws.on('close', (code, reason) => {
      clearTimeout(timer);
      finish({ closed: true, code, reason: reason.toString() });
    });
    ws.on('error', () => { /* close event will follow */ });
  });
}

test('WS handshake: token + matching v → auth passes', async () => {
  const sid = 'sess_ws_auth_match';
  const v = await startViewer(sid, stubDriver, stubSession(sid), { enableShortUrl: false });
  try {
    const r = await probeWsAuth(v.port, `?token=${v.token}&v=${v.integrity}`);
    assert.deepStrictEqual(r, { opened: true });
  } finally {
    await stopViewer(sid);
  }
});

test('WS handshake: token only (no v) → auth passes (lenient, matches page-load)', async () => {
  // Regression guard for the bug that returned the user's "URL was
  // corrupted in transit" symptom: the embedded client JS opens the WS
  // with only ?token= and no ?v=; the server check must tolerate the
  // missing v and fall through to token equality.
  const sid = 'sess_ws_auth_no_v';
  const v = await startViewer(sid, stubDriver, stubSession(sid), { enableShortUrl: false });
  try {
    const r = await probeWsAuth(v.port, `?token=${v.token}`);
    assert.deepStrictEqual(r, { opened: true });
  } finally {
    await stopViewer(sid);
  }
});

test('WS handshake: token + mismatched v → 4002 corruption reject', async () => {
  const sid = 'sess_ws_auth_bad_v';
  const v = await startViewer(sid, stubDriver, stubSession(sid), { enableShortUrl: false });
  try {
    const r = await probeWsAuth(v.port, `?token=${v.token}&v=deadbeef`);
    assert.strictEqual(r.closed, true);
    assert.strictEqual(r.code, 4002);
    assert.strictEqual(r.reason, 'URL corrupted in transit');
  } finally {
    await stopViewer(sid);
  }
});

test('WS handshake: bad token + valid-shape v → 4001 invalid token', async () => {
  // When token is wrong but v happens to match recompute(token), the
  // integrity check is satisfied; auth then fails on token equality.
  // Confirms the two checks are layered correctly.
  const sid = 'sess_ws_auth_bad_token';
  const v = await startViewer(sid, stubDriver, stubSession(sid), { enableShortUrl: false });
  try {
    const fakeToken = 'eyJ-not-the-real-jwt';
    // No JWT exposure here — we just need a 8-char hex that matches
    // tokenIntegrity(fakeToken) to satisfy the integrity check, which
    // forces failure to land on token equality. Recompute via a tiny
    // import is cleaner than a hardcoded hex.
    const { tokenIntegrity } = await import('../dist/remote/jwt.js');
    const matchingV = tokenIntegrity(fakeToken);
    const r = await probeWsAuth(v.port, `?token=${fakeToken}&v=${matchingV}`);
    assert.strictEqual(r.closed, true);
    assert.strictEqual(r.code, 4001);
    assert.strictEqual(r.reason, 'Invalid token');
  } finally {
    await stopViewer(sid);
  }
});

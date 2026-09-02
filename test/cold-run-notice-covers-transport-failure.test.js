// A verification run withholds everything discovery established. The agent
// cannot see that from its own session: it watches the same URL work, gets a
// 403 from the verifier, and concludes the request is wrong. Observed on reddit
// — the agent re-saved the identical `fetch` five times.
//
// The notice therefore has to ride EVERY branch that reports a failed
// verification, not just the candidate `explicit_failure` one. Which branch a
// failure lands in is decided by how the site rejects the call, and that must
// not decide whether the agent is told why the call was rejected.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-cold-notice-test-'));
process.env.KLURA_HOME = TMP;

const { verifySavedStrategy, coldRunNotice } = await import(
  '../dist/strategies/verify-saved-strategy.js'
);
const skills = await import('../dist/strategies/skills.js');

// 403 unless the request carries the cookie a real browser would have been
// handed — the shape of a challenge- or login-gated endpoint.
const server = http.createServer((req, res) => {
  const cookie = req.headers.cookie ?? '';
  if (!cookie.includes('challenge_token')) {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'text/html');
    res.end('<html><body>blocked</body></html>');
    return;
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true, items: [{ id: 1 }] }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
server.unref();
const BASE = `http://127.0.0.1:${server.address().port}`;

process.on('exit', () => {
  try {
    server.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const PLATFORM = 'cold-notice';
const CAPABILITY = 'list_things';

test('a 403 verification names the withheld state and points off fetch', async () => {
  skills.saveStrategy(PLATFORM, CAPABILITY, {
    schema_version: 1,
    strategy: 'fetch',
    method: 'GET',
    baseUrl: BASE,
    endpoint: '/items',
    notes: { params: {} },
  });
  // The jar a discovery session would have left behind. Verification must not
  // read it — that is what makes the endpoint answer 403 here and 200 there.
  skills.writeStorageStateCookies(PLATFORM, ['challenge_token=abc; Path=/'], `${BASE}/items`);

  const result = await verifySavedStrategy(PLATFORM, CAPABILITY, {}, null);

  assert.equal(result.ok, false);
  assert.equal(result.status, 403, 'the jar must have been withheld, or this endpoint returns 200');

  const message = result.message ?? '';
  assert.match(message, /post_save_validation_failed/);
  assert.match(
    message,
    /empty cookie jar/,
    'the transport-failure branch carried no explanation of the withheld state',
  );
  assert.match(
    message,
    /HTTP 403 against a URL that works in your session/,
    'a session-shaped status has to be named as such, or the agent reads it as a wrong request',
  );
  assert.match(
    message,
    /keep failing/,
    'must say retrying is futile — the observed failure was five identical re-saves',
  );
  assert.match(
    message,
    /page-script/,
    'fetch rejects browser-bound prereqs, so the remedy has to name the tier that accepts them',
  );
});

test('a non-session failure gets the notice without the session-shaped remedy', async () => {
  const PLATFORM_500 = 'cold-notice-500';
  const broken = http.createServer((_req, res) => {
    res.statusCode = 500;
    res.end('boom');
  });
  await new Promise((resolve) => broken.listen(0, '127.0.0.1', resolve));
  broken.unref();

  skills.saveStrategy(PLATFORM_500, CAPABILITY, {
    schema_version: 1,
    strategy: 'fetch',
    method: 'GET',
    baseUrl: `http://127.0.0.1:${broken.address().port}`,
    endpoint: '/items',
    notes: { params: {} },
  });

  const result = await verifySavedStrategy(PLATFORM_500, CAPABILITY, {}, null);
  const message = result.message ?? '';
  broken.close();

  assert.notEqual(result.status, 403, 'this case must not be session-shaped');
  assert.match(
    message,
    /empty cookie jar/,
    'the withheld-state fact is true of every verification run, whatever the status',
  );
  assert.doesNotMatch(
    message,
    /works in your session/,
    'a 500 is not a session dependency — claiming it is would send the agent after the wrong fix',
  );
});


test('a page-script failure names the browser prereq, not just "a prereq"', () => {
  // The observed loss: six page-script candidates staged in one session, each
  // failing verification the same way — an in-page fetch to an API path with no
  // preceding page load, so the site answered with its interstitial and the
  // expression died parsing HTML as JSON. The notice said "a prereq has to
  // establish it" every time. Naming the category was not enough.
  const message = coldRunNotice('page-script', 0);

  assert.match(message, /empty cookie jar/);
  assert.match(
    message,
    /`browser` prereq ordered before the one that reads/,
    'the agent needs the shape, not the category',
  );
  assert.match(
    message,
    /without a preceding page load/,
    'and why an API-path prereq on its own starts from nothing',
  );
});

test('the browser-prereq remedy is scoped to page-script', () => {
  assert.doesNotMatch(
    coldRunNotice('fetch', 0),
    /`browser` prereq/,
    'fetch rejects browser-bound prereqs outright — naming one there is a dead end',
  );
  assert.doesNotMatch(coldRunNotice('recorded-path', 0), /`browser` prereq/);
});

test('a session-shaped status keeps pointing off fetch rather than into it', () => {
  const message = coldRunNotice('fetch', 403);
  assert.match(message, /works in your session/);
  assert.match(message, /belongs on `page-script`/);
});

// Unit test for src/drivers/cdp-network-capture.ts.
//
// We pass a fake CDP session (just `on` and `send`) and simulate the
// protocol-level events, then assert the sink ends up with the right
// entries. This is the correct layer to test: the real CDP session is
// owned by Playwright and integration-tested via the browser end-to-end,
// but the filter rules (static-asset skip, GET-without-/api/ skip, redirect
// chain handling, JSON body extraction) are pure logic we own.

import test from 'node:test';
import assert from 'node:assert';

import {
  attachCdpNetworkCapture,
  isStaticAsset,
  getInterceptedFromSink,
} from '../dist/drivers/cdp-network-capture.js';

function makeFakeCdp() {
  const handlers = new Map();
  const sends = [];
  return {
    handlers,
    sends,
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
    },
    emit(event, params) {
      const list = handlers.get(event) || [];
      for (const fn of list) fn(params);
    },
    send(method, params) {
      sends.push({ method, params });
      if (method === 'Network.enable') return Promise.resolve();
      if (method === 'Network.getResponseBody') {
        return Promise.resolve(this._responseBodies?.[params.requestId] ?? { body: null });
      }
      return Promise.resolve();
    },
  };
}

test('isStaticAsset drops css/js/image/font extensions', () => {
  assert.equal(isStaticAsset('https://x.com/a.css'), true);
  assert.equal(isStaticAsset('https://x.com/a.js'), true);
  assert.equal(isStaticAsset('https://x.com/a.PNG'), true);
  assert.equal(isStaticAsset('https://x.com/a.woff2'), true);
  assert.equal(isStaticAsset('https://x.com/api/users'), false);
  assert.equal(isStaticAsset('https://x.com/submit'), false);
});

test('isStaticAsset handles malformed URLs without crashing', () => {
  assert.equal(isStaticAsset('not-a-url'), false);
  assert.equal(isStaticAsset(''), false);
});

test('attach calls Network.enable first', async () => {
  const cdp = makeFakeCdp();
  const sink = [];
  await attachCdpNetworkCapture(cdp, sink);
  assert.equal(cdp.sends[0].method, 'Network.enable');
});

test('GET requests without /api/ are dropped', async () => {
  const cdp = makeFakeCdp();
  const sink = [];
  await attachCdpNetworkCapture(cdp, sink);

  cdp.emit('Network.requestWillBeSent', {
    requestId: '1',
    request: { url: 'https://x.com/home', method: 'GET', headers: {} },
    type: 'Document',
  });
  assert.equal(sink.length, 0);
});

test('GET to /api/ is captured', async () => {
  const cdp = makeFakeCdp();
  const sink = [];
  await attachCdpNetworkCapture(cdp, sink);

  cdp.emit('Network.requestWillBeSent', {
    requestId: '1',
    request: { url: 'https://x.com/api/users', method: 'GET', headers: { accept: 'application/json' } },
    type: 'XHR',
  });

  const entries = getInterceptedFromSink({ intercepted: sink });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].method, 'GET');
  assert.equal(entries[0].url, 'https://x.com/api/users');
  assert.deepEqual(entries[0].headers, { accept: 'application/json' });
});

test('POST is captured regardless of URL', async () => {
  const cdp = makeFakeCdp();
  const sink = [];
  await attachCdpNetworkCapture(cdp, sink);

  cdp.emit('Network.requestWillBeSent', {
    requestId: '1',
    request: {
      url: 'https://x.com/submit',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      postData: '{"name":"alice"}',
    },
    type: 'Fetch',
  });

  const entries = getInterceptedFromSink({ intercepted: sink });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].method, 'POST');
  assert.deepEqual(entries[0].postData, { name: 'alice' });
});

test('non-JSON postData is preserved as-is', async () => {
  const cdp = makeFakeCdp();
  const sink = [];
  await attachCdpNetworkCapture(cdp, sink);

  cdp.emit('Network.requestWillBeSent', {
    requestId: '1',
    request: {
      url: 'https://x.com/submit',
      method: 'POST',
      headers: {},
      postData: 'authenticity_token=abc&name=alice',
    },
  });

  assert.equal(sink[0].postData, 'authenticity_token=abc&name=alice');
});

test('Document type sets isNavigation flag', async () => {
  const cdp = makeFakeCdp();
  const sink = [];
  await attachCdpNetworkCapture(cdp, sink);

  cdp.emit('Network.requestWillBeSent', {
    requestId: '1',
    request: {
      url: 'https://x.com/submit',
      method: 'POST',
      headers: {},
    },
    type: 'Document',
  });

  assert.equal(sink[0].isNavigation, true);
});

test('responseReceived fills status; 3xx sets redirectUrl', async () => {
  const cdp = makeFakeCdp();
  const sink = [];
  await attachCdpNetworkCapture(cdp, sink);

  cdp.emit('Network.requestWillBeSent', {
    requestId: '1',
    request: { url: 'https://x.com/api/x', method: 'POST', headers: {} },
  });
  cdp.emit('Network.responseReceived', {
    requestId: '1',
    response: { status: 302, headers: { location: '/done' } },
  });
  assert.equal(sink[0].status, 302);
  assert.equal(sink[0].redirectUrl, '/done');
});

test('redirect chain: same requestId reused, prev entry finalized', async () => {
  const cdp = makeFakeCdp();
  const sink = [];
  await attachCdpNetworkCapture(cdp, sink);

  // First hop
  cdp.emit('Network.requestWillBeSent', {
    requestId: '1',
    request: { url: 'https://x.com/api/a', method: 'POST', headers: {} },
  });
  // Second hop piggybacks redirectResponse for hop 1
  cdp.emit('Network.requestWillBeSent', {
    requestId: '1',
    request: { url: 'https://x.com/api/b', method: 'GET', headers: {} },
    redirectResponse: { status: 303, headers: { location: '/api/b' } },
  });

  assert.equal(sink.length, 2);
  assert.equal(sink[0].status, 303);
  assert.equal(sink[0].redirectUrl, '/api/b');
  assert.equal(sink[1].url, 'https://x.com/api/b');
});

test('loadingFinished fetches JSON response body', async () => {
  const cdp = makeFakeCdp();
  cdp._responseBodies = {
    '1': { body: '{"ok":true,"id":42}' },
  };
  const sink = [];
  await attachCdpNetworkCapture(cdp, sink);

  cdp.emit('Network.requestWillBeSent', {
    requestId: '1',
    request: { url: 'https://x.com/api/x', method: 'POST', headers: {} },
  });
  cdp.emit('Network.responseReceived', {
    requestId: '1',
    response: { status: 200, headers: {} },
  });
  cdp.emit('Network.loadingFinished', { requestId: '1' });

  // getResponseBody is async — wait a tick
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sink[0].responseBody, { ok: true, id: 42 });
});

test('loadingFinished stores non-JSON body as raw string (HTML, form, plain)', async () => {
  // Non-JSON bodies used to be silently dropped ("leave responseBody
  // null"). Diagnostic dumps need them preserved so grep / text_contains
  // can find the message literal regardless of Content-Type.
  const cdp = makeFakeCdp();
  cdp._responseBodies = {
    '1': { body: '<html>hi</html>' },
  };
  const sink = [];
  await attachCdpNetworkCapture(cdp, sink);

  cdp.emit('Network.requestWillBeSent', {
    requestId: '1',
    request: { url: 'https://x.com/api/x', method: 'POST', headers: {} },
  });
  cdp.emit('Network.responseReceived', {
    requestId: '1',
    response: { status: 200, headers: {} },
  });
  cdp.emit('Network.loadingFinished', { requestId: '1' });

  await new Promise((r) => setImmediate(r));
  assert.strictEqual(sink[0].responseBody, '<html>hi</html>');
});

test('loadingFinished clips oversized bodies with a marker', async () => {
  // A ~400 KB HTML dump would blow memory on chatty long-lived sessions.
  // The capture caps at 256 KB and appends a marker so the caller can tell
  // a clipped body apart from a naturally-short one.
  const cdp = makeFakeCdp();
  const giant = 'x'.repeat(400 * 1024);
  cdp._responseBodies = {
    '1': { body: giant },
  };
  const sink = [];
  await attachCdpNetworkCapture(cdp, sink);

  cdp.emit('Network.requestWillBeSent', {
    requestId: '1',
    request: { url: 'https://x.com/api/huge', method: 'POST', headers: {} },
  });
  cdp.emit('Network.responseReceived', {
    requestId: '1',
    response: { status: 200, headers: {} },
  });
  cdp.emit('Network.loadingFinished', { requestId: '1' });

  await new Promise((r) => setImmediate(r));
  const stored = sink[0].responseBody;
  assert.strictEqual(typeof stored, 'string');
  assert.ok(stored.length > 256 * 1024, 'stored must include marker suffix');
  assert.ok(stored.length < 260 * 1024, 'stored must not include the whole 400 KB');
  assert.match(stored, /responseBody clipped at 262144 bytes/);
});

test('Static asset requests are dropped even if POST', async () => {
  const cdp = makeFakeCdp();
  const sink = [];
  await attachCdpNetworkCapture(cdp, sink);

  cdp.emit('Network.requestWillBeSent', {
    requestId: '1',
    request: { url: 'https://x.com/style.css', method: 'POST', headers: {} },
  });
  assert.equal(sink.length, 0);
});

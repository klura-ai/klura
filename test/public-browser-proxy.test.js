import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { startPinnedEgressProxy } = require('../dist/consumer/execution/public-browser/pinned-proxy.js');

test('pinned browser proxy rejects unauthenticated and undeclared CONNECT requests before DNS', async () => {
  let resolutions = 0;
  const proxy = await startPinnedEgressProxy({
    allowed_origins: ['https://allowed.example.test'],
    max_wire_bytes: 1_024,
    connect_timeout_ms: 1_000,
    resolve_host: async () => {
      resolutions += 1;
      return ['8.8.8.8'];
    },
  });
  try {
    const unauthenticated = await sendProxyRequest(
      proxy.server,
      'CONNECT allowed.example.test:443 HTTP/1.1\r\nHost: allowed.example.test:443\r\n\r\n',
    );
    assert.match(unauthenticated, /^HTTP\/1\.1 407 Proxy Authentication Required\r\n/m);
    const wrongOrigin = await sendProxyRequest(
      proxy.server,
      [
        'CONNECT other.example.test:443 HTTP/1.1',
        'Host: other.example.test:443',
        `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}`,
        '',
        '',
      ].join('\r\n'),
    );
    assert.match(wrongOrigin, /^HTTP\/1\.1 403 Forbidden\r\n/m);
    assert.equal(resolutions, 0);
  } finally {
    await proxy.close();
  }
});

test('pinned browser proxy rejects DNS answers outside the public internet before connecting', async () => {
  let resolvedHost = null;
  const proxy = await startPinnedEgressProxy({
    allowed_origins: ['https://allowed.example.test'],
    max_wire_bytes: 1_024,
    connect_timeout_ms: 1_000,
    resolve_host: async (hostname) => {
      resolvedHost = hostname;
      return ['127.0.0.1'];
    },
  });
  try {
    const result = await sendProxyRequest(
      proxy.server,
      [
        'CONNECT allowed.example.test:443 HTTP/1.1',
        'Host: allowed.example.test:443',
        `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}`,
        '',
        '',
      ].join('\r\n'),
    );
    assert.match(result, /^HTTP\/1\.1 403 Forbidden\r\n/m);
    assert.equal(resolvedHost, 'allowed.example.test');
    assert.equal(proxy.wire_bytes(), 0);
  } finally {
    await proxy.close();
  }
});

function sendProxyRequest(proxyUrl, request) {
  const url = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: url.hostname, port: Number(url.port) });
    const chunks = [];
    socket.once('connect', () => socket.write(request));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.once('error', reject);
    socket.once('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
  });
}

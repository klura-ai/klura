import { randomBytes } from 'node:crypto';
import { promises as dns } from 'node:dns';
import net from 'node:net';
import { URL } from 'node:url';
import { isPublicInternetAddress } from '../node-http';

const MAX_CONNECT_HEADER_BYTES_V1 = 16 * 1024;

export interface PinnedEgressProxyOptionsV1 {
  allowed_origins: readonly string[];
  max_wire_bytes: number;
  connect_timeout_ms: number;
  resolve_host?: (hostname: string) => Promise<readonly string[]>;
}

export interface PinnedEgressProxyV1 {
  server: string;
  username: string;
  password: string;
  close(): Promise<void>;
  wire_bytes(): number;
}

/**
 * Opens a loopback-only CONNECT proxy that pins every tunnel to a validated
 * public DNS answer. Browser TLS remains end-to-end between Chromium and the
 * declared HTTPS origin.
 */
export async function startPinnedEgressProxy(
  options: PinnedEgressProxyOptionsV1,
): Promise<PinnedEgressProxyV1> {
  const allowedOrigins = parseAllowedOrigins(options.allowed_origins);
  const maxWireBytes = parsePositiveInteger(options.max_wire_bytes, 'max_wire_bytes');
  const connectTimeoutMs = parsePositiveInteger(options.connect_timeout_ms, 'connect_timeout_ms');
  const resolveHost = options.resolve_host ?? resolvePublicHost;
  const username = randomBytes(18).toString('base64url');
  const password = randomBytes(32).toString('base64url');
  const credential = `${username}:${password}`;
  const expectedAuthorization = `Basic ${Buffer.from(credential).toString('base64')}`;
  const sockets = new Set<net.Socket>();
  let wireBytes = 0;
  let closed = false;
  const server = net.createServer((client) => {
    sockets.add(client);
    client.once('close', () => sockets.delete(client));
    if (!isLoopbackAddress(client.remoteAddress)) {
      client.destroy();
      return;
    }
    acceptConnect(client, {
      allowed_origins: allowedOrigins,
      expected_authorization: expectedAuthorization,
      max_wire_bytes: maxWireBytes,
      connect_timeout_ms: connectTimeoutMs,
      resolve_host: resolveHost,
      add_wire_bytes: (count) => {
        wireBytes += count;
        return wireBytes <= maxWireBytes;
      },
      register_socket: (socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
      },
    });
  });
  await listenLoopback(server);
  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('pinned egress proxy did not expose a TCP loopback address');
  }
  return {
    server: `http://127.0.0.1:${address.port}`,
    username,
    password,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    },
    wire_bytes: () => wireBytes,
  };
}

interface ConnectHandlerOptionsV1 {
  allowed_origins: ReadonlySet<string>;
  expected_authorization: string;
  max_wire_bytes: number;
  connect_timeout_ms: number;
  resolve_host: (hostname: string) => Promise<readonly string[]>;
  add_wire_bytes: (count: number) => boolean;
  register_socket: (socket: net.Socket) => void;
}

function acceptConnect(client: net.Socket, options: ConnectHandlerOptionsV1): void {
  let header = Buffer.alloc(0);
  const receive = (chunk: Buffer): void => {
    header = Buffer.concat([header, chunk]);
    if (header.byteLength > MAX_CONNECT_HEADER_BYTES_V1) {
      rejectConnect(client, 431, 'Request Header Fields Too Large');
      return;
    }
    const end = header.indexOf('\r\n\r\n');
    if (end < 0) return;
    client.off('data', receive);
    const remainder = header.subarray(end + 4);
    void establishTunnel(client, header.subarray(0, end), remainder, options);
  };
  client.on('data', receive);
  client.once('error', () => undefined);
}

async function establishTunnel(
  client: net.Socket,
  header: Buffer,
  remainder: Buffer,
  options: ConnectHandlerOptionsV1,
): Promise<void> {
  const request = parseConnectRequest(header, options.expected_authorization);
  if (request.kind === 'unauthorized') {
    rejectProxyAuthentication(client);
    return;
  }
  if (request.kind !== 'connect' || !options.allowed_origins.has(request.origin)) {
    rejectConnect(client, 403, 'Forbidden');
    return;
  }
  let addresses: readonly string[];
  try {
    addresses = await options.resolve_host(request.hostname);
  } catch {
    rejectConnect(client, 502, 'Bad Gateway');
    return;
  }
  if (addresses.length === 0 || addresses.some((address) => !isPublicInternetAddress(address))) {
    rejectConnect(client, 403, 'Forbidden');
    return;
  }
  const address = addresses[0];
  if (!address) {
    rejectConnect(client, 403, 'Forbidden');
    return;
  }
  const upstream = net.createConnection({
    host: address,
    port: request.port,
    family: net.isIP(address),
  });
  options.register_socket(upstream);
  const timeout = setTimeout(() => upstream.destroy(), options.connect_timeout_ms);
  upstream.once('connect', () => {
    clearTimeout(timeout);
    if (client.destroyed) {
      upstream.destroy();
      return;
    }
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (remainder.byteLength > 0) {
      if (!options.add_wire_bytes(remainder.byteLength)) {
        client.destroy();
        upstream.destroy();
        return;
      }
      upstream.write(remainder);
    }
    pipeTunnel(client, upstream, options);
  });
  upstream.once('error', () => {
    clearTimeout(timeout);
    if (!client.destroyed) rejectConnect(client, 502, 'Bad Gateway');
  });
}

function pipeTunnel(
  client: net.Socket,
  upstream: net.Socket,
  options: ConnectHandlerOptionsV1,
): void {
  const count = (chunk: Buffer): boolean => {
    if (options.add_wire_bytes(chunk.byteLength)) return true;
    client.destroy();
    upstream.destroy();
    return false;
  };
  client.on('data', count);
  upstream.on('data', count);
  client.pipe(upstream);
  upstream.pipe(client);
  client.once('close', () => upstream.destroy());
  upstream.once('close', () => client.destroy());
}

function parseConnectRequest(
  header: Buffer,
  expectedAuthorization: string,
):
  | { kind: 'connect'; origin: string; hostname: string; port: number }
  | { kind: 'unauthorized' }
  | { kind: 'invalid' } {
  const lines = header.toString('latin1').split('\r\n');
  const [method, authority, version, ...extra] = (lines[0] ?? '').split(' ');
  if (method !== 'CONNECT' || version !== 'HTTP/1.1' || extra.length > 0 || !authority) {
    return { kind: 'invalid' };
  }
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(':');
    if (separator < 1) return { kind: 'invalid' };
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (headers.has(name)) return { kind: 'invalid' };
    headers.set(name, value);
  }
  if (headers.get('proxy-authorization') !== expectedAuthorization) return { kind: 'unauthorized' };
  let url: URL;
  try {
    url = new URL(`https://${authority}`);
  } catch {
    return { kind: 'invalid' };
  }
  if (
    url.protocol !== 'https:' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.origin !== `https://${url.hostname}`
  ) {
    return { kind: 'invalid' };
  }
  const port = url.port === '' ? 443 : Number(url.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return { kind: 'invalid' };
  return { kind: 'connect', origin: url.origin, hostname: url.hostname, port };
}

function rejectConnect(client: net.Socket, status: number, statusText: string): void {
  if (!client.destroyed)
    client.end(`HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\n\r\n`);
}

function rejectProxyAuthentication(client: net.Socket): void {
  if (!client.destroyed) {
    client.end(
      'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="klura"\r\nConnection: close\r\n\r\n',
    );
  }
}

function parseAllowedOrigins(origins: readonly string[]): ReadonlySet<string> {
  if (origins.length === 0)
    throw new Error('allowed_origins must contain at least one HTTPS origin');
  const values = new Set<string>();
  for (const origin of origins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error('allowed_origins must contain normalized HTTPS origins');
    }
    if (
      url.protocol !== 'https:' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.username !== '' ||
      url.password !== '' ||
      url.origin !== origin ||
      values.has(origin)
    ) {
      throw new Error('allowed_origins must contain unique normalized HTTPS origins');
    }
    values.add(origin);
  }
  return values;
}

function parsePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  if (address === '::1' || address === '127.0.0.1') return true;
  return address.startsWith('::ffff:127.') && net.isIP(address) === 6;
}

async function resolvePublicHost(hostname: string): Promise<readonly string[]> {
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => entry.address);
}

async function listenLoopback(server: net.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error): void => {
      server.off('listening', ready);
      reject(error);
    };
    const ready = (): void => {
      server.off('error', fail);
      resolve();
    };
    server.once('error', fail);
    server.once('listening', ready);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true });
  });
}

async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

import cp from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { canonicalJson, assertJsonValue, type JsonValueV1 } from '../public/contracts/json';
import { PUBLIC_CONTRACT_LIMITS } from '../public/contracts/common';
import { defaultConsumerHome } from './store/package-store';
import { releaseOwnerFileLock, tryAcquireOwnerFileLock } from '../utils/owner-file-lock';

const DAEMON_READY_TIMEOUT_MS = 10_000;

export class ConsumerDaemonClientError extends Error {
  constructor(
    public readonly code:
      | 'cancelled'
      | 'daemon_unavailable'
      | 'daemon_rejected'
      | 'daemon_protocol',
    message: string,
  ) {
    super(message);
    this.name = 'ConsumerDaemonClientError';
  }
}

/** Sends one bounded consumer request through the machine-local shared daemon. */
export async function invokeConsumerDaemon<Result>(
  route:
    | '/consumer/search'
    | '/consumer/show'
    | '/consumer/install'
    | '/consumer/installed'
    | '/consumer/remove'
    | '/consumer/doctor'
    | '/consumer/session/clear'
    | '/consumer/login/open'
    | '/consumer/login/complete'
    | '/consumer/call'
    | '/consumer/run'
    | '/consumer/runs/resume'
    | '/consumer/runs/wait'
    | '/consumer/runs/wait-state'
    | '/consumer/runs/cancel'
    | '/consumer/runs/show'
    | '/consumer/runs/list'
    | '/consumer/runs/items'
    | '/consumer/runs/items/follow'
    | '/consumer/runs/discard',
  body: JsonValueV1,
  signal?: AbortSignal,
): Promise<Result> {
  const home = defaultConsumerHome();
  await ensureConsumerDaemon(home, signal);
  return sendConsumerRequest<Result>(home, route, body, signal);
}

/** Streams one consumer daemon NDJSON response without polling local run state. */
export async function* followConsumerDaemon<Result>(
  route: '/consumer/runs/items/follow',
  body: JsonValueV1,
  signal?: AbortSignal,
): AsyncGenerator<Result> {
  const home = defaultConsumerHome();
  await ensureConsumerDaemon(home, signal);
  const response = await openConsumerStream(home, route, body, signal);
  let buffered = Buffer.alloc(0);
  const abort = (): void => {
    response.destroy(cancelledError());
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for await (const chunk of response) {
      buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
      for (;;) {
        const newline = buffered.indexOf(0x0a);
        if (newline < 0) break;
        const line = buffered.subarray(0, newline);
        buffered = buffered.subarray(newline + 1);
        yield parseStreamLine(line) as Result;
      }
      if (buffered.byteLength > PUBLIC_CONTRACT_LIMITS.packageBytes) {
        throw new ConsumerDaemonClientError(
          'daemon_protocol',
          'daemon stream event exceeds its byte limit',
        );
      }
    }
    if (buffered.byteLength !== 0) {
      throw new ConsumerDaemonClientError('daemon_protocol', 'daemon stream ended mid-event');
    }
  } catch (error) {
    throw asConsumerDaemonError(error);
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

async function ensureConsumerDaemon(home: string, signal?: AbortSignal): Promise<void> {
  if (isDaemonReady(home)) return;
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.chmodSync(home, 0o700);
  const lock = tryAcquireOwnerFileLock(path.join(home, 'daemon-start.lock'));
  if (lock === null) {
    // A live process is starting the daemon — wait for its readiness signal.
    await waitForDaemonReady(home, signal);
    return;
  }
  try {
    if (isDaemonReady(home)) return;
    await startConsumerDaemon(home, signal);
  } finally {
    releaseOwnerFileLock(lock);
  }
}

function startConsumerDaemon(home: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(cancelledError());
  const daemonScript = path.join(__dirname, '..', '..', 'bin', 'klura-daemon.js');
  const child = cp.fork(daemonScript, [], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, KLURA_HOME: home },
  });
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      child.removeListener('message', onMessage);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      try {
        child.disconnect();
      } catch {
        // The daemon may already have disconnected its IPC channel.
      }
      child.unref();
      if (error) reject(error);
      else resolve();
    };
    const onMessage = (message: unknown): void => {
      if (!isDaemonReadyMessage(message) || !isDaemonReady(home)) return;
      finish();
    };
    const onError = (): void => {
      finish(new ConsumerDaemonClientError('daemon_unavailable', 'daemon process could not start'));
    };
    const onExit = (): void => {
      finish(new ConsumerDaemonClientError('daemon_unavailable', 'daemon exited before readiness'));
    };
    const onAbort = (): void => {
      finish(cancelledError());
    };
    const timer = setTimeout(() => {
      finish(new ConsumerDaemonClientError('daemon_unavailable', 'daemon did not become ready'));
    }, DAEMON_READY_TIMEOUT_MS);
    child.once('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function waitForDaemonReady(home: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(cancelledError());
  if (isDaemonReady(home)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher.close();
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onChange = (): void => {
      if (isDaemonReady(home)) finish();
    };
    const onAbort = (): void => {
      finish(cancelledError());
    };
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(home, { persistent: false }, onChange);
    } catch {
      reject(new ConsumerDaemonClientError('daemon_unavailable', 'daemon home cannot be watched'));
      return;
    }
    const timer = setTimeout(() => {
      finish(
        new ConsumerDaemonClientError('daemon_unavailable', 'another daemon start did not finish'),
      );
    }, DAEMON_READY_TIMEOUT_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
    onChange();
  });
}

function sendConsumerRequest<Result>(
  home: string,
  route: string,
  body: JsonValueV1,
  signal?: AbortSignal,
): Promise<Result> {
  if (signal?.aborted) return Promise.reject(cancelledError());
  const payload = Buffer.from(canonicalJson(body), 'utf8');
  return new Promise<Result>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: Result): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(value as Result);
    };
    const request = http.request(
      daemonRequestOptions(home, route, payload.byteLength),
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > PUBLIC_CONTRACT_LIMITS.packageBytes) {
            response.destroy(
              new ConsumerDaemonClientError(
                'daemon_protocol',
                'daemon response exceeds its byte limit',
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.once('error', (error) => {
          finish(asConsumerDaemonError(error));
        });
        response.once('end', () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
            assertJsonValue(parsed, 'consumer_daemon.response', PUBLIC_CONTRACT_LIMITS.maxDepth);
          } catch {
            finish(
              new ConsumerDaemonClientError('daemon_protocol', 'daemon returned invalid JSON'),
            );
            return;
          }
          if (response.statusCode !== 200) {
            finish(
              new ConsumerDaemonClientError(
                'daemon_rejected',
                'daemon rejected the consumer request',
              ),
            );
            return;
          }
          finish(undefined, parsed as Result);
        });
      },
    );
    const onAbort = (): void => {
      request.destroy(cancelledError());
    };
    request.once('error', (error) => {
      finish(asConsumerDaemonError(error));
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    request.end(payload);
  });
}

function openConsumerStream(
  home: string,
  route: string,
  body: JsonValueV1,
  signal?: AbortSignal,
): Promise<http.IncomingMessage> {
  if (signal?.aborted) return Promise.reject(cancelledError());
  const payload = Buffer.from(canonicalJson(body), 'utf8');
  return new Promise<http.IncomingMessage>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, response?: http.IncomingMessage): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(response as http.IncomingMessage);
    };
    const request = http.request(
      daemonRequestOptions(home, route, payload.byteLength),
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          finish(
            new ConsumerDaemonClientError(
              'daemon_rejected',
              'daemon rejected the consumer request',
            ),
          );
          return;
        }
        const contentType = response.headers['content-type'];
        if (
          typeof contentType !== 'string' ||
          !contentType.toLowerCase().startsWith('application/x-ndjson')
        ) {
          response.resume();
          finish(
            new ConsumerDaemonClientError(
              'daemon_protocol',
              'daemon returned an invalid stream type',
            ),
          );
          return;
        }
        finish(undefined, response);
      },
    );
    const onAbort = (): void => {
      request.destroy(cancelledError());
    };
    request.once('error', (error) => {
      finish(asConsumerDaemonError(error));
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    request.end(payload);
  });
}

function parseStreamLine(line: Buffer): unknown {
  if (line.byteLength === 0 || line.byteLength > PUBLIC_CONTRACT_LIMITS.packageBytes) {
    throw new ConsumerDaemonClientError('daemon_protocol', 'daemon stream event has invalid bytes');
  }
  try {
    const parsed: unknown = JSON.parse(line.toString('utf8'));
    assertJsonValue(parsed, 'consumer_daemon.stream_event', PUBLIC_CONTRACT_LIMITS.maxDepth);
    return parsed;
  } catch (error) {
    if (error instanceof ConsumerDaemonClientError) throw error;
    throw new ConsumerDaemonClientError('daemon_protocol', 'daemon stream event is invalid JSON');
  }
}

function daemonRequestOptions(
  home: string,
  route: string,
  contentLength: number,
): http.RequestOptions {
  const address = process.env.KLURA_DAEMON_ADDR ?? readDaemonAddress(home);
  const headers = { 'Content-Type': 'application/json', 'Content-Length': contentLength };
  if (address === 'unix') {
    return { socketPath: path.join(home, 'klura.sock'), path: route, method: 'POST', headers };
  }
  const separator = address.lastIndexOf(':');
  if (separator < 0) {
    throw new ConsumerDaemonClientError('daemon_protocol', 'daemon address is invalid');
  }
  const port = Number(address.slice(separator + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConsumerDaemonClientError('daemon_protocol', 'daemon port is invalid');
  }
  return {
    hostname: address.slice(0, separator) || '127.0.0.1',
    port,
    path: route,
    method: 'POST',
    headers,
  };
}

function isDaemonReady(home: string): boolean {
  const pidPath = path.join(home, 'daemon.pid');
  try {
    const pid = Number(fs.readFileSync(pidPath, 'utf8').trim());
    if (!Number.isInteger(pid) || pid < 1) return false;
    process.kill(pid, 0);
    return (
      fs.existsSync(path.join(home, 'klura.sock')) || fs.existsSync(path.join(home, 'daemon.addr'))
    );
  } catch {
    return false;
  }
}

function readDaemonAddress(home: string): string {
  try {
    return fs.readFileSync(path.join(home, 'daemon.addr'), 'utf8').trim() || 'unix';
  } catch {
    return 'unix';
  }
}

function isDaemonReadyMessage(value: unknown): value is { kind: 'ready' } {
  return !!value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'ready';
}

function asConsumerDaemonError(error: unknown): ConsumerDaemonClientError {
  if (error instanceof ConsumerDaemonClientError) return error;
  return new ConsumerDaemonClientError('daemon_unavailable', 'daemon IPC request failed');
}

function cancelledError(): ConsumerDaemonClientError {
  return new ConsumerDaemonClientError('cancelled', 'consumer request was cancelled');
}

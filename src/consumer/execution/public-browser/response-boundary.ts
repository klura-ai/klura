import type { CDPSession } from 'playwright';
import { PublicHttpExecutionError } from '../node-http';

export async function readPausedResponseBody(
  cdp: CDPSession,
  requestId: string,
  maximumBytes: number,
): Promise<Buffer> {
  if (maximumBytes < 1) {
    throw new PublicHttpExecutionError(
      'response_too_large',
      'browser response budget is exhausted',
    );
  }
  const opened = await cdp.send('Fetch.takeResponseBodyAsStream', { requestId });
  const stream = readStringProperty(opened, 'stream');
  const chunks: Buffer[] = [];
  let total = 0;
  let eof = false;
  while (!eof) {
    const result = await cdp.send('IO.read', { handle: stream, size: 65_536 });
    const data = readStringProperty(result, 'data');
    const encoded = readBooleanProperty(result, 'base64Encoded');
    const chunk = Buffer.from(data, encoded ? 'base64' : 'utf8');
    total += chunk.byteLength;
    if (total > maximumBytes) {
      await cdp.send('IO.close', { handle: stream }).catch(() => undefined);
      throw new PublicHttpExecutionError(
        'response_too_large',
        'browser response exceeds its signed limit',
      );
    }
    chunks.push(chunk);
    eof = readBooleanProperty(result, 'eof');
  }
  return Buffer.concat(chunks, total);
}

export function rewriteResponseHeaders(
  headers: readonly { name: string; value: string }[],
  bodyLength: number,
): Array<{ name: string; value: string }> {
  const retained = headers.filter((header) => {
    const name = header.name.toLowerCase();
    return name !== 'content-length' && name !== 'content-encoding';
  });
  return [...retained, { name: 'content-length', value: String(bodyLength) }];
}

function readStringProperty(value: object, property: string): string {
  const candidate = (value as Record<string, unknown>)[property];
  if (typeof candidate !== 'string') {
    throw new PublicHttpExecutionError(
      'transport_failure',
      `browser CDP response lacks ${property}`,
    );
  }
  return candidate;
}

function readBooleanProperty(value: object, property: string): boolean {
  const candidate = (value as Record<string, unknown>)[property];
  if (typeof candidate !== 'boolean') {
    throw new PublicHttpExecutionError(
      'transport_failure',
      `browser CDP response lacks ${property}`,
    );
  }
  return candidate;
}

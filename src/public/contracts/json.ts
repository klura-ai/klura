import { PublicContractError, sha256Digest } from './common';

export type JsonValueV1 =
  | null
  | boolean
  | number
  | string
  | JsonValueV1[]
  | { [key: string]: JsonValueV1 };

export function canonicalJson(value: JsonValueV1): string {
  return renderJson(value, '$', 0);
}

export function canonicalJsonDigest(value: JsonValueV1): ReturnType<typeof sha256Digest> {
  return sha256Digest(canonicalJson(value));
}

export function parseStrictJson(
  bytes: string | Uint8Array,
  field: string,
  maximumBytes: number,
  maximumDepth: number,
): JsonValueV1 {
  const source = typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8');
  if (Buffer.byteLength(source, 'utf8') > maximumBytes) {
    throw new PublicContractError(field, `must be at most ${maximumBytes} UTF-8 bytes`);
  }
  assertNoDuplicateJsonObjectKeys(source, field, maximumDepth);
  try {
    return JSON.parse(source) as JsonValueV1;
  } catch {
    throw new PublicContractError(field, 'must be valid JSON');
  }
}

export function assertJsonValue(
  value: unknown,
  field: string,
  maximumDepth: number,
): asserts value is JsonValueV1 {
  assertJsonValueAt(value, field, 0, maximumDepth);
}

function renderJson(value: JsonValueV1, field: string, depth: number): string {
  if (depth > 100) {
    throw new PublicContractError(field, 'exceeds the canonical JSON depth limit');
  }
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new PublicContractError(field, 'must not contain a non-finite number');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const entries = value.map((item, index) => {
      const itemField = `${field}[${index}]`;
      return renderJson(item, itemField, depth + 1);
    });
    return `[${entries.join(',')}]`;
  }
  if (typeof value !== 'object') {
    throw new PublicContractError(field, 'must be a JSON value');
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new PublicContractError(field, 'must be a plain JSON object');
  }
  const object = value as Record<string, JsonValueV1>;
  const entries = Object.keys(object)
    .sort(compareJsonKeys)
    .map((key) => {
      const valueField = `${field}.${key}`;
      return `${JSON.stringify(key)}:${renderJson(object[key] as JsonValueV1, valueField, depth + 1)}`;
    });
  return `{${entries.join(',')}}`;
}

function assertJsonValueAt(
  value: unknown,
  field: string,
  depth: number,
  maximumDepth: number,
): void {
  if (depth > maximumDepth) {
    throw new PublicContractError(field, `exceeds maximum depth ${maximumDepth}`);
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new PublicContractError(field, 'must not contain a non-finite number');
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      assertJsonValueAt(entry, `${field}[${index}]`, depth + 1, maximumDepth);
    });
    return;
  }
  if (!value || typeof value !== 'object') {
    throw new PublicContractError(field, 'must be a JSON value');
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new PublicContractError(field, 'must be a plain JSON object');
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    assertJsonValueAt(entry, `${field}.${key}`, depth + 1, maximumDepth);
  }
}

function assertNoDuplicateJsonObjectKeys(
  source: string,
  field: string,
  maximumDepth: number,
): void {
  let cursor = 0;
  const whitespace = (): void => {
    while (/\s/.test(source[cursor] ?? '')) cursor += 1;
  };
  const fail = (message: string): never => {
    throw new PublicContractError(field, message);
  };
  const consumeString = (): string => {
    if (source[cursor] !== '"') fail('must be valid JSON');
    const start = cursor;
    cursor += 1;
    while (cursor < source.length) {
      const current = source[cursor];
      if (current === '"') {
        cursor += 1;
        try {
          const parsed: unknown = JSON.parse(source.slice(start, cursor));
          if (typeof parsed !== 'string') return fail('must be valid JSON');
          return parsed;
        } catch {
          return fail('must be valid JSON');
        }
      }
      if (current === '\\') {
        cursor += 2;
        continue;
      }
      if (!current || current.charCodeAt(0) < 0x20) fail('must be valid JSON');
      cursor += 1;
    }
    return fail('must be valid JSON');
  };
  const consumeLiteral = (): void => {
    const remainder = source.slice(cursor);
    // eslint-disable-next-line sonarjs/regex-complexity -- Closed JSON grammar.
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      remainder,
    );
    const token = match?.[0];
    if (!token) return fail('must be valid JSON');
    cursor += token.length;
  };
  const consumeValue = (depth: number): void => {
    if (depth > maximumDepth) fail(`exceeds maximum depth ${maximumDepth}`);
    whitespace();
    const current = source[cursor];
    if (current === '"') {
      consumeString();
      return;
    }
    if (current === '[') {
      cursor += 1;
      whitespace();
      if (source[cursor] === ']') {
        cursor += 1;
        return;
      }
      for (;;) {
        consumeValue(depth + 1);
        whitespace();
        if (source[cursor] === ']') {
          cursor += 1;
          return;
        }
        if (source[cursor] !== ',') fail('must be valid JSON');
        cursor += 1;
      }
    }
    if (current === '{') {
      cursor += 1;
      const keys = new Set<string>();
      whitespace();
      if (source[cursor] === '}') {
        cursor += 1;
        return;
      }
      for (;;) {
        whitespace();
        const key = consumeString();
        if (keys.has(key)) fail(`contains duplicate object key ${JSON.stringify(key)}`);
        keys.add(key);
        whitespace();
        if (source[cursor] !== ':') fail('must be valid JSON');
        cursor += 1;
        consumeValue(depth + 1);
        whitespace();
        if (source[cursor] === '}') {
          cursor += 1;
          return;
        }
        if (source[cursor] !== ',') fail('must be valid JSON');
        cursor += 1;
      }
    }
    consumeLiteral();
  };

  consumeValue(0);
  whitespace();
  if (cursor !== source.length) fail('must be valid JSON');
}

function compareJsonKeys(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

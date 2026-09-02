import {
  parseExactRecord,
  parseHttpsOrigin,
  parseInteger,
  parseStableContractId,
  parseString,
  PublicContractError,
  type StableContractIdV1,
} from './common';

export type StartUrlPathSegmentV1 =
  | { kind: 'literal'; value: string }
  | {
      kind: 'slot';
      slot_id: StableContractIdV1;
      min_utf8_bytes: number;
      max_utf8_bytes: number;
    };

export interface StartUrlTemplateV1 {
  id: StableContractIdV1;
  origin: string;
  path: {
    segments: StartUrlPathSegmentV1[];
    trailing_slash: 'required' | 'forbidden';
  };
  query: Array<{
    key: string;
    max_values: 1;
    max_value_utf8_bytes: number;
  }>;
}

const MAX_PATH_SEGMENTS_V1 = 64;
const MAX_QUERY_PARAMETERS_V1 = 32;
const MAX_SEGMENT_BYTES_V1 = 512;
const MAX_QUERY_VALUE_BYTES_V1 = 2_048;

/** Parses the closed route grammar used to bind a caller-provided scrape start URL. */
export function parseStartUrlTemplate(value: unknown, field: string): StartUrlTemplateV1 {
  const record = parseExactRecord(value, field, ['id', 'origin', 'path', 'query']);
  return {
    id: parseStableContractId(record.id, `${field}.id`),
    origin: parseHttpsOrigin(record.origin, `${field}.origin`),
    path: parsePath(record.path, `${field}.path`),
    query: parseQuery(record.query, `${field}.query`),
  };
}

/** Validates a caller URL against its signed route grammar and returns its canonical URL. */
export function validateStartUrl(
  template: StartUrlTemplateV1,
  value: unknown,
  field: string,
): string {
  const text = parseString(value, field);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new PublicContractError(field, 'must be an absolute HTTPS URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.origin !== template.origin ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    throw new PublicContractError(field, 'does not match the template origin');
  }
  const pathSegments = parseUrlPath(url, template, field);
  const query = parseUrlQuery(url, template, field);
  const canonical = new URL(template.origin);
  canonical.pathname = serializePath(pathSegments, template.path.trailing_slash);
  for (const parameter of template.query) {
    const queryValue = query.get(parameter.key);
    if (queryValue !== undefined) canonical.searchParams.append(parameter.key, queryValue);
  }
  return canonical.toString();
}

function parsePath(value: unknown, field: string): StartUrlTemplateV1['path'] {
  const record = parseExactRecord(value, field, ['segments', 'trailing_slash']);
  if (!Array.isArray(record.segments) || record.segments.length > MAX_PATH_SEGMENTS_V1) {
    throw new PublicContractError(
      `${field}.segments`,
      `must contain at most ${MAX_PATH_SEGMENTS_V1} segments`,
    );
  }
  if (record.trailing_slash !== 'required' && record.trailing_slash !== 'forbidden') {
    throw new PublicContractError(`${field}.trailing_slash`, 'must be required or forbidden');
  }
  return {
    segments: record.segments.map((segment, index) =>
      parsePathSegment(segment, `${field}.segments[${index}]`),
    ),
    trailing_slash: record.trailing_slash,
  };
}

function parsePathSegment(value: unknown, field: string): StartUrlPathSegmentV1 {
  const kind = readKind(value, field);
  if (kind === 'literal') {
    const record = parseExactRecord(value, field, ['kind', 'value']);
    const literal = parseString(record.value, `${field}.value`, MAX_SEGMENT_BYTES_V1);
    assertSafePathSegment(literal, `${field}.value`);
    return { kind, value: literal };
  }
  if (kind === 'slot') {
    const record = parseExactRecord(value, field, [
      'kind',
      'slot_id',
      'min_utf8_bytes',
      'max_utf8_bytes',
    ]);
    const minimum = parseInteger(
      record.min_utf8_bytes,
      `${field}.min_utf8_bytes`,
      1,
      MAX_SEGMENT_BYTES_V1,
    );
    const maximum = parseInteger(
      record.max_utf8_bytes,
      `${field}.max_utf8_bytes`,
      minimum,
      MAX_SEGMENT_BYTES_V1,
    );
    return {
      kind,
      slot_id: parseStableContractId(record.slot_id, `${field}.slot_id`),
      min_utf8_bytes: minimum,
      max_utf8_bytes: maximum,
    };
  }
  throw new PublicContractError(`${field}.kind`, 'must be literal or slot');
}

function parseQuery(value: unknown, field: string): StartUrlTemplateV1['query'] {
  if (!Array.isArray(value) || value.length > MAX_QUERY_PARAMETERS_V1) {
    throw new PublicContractError(
      field,
      `must contain at most ${MAX_QUERY_PARAMETERS_V1} parameters`,
    );
  }
  const query = value.map((candidate, index) => {
    const item = parseExactRecord(candidate, `${field}[${index}]`, [
      'key',
      'max_values',
      'max_value_utf8_bytes',
    ]);
    if (item.max_values !== 1) {
      throw new PublicContractError(`${field}[${index}].max_values`, 'must be 1');
    }
    return {
      key: parseQueryKey(item.key, `${field}[${index}].key`),
      max_values: 1 as const,
      max_value_utf8_bytes: parseInteger(
        item.max_value_utf8_bytes,
        `${field}[${index}].max_value_utf8_bytes`,
        0,
        MAX_QUERY_VALUE_BYTES_V1,
      ),
    };
  });
  for (let index = 1; index < query.length; index += 1) {
    const prior = query[index - 1];
    const current = query[index];
    if (
      !prior ||
      !current ||
      Buffer.compare(Buffer.from(prior.key), Buffer.from(current.key)) >= 0
    ) {
      throw new PublicContractError(field, 'keys must be unique and sorted by UTF-8 byte order');
    }
  }
  return query;
}

function parseUrlPath(url: URL, template: StartUrlTemplateV1, field: string): string[] {
  const actualTrailingSlash = url.pathname.endsWith('/');
  const expectedTrailingSlash = template.path.trailing_slash === 'required';
  if (actualTrailingSlash !== expectedTrailingSlash) {
    throw new PublicContractError(field, 'does not match the template trailing-slash policy');
  }
  const raw = url.pathname.slice(1);
  const pieces = raw === '' ? [] : raw.split('/');
  if (actualTrailingSlash && pieces.length > 0) pieces.pop();
  if (pieces.length !== template.path.segments.length) {
    throw new PublicContractError(field, 'does not match the template path segment count');
  }
  return pieces.map((piece, index) => {
    const segment = decodeComponent(piece, `${field}.path[${index}]`);
    const expected = template.path.segments[index];
    if (!expected) throw new PublicContractError(field, 'does not match the template path');
    if (expected.kind === 'literal') {
      if (segment !== expected.value) {
        throw new PublicContractError(field, 'does not match a literal path segment');
      }
    } else {
      assertSafePathSegment(segment, `${field}.path[${index}]`);
      const bytes = Buffer.byteLength(segment, 'utf8');
      if (bytes < expected.min_utf8_bytes || bytes > expected.max_utf8_bytes) {
        throw new PublicContractError(
          `${field}.path[${index}]`,
          `must contain ${expected.min_utf8_bytes} to ${expected.max_utf8_bytes} UTF-8 bytes`,
        );
      }
    }
    return segment;
  });
}

function parseUrlQuery(url: URL, template: StartUrlTemplateV1, field: string): Map<string, string> {
  const permitted = new Map(template.query.map((parameter) => [parameter.key, parameter]));
  const values = new Map<string, string>();
  const rawQuery = url.search.startsWith('?') ? url.search.slice(1) : url.search;
  if (rawQuery === '') return values;
  for (const [index, entry] of rawQuery.split('&').entries()) {
    const separator = entry.indexOf('=');
    const rawKey = separator < 0 ? entry : entry.slice(0, separator);
    const rawValue = separator < 0 ? '' : entry.slice(separator + 1);
    const key = decodeQueryComponent(rawKey, `${field}.query[${index}].key`);
    const queryValue = decodeQueryComponent(rawValue, `${field}.query[${index}].value`);
    const policy = permitted.get(key);
    if (!policy) {
      throw new PublicContractError(
        `${field}.query[${index}].key`,
        'is not declared by the template',
      );
    }
    if (values.has(key)) {
      throw new PublicContractError(`${field}.query[${index}].key`, 'must not be duplicated');
    }
    if (Buffer.byteLength(queryValue, 'utf8') > policy.max_value_utf8_bytes) {
      throw new PublicContractError(
        `${field}.query[${index}].value`,
        `must be at most ${policy.max_value_utf8_bytes} UTF-8 bytes`,
      );
    }
    values.set(key, queryValue);
  }
  return values;
}

function serializePath(
  segments: readonly string[],
  trailingSlash: 'required' | 'forbidden',
): string {
  if (segments.length === 0) return '/';
  const serialized = `/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`;
  return trailingSlash === 'required' ? `${serialized}/` : serialized;
}

function decodeComponent(value: string, field: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new PublicContractError(field, 'must use valid UTF-8 percent encoding');
  }
}

function decodeQueryComponent(value: string, field: string): string {
  return decodeComponent(value.replaceAll('+', ' '), field);
}

function parseQueryKey(value: unknown, field: string): string {
  const key = parseString(value, field, 128);
  if (key.length === 0 || key.includes('&') || key.includes('=') || containsControl(key)) {
    throw new PublicContractError(
      field,
      'must be a non-empty query key without delimiters or controls',
    );
  }
  return key;
}

function assertSafePathSegment(value: string, field: string): void {
  if (
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    containsControl(value)
  ) {
    throw new PublicContractError(
      field,
      'must be a non-empty path segment without separators, dot segments, or controls',
    );
  }
}

function containsControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function readKind(value: unknown, field: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PublicContractError(field, 'must be a path segment object');
  }
  return (value as Record<string, unknown>).kind;
}

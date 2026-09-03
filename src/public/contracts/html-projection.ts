import { parseBoundedRecord, parseExactRecord, parseString, PublicContractError } from './common';
import { parseCssSelector } from './css-selector';

/** Bounds on a declared HTML projection: enough for a listing page, small
 *  enough that every selector is reviewable. */
export const HTML_PROJECTION_LIMITS_V1 = {
  maxExtractions: 32,
  maxFieldsPerExtraction: 32,
  maxNameBytes: 64,
  maxAttributeBytes: 128,
} as const;

const NAME_PATTERN = /^[A-Za-z_]\w*$/;

/** One value read from a matched element: an attribute, or its trimmed text. */
export interface HtmlExtractLeafV1 {
  /** Selector scoped to the row; null reads the row element itself. */
  selector: string | null;
  attr: string | null;
  multiple: boolean;
}

/** One named extraction from the document root: a leaf, or a row group whose
 *  `fields` are each scoped to a matched row. */
export interface HtmlExtractSpecV1 {
  selector: string;
  attr: string | null;
  multiple: boolean;
  fields: Record<string, HtmlExtractLeafV1> | null;
}

/** Declared, data-only HTML extraction for an http strategy whose response is
 *  a document rather than JSON. The response the outcome contracts classify is
 *  the extracted object: one key per extraction, a missing single match is `""`
 *  (or `{}` for a row group), a missing multiple match is `[]`. */
export interface HtmlProjectionV1 {
  kind: 'html';
  extract: Record<string, HtmlExtractSpecV1>;
}

export function parseHtmlProjection(value: unknown, field: string): HtmlProjectionV1 {
  const record = parseExactRecord(value, field, ['kind', 'extract']);
  if (record.kind !== 'html') throw new PublicContractError(`${field}.kind`, 'must be html');
  const entries = parseBoundedRecord(
    record.extract,
    `${field}.extract`,
    HTML_PROJECTION_LIMITS_V1.maxExtractions,
  );
  if (Object.keys(entries).length === 0) {
    throw new PublicContractError(`${field}.extract`, 'must declare at least one extraction');
  }
  const extract: Record<string, HtmlExtractSpecV1> = {};
  for (const [name, candidate] of Object.entries(entries)) {
    extract[parseExtractName(name, `${field}.extract`)] = parseExtractSpec(
      candidate,
      `${field}.extract.${name}`,
    );
  }
  return { kind: 'html', extract };
}

function parseExtractName(name: string, field: string): string {
  parseString(name, `${field} key`, HTML_PROJECTION_LIMITS_V1.maxNameBytes);
  if (!NAME_PATTERN.test(name)) {
    throw new PublicContractError(`${field}.${name}`, 'must be an identifier-shaped key');
  }
  return name;
}

function parseExtractSpec(value: unknown, field: string): HtmlExtractSpecV1 {
  const record = parseExactRecord(value, field, ['selector', 'attr', 'multiple', 'fields']);
  const selector = parseCssSelector(record.selector, `${field}.selector`);
  const attr = parseAttribute(record.attr, `${field}.attr`);
  const multiple = parseBoolean(record.multiple, `${field}.multiple`);
  if (record.fields === null) return { selector, attr, multiple, fields: null };
  if (attr !== null) {
    throw new PublicContractError(
      `${field}.attr`,
      'must be null on a row group: a row has no attribute of its own, its fields do',
    );
  }
  const leaves = parseBoundedRecord(
    record.fields,
    `${field}.fields`,
    HTML_PROJECTION_LIMITS_V1.maxFieldsPerExtraction,
  );
  if (Object.keys(leaves).length === 0) {
    throw new PublicContractError(`${field}.fields`, 'must declare at least one field');
  }
  const fields: Record<string, HtmlExtractLeafV1> = {};
  for (const [name, candidate] of Object.entries(leaves)) {
    fields[parseExtractName(name, `${field}.fields`)] = parseExtractLeaf(
      candidate,
      `${field}.fields.${name}`,
    );
  }
  return { selector, attr: null, multiple, fields };
}

function parseExtractLeaf(value: unknown, field: string): HtmlExtractLeafV1 {
  const record = parseExactRecord(value, field, ['selector', 'attr', 'multiple']);
  return {
    selector:
      record.selector === null ? null : parseCssSelector(record.selector, `${field}.selector`),
    attr: parseAttribute(record.attr, `${field}.attr`),
    multiple: parseBoolean(record.multiple, `${field}.multiple`),
  };
}

function parseAttribute(value: unknown, field: string): string | null {
  if (value === null) return null;
  const attr = parseString(value, field, HTML_PROJECTION_LIMITS_V1.maxAttributeBytes);
  if (!/^[A-Za-z_:][A-Za-z0-9_:.-]*$/.test(attr)) {
    throw new PublicContractError(field, 'must be an attribute name');
  }
  return attr;
}

function parseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new PublicContractError(field, 'must be a boolean');
  return value;
}

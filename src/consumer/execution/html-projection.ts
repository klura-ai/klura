import * as cheerio from 'cheerio';
import type { Cheerio, CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import type {
  HtmlExtractLeafV1,
  HtmlExtractSpecV1,
  HtmlProjectionV1,
} from '../../public/contracts/html-projection';
import type { JsonValueV1 } from '../../public/contracts/json';

type Scope = Cheerio<Element> | ReturnType<CheerioAPI['root']>;

/** Applies a declared HTML projection to a document. The shape of every value
 *  is fixed by the declaration alone: a single leaf is a string (`""` when
 *  nothing matched), a multiple leaf is a string array, a single row group is
 *  an object (`{}` when nothing matched), a multiple row group is an array of
 *  objects, and a multiple field inside a row joins its values with commas so
 *  a row stays a flat string record. */
export function projectHtml(
  html: string,
  projection: HtmlProjectionV1,
): Record<string, JsonValueV1> {
  const $ = cheerio.load(html);
  const out: Record<string, JsonValueV1> = {};
  for (const [name, spec] of Object.entries(projection.extract)) {
    out[name] = extractEntry($, $.root(), spec);
  }
  return out;
}

function extractEntry($: CheerioAPI, scope: Scope, spec: HtmlExtractSpecV1): JsonValueV1 {
  const matches = (scope as Cheerio<Element>).find(spec.selector);
  const fields = spec.fields;
  const value: JsonValueV1 =
    fields === null
      ? extractLeaf($, matches, spec.attr, spec.multiple)
      : extractRowGroup($, matches, fields, spec.multiple);
  return value;
}

function extractLeaf(
  $: CheerioAPI,
  matches: Cheerio<Element>,
  attr: string | null,
  multiple: boolean,
): string | string[] {
  const values: string[] = [];
  matches.each((_, element) => {
    values.push(readValue($(element), attr));
  });
  const value: string | string[] = multiple ? values : (values[0] ?? '');
  return value;
}

function extractRowGroup(
  $: CheerioAPI,
  matches: Cheerio<Element>,
  fields: Record<string, HtmlExtractLeafV1>,
  multiple: boolean,
): Record<string, string> | Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  matches.each((_, element) => {
    rows.push(extractRow($, $(element), fields));
  });
  const value: Record<string, string> | Record<string, string>[] = multiple
    ? rows
    : (rows[0] ?? {});
  return value;
}

function extractRow(
  $: CheerioAPI,
  row: Cheerio<Element>,
  fields: Record<string, HtmlExtractLeafV1>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, leaf] of Object.entries(fields)) {
    const matches = leaf.selector === null ? row : row.find(leaf.selector);
    if (leaf.multiple) {
      const parts: string[] = [];
      matches.each((_, element) => {
        parts.push(readValue($(element), leaf.attr));
      });
      out[name] = parts.join(',');
      continue;
    }
    out[name] = matches.length === 0 ? '' : readValue(matches.first(), leaf.attr);
  }
  return out;
}

function readValue(element: Cheerio<Element>, attr: string | null): string {
  const value = attr === null ? element.text().trim() : element.attr(attr);
  return value ?? '';
}

/** Decodes a document body using the charset its content type declares. */
export function decodeHtmlBody(bytes: Uint8Array, contentType: string | undefined): string {
  const charset = /charset=("?)([a-z0-9._-]+)\1/i.exec(contentType ?? '')?.[2];
  try {
    return new TextDecoder(charset ?? 'utf-8', { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

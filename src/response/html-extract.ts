// Pure Node HTML extraction via cheerio. Single-purpose helper the Node execute
// paths, the strategy probe, and the in-browser HTML response path all route
// through. Cheerio gives jQuery-compatible CSS selector semantics and attribute
// access as a pure Node function, so extraction needs no driver interaction.
//
// The contract: selectors is a map of varName → { selector, attr?, multiple?,
// json?, fields? }; the return value is a map of varName → extracted value.
// Missing matches return '' (single) or [] (multiple), NEVER undefined,
// because the probe relies on emptiness detection to reject all-empty
// extracts as auth-wall interstitials.

import * as cheerio from 'cheerio';
import type { Cheerio, CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { extractRawByPath } from './json-path';

interface HtmlExtractSpec {
  selector: string;
  /** Read this attribute instead of the element text content. Mutually
   *  exclusive with `fields` and `json`. */
  attr?: string;
  /** When true, return all matches as an array. When false/unset, return the
   *  first match. */
  multiple?: boolean;
  /** Parse the matched element's text content as JSON and return the value at
   *  this path (grammar in `./json-path`; bracket-quote keys that contain
   *  dots). `''` returns the whole parsed document. Reaches data that a site
   *  server-renders into a `<script>` tag rather than into markup —
   *  `__NEXT_DATA__`, `__NUXT__`, `application/ld+json`, and friends — so
   *  those capabilities stay on the `fetch` tier instead of needing a browser
   *  to read a global. Yields raw JSON values (objects, arrays, numbers,
   *  booleans), not stringified ones. Mutually exclusive with `attr` and
   *  `fields`. */
  json?: string;
  /** Per-row sub-extract. When set, the spec defines a ROW selector and a map
   *  of per-row field extracts, each scoped to that row. With `multiple:true`
   *  produces `Array<Record<string,string>>`; with explicit `multiple:false`
   *  produces a single `Record<string,string>` for the first match. Field
   *  specs are flat (one level of nesting only) — `fields` inside `fields` is
   *  rejected at save time. Mutually exclusive with `attr`. */
  fields?: HtmlExtractFlatSelectors;
}

/** Flat selector spec used inside `fields` — no further nesting. */
type HtmlExtractFlatSpec = Omit<HtmlExtractSpec, 'fields'>;
type HtmlExtractFlatSelectors = Record<string, HtmlExtractFlatSpec>;

/** Any JSON-representable value — what a `json` dot-path can resolve to. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type HtmlExtractSelectors = Record<string, HtmlExtractSpec>;
type HtmlExtractRow = Record<string, JsonValue>;
type HtmlExtractResult = Record<string, JsonValue>;

/**
 * Apply a set of CSS selector specs to an HTML string and return a flat map of
 * varName → extracted value(s).
 *
 * Thin wrapper around cheerio's `load()` + jQuery-like selector API. The HTML
 * is parsed once per call; cheerio's parser (parse5 via htmlparser2) handles
 * malformed HTML gracefully the same way Chrome's quirks-mode recovery does, so
 * we don't need to pre-sanitize input.
 *
 * Does not mutate the input string. Safe to call concurrently; each call owns
 * its own cheerio document.
 *
 * Spec shapes:
 *  - Leaf: `{selector, attr?, multiple?}` — extracts a string or string[].
 *  - JSON leaf: `{selector, json: "dot.path", multiple?}` — parses the matched
 *    element's text as JSON and returns the raw value at `json`, so
 *    server-rendered `<script>` payloads stay readable without a browser.
 *  - Row group: `{selector, multiple:true, fields: {...}}` — iterates over
 *    matches of `selector` and runs each `fields` entry scoped to that row,
 *    producing `Array<Record<string,JsonValue>>`.
 *  - Single row: `{selector, fields:{...}}` (or `multiple:false`) — scopes
 *    the fields to the first match, producing a `Record<string,JsonValue>`.
 */
export function extractFromHtml(html: string, selectors: HtmlExtractSelectors): HtmlExtractResult {
  const $ = cheerio.load(html);
  const out: HtmlExtractResult = {};

  for (const [name, spec] of Object.entries(selectors)) {
    out[name] = extractEntry($, $.root(), spec);
  }

  return out;
}

function extractEntry(
  $: CheerioAPI,
  scope: Cheerio<Element> | ReturnType<CheerioAPI['root']>,
  spec: HtmlExtractSpec,
): JsonValue {
  const matches = (scope as Cheerio<Element>).find(spec.selector);
  let out: JsonValue;
  if (spec.json !== undefined) {
    const jsonPath = spec.json;
    if (spec.multiple) {
      const values: JsonValue[] = [];
      matches.each((_, el) => {
        values.push(readJsonPath($(el).text(), jsonPath));
      });
      out = values;
    } else if (matches.length === 0) {
      out = '';
    } else {
      out = readJsonPath(matches.first().text(), jsonPath);
    }
  } else if (spec.fields) {
    if (spec.multiple) {
      const rows: HtmlExtractRow[] = [];
      const fields = spec.fields;
      matches.each((_, el) => {
        rows.push(extractRowFields($, $(el), fields));
      });
      out = rows;
    } else if (matches.length === 0) {
      out = {};
    } else {
      out = extractRowFields($, matches.first(), spec.fields);
    }
  } else if (spec.multiple) {
    const values: string[] = [];
    matches.each((_, el) => {
      const value = spec.attr ? $(el).attr(spec.attr) : $(el).text().trim();
      values.push(value ?? '');
    });
    out = values;
  } else if (matches.length === 0) {
    out = '';
  } else {
    const first = matches.first();
    const value = spec.attr ? first.attr(spec.attr) : first.text().trim();
    out = value ?? '';
  }
  return out;
}

/**
 * Parse `text` as JSON and return the value at `path`. Unparseable text and
 * paths that don't resolve both yield `''` — the same "nothing here" signal a
 * selector miss produces, so the probe's emptiness detection still fires.
 */
function readJsonPath(text: string, path: string): JsonValue {
  let found: unknown;
  try {
    found = extractRawByPath(JSON.parse(text), path);
  } catch {
    found = undefined;
  }
  // extractRawByPath walks a value that came out of JSON.parse, so anything it
  // returns is JSON-representable by construction.
  const value: JsonValue = found === undefined ? '' : (found as JsonValue);
  return value;
}

function extractRowFields(
  $: CheerioAPI,
  row: Cheerio<Element>,
  fields: HtmlExtractFlatSelectors,
): HtmlExtractRow {
  const out: HtmlExtractRow = {};
  for (const [fieldName, fieldSpec] of Object.entries(fields)) {
    // Empty selector means "this row's own element" — read attr/text directly
    // from `row` rather than running a `.find()` that would skip self.
    let matches: Cheerio<Element>;
    if (fieldSpec.selector.length === 0) {
      matches = row;
    } else {
      matches = row.find(fieldSpec.selector);
    }
    if (fieldSpec.json !== undefined) {
      const jsonPath = fieldSpec.json;
      if (fieldSpec.multiple) {
        const values: JsonValue[] = [];
        matches.each((_, el) => {
          values.push(readJsonPath($(el).text(), jsonPath));
        });
        out[fieldName] = values;
      } else {
        out[fieldName] = matches.length === 0 ? '' : readJsonPath(matches.first().text(), jsonPath);
      }
      continue;
    }
    if (fieldSpec.multiple) {
      // multiple inside fields collapses to a comma-joined string so a
      // text/attr row stays `Record<string,string>` (callers that need arrays
      // should declare the array at the top level).
      const parts: string[] = [];
      matches.each((_, el) => {
        const v = fieldSpec.attr ? $(el).attr(fieldSpec.attr) : $(el).text().trim();
        parts.push(v ?? '');
      });
      out[fieldName] = parts.join(',');
      continue;
    }
    if (matches.length === 0) {
      out[fieldName] = '';
      continue;
    }
    const first = matches.first();
    const value = fieldSpec.attr ? first.attr(fieldSpec.attr) : first.text().trim();
    out[fieldName] = value ?? '';
  }
  return out;
}

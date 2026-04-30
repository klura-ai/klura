// Pure Node HTML extraction via cheerio. Single-purpose helper the Node execute
// paths, the strategy probe, and the old in-browser HTML response path all
// route through.
//
// Before this module: `driver.extractFromDocument` ran a DOMParser closure
// inside a Playwright page context just to do `querySelector` on an HTML string
// that was already in the Node process. It shipped the string through CDP,
// parsed in-browser, shipped the result back. That made sense when klura had a
// browser for everything and `page.evaluate` was "free" — now that the warm
// path is Node-native, the in-browser detour is absurd overhead. Cheerio gives
// us the same selector semantics (jQuery-compatible CSS selectors + attribute
// access) as a pure Node function with zero driver interaction.
//
// The contract matches what `extractFromDocument` promised so callers don't
// have to reason about two different shapes: - selectors is a map of varName →
// { selector, attr?, multiple? } - return value is a map of varName → string
// (single) or string[] (multiple) - missing matches return '' (single) or []
// (multiple), NEVER undefined, because the probe relies on emptiness detection
// to reject all-empty extracts as auth-wall interstitials

import * as cheerio from 'cheerio';

interface HtmlExtractSpec {
  selector: string;
  /** Read this attribute instead of the element text content. */
  attr?: string;
  /** When true, return all matches as an array. When false/unset, return the
   *  first match. */
  multiple?: boolean;
}

type HtmlExtractSelectors = Record<string, HtmlExtractSpec>;
type HtmlExtractResult = Record<string, string | string[]>;

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
 */
export function extractFromHtml(html: string, selectors: HtmlExtractSelectors): HtmlExtractResult {
  const $ = cheerio.load(html);
  const out: HtmlExtractResult = {};

  for (const [name, spec] of Object.entries(selectors)) {
    const matches = $(spec.selector);
    if (spec.multiple) {
      const values: string[] = [];
      matches.each((_, el) => {
        const value = spec.attr ? $(el).attr(spec.attr) : $(el).text().trim();
        values.push(value ?? '');
      });
      out[name] = values;
    } else {
      if (matches.length === 0) {
        out[name] = '';
        continue;
      }
      const first = matches.first();
      const value = spec.attr ? first.attr(spec.attr) : first.text().trim();
      out[name] = value ?? '';
    }
  }

  return out;
}

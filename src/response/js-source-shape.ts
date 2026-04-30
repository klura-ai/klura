// Pure helpers for the get_js_source tool: pretty-printing minified JS and
// windowing the source around a target line within the MCP output budget.
// Driver-side fetching lives in playwright.ts; this module just shapes what we
// hand back to the agent.

import { MAX_TOOL_OUTPUT_CHARS } from './response-size';

export interface JsSourceMatch {
  line: number;
  column: number;
  preview: string;
}

/**
 * Substring-search a JS source. Agents use this to find candidate encoder call
 * sites by searching for protocol literals they saw in captured bytes (opcode
 * chars, field names, stable route strings). Returns raw-source line numbers
 * matching `Error.stack` / `get_js_source({line})` semantics — no pretty-print
 * coordinate shift.
 */
export function searchJsSource(
  source: string,
  pattern: string,
  opts: { case_sensitive?: boolean; max_matches?: number } = {},
): JsSourceMatch[] {
  if (!pattern) return [];
  const maxMatches = Math.min(Math.max(opts.max_matches ?? 20, 1), 100);
  const caseSensitive = opts.case_sensitive !== false; // default true
  const haystack = caseSensitive ? source : source.toLowerCase();
  const needle = caseSensitive ? pattern : pattern.toLowerCase();
  const matches: JsSourceMatch[] = [];
  let line = 1;
  let col = 1;
  let lastNewline = 0;
  for (let i = 0; i < haystack.length; i += 1) {
    if (haystack[i] === '\n') {
      line += 1;
      col = 1;
      lastNewline = i + 1;
      continue;
    }
    if (haystack.startsWith(needle, i)) {
      const previewStart = Math.max(lastNewline, i - 40);
      const previewEnd = Math.min(source.length, i + needle.length + 40);
      matches.push({
        line,
        column: col,
        preview: source.slice(previewStart, previewEnd).replace(/\n/g, ' '),
      });
      if (matches.length >= maxMatches) break;
      i += needle.length - 1;
      col += needle.length;
      continue;
    }
    col += 1;
  }
  return matches;
}

export interface JsFunctionSlice {
  name?: string;
  start_line: number;
  end_line: number;
  params: string;
  body_preview: string;
  body_total_chars: number;
  truncated?: true;
}

interface FunctionHeader {
  funcStart: number;
  arrow: boolean;
  funcName?: string;
  paramStart: number;
  paramEnd: number;
}

function targetOffsetForLine(lines: readonly string[], targetLine: number): number {
  let targetOffset = 0;
  for (let i = 0; i < targetLine - 1; i += 1) {
    targetOffset += (lines[i]?.length ?? 0) + 1;
  }
  return targetOffset;
}

function isIdentifierChar(char: string): boolean {
  return (
    (char >= 'A' && char <= 'Z') ||
    (char >= 'a' && char <= 'z') ||
    (char >= '0' && char <= '9') ||
    char === '_' ||
    char === '$'
  );
}

function isIdentifierStart(char: string): boolean {
  return (
    (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || char === '_' || char === '$'
  );
}

function skipWhitespace(source: string, offset: number): number {
  let i = offset;
  while (i < source.length) {
    const c = source[i];
    if (c !== ' ' && c !== '\t' && c !== '\n') break;
    i += 1;
  }
  return i;
}

function parseFunctionKeywordHeader(source: string, keywordOffset: number): FunctionHeader | null {
  const prev = keywordOffset > 0 ? (source[keywordOffset - 1] ?? '') : '';
  if (prev && isIdentifierChar(prev)) return null;

  let i = skipWhitespace(source, keywordOffset + 'function'.length);
  let funcName: string | undefined;
  if (isIdentifierStart(source[i] ?? '')) {
    const nameStart = i;
    i += 1;
    while (i < source.length && isIdentifierChar(source[i] ?? '')) i += 1;
    funcName = source.slice(nameStart, i);
    i = skipWhitespace(source, i);
  }
  if (source[i] !== '(') return null;
  return { funcStart: keywordOffset, arrow: false, funcName, paramStart: i, paramEnd: -1 };
}

function findArrowParamStart(source: string, arrowIdx: number): number {
  let depth = 0;
  for (let i = arrowIdx - 1; i >= 0; i -= 1) {
    const c = source[i];
    if (c === ')') {
      depth += 1;
    } else if (c === '(') {
      depth -= 1;
      if (depth < 0) return i;
    }
  }
  return -1;
}

function findFunctionHeader(source: string, targetOffset: number): FunctionHeader | null {
  for (let i = targetOffset; i >= 0; i -= 1) {
    if (!source.startsWith('function', i)) continue;
    const header = parseFunctionKeywordHeader(source, i);
    if (header) return header;
  }

  const arrowIdx = source.lastIndexOf('=>', targetOffset);
  if (arrowIdx < 0) return null;
  const paramStart = findArrowParamStart(source, arrowIdx);
  if (paramStart < 0) return null;
  return { funcStart: paramStart, arrow: true, paramStart, paramEnd: arrowIdx - 1 };
}

function findParamEnd(source: string, paramStart: number): number {
  let depth = 0;
  for (let i = paramStart; i < source.length; i += 1) {
    const c = source[i];
    if (c === '(') {
      depth += 1;
    } else if (c === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findBraceStart(source: string, paramEnd: number, arrow: boolean): number | null {
  for (let i = paramEnd + 1; i < source.length; i += 1) {
    const c = source[i];
    if (c === '{') return i;
    if (c === '=' && source[i + 1] === '>') {
      i += 1;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n') continue;
    return arrow ? -1 : null;
  }
  return null;
}

function updateStringState(
  c: string | undefined,
  state: { inString: string | null; escape: boolean },
): boolean {
  if (state.inString) {
    if (state.escape) {
      state.escape = false;
      return true;
    }
    if (c === '\\') {
      state.escape = true;
      return true;
    }
    if (c === state.inString) state.inString = null;
    return true;
  }
  if (c === '"' || c === "'" || c === '`') {
    state.inString = c;
    return true;
  }
  return false;
}

function expressionBodyRange(
  source: string,
  paramEnd: number,
): { bodyStart: number; bodyEnd: number } {
  const bodyStart = paramEnd + 1;
  let depth = 0;
  let bodyEnd = source.length;
  const state = { inString: null as string | null, escape: false };
  for (let i = paramEnd + 2; i < source.length; i += 1) {
    const c = source[i];
    if (updateStringState(c, state)) continue;
    if (c === '(' || c === '[' || c === '{') {
      depth += 1;
    } else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) {
        bodyEnd = i;
        break;
      }
      depth -= 1;
    } else if (depth === 0 && (c === ';' || c === ',' || c === '\n')) {
      bodyEnd = i;
      break;
    }
  }
  return { bodyStart, bodyEnd };
}

function blockBodyRange(
  source: string,
  braceStart: number,
): { bodyStart: number; bodyEnd: number } {
  let depth = 0;
  let bodyEnd = source.length;
  const state = { inString: null as string | null, escape: false };
  for (let i = braceStart; i < source.length; i += 1) {
    const c = source[i];
    if (updateStringState(c, state)) continue;
    if (c === '{') {
      depth += 1;
    } else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        bodyEnd = i + 1;
        break;
      }
    }
  }
  return { bodyStart: braceStart, bodyEnd };
}

/**
 * Given a line in a JS source, find the enclosing function and return its
 * header (name + params), line range, and body preview. Bracket- match-based;
 * no parser. Handles `function name(...){...}`, `function(...){...}`, and arrow
 * functions `(...)=>{...}`. Returns null when we can't confidently anchor a
 * function around the target line.
 */
export function readJsFunction(
  source: string,
  targetLine: number,
  maxBodyChars = 2000,
): JsFunctionSlice | null {
  if (targetLine < 1) return null;
  const lines = source.split('\n');
  if (targetLine > lines.length) return null;

  const targetOffset = targetOffsetForLine(lines, targetLine);
  const header = findFunctionHeader(source, targetOffset);
  if (!header) return null;

  // Find the opening `(` and matching `)` for params.
  const paramEnd =
    header.paramEnd === -1 ? findParamEnd(source, header.paramStart) : header.paramEnd;
  if (paramEnd === -1) return null;

  // Body: find the opening `{` after paramEnd (skipping whitespace, `=>`).
  const braceStart = findBraceStart(source, paramEnd, header.arrow);
  if (braceStart === null) return null;
  const { bodyStart, bodyEnd } =
    braceStart === -1 ? expressionBodyRange(source, paramEnd) : blockBodyRange(source, braceStart);

  // Compute line numbers.
  const startLine = lineOf(source, header.funcStart);
  const endLine = lineOf(source, bodyEnd - 1);
  const paramsText = source.slice(header.paramStart, paramEnd + 1);
  const body = source.slice(bodyStart, bodyEnd);
  const bodyPreview = body.length > maxBodyChars ? body.slice(0, maxBodyChars) : body;
  const out: JsFunctionSlice = {
    name: header.funcName,
    start_line: startLine,
    end_line: endLine,
    params: paramsText,
    body_preview: bodyPreview,
    body_total_chars: body.length,
  };
  if (body.length > maxBodyChars) out.truncated = true;
  return out;
}

function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}

const PRETTY_PRINT_LENGTH_THRESHOLD = 1024;
const PRETTY_PRINT_MAX_LINES_PER_SOURCE = 200_000;
const DEFAULT_CONTEXT_LINES = 60;
const MAX_CONTEXT_LINES = 200;

export interface JsSourceWindow {
  url: string;
  format: 'raw' | 'pretty';
  total_lines: number;
  start_line: number;
  end_line: number;
  source: string;
  truncated?: boolean;
  /**
   * When the caller supplied `opts.line`, echoes back the raw-source line they
   * asked for so they can confirm the runtime treated it as a raw-file offset
   * (matching `Error.stack` semantics), not a pretty-printed index. Absent on
   * browse-mode calls (no line supplied).
   */
  raw_line?: number;
}

interface JsSourceWindowOpts {
  line?: number;
  context_lines?: number;
  format?: 'raw' | 'pretty';
}

/**
 * Pretty-print a minified single-line script. Splits on `;` / `{` / `}`
 * boundaries with a brace-depth-tracking indenter — not a real formatter (no JS
 * lexer, no AST), but enough to make patterns scannable. Keeps string literals
 * together so we don't accidentally split a JSON blob.
 */
export function prettyPrintMinified(source: string): string {
  if (source.length === 0) return source;
  // Quick gate: only pretty-print scripts that look minified-on-one-line.
  const newlineCount = countNewlines(source);
  const looksMinified =
    newlineCount === 0 ||
    source.length / Math.max(1, newlineCount + 1) > PRETTY_PRINT_LENGTH_THRESHOLD;
  if (!looksMinified) return source;

  const out: string[] = [];
  let depth = 0;
  let buf = '';
  let inString = false;
  let stringQuote = '';
  let inLineComment = false;
  let inBlockComment = false;
  let prev = '';
  let escapeNext = false;

  const flushLine = (): void => {
    const trimmed = buf.replace(/^\s+/, '');
    if (trimmed.length > 0) out.push('  '.repeat(Math.max(0, depth)) + trimmed);
    buf = '';
  };

  for (let i = 0; i < source.length; i += 1) {
    const c = source[i] ?? '';
    buf += c;

    if (escapeNext) {
      escapeNext = false;
      prev = c;
      continue;
    }
    if (c === '\\' && (inString || inBlockComment)) {
      escapeNext = true;
      prev = c;
      continue;
    }

    if (inLineComment) {
      if (c === '\n') {
        inLineComment = false;
        flushLine();
      }
      prev = c;
      continue;
    }
    if (inBlockComment) {
      if (prev === '*' && c === '/') inBlockComment = false;
      prev = c;
      continue;
    }
    if (inString) {
      if (c === stringQuote) {
        inString = false;
        stringQuote = '';
      }
      prev = c;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = true;
      stringQuote = c;
      prev = c;
      continue;
    }
    if (prev === '/' && c === '/') {
      inLineComment = true;
      prev = c;
      continue;
    }
    if (prev === '/' && c === '*') {
      inBlockComment = true;
      prev = c;
      continue;
    }

    if (c === '{') {
      flushLine();
      depth += 1;
    } else if (c === '}') {
      // Trim the trailing '}' off buf, dedent, then re-emit on its own line.
      buf = buf.slice(0, -1);
      flushLine();
      depth = Math.max(0, depth - 1);
      buf = '}';
      flushLine();
    } else if (c === ';') {
      flushLine();
    }
    prev = c;
    if (out.length > PRETTY_PRINT_MAX_LINES_PER_SOURCE) break;
  }
  if (buf.length > 0) flushLine();
  return out.join('\n');
}

function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '\n') n += 1;
  }
  return n;
}

/**
 * Window a JS source into a slice around `line` with `context_lines` of
 * surrounding context, capped to the MCP output budget.
 *
 * Line-number semantics: when `opts.line` is supplied, it is treated as a
 * **raw-file** line number (matching `Error.stack` frame semantics — that's
 * where the agent got the line from). The window is sliced from the raw source
 * at [line - context, line + context], then pretty-printed for readability if
 * `format: "pretty"`. That preserves the agent's coordinate system across the
 * pretty-print step.
 *
 * When `opts.line` is NOT supplied, the agent is browsing without a specific
 * target — the whole source is pretty-printed first, then the window is taken
 * from the top of the pretty buffer.
 */
export function windowJsSource(
  url: string,
  source: string,
  opts: JsSourceWindowOpts = {},
): JsSourceWindow {
  const format: 'raw' | 'pretty' = opts.format ?? 'pretty';
  const hasExplicitLine =
    typeof opts.line === 'number' && Number.isFinite(opts.line) && opts.line >= 1;
  const contextLines = Math.min(
    MAX_CONTEXT_LINES,
    Math.max(1, Math.floor(opts.context_lines ?? DEFAULT_CONTEXT_LINES)),
  );

  // Two coordinate systems: when the agent supplied a specific line, we window
  // in raw-source space (their Error.stack line numbers) and pretty-print only
  // the result. Otherwise we pretty-print everything and window the pretty
  // buffer as the "browse" mode.
  let slice: string;
  let start: number;
  let end: number;
  let totalLines: number;

  if (hasExplicitLine) {
    const rawLines = source.split('\n');
    const rawTotal = rawLines.length;
    const requestedLine = Math.max(1, Math.floor(opts.line ?? 1));
    const targetLine = Math.min(Math.max(1, rawTotal), requestedLine);
    start = Math.max(1, targetLine - contextLines);
    end = Math.min(rawTotal, targetLine + contextLines);
    const rawSlice = rawLines.slice(start - 1, end).join('\n');
    const pretty = format === 'pretty' ? prettyPrintMinified(rawSlice) : rawSlice;
    // After pretty-printing, totalLines reports the pretty-line count of the
    // slice (what the agent is actually reading). start/end stay in raw-source
    // coordinates — the agent's line 216 is the center of the returned raw
    // window, now pretty-printed around it.
    slice = pretty;
    totalLines = rawTotal;
  } else {
    const effective = format === 'pretty' ? prettyPrintMinified(source) : source;
    const lines = effective.split('\n');
    totalLines = lines.length;
    start = 1;
    end = Math.min(totalLines, 1 + contextLines);
    slice = lines.slice(start - 1, end).join('\n');
  }

  // Clamp the slice under the MCP output budget. Truncate tail-first to
  // preserve the target line at the top of the returned window.
  let truncated = false;
  if (slice.length > MAX_TOOL_OUTPUT_CHARS) {
    slice = slice.slice(0, MAX_TOOL_OUTPUT_CHARS);
    truncated = true;
  }

  const out: JsSourceWindow = {
    url,
    format,
    total_lines: totalLines,
    start_line: start,
    end_line: end,
    source: slice,
  };
  if (truncated) out.truncated = true;
  if (hasExplicitLine) out.raw_line = opts.line;
  return out;
}

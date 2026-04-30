// Pure parsers for JS stack traces. Used by the WebSocket-send callstack
// capture to turn a raw `Error.stack` string into a structured `frames[]` array
// the agent can read. Three engines covered:
//
// - V8 (Chromium) — the load-bearing case for klura, since the playwright
// driver runs Chromium. - SpiderMonkey (Firefox) — useful when a future driver
// targets Firefox. - JavaScriptCore (WebKit/Safari) — same.
//
// V8 format examples:
//   `    at sendMessage (https://x/static/bundle.js:44821:5)`
//   `    at Object.<anonymous> (eval at evaluate (<anonymous>:1:1),
//    <anonymous>:1:1)`
//   `    at https://x/static/bundle.js:44821:5`            (no function name)
//   `    at <anonymous>:1:1`                               (eval'd source)
//
// SpiderMonkey format example: `sendMessage@https://x/static/bundle.js:44821:5`
//
// JavaScriptCore format example:
// `sendMessage@https://x/static/bundle.js:44821:5` `global
// code@<anonymous>:1:1`
//
// All parsers tolerate junk lines (skip rather than throw) and return
// `frames[]` in top-to-bottom call order — frames[0] is the innermost caller,
// the last frame is the outermost (typically the entry point).

interface StackFrame {
  /** Function name as reported by the engine. May be `<anonymous>` /
   *  empty / a minified single letter. Absent when the engine did not
   *  attach a name (anonymous function expression with no .name). */
  function?: string;
  /** Source URL of the script. Absent for native frames + eval'd source
   *  with no resolvable origin. */
  file?: string;
  /** 1-indexed line number in the source. */
  line?: number;
  /** 1-indexed column number in the source. */
  column?: number;
  /** True when the engine marked this frame as native code. */
  native?: boolean;
}

/**
 * Parse a raw `Error.stack` string into structured frames. Auto-detects the
 * engine format from the first non-trivial line. Unknown formats return an
 * empty array rather than throwing — stack parsing is diagnostic, not
 * load-bearing.
 */
export function parseStack(raw: string): StackFrame[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  const lines = raw.split(/\r?\n/);
  // Detect format by scanning the first few non-empty lines. V8 starts
  // with "Error" + lines beginning with "    at ". SpiderMonkey/JSC use
  // "fnName@url:line:col" with no leading "at".
  let kind: 'v8' | 'spidermonkey-jsc' | 'unknown' = 'unknown';
  for (const ln of lines) {
    const trimmed = ln.trim();
    if (trimmed.length === 0) continue;
    if (/^at\s/.test(trimmed)) {
      kind = 'v8';
      break;
    }
    if (/@(?:[a-z]+:\/\/|[<[]|\/|\w+:)/.test(trimmed)) {
      kind = 'spidermonkey-jsc';
      break;
    }
  }
  if (kind === 'v8') return parseV8(lines);
  if (kind === 'spidermonkey-jsc') return parseSpiderMonkeyOrJsc(lines);
  return [];
}

function parseV8(lines: string[]): StackFrame[] {
  const out: StackFrame[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('at ')) continue;
    const rest = line.slice(3); // strip leading "at "
    const frame = parseV8Frame(rest);
    if (frame) out.push(frame);
  }
  return out;
}

function parseV8Frame(rest: string): StackFrame | null {
  // Forms to handle:
  //   "fnName (URL:LINE:COL)"
  //   "fnName (native)"
  //   "URL:LINE:COL"           (no function name)
  //   "<anonymous>"
  //   "Object.<anonymous> (URL:LINE:COL)"
  //   "async fnName (URL:LINE:COL)"
  if (rest === '<anonymous>') return { function: '<anonymous>' };
  // "fn (loc)" form — match function name (possibly with dots/brackets)
  // followed by space + parenthesised location.
  const parenStart = rest.endsWith(')') ? rest.lastIndexOf(' (') : -1;
  if (parenStart > 0) {
    const fn = rest.slice(0, parenStart);
    const loc = rest.slice(parenStart + 2, -1);
    if (loc === 'native') return { function: fn, native: true };
    const parsed = parseV8Location(loc);
    return { function: fn, ...(parsed ?? {}) };
  }
  // No function name — the whole rest is the location.
  const parsed = parseV8Location(rest);
  if (parsed) return parsed;
  return null;
}

function parseV8Location(loc: string): Pick<StackFrame, 'file' | 'line' | 'column'> | null {
  // Split on the LAST two colons so `https://x:8080/foo.js:10:5` parses as
  // file=https://x:8080/foo.js, line=10, col=5.
  const lastColon = loc.lastIndexOf(':');
  const prevColon = lastColon > 0 ? loc.lastIndexOf(':', lastColon - 1) : -1;
  if (lastColon < 0 || prevColon < 0) {
    return loc.length > 0 ? { file: loc } : null;
  }
  const lineText = loc.slice(prevColon + 1, lastColon);
  const columnText = loc.slice(lastColon + 1);
  if (!/^\d+$/.test(lineText) || !/^\d+$/.test(columnText)) {
    return loc.length > 0 ? { file: loc } : null;
  }
  const out: { file: string; line: number; column: number } = {
    file: loc.slice(0, prevColon),
    line: Number(lineText),
    column: Number(columnText),
  };
  return out;
}

function parseSpiderMonkeyOrJsc(lines: string[]): StackFrame[] {
  const out: StackFrame[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    // "fnName@URL:LINE:COL" — function name may be empty (anonymous).
    const at = line.lastIndexOf('@');
    if (at < 0) continue;
    const fn = line.slice(0, at);
    const loc = line.slice(at + 1);
    const parsed = parseV8Location(loc);
    out.push({
      function: fn.length > 0 ? fn : '<anonymous>',
      ...(parsed ?? {}),
    });
  }
  return out;
}

// Server-side wrapper around agent-supplied JS expressions evaluated in the
// live page. Its job is to make bytes round-trip cleanly across the
// `evaluateExpression` boundary — the driver JSON-serializes results, so any
// ArrayBuffer / Uint8Array returned by the agent's expression would become
// `{}`. The wrapper detects those shapes and hex-encodes them on the page side
// before return, so the host receives a plain string.
//
// Shared by: - The `js_eval` agent tool: probe the live page during discovery.
// - The `frameFromPage` strategy source at execute time: produce binary frame
// bytes by calling the page's own encoder.
//
// The agent's expression can be sync or async — the wrapper awaits it.

// Scan for a top-level `return` keyword — one that appears at paren/brace/
// bracket depth 0, ignoring strings, template literals, and comments. A
// `return` inside a nested function body (IIFE, arrow, etc.) is legal inside an
// expression wrap; only a statement-level return forces the block-body wrap in
// evaluateExpression.
export function hasTopLevelReturn(expression: string): boolean {
  let depth = 0;
  let i = 0;
  const n = expression.length;
  while (i < n) {
    const c = expression[i];
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < n) {
        const ch = expression[i];
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === quote) {
          i++;
          break;
        }
        // template literal ${...} — skip balanced
        if (quote === '`' && ch === '$' && expression[i + 1] === '{') {
          i += 2;
          let td = 1;
          while (i < n && td > 0) {
            const tc = expression[i];
            if (tc === '{') td++;
            else if (tc === '}') td--;
            i++;
          }
          continue;
        }
        i++;
      }
      continue;
    }
    if (c === '/' && expression[i + 1] === '/') {
      const nl = expression.indexOf('\n', i);
      if (nl < 0) break;
      i = nl + 1;
      continue;
    }
    if (c === '/' && expression[i + 1] === '*') {
      const end = expression.indexOf('*/', i + 2);
      if (end < 0) break;
      i = end + 2;
      continue;
    }
    if (c === '{' || c === '(' || c === '[') {
      depth++;
      i++;
      continue;
    }
    if (c === '}' || c === ')' || c === ']') {
      depth--;
      i++;
      continue;
    }
    if (depth === 0) {
      // Word-boundary check for the keyword.
      if (expression.slice(i, i + 6) === 'return') {
        const before: string = i === 0 ? ' ' : (expression[i - 1] ?? ' ');
        const after: string = expression[i + 6] ?? ' ';
        const isBoundary = (ch: string): boolean => !/[A-Za-z0-9_$]/.test(ch);
        if (isBoundary(before) && isBoundary(after)) return true;
      }
    }
    i++;
  }
  return false;
}

// Scan for a top-level statement keyword — declarations (`const`/`let`/
// `var`/`function`/`class`) or control-flow statements (`try`/`if`/`for`/
// `while`/`do`/`switch`/`throw`) at depth 0, ignoring strings, template
// literals, and comments. Any hit signals that the agent wrote a statement
// sequence rather than a value expression, so the wrapper must use block-body
// mode (wrap in an async IIFE) instead of expression-body mode
// (`Promise.resolve(expr)`). Without block-body, `try { … } catch { … }` and
// `const x = 1; x` become `Promise.resolve(try { … })` / `async () => (const x
// = 1; x)` — both SyntaxError. The LLM's natural pasted-into- Node-REPL shape
// must round-trip cleanly. See principles.md — "if the LLM keeps making the
// same mistake, the runtime is wrong."
export function hasTopLevelStatement(expression: string): boolean {
  let depth = 0;
  let i = 0;
  const n = expression.length;
  const keywords = [
    'const',
    'let',
    'var',
    'function',
    'class',
    'try',
    'if',
    'for',
    'while',
    'do',
    'switch',
    'throw',
  ];
  const isBoundary = (ch: string): boolean => !/[A-Za-z0-9_$]/.test(ch);
  while (i < n) {
    const c = expression[i];
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < n) {
        const ch = expression[i];
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === quote) {
          i++;
          break;
        }
        if (quote === '`' && ch === '$' && expression[i + 1] === '{') {
          i += 2;
          let td = 1;
          while (i < n && td > 0) {
            const tc = expression[i];
            if (tc === '{') td++;
            else if (tc === '}') td--;
            i++;
          }
          continue;
        }
        i++;
      }
      continue;
    }
    if (c === '/' && expression[i + 1] === '/') {
      const nl = expression.indexOf('\n', i);
      if (nl < 0) break;
      i = nl + 1;
      continue;
    }
    if (c === '/' && expression[i + 1] === '*') {
      const end = expression.indexOf('*/', i + 2);
      if (end < 0) break;
      i = end + 2;
      continue;
    }
    if (c === '{' || c === '(' || c === '[') {
      depth++;
      i++;
      continue;
    }
    if (c === '}' || c === ')' || c === ']') {
      depth--;
      i++;
      continue;
    }
    if (depth === 0) {
      for (const kw of keywords) {
        if (expression.slice(i, i + kw.length) === kw) {
          const before: string = i === 0 ? ' ' : (expression[i - 1] ?? ' ');
          const after: string = expression[i + kw.length] ?? ' ';
          if (isBoundary(before) && isBoundary(after)) return true;
        }
      }
    }
    i++;
  }
  return false;
}

// Scan for a top-level semicolon followed by more non-whitespace content. A
// separating `;` turns `a; b` into two statements — valid block-body, invalid
// expression-body (the expression-body wrap `Promise.resolve(a; b)` is a
// SyntaxError). A trailing semicolon with nothing after it is benign and stays
// expression-body.
//
// Uses the same string / template / comment / depth skipping shape as the
// sibling scanners above so the behavior (`;` inside strings, template
// substitutions, or parens like `for (i=0; i<n; i++)`) matches naturally.
export function hasTopLevelStatementSeparator(expression: string): boolean {
  let depth = 0;
  let i = 0;
  const n = expression.length;
  while (i < n) {
    const c = expression[i];
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < n) {
        const ch = expression[i];
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === quote) {
          i++;
          break;
        }
        if (quote === '`' && ch === '$' && expression[i + 1] === '{') {
          i += 2;
          let td = 1;
          while (i < n && td > 0) {
            const tc = expression[i];
            if (tc === '{') td++;
            else if (tc === '}') td--;
            i++;
          }
          continue;
        }
        i++;
      }
      continue;
    }
    if (c === '/' && expression[i + 1] === '/') {
      const nl = expression.indexOf('\n', i);
      if (nl < 0) break;
      i = nl + 1;
      continue;
    }
    if (c === '/' && expression[i + 1] === '*') {
      const end = expression.indexOf('*/', i + 2);
      if (end < 0) break;
      i = end + 2;
      continue;
    }
    if (c === '{' || c === '(' || c === '[') {
      depth++;
      i++;
      continue;
    }
    if (c === '}' || c === ')' || c === ']') {
      depth--;
      i++;
      continue;
    }
    if (depth === 0 && c === ';') {
      // Trailing semicolon with only whitespace / comments after it is benign —
      // the expression-body path handles `expr;` fine. A `;` with any
      // non-whitespace to follow is a separator, force block.
      for (let j = i + 1; j < n; j++) {
        const next = expression[j];
        if (next === ' ' || next === '\t' || next === '\n' || next === '\r') continue;
        return true;
      }
      return false;
    }
    i++;
  }
  return false;
}

// Combined block-body detector. True when the agent wrote a statement sequence
// (any of the top-level statement keywords OR a `;` separating top-level
// expressions) OR an explicit top-level `return`. Both the host driver
// (playwright.ts, docker/driver-server/index.js) and `wrapAgentExpression`
// below route through this single predicate so the two wrap paths stay in
// lock-step.
export function needsBlockBodyWrap(expression: string): boolean {
  return (
    hasTopLevelReturn(expression) ||
    hasTopLevelStatement(expression) ||
    hasTopLevelStatementSeparator(expression)
  );
}

export function wrapAgentExpression(expression: string): string {
  // Two wrap shapes. Expression-body (`Promise.resolve(e)`) is the fast path
  // for agents writing a value expression — ternary, IIFE, await-chain, or
  // plain identifier. Block-body (`(async () => { e })()`) kicks in when the
  // expression contains top-level statements or an explicit top-level `return`
  // — the agent wrote what Node REPL users would write, and needs to `return`
  // explicitly from the block. Every postprocess branch avoids any literal
  // `return` keyword because the driver's evaluateExpression regex-rejects it
  // in expression-body mode.
  const needsBlock = needsBlockBodyWrap(expression);
  const inner = needsBlock ? `(async () => { ${expression} })()` : `Promise.resolve(${expression})`;
  return (
    `(${inner}.then((__r) => (` +
    `__r instanceof ArrayBuffer` +
    ` ? Array.from(new Uint8Array(__r)).map((__b) => __b.toString(16).padStart(2, '0')).join('')` +
    ` : (ArrayBuffer.isView(__r)` +
    ` ? Array.from(new Uint8Array(__r.buffer, __r.byteOffset, __r.byteLength)).map((__b) => __b.toString(16).padStart(2, '0')).join('')` +
    ` : (typeof __r === 'string' || typeof __r === 'number' || typeof __r === 'boolean' || __r == null` +
    ` ? __r` +
    ` : JSON.parse(JSON.stringify(__r))))` +
    `)))`
  );
}

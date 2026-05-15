// Shared budget constants and helpers for keeping MCP tool results under the
// agent-runtime token cap. Every tool that can return a "big" value — a11y
// tree, attribute text, raw error — should cap its output using this module so
// we never hit the "result too large, saved to file" fallback that wastes
// rounds and confuses the agent.
//
// Design principle: default to a trimmed/summary shape that fits in budget,
// expose a detail-on-demand follow-up when the agent actually needs the full
// payload.

/**
 * Hard ceiling on any single tool result. The agent runtime ~25 KB / ~6k tokens
 * is the observed cap that triggers the "saved to file" fallback; we stay well
 * under it so multiple fields + JSON overhead don't push us over.
 */
export const MAX_TOOL_OUTPUT_CHARS = 20_000;

/**
 * Default trim budget for a11y trees returned by `start_session` and
 * `perform_action`. Large enough to cover most app pages completely, small
 * enough that combining it with a screenshot and structured fields stays inside
 * MAX_TOOL_OUTPUT_CHARS. On pages where the trimmed output is insufficient, the
 * agent calls `get_a11y_tree(session_id)` for the full unabridged tree via
 * pagination.
 */
export const DEFAULT_A11Y_BUDGET = 15_000;

/**
 * Tighter budget for healable-error responses in `execute`. The healable body
 * also carries `failed_step`, `screenshot` (base64 JPEG), and `remoteUrl`, so
 * the a11y tree has to share the output budget. 8 KB is enough context for most
 * single-selector drifts; full tree is always available via
 * `get_a11y_tree(session_id)` on the still-alive session.
 */
export const HEALABLE_A11Y_BUDGET = 8_000;

/** Cap on a single attribute value returned by `get_attribute`. */
export const ATTRIBUTE_VALUE_BUDGET = 10_000;

/**
 * Truncate a string to at most `max` characters, appending `suffix` so the
 * reader knows the tail was clipped. Safe when `max < suffix.length`: returns
 * the suffix-only. Used by any tool that needs "cap this value" semantics.
 */
export function truncateString(s: string, max: number, suffix = '…'): string {
  if (s.length <= max) return s;
  if (max <= suffix.length) return suffix.slice(0, max);
  return s.slice(0, max - suffix.length) + suffix;
}

interface SliceResult {
  /** The bounded slice — at most `length` chars starting at `offset`. */
  slice: string;
  /** Character count of the original string. */
  total_chars: number;
  /** True when `slice` doesn't cover the whole original string. */
  truncated: boolean;
  /** Inclusive start offset of the slice within the original string. */
  slice_start: number;
  /** Exclusive end offset; equals `total_chars` when the full string fits. */
  slice_end: number;
  /** Caller-composed pointer telling the agent how to fetch the next chunk.
   *  Only set when `truncated` is true. */
  hint?: string;
}

/**
 * Canonical "big string → budget-sized slice" helper. Every agent-facing tool
 * that can return a potentially-large single string routes through this:
 * `get_network_log({i, full:true})` for response bodies, `js_eval` for
 * arbitrary expression results, `evaluate_on_frame` for debugger closure
 * previews, `read_js_function` for function bodies, etc.
 *
 * Contract: - Clamps offset to [0, total_chars]. - Clamps length to [1,
 * defaultMaxLength || MAX_TOOL_OUTPUT_CHARS]. - Returns a truncation marker +
 * fields so the caller can tell a clipped slice apart from a genuinely short
 * value and tell the agent how to fetch the rest. - `hintFetchNext` is a
 * caller-supplied template — tool-specific continuation guidance (e.g. "fetch
 * next chunk with {i, full:true, body_offset:<N>}"). Callers compute it because
 * the parameter name of the offset differs per tool (body_offset / offset /
 * slice_from).
 *
 * Why a helper: observed failure 2026-04-19 — `get_network_log({i:1,
 * full:true})` emitted 1,021,635 chars, triggered MCP's "result saved to file"
 * fallback, cost the agent 5 rounds of workarounds. The shape (clamped
 * offset/length + truncation markers + next-chunk hint) generalizes; every
 * potentially-unbounded string return site should route through here.
 */
export function sliceLargeString(
  s: string | null | undefined,
  opts: {
    offset?: number;
    length?: number;
    defaultMaxLength?: number;
    hintFetchNext?: (sliceEnd: number, remaining: number) => string;
  } = {},
): SliceResult {
  const str = typeof s === 'string' ? s : '';
  const total = str.length;
  const defaultMax = Math.max(
    1,
    Math.min(opts.defaultMaxLength ?? MAX_TOOL_OUTPUT_CHARS, MAX_TOOL_OUTPUT_CHARS),
  );
  const offset = Math.max(0, Math.min(Math.floor(opts.offset ?? 0), total));
  const requestedLength = Math.floor(opts.length ?? defaultMax);
  const maxLength = Math.max(1, Math.min(requestedLength, defaultMax));
  const end = Math.min(total, offset + maxLength);
  const slice = str.slice(offset, end);
  const truncated = offset > 0 || end < total;
  const result: SliceResult = {
    slice,
    total_chars: total,
    truncated,
    slice_start: offset,
    slice_end: end,
  };
  if (truncated && opts.hintFetchNext) {
    result.hint = opts.hintFetchNext(end, Math.max(0, total - end));
  }
  return result;
}

/**
 * Wrap an arbitrary tool return value as a budget-safe `{result, result_*}`
 * shape. Thin facade over `sliceLargeString` that handles the surrounding shape
 * concerns every tool-result needs: scalars and short strings pass through
 * untouched, objects are JSON-serialized (circular refs surface as
 * `result_error`), values that fit the budget return raw so the agent sees the
 * untouched data, and oversized values route through `sliceLargeString` with
 * tool-specific continuation guidance.
 *
 * Callers: `js_eval`, `evaluate_on_frame` — every tool that returns an
 * agent-expression result whose size is genuinely unbounded.
 */
export function guardLargeResult(
  result: unknown,
  offset: number | undefined,
  length: number | undefined,
  toolName: string,
): Record<string, unknown> {
  if (
    result === null ||
    result === undefined ||
    typeof result === 'number' ||
    typeof result === 'boolean'
  ) {
    return { result };
  }
  if (typeof result === 'string' && result.length <= 500) {
    return { result };
  }
  let serialized: string;
  if (typeof result === 'string') {
    serialized = result;
  } else {
    try {
      serialized = JSON.stringify(result);
    } catch (e) {
      return {
        result: null,
        result_error: `could not serialize result: ${e instanceof Error ? e.message : String(e)}. The expression returned a value that resists JSON.stringify (circular reference, BigInt, function). Narrow the expression.`,
      };
    }
  }
  if (
    serialized.length <= MAX_TOOL_OUTPUT_CHARS - 2_000 &&
    offset === undefined &&
    length === undefined
  ) {
    return { result };
  }
  const sliced = sliceLargeString(serialized, {
    offset,
    length,
    hintFetchNext: (end, remaining) =>
      remaining > 0
        ? `result truncated at char ${end} of ${serialized.length}; ${remaining} chars remaining. Re-run ${toolName} with the same expression plus {result_offset: ${end}} to read the next chunk. Better: narrow the expression so the result fits — e.g., slice the string in the expression itself.`
        : `this slice starts at char ${offset ?? 0}`,
  });
  const out: Record<string, unknown> = {
    result: sliced.slice,
    result_is_serialized: true,
    result_total_chars: sliced.total_chars,
    result_slice_start: sliced.slice_start,
    result_slice_end: sliced.slice_end,
  };
  if (sliced.truncated) {
    out.result_truncated = true;
    if (sliced.hint) out.result_hint = sliced.hint;
  }
  return out;
}

/** Diagnostic record describing one truncation made by `enforceFinalBudget`. */
export interface BudgetTruncation {
  /** Dotted path to the truncated leaf within the tool result (e.g.
   *  `execute_result.body.original_body` or `a11yTree`). */
  path: string;
  /** Pre-truncation byte cost of the leaf (chars). */
  from: number;
  /** Post-truncation byte cost of the leaf (chars). */
  to: number;
}

export interface BudgetEnforced<T> {
  /** Possibly-mutated value. When `truncations` is non-empty this is a fresh
   *  deep-clone (via JSON round-trip), not the original — safe to mutate
   *  further at the call site without aliasing concerns. */
  value: T;
  /** One entry per leaf that was clipped; empty when the value fit untouched. */
  truncations: BudgetTruncation[];
}

/** Cap below which strings inside the budget walker are never touched. Below
 *  this, the leaf contributes too little to be worth shaving. */
const ENFORCE_STRING_LEAF_MIN = 1_000;

/** Threshold below which arrays inside the budget walker are never touched. */
const ENFORCE_ARRAY_LEAF_MIN = 50;

/** Hard cap on tree-walk depth, prevents pathological recursion on hostile
 *  shapes (`JSON.stringify` already rejects circular references). */
const ENFORCE_MAX_DEPTH = 16;

interface BudgetLeafCandidate {
  parent: Record<string, unknown> | unknown[];
  key: string | number;
  path: string;
  kind: 'string' | 'array';
  value: string | unknown[];
  size: number;
}

function dotJoin(parentPath: string, segment: string | number): string {
  if (parentPath.length === 0) return String(segment);
  if (typeof segment === 'number') return `${parentPath}[${segment}]`;
  return `${parentPath}.${segment}`;
}

function collectBudgetLeaves(
  node: unknown,
  parent: Record<string, unknown> | unknown[] | null,
  key: string | number | null,
  path: string,
  depth: number,
  out: BudgetLeafCandidate[],
): void {
  if (depth > ENFORCE_MAX_DEPTH) return;
  if (typeof node === 'string') {
    if (parent === null || key === null) return;
    if (node.length < ENFORCE_STRING_LEAF_MIN) return;
    out.push({ parent, key, path, kind: 'string', value: node, size: node.length });
    return;
  }
  if (Array.isArray(node)) {
    if (parent !== null && key !== null && node.length >= ENFORCE_ARRAY_LEAF_MIN) {
      const size = JSON.stringify(node).length;
      out.push({ parent, key, path, kind: 'array', value: node, size });
      // Don't descend into a large array's children — head-slicing the array
      // itself is the cheaper move and avoids per-entry mutation.
      return;
    }
    for (let i = 0; i < node.length; i++) {
      collectBudgetLeaves(node[i], node, i, dotJoin(path, i), depth + 1, out);
    }
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      collectBudgetLeaves(v, node as Record<string, unknown>, k, dotJoin(path, k), depth + 1, out);
    }
  }
}

/**
 * Last-resort transport-cap enforcement for a tool result. After all per-tool
 * smart compaction has run, this walker guarantees the serialized result stays
 * under `opts.ceiling` chars by greedy-truncating the largest leaves first.
 *
 * Strategy:
 *  1. Serialize once. If under ceiling, return the original value untouched
 *     with `truncations: []`.
 *  2. Deep-clone via JSON round-trip (the stringify is paid; parse is cheap).
 *  3. Collect string leaves ≥ 1 KB and array leaves ≥ 50 entries, sorted
 *     descending by size.
 *  4. Repeatedly clip the largest: strings via `truncateString` with a marker
 *     naming the dot-path; arrays head-sliced to a count proportional to the
 *     overshoot, with a `{__truncated, original_length, kept}` sentinel
 *     appended.
 *  5. Stop when the serialized clone fits.
 *
 * Returns a fresh value (not the input) when any truncation fires — the
 * caller's reference is never mutated. Aligns with principles.md §"Respect
 * the MCP output budget"; designed as the safety net layer behind per-tool
 * compaction, so a regression in the per-tool layer surfaces as a populated
 * `truncations[]` instead of an MCP transport rejection.
 */
export function enforceFinalBudget<T>(
  value: T,
  opts: { ceiling: number; toolName: string },
): BudgetEnforced<T> {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    // Circular / non-serializable — let the downstream JSON.stringify in the
    // formatter surface the failure. We can't measure or trim what won't
    // serialize.
    return { value, truncations: [] };
  }
  if (serialized.length <= opts.ceiling) {
    return { value, truncations: [] };
  }

  let clone: T;
  try {
    clone = JSON.parse(serialized) as T;
  } catch {
    return { value, truncations: [] };
  }

  const truncations: BudgetTruncation[] = [];
  let currentSize = serialized.length;
  // Leave a small buffer below the ceiling so the injected
  // `_runtime_oversize_warning` field (added by the caller) still fits.
  const safeCeiling = Math.max(1_000, opts.ceiling - 2_000);

  // Fixed-point loop: re-walk after every truncation so a previously-clipped
  // array's surviving entries become reachable as string leaves on the next
  // pass. Cap iterations to defend against pathological convergence on
  // hostile shapes; each iteration measurably shrinks the largest offender,
  // so 64 passes covers anything the runtime would ever emit in practice.
  for (let iter = 0; iter < 64; iter++) {
    if (currentSize <= safeCeiling) break;
    const leaves: BudgetLeafCandidate[] = [];
    collectBudgetLeaves(clone, null, null, '', 0, leaves);
    leaves.sort((a, b) => b.size - a.size);
    const leaf = leaves[0];
    if (!leaf) break;

    const overshoot = currentSize - safeCeiling;
    if (leaf.kind === 'string') {
      const before = (leaf.value as string).length;
      // Aim to free `overshoot + 10% buffer`; never shave below 200 chars so
      // the agent retains a usable preview.
      const target = Math.max(200, before - overshoot - Math.floor(opts.ceiling * 0.1));
      if (target >= before) break;
      const marker = `…<truncated path=${leaf.path}>`;
      const next = truncateString(leaf.value as string, target, marker);
      (leaf.parent as Record<string, unknown>)[leaf.key as never] = next;
      truncations.push({ path: leaf.path, from: before, to: next.length });
    } else {
      const arr = leaf.value as unknown[];
      const before = leaf.size;
      // Two-stage keep estimate. Stage 1: proportional to overshoot. Stage 2:
      // walk down from that estimate until the slice's own JSON fits the
      // target share. The walk handles the "array of huge entries" case
      // where proportional alone keeps the slice oversized.
      const ratio = Math.max(0.05, 1 - overshoot / before);
      let keep = Math.max(1, Math.min(arr.length, Math.floor(arr.length * ratio)));
      const targetSliceSize = Math.max(500, Math.floor(safeCeiling * 0.5));
      while (keep > 1 && JSON.stringify(arr.slice(0, keep)).length > targetSliceSize) {
        keep = Math.max(1, Math.floor(keep / 2));
      }
      const sliced: unknown[] = arr.slice(0, keep);
      sliced.push({ __truncated: true, original_length: arr.length, kept: keep });
      (leaf.parent as Record<string, unknown>)[leaf.key as never] = sliced;
      const after = JSON.stringify(sliced).length;
      truncations.push({ path: leaf.path, from: before, to: after });
    }
    currentSize = JSON.stringify(clone).length;
  }

  return { value: clone, truncations };
}

interface TrimmedA11yTree {
  /** The (possibly trimmed) tree text. Safe to inline in a tool result. */
  tree: string;
  /** Character count of the original tree before trimming. */
  total_chars: number;
  /** True if the tree was clipped; agent should call get_a11y_tree for full. */
  truncated: boolean;
}

/**
 * Trim an a11y tree to a character budget. Three-step strategy, each step only
 * runs if the previous one didn't fit:
 *
 * Step 1 — shorten long quoted values (content-bloat pages). On wikis,
 * articles, product descriptions, and long URLs, the fat lives in leaves:
 * `text: "...long paragraph..."`, `paragraph: "..."`, `/url: "..."`.
 * Regex-clips every `"..."` span over MAX_VALUE_CHARS to the first 100 chars +
 * ellipsis. Preserves the full structural skeleton (every role + short name)
 * since roles and short names are untouched.
 *
 * Step 2 — landmark-aware collapse (structure-bloat pages). On pages where the
 * tree is dominated by page chrome — huge nav menus, footer link columns,
 * cookie banners — we detect ARIA landmarks by their top-level role markers (`-
 * banner:`, `- navigation:`, `- main:`, `- complementary:`, `- contentinfo:`)
 * and apply a priority: - `main` is always preserved in full (that's where the
 * task element is) - `form`, `dialog`, `alertdialog` are preserved in full
 * (login flows, modals, confirmation prompts all live here) - `banner`,
 * `navigation`, `complementary`, `contentinfo` are capped at a fixed
 * per-landmark character budget, with a marker line telling the agent what was
 * omitted The collapse runs on the already-shortened tree from step 1 so both
 * effects compound.
 *
 * Step 3 — line-boundary tail cut (fallback). If the tree has no recognizable
 * landmarks (test pages, minimal SPAs, malformed dumps), fall back to a tail
 * cut with a marker pointing at `get_a11y_tree` for the rest. We never cut
 * inside a line — the a11y tree uses indentation to encode hierarchy, and
 * snapping mid-line breaks the indentation contract.
 */
export function trimA11yTree(tree: string, maxChars: number): TrimmedA11yTree {
  if (tree.length <= maxChars) {
    return { tree, total_chars: tree.length, truncated: false };
  }

  // Step 1: shorten long quoted values.
  const shortened = shortenLongQuotedValues(tree);
  if (shortened.length <= maxChars) {
    return { tree: shortened, total_chars: tree.length, truncated: true };
  }

  // Step 2: landmark-aware collapse of page chrome.
  const collapsed = collapseLandmarks(shortened, maxChars);
  if (collapsed && collapsed.length <= maxChars) {
    return { tree: collapsed, total_chars: tree.length, truncated: true };
  }

  // Step 3: fallback line-boundary tail cut.
  const markerText = (omitted: number, total: number): string =>
    `\n... [a11y tree truncated: ${omitted} of ${total} chars omitted; call get_a11y_tree(session_id) for the full tree]`;
  const base = collapsed ?? shortened;
  const budget = maxChars - markerText(0, tree.length).length - 20;
  const lines = base.split('\n');
  let out = '';
  for (const line of lines) {
    const nextLen = out.length + (out ? 1 : 0) + line.length;
    if (nextLen > budget) break;
    out += (out ? '\n' : '') + line;
  }
  const omitted = tree.length - out.length;
  return {
    tree: out + markerText(omitted, tree.length),
    total_chars: tree.length,
    truncated: true,
  };
}

/**
 * Max length of any double-quoted value kept verbatim. Playwright's
 * `ariaSnapshot()` emits roles, names, and textual leaves all as
 * `"..."`-wrapped strings; 120 is long enough for a realistic button label,
 * heading, or URL, and short enough that paragraph-sized text gets clipped.
 */
const MAX_VALUE_CHARS = 120;

/** Character class used in the quoted-string regex (non-backtracking). */
const QUOTED_STRING_REGEX = /"((?:[^"\\]|\\.)*)"/g;

/**
 * Replace every double-quoted span longer than MAX_VALUE_CHARS with a clipped
 * version ending in `…`. Preserves escape sequences inside the quote since we
 * match with a proper non-backtracking char class.
 */
function shortenLongQuotedValues(tree: string): string {
  return tree.replace(QUOTED_STRING_REGEX, (full, content) => {
    if (typeof content !== 'string' || content.length <= MAX_VALUE_CHARS) {
      return full;
    }
    return `"${content.slice(0, MAX_VALUE_CHARS - 1)}…"`;
  });
}

/** Landmark roles preserved at full fidelity — this is where the task lives. */
const PRESERVED_LANDMARKS = new Set(['main', 'form', 'dialog', 'alertdialog', 'search']);

/** Landmark roles collapsed to a per-landmark cap — chrome, not content. */
const COLLAPSIBLE_LANDMARKS = new Set([
  'banner',
  'navigation',
  'complementary',
  'contentinfo',
  'region',
]);

/** Budget for each collapsible landmark section, in characters. */
const COLLAPSIBLE_LANDMARK_BUDGET = 800;

/**
 * Walk a trimmed-or-raw tree and collapse chrome landmarks to a fixed
 * per-landmark budget, leaving `main`/`form`/`dialog` verbatim. Returns null if
 * no top-level landmarks were detected (agent should fall through to the
 * tail-cut path).
 *
 * Playwright's aria-snapshot format: - <role>[ "<name>"]: - <child> - <child> -
 * <other-role>
 *
 * We detect a landmark by `^(\s*)- (<role>)[ "name"]?:?$` on a line, then
 * extend to include all descendant lines (higher indent than the landmark
 * line). No full parser — indent-level matching is enough because a11y trees
 * are strictly nested by indent depth.
 */
function collapseLandmarks(tree: string, maxChars: number): string | null {
  const lines = tree.split('\n');
  interface Section {
    startLine: number;
    endLine: number; // exclusive
    indent: number;
    role: string;
    kind: 'preserve' | 'collapsible' | 'other';
  }
  const sections: Section[] = [];

  const landmarkLine = /^(\s*)- ([a-z]+)(?:\s+"[^"]*")?:?\s*$/;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const m = landmarkLine.exec(line);
    if (!m) {
      i += 1;
      continue;
    }
    const indent = (m[1] ?? '').length;
    const role = m[2] ?? '';
    let kind: Section['kind'] = 'other';
    if (PRESERVED_LANDMARKS.has(role)) {
      kind = 'preserve';
    } else if (COLLAPSIBLE_LANDMARKS.has(role)) {
      kind = 'collapsible';
    }
    if (kind === 'other') {
      i += 1;
      continue;
    }
    // Find the extent: all descendant lines with greater indent.
    let j = i + 1;
    while (j < lines.length) {
      const child = lines[j] ?? '';
      if (child.trim().length === 0) {
        j += 1;
        continue;
      }
      const childIndent = /^(\s*)/.exec(child)?.[1]?.length ?? 0;
      if (childIndent <= indent) break;
      j += 1;
    }
    sections.push({ startLine: i, endLine: j, indent, role, kind });
    i = j;
  }

  if (sections.length === 0) {
    return null;
  }

  // Rebuild the tree, collapsing collapsible sections to the per-landmark
  // budget. Preserved sections stay verbatim. Any text outside of detected
  // sections (stray leading / trailing lines) is kept as-is.
  const out: string[] = [];
  let cursor = 0;
  for (const s of sections) {
    // Everything before this section from the previous cursor position.
    out.push(...lines.slice(cursor, s.startLine));
    const sectionLines = lines.slice(s.startLine, s.endLine);
    if (s.kind === 'preserve') {
      out.push(...sectionLines);
    } else {
      const sectionText = sectionLines.join('\n');
      if (sectionText.length <= COLLAPSIBLE_LANDMARK_BUDGET) {
        out.push(...sectionLines);
      } else {
        // Keep the header line + indent-preserved initial content up to the
        // budget, then a marker line.
        let kept = 0;
        const keepLines: string[] = [];
        for (const ln of sectionLines) {
          if (kept + ln.length + 1 > COLLAPSIBLE_LANDMARK_BUDGET) break;
          keepLines.push(ln);
          kept += ln.length + 1;
        }
        const omitted = sectionText.length - kept;
        const indentStr = ' '.repeat(s.indent + 2);
        keepLines.push(
          `${indentStr}... [${s.role} collapsed: ${omitted} of ${sectionText.length} chars omitted — call get_a11y_tree(session_id) for the full tree]`,
        );
        out.push(...keepLines);
      }
    }
    cursor = s.endLine;
  }
  // Trailing lines after the last section.
  out.push(...lines.slice(cursor));

  const rebuilt = out.join('\n');
  // If we didn't actually save anything, signal no-op so the caller falls
  // through to the line-cut path.
  if (rebuilt.length >= tree.length) return null;
  if (rebuilt.length > maxChars) {
    // Landmark collapse alone wasn't enough — caller will tail-cut.
    return rebuilt;
  }
  return rebuilt;
}

export interface PaginatedA11yTree {
  tree: string;
  total_chars: number;
  page: number;
  page_size: number;
  total_pages: number;
  has_more: boolean;
}

/**
 * Page through an a11y tree in character-sized windows. Used by the
 * `get_a11y_tree` tool for cases where the trimmed tree in the tool-result
 * default path isn't enough and the agent needs the full unabridged view.
 *
 * page is 1-indexed; page_size caps at MAX_TOOL_OUTPUT_CHARS so a single page
 * always fits in one tool result.
 */
/**
 * Size-aware object-body trimmer — the canonical primitive for tools that
 * return structured response bodies whose upper bound is page-dependent (most
 * notably the `execute` tool's embedded network log). Mirrors the
 * `get_network_log {full: true}` pattern documented in principles.md §"Respect
 * the MCP output budget": compact by default when oversized, fully opt-in for
 * detail.
 *
 * The trim is NARROW — it drops the named large field only, leaving the rest of
 * the body unchanged. Allowlisting by-field would hide application-specific
 * success markers (`edit.result`, `receipt`, etc.) the caller needs to tell
 * success from failure.
 *
 * Modes:
 *   "smart"         — pass through if total fits `MAX_TOOL_OUTPUT_CHARS`;
 *                     drop `dropField` from the body if oversized.
 *   "force-compact" — drop `dropField` whenever present (used when the
 *                     body is embedded in an already-large outer
 *                     response that has less headroom).
 *   "full"          — no trim, caller opted into unabridged.
 *
 * When a field is dropped, an advisory string field is inserted at
 * `<dropField>_available` so the agent sees the follow-up tool call instead of
 * silently losing detail.
 */
export function trimOversizedObjectBody<T extends { body?: unknown }>(
  result: T,
  opts: {
    dropField: string;
    mode: 'smart' | 'force-compact' | 'full';
    availableHint: string;
  },
): T {
  if (opts.mode === 'full') return result;
  const body = result.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return result;
  const obj = body as Record<string, unknown>;
  if (!(opts.dropField in obj)) return result;

  let shouldTrim = opts.mode === 'force-compact';
  if (!shouldTrim && opts.mode === 'smart') {
    try {
      shouldTrim = JSON.stringify(result).length > MAX_TOOL_OUTPUT_CHARS;
    } catch {
      shouldTrim = true;
    }
  }
  if (!shouldTrim) return result;

  const trimmedBody: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === opts.dropField) continue;
    trimmedBody[k] = v;
  }
  trimmedBody[`${opts.dropField}_available`] = opts.availableHint;
  return { ...result, body: trimmedBody };
}

export function paginateA11yTree(
  tree: string,
  opts: { page?: number; page_size?: number } = {},
): PaginatedA11yTree {
  const pageSize = Math.min(
    Math.max(opts.page_size ?? DEFAULT_A11Y_BUDGET, 1_000),
    MAX_TOOL_OUTPUT_CHARS,
  );
  const totalChars = tree.length;
  const totalPages = Math.max(1, Math.ceil(totalChars / pageSize));
  const page = Math.min(Math.max(opts.page ?? 1, 1), totalPages);
  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  return {
    tree: tree.slice(start, end),
    total_chars: totalChars,
    page,
    page_size: pageSize,
    total_pages: totalPages,
    has_more: end < totalChars,
  };
}

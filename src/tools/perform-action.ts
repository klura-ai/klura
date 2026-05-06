import { randomBytes } from 'node:crypto';
import { pool } from '../runtime-state';
import { capturePageFingerprint } from '../strategies/page-fingerprint';
import { ensureAccumulator, ringPush, digestArgs } from '../strategies/discovery-artifact';
import { trimA11yTree, paginateA11yTree, DEFAULT_A11Y_BUDGET } from '../response/response-size';
import type { PaginatedA11yTree } from '../response/response-size';
import type { NetworkLogOptions, NetworkLogResponse } from '../drivers/types/network';
import { shapeNetworkLog } from '../response/network-log-shape';
import { WS_FRAMES_BUFFER_CAP_RE_MODE } from '../response/ws-pin';
import { classifyRequestShape } from '../response/lookup-classifier';
import {
  recordLookupCandidate,
  recordRawCapture,
  recordParamObservation,
} from '../response/session-observations';
import { correlateUiAction, CORRELATION_WINDOW_MS } from '../response/action-correlator';
import { asNonEmptyBoundedString, ValidationError } from '../validators';
import { captureAndAppendForms, enumerateStringParams } from './_internals';
import { graphConfig } from '../session-phase/registry';
import { maybeFireSurfaceChanged } from '../session-phase/surface-changed';
import type { CheckpointEnvelope } from '../checkpoints';

export interface ActionResult {
  a11yTree: string;
  a11y_total_chars: number;
  a11y_truncated: boolean;
  url: string;
  /**
   * Open sub-pages observed for this session at response time, in the order
   * they opened. Each entry is `{id, url, title?, openerId, openedAt,
   * closedAt?}`. A click that triggered a popup shows up here as a new entry;
   * the agent reads `id` to address the popup in subsequent calls
   * (`perform_action(..., page: 'popup-1')`). Closed popups stay in the list
   * with `closedAt` set so handle ids stay stable, but the agent should not
   * target them — the runtime will reject the call.
   *
   * Omitted from the response when no popup has ever been observed (the
   * common case), to keep the typical perform_action response unchanged.
   */
  subPages?: Array<{
    id: string;
    url: string;
    title?: string;
    openerId: string;
    openedAt: number;
    closedAt?: number;
  }>;
  /**
   * Pending-checkpoint envelope when the action's resulting navigation
   * crossed to a path-distinct surface that no triage plan covers.
   * The next tool call must echo `checkpoint_token` via `ack_checkpoint`
   * (gate framework). Resolution path: agent re-enters triage and submits
   * a defense-surface plan for the new surface.
   */
  _checkpoint?: CheckpointEnvelope;
}

/**
 * Resolve a `page` parameter against the session's tracked sub-pages. Returns
 * the canonical handle (`'main'` or a `popup-N` id) on success; throws an
 * `invalid_action` error citing the open handles when the requested handle is
 * unknown or already closed. Used by `performAction` (and other page-aware
 * tools) so the agent gets a single consistent rejection shape.
 */
export function resolvePageHandle(
  session: import('../drivers/types/session').Session,
  page?: string,
): string {
  if (page === undefined || page === '' || page === 'main') return 'main';
  const list = session.subPages ?? [];
  const entry = list.find((p) => p.id === page);
  if (!entry) {
    const openIds = list.filter((p) => !p.closedAt).map((p) => p.id);
    const known = openIds.length > 0 ? openIds.join(', ') : '<none open>';
    throw new Error(
      `invalid_action: unknown page handle ${JSON.stringify(page)}. ` +
        `Allowed: "main" (the page the session opened with) or one of [${known}]. ` +
        `Sub-page handles appear in tool responses as session.subPages[].id when a click ` +
        `or navigation opens a popup or new tab.`,
    );
  }
  if (entry.closedAt !== undefined) {
    throw new Error(
      `invalid_action: page handle ${JSON.stringify(page)} is closed (closedAt=${entry.closedAt}). ` +
        `Closed popups are kept in session.subPages so handle ids stay stable, but cannot be ` +
        `addressed. Pick another open page or "main".`,
    );
  }
  return entry.id;
}

// Mine candidate selectors from a Playwright ariaSnapshot string. The
// snapshot uses YAML-ish lines like `- searchbox "Search members by name"`
// or `- button "Submit"`; we extract role+name pairs (or bare roles) and
// rank by token overlap with the failed selector so the most relevant
// candidates float to the top. Returned in klura's a11y dialect so the
// agent can paste a hint line straight into the next perform_action call.
// Mutating action kinds that trigger the map-mode consent gate. Excludes
// read-only actions (navigate, scroll, wait) and the keyboard-shortcut
// surface (key_press fires after focus, doesn't directly select what changes
// — but it CAN submit a form via Enter, so it stays in). Mirrors the set in
// session-obligations.ts MUTATING_ACTIONS.
const MUTATING_MAP_GATE_ACTIONS = new Set(['click', 'type', 'fill_editor', 'key_press', 'select']);

// Plain text-shaped input types where typing only mutates local DOM state
// (the browser holds the value in memory until form submit). Excludes
// password (sensitive — keep the gate so the agent acknowledges intent),
// file (selecting a file is a real action), hidden (typing into hidden
// fields is an injection-shaped move), checkbox/radio (these flip state),
// and submit/image/button/reset (these aren't typed into anyway).
const SAFE_TEXT_INPUT_TYPES = new Set([
  'text',
  'search',
  'email',
  'url',
  'tel',
  'number',
  'date',
  'datetime-local',
  'time',
  'week',
  'month',
  'color',
  'range',
]);

// Decide whether a mutating action's HTML semantics make it structurally
// safe enough to skip the map-mode consent gate. Structural signals only
// (tag, input.type, form.method, href shape) — NOT name/text/aria patterns,
// which would re-introduce the brittle keyword matching the gate moved away
// from. When the driver can't introspect (returns null), default to gating
// (safer to ask than to silently mutate).
async function isStructurallySafeMapAction(
  driver: import('../drivers/interface').BrowserDriver,
  session: import('../drivers/types/session').Session,
  action: string,
  selector: string,
): Promise<boolean> {
  let target: Awaited<
    ReturnType<import('../drivers/interface').BrowserDriver['inspectActionTarget']>
  >;
  try {
    target = await driver.inspectActionTarget(session, selector);
  } catch {
    return false;
  }
  if (!target) return false;
  if (action === 'click') {
    if (target.submitLike) return false;
    if (target.formaction !== null) return false;
    // Disclosure toggles (aria-expanded / aria-controls / <summary>) flip
    // local UI state, never commit server state — exempt so map-mode agents
    // can expand sections without per-toggle acks. submitLike / formaction
    // guards above run first.
    if (target.isDisclosureToggle) return true;
    if (target.tag !== 'a') return false;
    if (target.onclick !== null) return false;
    const href = target.href;
    if (!href) return false;
    const hrefLower = href.trim().toLowerCase();
    if (hrefLower.startsWith('javascript:')) return false;
    return true;
  }
  if (action === 'type' || action === 'fill_editor') {
    // Typing only mutates local DOM state; the actual server-side mutation
    // happens at form submit, which fires through `click` on a submit-like
    // element (or `key_press: "Enter"`) — both of which gate separately.
    if (target.tag === 'textarea') return true;
    if (target.tag === 'input' && SAFE_TEXT_INPUT_TYPES.has(target.inputType)) return true;
    return false;
  }
  return false;
}

/**
 * When the supplied selector is neither valid CSS nor a klura a11y form,
 * playwright surfaces "is not a valid selector" inside a SyntaxError.
 * Agents have been inventing pseudo-shorthands like `link:Messenger`
 * thinking it's a klura dialect — this hint names the structural
 * mismatch and points at the closest valid form. Empty string when
 * the trace doesn't carry the pattern. Exported for unit tests.
 */
export function buildInvalidSelectorDialectHint(msg: string, selector: string): string {
  if (!/is not a valid selector/i.test(msg)) return '';
  return (
    `\n\nYour selector \`${selector}\` is not valid CSS AND not a klura a11y form. ` +
    `klura accepts two dialects:\n` +
    `  - **a11y role+name** (the canonical klura form): \`role "name"\` — e.g. \`button "Submit"\`, \`link "Messenger"\`, \`textbox "Search"\` (note the space and double-quotes around the name).\n` +
    `  - **a11y role+attr**: \`role[attr="value"]\` — e.g. \`searchbox[name="q"]\`, \`button[aria-label="Close"]\`.\n` +
    `  - **standard CSS**: same shapes you'd use in querySelector — \`button.primary\`, \`#login\`, \`[data-testid="submit"]\`.\n` +
    `If you wrote \`role:name\` or \`role-name\`, that's not valid in either dialect. Pick the role+name form (role + space + double-quoted name) from the closest-candidates list below.`
  );
}

/**
 * When playwright's click trace ends in "...from <X> subtree intercepts
 * pointer events", a page overlay is sitting on top of the target — a
 * cookie banner, modal, or fullscreen consent dialog. Returns a structural
 * hint naming the intercepting element and the dismiss-first move order;
 * empty string when the trace doesn't carry that pattern. Exported for
 * unit tests; also called inline by the click failure path.
 */
export function buildOverlayInterceptHint(msg: string): string {
  // The trace usually carries a closing tag + truncation between the opening
  // tag and the "subtree intercepts" marker (e.g. `<div class="overlay">…</div> subtree…`),
  // so allow arbitrary content (including newlines) between the captured tag
  // and the marker. Lazy match so we stop at the first marker, not the last.
  const m = /from\s+<([^>]+)>[\s\S]*?subtree intercepts pointer events/.exec(msg);
  if (!m) return '';
  const interceptor = m[1] ?? '<unknown overlay>';
  return (
    `\n\nA page overlay is intercepting clicks (intercepting element: \`<${interceptor}>\`). ` +
    `**Dismiss the overlay first** before retrying — this is NOT a "gate you cannot pass," it's a banner/modal sitting on top. Try in order:\n` +
    `  1. \`perform_action({action: "key_press", selector: "Escape"})\` — closes most modals.\n` +
    `  2. If Escape doesn't dismiss: scan the a11y tree for a Decline / Close / Reject / Got it / Allow button and click it.\n` +
    `  3. Then retry your original click.\n` +
    `\nDo NOT call \`start_remote_session\` for an overlay you can dismiss yourself — escalate only when the underlying interaction (login, captcha, 2FA) genuinely needs a human.`
  );
}

function mineSelectorCandidatesFromA11yTree(tree: string, failedSelector: string): string[] {
  const ROLE_TOKENS = new Set([
    'button',
    'textbox',
    'searchbox',
    'link',
    'checkbox',
    'radio',
    'combobox',
    'heading',
    'img',
    'tab',
    'switch',
    'slider',
    'spinbutton',
    'menuitem',
    'option',
    'dialog',
    'navigation',
    'main',
    'form',
    'list',
    'listitem',
    'table',
    'row',
    'cell',
    'menu',
    'tablist',
    'tabpanel',
    'tree',
    'treeitem',
    'group',
    'article',
    'log',
    'tooltip',
    'status',
  ]);
  const failedTokens = new Set(
    failedSelector
      .toLowerCase()
      .match(/[a-z0-9]+/g)
      ?.filter((t) => t.length >= 2) ?? [],
  );
  const candidates: { selector: string; score: number; order: number }[] = [];
  const seen = new Set<string>();
  let order = 0;
  for (const rawLine of tree.split('\n')) {
    const line = rawLine.replace(/^[\s-]+/, '').trim();
    if (!line) continue;
    const m = /^([a-z]+)(?:\s+"([^"]+)")?/.exec(line);
    if (!m || !m[1] || !ROLE_TOKENS.has(m[1])) continue;
    const role = m[1];
    const name = m[2];
    const sel = name ? `${role} "${name}"` : role;
    if (seen.has(sel)) continue;
    seen.add(sel);
    let score = 0;
    const candTokens = sel.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    for (const t of candTokens) if (failedTokens.has(t)) score += 1;
    candidates.push({ selector: sel, score, order: order++ });
  }
  candidates.sort((a, b) => b.score - a.score || a.order - b.order);
  return candidates.map((c) => c.selector);
}

export async function performAction(
  sessionId: string,
  action: string,
  selector: string,
  value?: string,
  opts: { returnTree?: boolean; replace?: boolean; page?: string } = {},
): Promise<ActionResult> {
  // Validate inputs through the centralized validator layer
  try {
    // Action must be a known string (validated against switch cases below)
    if (typeof action !== 'string' || action.length === 0) {
      throw new ValidationError('action', 'must be a non-empty string');
    }
    asNonEmptyBoundedString(selector, 'selector');
    if (value !== undefined) {
      asNonEmptyBoundedString(value, 'value');
    }
  } catch (e) {
    if (e instanceof ValidationError) {
      throw new Error(`invalid_action: ${e.message}`, { cause: e });
    }
    throw e;
  }
  const session = pool.getSession(sessionId);
  const driver = pool.driverFor(sessionId);
  // Resolve the optional `page` handle against `session.subPages` first so
  // an unknown popup id rejects with a clean shape error before the action
  // dispatch path runs. Default ('main') leaves all calls untouched.
  const pageHandle = resolvePageHandle(session, opts.page);
  const pageOpts = pageHandle === 'main' ? undefined : { page: pageHandle };

  // Fail-fast when the debugger is paused. Playwright locator ops need the main
  // thread; a paused-at-breakpoint page blocks every fill / click / type until
  // the 5s timeout fires, and the agent loops against that error instead of
  // realizing the pause is the cause. Surface the pause location + resolution
  // options in the error so the next tool call is evaluate_on_frame / resume /
  // remove_breakpoint rather than another doomed perform_action.
  const pause = driver.getDebuggerPauseState(session);
  if (pause) {
    let loc = '<unknown location>';
    if (pause.location) {
      const functionName = pause.location.function_name
        ? ` in ${pause.location.function_name}`
        : '';
      loc = `${pause.location.file}:${pause.location.line}${functionName}`;
    }
    const bps =
      pause.breakpoint_ids.length > 0 ? ` (breakpoint ${pause.breakpoint_ids.join(', ')})` : '';
    throw new Error(
      `debugger_paused: cannot perform_action while the main thread is paused at ${loc}${bps}. ` +
        `Inspect with get_frame_scope / evaluate_on_frame (these work while paused), then call resume or step to continue, ` +
        `or remove_breakpoint + resume to disarm before driving the page again.`,
    );
  }

  // Map-mode pre-action consent gate. Map-mode sessions are surface-discovery
  // — the agent should observe what a platform CAN do, not act on the user's
  // account. Once-per-session ack: the FIRST mutating perform_action raises
  // the consent prompt; on approve, the session flips `mapGateAcked = true`
  // and every subsequent mutating action admits without re-prompting. Single
  // commitment moment, no per-(action, selector) bookkeeping — the prior
  // shape produced ack-loops on sites with cookie banners + product clicks
  // + UI exploration where each new selector re-prompted.
  //
  // Mechanics: 4-char hex nonce when prompting. ack_checkpoint validates,
  // demands a non-empty user_response, flips the session bool. Cancel path:
  // ack_checkpoint({cancelled: true, reason}) — no flip; bool stays false
  // and the next mutating action prompts fresh.
  if (graphConfig(session).gateMutatingActions && MUTATING_MAP_GATE_ACTIONS.has(action)) {
    if (!session.pendingActionConsents) session.pendingActionConsents = new Map();
    if (
      session.mapGateAcked !== true &&
      !(await isStructurallySafeMapAction(driver, session, action, selector))
    ) {
      const nonce = randomBytes(2).toString('hex'); // 4 hex chars
      session.pendingActionConsents.set(nonce, { action, selector });
      const targetDescription =
        value && value.length > 0 && action !== 'click'
          ? `${action} ${JSON.stringify(value)} into ${JSON.stringify(selector)}`
          : `${action} on ${JSON.stringify(selector)}`;
      const lines: string[] = [];
      lines.push('invalid_action: action_consent_required');
      lines.push('');
      lines.push(
        `Map-mode requires a one-time consent before any mutating action this session. ` +
          `You're about to ${targetDescription}.`,
      );
      lines.push('');
      lines.push(
        "Map mode is for observing what a platform can do, not acting on the user's account. " +
          'Before acking, confirm this site is one you intend to map (no transactions, no account ' +
          "state changes, no sends on the user's behalf). The ack covers the WHOLE session — " +
          'subsequent clicks / types / submits will fire without re-prompting.',
      );
      lines.push('');
      lines.push('To approve and unlock the session for mapping:');
      lines.push('  ack_checkpoint({');
      lines.push(`    session_id: "${sessionId}",`);
      lines.push(`    checkpoint_token: "${nonce}",`);
      lines.push(
        '    user_response: "<one sentence: what you intend to map and why this is exploratory>"',
      );
      lines.push('  })');
      lines.push('');
      lines.push(
        "If this action would mutate state in a way you don't want to authorize, cancel: " +
          'ack_checkpoint({session_id, checkpoint_token, cancelled: true, reason: "<why>"}). ' +
          'The session-wide ack is NOT granted; the next mutating action will prompt again.',
      );
      throw new Error(lines.join('\n'));
    }
  }

  // Stamp the action's wall-clock time BEFORE dispatching — drivers await
  // navigation / settle inside click/type/etc, and captured XHRs land with
  // timestamps earlier than the driver call returns. If we stamped `at`
  // after await, every click→XHR correlation would see `click.at >
  // request.timestamp` and skip. Sampling before dispatch puts the click
  // timestamp strictly before any XHR it triggers.
  const actionAt = Date.now();
  let clickA11yName: string | null = null;
  // Wrap selector-based driver calls so a Playwright locator timeout
  // surfaces the actual a11y candidates on the page. Without this, weak
  // models loop on the same wrong selector — they have no signal to
  // self-correct beyond "Timeout 5000ms exceeded waiting for locator(...)".
  // Paired with a repeat-selector guard: re-issuing a recently-failed
  // (action, selector) is rejected before dispatch so a stuck model can't
  // burn a fresh 5s timeout per attempt.
  const REPEAT_SELECTOR_WINDOW_MS = 60_000;
  const REPEAT_SELECTOR_MAX_ENTRIES = 5;
  const recordFailedSelector = (): void => {
    if (!session.recentFailedSelectors) session.recentFailedSelectors = [];
    session.recentFailedSelectors.push({ action, selector, at: Date.now() });
    if (session.recentFailedSelectors.length > REPEAT_SELECTOR_MAX_ENTRIES) {
      session.recentFailedSelectors.splice(
        0,
        session.recentFailedSelectors.length - REPEAT_SELECTOR_MAX_ENTRIES,
      );
    }
  };
  const buildSelectorHint = async (): Promise<string> => {
    try {
      const tree = await driver.getAccessibilityTree(session, pageOpts);
      const candidates = mineSelectorCandidatesFromA11yTree(tree, selector);
      if (!candidates.length) return '';
      return (
        `\n\nselector ${JSON.stringify(selector)} matched nothing on this page. ` +
        `Closest a11y-tree candidates (use the role+name form directly):\n` +
        candidates
          .slice(0, 5)
          .map((c) => `  - ${c}`)
          .join('\n') +
        `\n\nklura selector dialects: a11y role syntax (\`textbox\`, \`button "Submit"\`), ` +
        `role+attr (\`searchbox[name="..."]\`), CSS, and \`:!nth(N)\` to disambiguate.`
      );
    } catch {
      return '';
    }
  };
  const SELECTOR_ACTIONS = new Set(['click', 'type', 'fill_editor', 'select']);
  if (SELECTOR_ACTIONS.has(action) && session.recentFailedSelectors?.length) {
    const now = Date.now();
    const dupe = session.recentFailedSelectors.find(
      (e) =>
        e.action === action && e.selector === selector && now - e.at < REPEAT_SELECTOR_WINDOW_MS,
    );
    if (dupe) {
      const hint = await buildSelectorHint();
      throw new Error(
        `repeat_failed_selector: ${action}(${JSON.stringify(selector)}) failed ` +
          `${Math.round((now - dupe.at) / 1000)}s ago and is being re-issued without change. ` +
          `Pick a different selector — re-issuing the same one will keep failing the same way.${hint}`,
      );
    }
  }
  const withSelectorHelp = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/Timeout.*exceeded|waiting for locator|is not a valid selector/i.test(msg)) throw err;
      recordFailedSelector();
      const dialectHint = buildInvalidSelectorDialectHint(msg, selector);
      const overlay = buildOverlayInterceptHint(msg);
      // Dialect mismatch is highest priority — fixes the root cause. Then
      // overlay-intercept (the click was valid but blocked). Otherwise fall
      // back to closest-candidates from the a11y tree.
      let hint: string;
      if (dialectHint) hint = dialectHint + (await buildSelectorHint());
      else if (overlay) hint = overlay;
      else hint = await buildSelectorHint();
      throw new Error(msg + hint, { cause: err });
    }
  };
  switch (action) {
    case 'navigate':
      // Top-level navigation always targets the main page — popups don't
      // navigate via this tool path; agents drive popup URL changes by
      // clicking links in the popup, not by replacing its document.
      await driver.navigate(session, selector);
      break;
    case 'click': {
      const clickResult = await withSelectorHelp(() => driver.click(session, selector, pageOpts));
      if (clickResult && typeof clickResult === 'object' && typeof clickResult.name === 'string') {
        clickA11yName = clickResult.name;
      }
      break;
    }
    case 'type':
      if (!value) throw new Error('type action requires a value');
      await withSelectorHelp(() =>
        driver.type(session, selector, value, {
          replace: opts.replace === true,
          ...(pageOpts ?? {}),
        }),
      );
      break;
    case 'fill_editor':
      if (!value) throw new Error('fill_editor action requires a value');
      await withSelectorHelp(() => driver.fillEditor(session, selector, value, pageOpts));
      break;
    case 'select':
      if (!value) throw new Error('select action requires a value');
      await withSelectorHelp(() => driver.select(session, selector, value, pageOpts));
      break;
    case 'mouse_click': {
      const mc = selector.split(',').map(Number);
      await driver.mouseClick(session, mc[0] ?? 0, mc[1] ?? 0, pageOpts);
      break;
    }
    case 'mouse_drag': {
      const from = selector.split(',').map(Number);
      const to = (value ?? '').split(',').map(Number);
      await driver.mouseDrag(session, from[0] ?? 0, from[1] ?? 0, to[0] ?? 0, to[1] ?? 0, pageOpts);
      break;
    }
    case 'key_press':
      // Shape guard — agents sometimes pass a CSS/a11y selector into the
      // `key` slot (e.g. `textbox[placeholder="Search"]` instead of
      // `Enter`). keyboard.press expects a keyboard name and presses on
      // whatever has focus — there is no target-element arg. Catch the
      // misuse with a concrete fix-path before Playwright throws a
      // cryptic "Unknown key" downstream.
      if (/[[\]=]/.test(selector) || /\s\s+/.test(selector)) {
        throw new Error(
          `key_press takes a keyboard name (e.g. "Enter", "Tab", "Escape", "Control+End") and fires on the currently-focused element — it has no target-element arg. You passed ${JSON.stringify(selector)}, which looks like a selector.\n\nIf you want to send a key to a specific field, use two steps:\n  1. perform_action({action: "click", selector: ${JSON.stringify(selector)}})   // focuses it\n  2. perform_action({action: "key_press", selector: "Enter"})    // presses on focused field\n\nOr if you meant to type text into it:\n  perform_action({action: "type", selector: ${JSON.stringify(selector)}, value: "<text>"})\n\nOr to just click it:\n  perform_action({action: "click", selector: ${JSON.stringify(selector)}})`,
        );
      }
      await driver.keyPress(session, selector, pageOpts);
      break;
    case 'scroll': {
      const sp = selector.split(',').map(Number);
      const sd = (value ?? '0,0').split(',').map(Number);
      await driver.scroll(session, sp[0] ?? 0, sp[1] ?? 0, sd[0] ?? 0, sd[1] ?? 0, pageOpts);
      break;
    }
    default:
      throw new Error(`Unknown action: ${action}`);
  }

  // Persist this action on the session so end_drive auto-synthesis can
  // replay it as a recorded-path step. Only record actions that map cleanly to
  // recorded-path steps — skip mouse-level primitives (mouse_click, mouse_drag,
  // scroll) which have no durable replay value on warm runs since they depend
  // on pixel coordinates.
  if (
    action === 'navigate' ||
    action === 'click' ||
    action === 'type' ||
    action === 'fill_editor' ||
    action === 'select' ||
    action === 'key_press'
  ) {
    if (!session.performActionHistory) session.performActionHistory = [];
    const record: import('../drivers/types/session').PerformActionRecord = {
      at: actionAt,
      action,
    };
    if (action === 'navigate') {
      record.url = selector;
    } else if (action === 'key_press') {
      record.key = selector;
    } else {
      record.selector = selector;
    }
    if (value !== undefined) record.value = value;
    // Stash the clicked element's accessible name on the record so the
    // action-correlator can surface a human-visible label when it pairs
    // this click with a subsequent XHR. Falls through to selector-string
    // when a11y-name resolution returned null.
    if (clickA11yName !== null) {
      record.locators = { name: clickA11yName };
    }
    session.performActionHistory.push(record);
    // Track whether the agent did real mutating work on the current
    // (path-tracked) surface. Drives the DRIVE-phase `surface_changed`
    // detection so the agent gets re-triaged ONLY when leaving a surface
    // they actually interacted with — pure landing→linked-page navigation
    // doesn't kick anyone into TRIAGE.
    if (action !== 'navigate' && MUTATING_MAP_GATE_ACTIONS.has(action)) {
      session.priorSurfaceHadMutation = true;
    }
  }

  // Short settle — action-event handlers that mutate the DOM (React state
  // flushes, click handlers that fire off an XHR, etc.) typically finish in
  // well under 200ms. The old 500ms default was a safety margin that cost ~10s
  // across a 20-round discovery flow. Most sites are fine on 150ms; tests still
  // pass, warm execute latency drops meaningfully.
  await driver.delay(session, 150);

  // a11y tree is typically 2-4s on heavy DOMs (Messenger, GitHub) — a
  // meaningful chunk of per-round latency when the agent's next call is going
  // to be `get_network_log` or `get_screenshot` anyway. Callers that know they
  // won't use the tree can pass `returnTree: false` to skip the tree read; url
  // is cheap and always returned.
  const currentUrl = await driver.getUrl(session, pageOpts).catch(() => '');

  // Surface-map: explicit navigate produces a dom_navigation event tagged
  // `via:'nav'`. Click-driven SPA route changes and form-submit navigations
  // are captured by `driver.consumePendingNavs` below — the playwright
  // driver listens on `framenavigated` and buffers main-frame URL changes
  // that weren't already attributed to an explicit `driver.navigate`.
  if (action === 'navigate') {
    if (!session.domNavigations) session.domNavigations = [];
    session.domNavigations.push({
      at: actionAt,
      url: currentUrl || selector,
      via: 'nav',
    });
  }

  // Drain the framenavigated buffer regardless of action — clicks, form
  // submits, and key_press(Enter) on a form all routinely trigger SPA route
  // changes that the explicit-navigate path doesn't see. Tag each entry
  // with a `via` derived from the action that triggered the surrounding
  // tool call so the url_graph edge attribution reflects what the agent
  // actually did.
  const pending = await driver.consumePendingNavs(session).catch(() => []);
  if (pending.length > 0) {
    if (!session.domNavigations) session.domNavigations = [];
    let derivedVia: 'click' | 'submit' | 'nav';
    if (action === 'click') {
      derivedVia = 'click';
    } else if (action === 'type' || action === 'key_press' || action === 'fill_editor') {
      derivedVia = 'submit';
    } else {
      derivedVia = 'nav';
    }
    for (const p of pending) {
      session.domNavigations.push({
        at: p.at,
        url: p.url,
        ...(p.title ? { title: p.title } : {}),
        via: p.via ?? derivedVia,
      });
    }
  }

  // Snapshot any <form> currently in the DOM. Per-action capture covers
  // SPA route changes that introduced new forms (modal open, navigation,
  // dynamic form injection). foldFormsIntoLogbook dedups at flush time
  // by (url, action, method).
  await captureAndAppendForms(session, driver);

  // Surface-changed checkpoint: when the page is now on a path-distinct
  // URL that no triage plan covers and the session is past triage entry,
  // fire the checkpoint so the agent re-enters triage and produces a
  // defense-surface read for the new surface. Only fires from lift /
  // triage; in drive there are no plans to be missing yet, and the agent
  // is still navigating into the goal. Always update lastSurfaceUrl so
  // future checks compare against the most recent visit.
  const surfaceCheckpoint = await maybeFireSurfaceChanged(session, currentUrl);

  // Snapshot of currently-tracked sub-pages, included on every response so
  // the agent sees popups appear and disappear without a separate list call.
  // Empty array elided so the typical (no-popup) response shape stays
  // unchanged.
  const subPagesSnapshot = (session.subPages ?? []).map((p) => ({ ...p }));
  const subPagesField = subPagesSnapshot.length > 0 ? { subPages: subPagesSnapshot } : {};
  const checkpointField = surfaceCheckpoint ? { _checkpoint: surfaceCheckpoint } : {};

  if (opts.returnTree === false) {
    return {
      a11yTree: '',
      a11y_total_chars: 0,
      a11y_truncated: false,
      url: currentUrl,
      ...subPagesField,
      ...checkpointField,
    };
  }
  const rawTree = await driver.getAccessibilityTree(session, pageOpts);
  const trimmed = trimA11yTree(rawTree, DEFAULT_A11Y_BUDGET);
  session.extractedContentBytes = (session.extractedContentBytes ?? 0) + trimmed.tree.length;

  // Stamp a structural page fingerprint on the just-pushed action record for
  // mutating actions. Runtime-internal drift detection: on warm replay the
  // recorded-path step loop compares this against a live re-capture and
  // aborts before the click fires if the page drifted (nag overlay, interstitial,
  // target form gone). See strategies/page-fingerprint.ts.
  if (
    (action === 'click' || action === 'type' || action === 'fill_editor' || action === 'select') &&
    session.performActionHistory &&
    session.performActionHistory.length > 0
  ) {
    const last = session.performActionHistory[session.performActionHistory.length - 1];
    if (last) {
      last.page_fingerprint = capturePageFingerprint(rawTree, currentUrl);
    }
  }
  return {
    a11yTree: trimmed.tree,
    a11y_total_chars: trimmed.total_chars,
    a11y_truncated: trimmed.truncated,
    url: currentUrl,
    ...subPagesField,
    ...checkpointField,
  };
}

/**
 * Fetch the full, untrimmed a11y tree for a live session. Use when the trimmed
 * tree returned by `start_session` / `perform_action` / a healable `execute`
 * error isn't enough to locate the element you need to interact with. Paginates
 * in character-sized windows; a single page is capped at the tool-output budget
 * so it always fits in one tool result.
 */
export async function getA11yTree(
  sessionId: string,
  opts: { page?: number; page_size?: number } = {},
): Promise<PaginatedA11yTree> {
  const session = pool.getSession(sessionId);
  const driver = pool.driverFor(sessionId);
  const rawTree = await driver.getAccessibilityTree(session);
  const paginated = paginateA11yTree(rawTree, opts);
  session.extractedContentBytes = (session.extractedContentBytes ?? 0) + paginated.tree.length;
  return paginated;
}

/**
 * Return the session's perform_action history with Unix-ms timestamps. Filter
 * by `since` / `until` to time-correlate actions with XHR timestamps from
 * `get_network_log` — e.g. "I clicked X at time T; which XHRs fired between T
 * and T+2s?" Compact response (no pagination); action histories are short
 * (10-30 entries typical).
 */
export function getActionHistory(
  sessionId: string,
  opts: { since?: number; until?: number } = {},
): {
  total: number;
  returned: number;
  actions: Array<{
    at: number;
    action: string;
    selector?: string;
    value?: string;
    key?: string;
    url?: string;
  }>;
} {
  const session = pool.getSession(sessionId);
  session.getActionHistoryCallCount = (session.getActionHistoryCallCount ?? 0) + 1;
  const history = session.performActionHistory ?? [];
  const { since, until } = opts;
  const filtered = history.filter((h) => {
    if (typeof since === 'number' && h.at < since) return false;
    if (typeof until === 'number' && h.at > until) return false;
    return true;
  });
  return {
    total: history.length,
    returned: filtered.length,
    actions: filtered.map((h) => ({
      at: h.at,
      action: h.action,
      ...(h.selector !== undefined ? { selector: h.selector } : {}),
      ...(h.value !== undefined ? { value: h.value } : {}),
      ...(h.key !== undefined ? { key: h.key } : {}),
      ...(h.url !== undefined ? { url: h.url } : {}),
    })),
  };
}

export async function getNetworkLog(
  sessionId: string,
  opts: NetworkLogOptions = {},
): Promise<NetworkLogResponse> {
  const session = pool.getSession(sessionId);
  const driver = pool.driverFor(sessionId);
  ringPush(ensureAccumulator(session).getNetworkLogCalls, {
    filter_digest: digestArgs({
      url_contains: opts.url_contains ?? '',
      text_contains: opts.text_contains ?? '',
      last: opts.last ?? 0,
      full: !!opts.full,
    }),
    full: !!opts.full,
    at: new Date().toISOString(),
  });
  const [raw, wsFrames] = await Promise.all([
    driver.getInterceptedRequests(session),
    driver.getInterceptedWebSocketFrames(session).catch(() => [] as never[]),
  ]);
  // Per-session try_generator counter snapshot — feeds the binary-WS advisory's
  // progress nudge so the agent sees their own iteration count (or lack of it)
  // narrated back at them inline.
  const stats =
    typeof pool.getTryGeneratorStats === 'function'
      ? (pool.getTryGeneratorStats(sessionId) as {
          total: number;
          with_verify_against: number;
          ok_true: number;
          verified_ok: number;
        } | null)
      : null;
  const roundCount =
    typeof pool.getSessionRoundCount === 'function'
      ? pool.getSessionRoundCount(sessionId)
      : undefined;

  // Passive lookup accumulation: classify each captured request as potentially
  // lookup-shaped and append matches to a per-session candidate pool.
  //
  // The save-time provenance guard queries this pool when the agent tries
  // to hardcode an opaque id — so even when the agent never consciously "does a
  // search" (contacts pinned, slug-URL navigation, etc.) the background
  // inbox/typeahead/GraphQL traffic that resolved slugs → ids is already
  // indexed.
  //
  // Classification is idempotent: re-classifying the same request_i replaces
  // the prior entry (see session-observations recordLookupCandidate).
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    if (!entry) continue;
    try {
      const candidate = classifyRequestShape(entry, { request_i: i });
      recordLookupCandidate(sessionId, candidate);
    } catch {
      // Classification is diagnostic — a single bad entry must not break the
      // caller's view of the network log.
    }
    // Mirror the raw response/post bytes into the per-session index used by the
    // save-time guard's exact-substring match. This is the ground-truth
    // fallback for responses the classifier can't parse (XSSI-prefixed JSON,
    // HTML, binary framing) — the literal the agent is trying to hardcode is
    // the filter.
    try {
      recordRawCapture(sessionId, {
        request_i: i,
        method: entry.method,
        url: entry.url,
        response_body: entry.responseBody,
        post_data: entry.postData,
      });
    } catch {
      // best-effort; a single oddly-shaped entry must not break anything
    }
    // Param-observation pipeline: for each short-string query/body param on
    // this captured request, correlate with the session's preceding UI click
    // (within 3 s) to extract the element's a11y-name as the "label" side of
    // the observation. Feeds the pre-save audit's enum-param consistency
    // check. Narrowly scoped: we record only what's observable. The audit
    // enforces *consistency* (declared observed_values ⊆ recorded) — runtime
    // never decides what IS an enum; the agent does via `kind: "enum"`.
    try {
      const history = session.performActionHistory ?? [];
      const ui = correlateUiAction(entry, history);
      if (process.env.KLURA_DEBUG_PARAM_OBS) {
        const lastAts = history
          .slice(-3)
          .map((h) => `${h.action}@${h.at}`)
          .join(',');
        const uiSummary = ui
          ? JSON.stringify({
              kind: ui.kind,
              text: ui.element_text.slice(0, 40),
              click_at: ui.action_at,
              req_at: ui.request_at,
            })
          : 'null';
        console.error(
          `[param-obs/hook] req.ts=${entry.timestamp} url=${entry.url} history.len=${history.length} history.lastAts=[${lastAts}] ui=${uiSummary}`,
        );
      }
      if (ui) {
        // Caller-input suppression: when a param's value was typed by the
        // agent into a field shortly before the click that fired this XHR,
        // it's free-form input the user authored (text body of a message,
        // form field) — NOT a value the click selected from a fixed set.
        // Recording it as a `ui_click` observation forces the audit's enum-
        // grounding rule to refuse `kind: "text"` because every observation
        // appears to be a click-bound value, even though the click on
        // "Send" is a submit button, not a value selector. The structural
        // signal — typed value matches captured param value — is crisp
        // enough to act on without prose matching. See
        // docs/principles.md §"Crisp vs fuzzy".
        const recentTypedValues = new Set<string>();
        const TYPED_LOOKBACK_MS = CORRELATION_WINDOW_MS;
        for (const rec of session.performActionHistory ?? []) {
          if (rec.action !== 'type' && rec.action !== 'fill_editor') continue;
          if (typeof rec.value !== 'string' || rec.value.length === 0) continue;
          if (rec.at >= ui.request_at) continue;
          if (ui.request_at - rec.at > TYPED_LOOKBACK_MS) continue;
          recentTypedValues.add(rec.value);
        }
        for (const [paramName, paramValue] of enumerateStringParams(entry)) {
          if (recentTypedValues.has(paramValue)) continue;
          recordParamObservation(sessionId, {
            param_name: paramName,
            value: paramValue,
            source: { kind: 'ui_click', label: ui.element_text, request_i: i },
            observed_at: ui.request_at,
          });
        }
      }
    } catch (e) {
      if (process.env.KLURA_DEBUG_PARAM_OBS)
        console.error(`[param-obs/hook] threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const result = shapeNetworkLog(raw, opts, wsFrames, stats, roundCount);
  // When a structural advisory surfaces (binary WS, signed body, etc.),
  // raise the per-session WS ring-buffer cap so subsequent RE probe sends
  // don't evict reference frames before the agent pins them. Prior caller:
  // close-time complexity probe (deleted); same defensive behavior wired
  // here so the cap raise happens at exploration time, not too late.
  if (result._advisory && (session.wsFramesCap ?? 0) < WS_FRAMES_BUFFER_CAP_RE_MODE) {
    session.wsFramesCap = WS_FRAMES_BUFFER_CAP_RE_MODE;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tool registry metadata
// ---------------------------------------------------------------------------

import { TOOL_NAMES } from '../vocab';
import type { ToolDef } from '../tool-types';

export const TOOL_DEFS: ToolDef[] = [
  {
    name: TOOL_NAMES.performAction,
    description:
      'Interact with the page. Per-action args:\n  - click: selector (CSS / a11y / role-name)\n  - type: selector + text (the string to type — APPENDS by default; pass replace:true to clear first)\n  - fill_editor: selector + text (contenteditable rich-text editors — Lexical/Slate/Draft/ProseMirror — where type fails on zero-height bounding boxes)\n  - select: selector + text (the <option>\'s value attribute)\n  - key_press: selector + text (the key, e.g. "Enter", "Escape", "ArrowDown")\n  - mouse_click: selector="x,y" (coordinates as a string)\n  - mouse_drag: selector="x,y" (start) + text="x,y" (end)\n  - scroll: selector="x,y" (anchor, optional) + text="deltaX,deltaY"\n  - navigate: selector=<url> (top-level page navigation)\n\n`text` is the canonical name for the string-to-send, matching the Claude-in-Chrome convention. `value` is accepted as a deprecated alias for `text` and produces an identical effect. Returns the updated accessibility tree (~2-4s on heavy DOMs); pass `return_tree: false` when the next tool call (get_network_log, get_screenshot, another perform_action) will supersede the tree anyway. Pass `page` to target a popup or `target=_blank` tab — `subPages[]` lists open handles.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        action: {
          type: 'string',
          enum: [
            'navigate',
            'click',
            'type',
            'select',
            'fill_editor',
            'mouse_click',
            'mouse_drag',
            'key_press',
            'scroll',
          ],
          description: 'Action to perform',
        },
        selector: {
          type: 'string',
          description:
            'CSS / a11y selector for click/type/fill_editor/select/key_press; coordinate pair "x,y" for mouse_click/mouse_drag/scroll; target URL for navigate.',
        },
        text: {
          type: 'string',
          description:
            'For type/fill_editor: the string to type. For select: the <option> value to pick. For key_press: the key name (e.g. "Enter"). For mouse_drag: end coordinate "x,y". For scroll: "deltaX,deltaY". Matches Claude-in-Chrome\'s convention. Either `text` or `value` works (text wins if both given).',
        },
        value: {
          type: 'string',
          description:
            'Deprecated alias for `text`. Same semantics. Kept for backwards compatibility; prefer `text`.',
        },
        return_tree: {
          type: 'boolean',
          description:
            'Default true. Set false when the next tool call is going to supersede the tree anyway (network log, screenshot, another interaction) — skips the ~2-4s a11y read.',
        },
        page: {
          type: 'string',
          description:
            'Page handle. Default "main" (the page the session opened with). Pass a popup id from session.subPages[].id (e.g. "popup-1") to act on a tracked popup or target=_blank tab. Unknown handles reject with a list of the currently-open ones.',
        },
      },
      required: ['session_id', 'action', 'selector'],
    },
    handler: (args: any) =>
      performAction(args.session_id, args.action, args.selector, args.text ?? args.value, {
        returnTree: args.return_tree !== false,
        replace: args.replace === true,
        page: args.page,
      }),
  },

  {
    name: TOOL_NAMES.getNetworkLog,
    description:
      'Captured network activity — **HTTP requests AND WebSocket frames** in one call. **For write-capability discovery, ALWAYS narrow with a filter on the first call** — do not scan the raw summary and then fetch {i, full: true} per entry, that is the slow anti-pattern. A narrowing filter auto-promotes HTTP entries to detail-lite mode (full request headers + full postData + 512-char responseBody preview per entry) AND surfaces matching WebSocket frames in the response\'s `wsFrames` field (url + direction + 512-char payload preview per frame). Three filter patterns, in order of specificity: (1) {text_contains: "<literal>"} — the best primitive when you know a string you just typed. Substring-searches URL + headers + postData + responseBody for HTTP AND payload for every captured WS frame; the request OR ws frame that carried or echoed your input is almost always the only match. **On realtime / chat sites the write is usually a sent WS frame, not an HTTP POST** — it appears in `wsFrames`, not `requests`. (2) {url_contains: "<path>"} — when the endpoint path is distinctive (e.g. /graphql, /api/orders). (3) {last: 20} — when neither of the above applies, tails the final entries of the session. Detail-lite auto-paginates when the narrowed set is larger than one response; walk pages with {page: N}. The other modes: unfiltered call → summary (one tiny object per HTTP request + the last 30 WS frame previews); {i: N, full: true} → a single verbatim HTTP entry; {ws_i: N, full: true} → a single untrimmed WS frame (use this to capture the exact payload bytes for a `protocol:"websocket"` strategy); {full: true} → paginated raw detail-list for HTTP, rarely needed.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        i: {
          type: 'number',
          description:
            'Absolute index into the HTTP requests array. With full:true returns one entry verbatim, bypassing filters and pagination.',
        },
        ws_i: {
          type: 'number',
          description:
            'Absolute index into the WebSocket frames array. With full:true returns one frame verbatim (untrimmed payload). Use after scanning the clipped wsFrames previews to capture the exact payload of a specific frame for a protocol:"websocket" strategy.',
        },
        full: {
          type: 'boolean',
          description:
            'Return raw entries with all headers and full bodies (no response-body clipping). With i: single HTTP entry. With ws_i: single untrimmed WS frame. Without either: paginated detail-list (default page_size 5, max 20). Suppresses detail-lite auto-promotion.',
        },
        url_contains: {
          type: 'string',
          description:
            'Case-insensitive URL substring filter — applies to both HTTP entries and WS frames. Triggers detail-lite auto-promotion when the filtered set fits the budget.',
        },
        text_contains: {
          type: 'string',
          description:
            "Case-insensitive substring search across every field (URL, header names + values, postData, responseBody) of each HTTP entry AND every captured WebSocket frame's payload. Use when you know a literal string the request carried or the response / ws frame echoed — e.g. the message you just sent. Combines with url_contains. Triggers detail-lite auto-promotion.",
        },
        last: {
          type: 'number',
          description:
            'Tail the last N entries after filters (applies independently to HTTP requests and WS frames). Use to narrow to the window right after a submit action — the send/post/order request OR the sent WS frame is almost always in the final few entries. Triggers detail-lite auto-promotion.',
        },
        page: {
          type: 'number',
          description:
            '1-indexed page number. Default 1. Explicit pagination suppresses detail-lite auto-promotion.',
        },
        page_size: {
          type: 'number',
          description:
            'Override default page size. Summary default 50 (max 200); detail-list default 5 (max 20). Explicit page_size suppresses detail-lite auto-promotion.',
        },
      },
      required: ['session_id'],
    },
    handler: (args: any) =>
      getNetworkLog(args.session_id, {
        i: args.i,
        ws_i: args.ws_i,
        full: args.full,
        url_contains: args.url_contains,
        text_contains: args.text_contains,
        last: args.last,
        page: args.page,
        page_size: args.page_size,
        body_offset: args.body_offset,
        body_length: args.body_length,
      }),
  },

  {
    name: TOOL_NAMES.getA11yTree,
    description:
      'Fetch the full, untrimmed accessibility tree for a live session, paginated. Use when the default trimmed tree from `start_session` / `perform_action` (or the healable-error body from `execute`) came back with `a11y_truncated: true` and you need to see the rest of the page to pick a selector. Response shape: `{tree, total_chars, page, page_size, total_pages, has_more}`. Most discovery turns do NOT need this — the trimmed defaults cover the top ~15 KB of the tree, which is enough for nearly every real-world page. Reach for this tool only when you have evidence the element you want is outside the trimmed window (e.g. deeply nested content, very long lists).',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        page: {
          type: 'number',
          description: '1-indexed page number. Default 1. Follow has_more to walk the whole tree.',
        },
        page_size: {
          type: 'number',
          description: 'Characters per page. Default 15000. Max 20000 (the tool-output budget).',
        },
      },
      required: ['session_id'],
    },
    handler: (args: any) =>
      getA11yTree(args.session_id, { page: args.page, page_size: args.page_size }),
  },

  {
    name: TOOL_NAMES.getActionHistory,
    description:
      'Return the session\'s timestamped perform_action history. Each entry carries `at` (Unix ms), `action`, and whichever of `selector` / `value` / `key` / `url` apply. Filter with `since` / `until` to time-correlate against XHR timestamps from `get_network_log` — e.g. "I clicked X at time T; which XHR fired between T and T+2s was the data load for that click?" Compact response; no pagination needed (histories are typically 10-30 entries). Primary use case: at end_drive review time, when you need to figure out which captured request carried the data you reported to the user, scan action history for the last click/navigate + use that timestamp as a floor on `get_network_log` to narrow the candidate window.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        since: {
          type: 'number',
          description:
            'Unix-ms floor — include only actions at or after this timestamp. Default: no floor.',
        },
        until: {
          type: 'number',
          description:
            'Unix-ms ceiling — include only actions at or before this timestamp. Default: no ceiling.',
        },
      },
      required: ['session_id'],
    },
    handler: (args: any) =>
      getActionHistory(args.session_id, { since: args.since, until: args.until }),
  },
];

// Save-time DOM probe for prereqs declared on a strategy.
//
// When save_strategy is called with a strategy that has any probable prereq
// (page-extract, fetch-extract, js-eval, recorded-path steps, fetch with
// response.format='html', or wsOpen.steps), this module spins up a real
// browser session, navigates / fires the request, and rejects the save if
// anything fails to resolve. Catches the "agent invented a selector that
// doesn't exist" hallucination at save time, before the strategy can land in
// the skill corpus and silently fail at execute time.
//
// The probe is cheap because: 1. We only run read-only checks 2. We never
// click submit buttons, fire mutating fetches, or POST anything 3. We reuse
// the platform's saved storage state so authenticated pages work 4. We close
// the session immediately after probing
//
// Underlies the "LLMs hallucinate selectors" guard — the probe verifies that
// every selector the LLM emitted actually resolves on the live page before the
// save is accepted.

import * as skills from '../skills';
import type { BrowserPool } from '../../drivers/types/session';
import { collectParamExamples } from '../probe-helpers';
import { extractPageExtractPrereqs, probeOnePrereq, probeOnePrereqFromNode } from './page-extract';
import { extractFetchExtractPrereqs, probeOneFetchPrereq } from './fetch';
import { extractJsEvalPrereqs, probeOneJsEvalPrereq } from './js-eval';
import {
  extractFetchHtmlExtracts,
  probeOneFetchHtml,
  resolveFetchHtmlExtracts,
} from './fetch-html';
import {
  extractRecordedPathSteps,
  extractWsOpenSteps,
  probeRecordedPathSteps,
} from './recorded-path';
import { resolveTemplate } from '../probe-helpers';
import { extractInvalidStrategyMessage } from './errors';

export { isTransientNavigationError } from './errors';

interface ProbeArgs {
  data: Record<string, unknown>;
  platform: string;
  pool: BrowserPool;
}

/**
 * Probe a strategy against a real browser in read-only mode. Throws
 * `invalid_strategy: ...` with the failing selector if anything doesn't
 * resolve. No-op when there's nothing probe-able.
 *
 * Covers three cases: 1. fetch page-extract prereqs — navigate + read each
 * var's selector 2. fetch fetch-extract prereqs — fire a GET (only GET, for
 * safety) with credentials:omit and verify 2xx + every dot-path resolves in the
 * response body. Catches the "agent saved a public-REST lookup against a
 * private resource" class (HTTP 404) and the "agent invented a dot-path that
 * doesn't match the response shape" class 3. recorded-path steps — execute
 * navigate/wait (read-only), verify the first mutating click/type/select
 * selector via waitForSelector, then stop (subsequent steps depend on state
 * changes we deliberately skip)
 */
export async function probeStrategySelectors({ data, platform, pool }: ProbeArgs): Promise<void> {
  const prereqs = extractPageExtractPrereqs(data);
  const fetchPrereqs = extractFetchExtractPrereqs(data);
  const jsEvalPrereqs = extractJsEvalPrereqs(data);
  const recordedSteps = extractRecordedPathSteps(data);
  const fetchHtmlExtracts = extractFetchHtmlExtracts(data);
  const wsOpenSteps = extractWsOpenSteps(data);

  if (
    prereqs.length === 0 &&
    fetchPrereqs.length === 0 &&
    jsEvalPrereqs.length === 0 &&
    recordedSteps.length === 0 &&
    fetchHtmlExtracts.length === 0 &&
    wsOpenSteps.length === 0
  ) {
    return;
  }

  // Pre-resolve {{template}} placeholders using notes.params example values. If
  // a placeholder has no example, refuse the probe with a message telling the
  // agent to add one — better than silently skipping.
  const examples = collectParamExamples(data);
  const resolvedPrereqs = prereqs.map((p) => ({
    name: p.name,
    url: resolveTemplate(p.url, examples, `prerequisite "${p.name}".url`),
    vars: p.vars,
  }));
  const resolvedFetchPrereqs = fetchPrereqs.map((p) => ({
    ...p,
    url: resolveTemplate(p.url, examples, `prerequisite "${p.name}".url`),
  }));
  const resolvedFetchHtml = resolveFetchHtmlExtracts(fetchHtmlExtracts, examples);
  const resolvedJsEval = jsEvalPrereqs.map((p) => ({
    ...p,
    url: resolveTemplate(p.url, examples, `prerequisite "${p.name}".url`),
  }));

  // Spin up a real session. Use the platform's saved storage state so the probe
  // can navigate to authenticated pages — the agent has typically already
  // logged in via remote viewer earlier in the same discovery flow. `internal:
  // true` bypasses the pool's maxSessions cap so the probe doesn't get blocked
  // by the agent's active session count during discovery — save_strategy
  // validation is housekeeping, not user work.
  const storageStatePath = skills.loadStorageStatePath(platform);
  const session = await pool.createSession({
    internal: true,
    platform,
    ...(storageStatePath ? { storageState: storageStatePath } : {}),
  });

  // Accumulator for whether every page-extract prereq also resolves via the
  // pure-Node path (fetch + cheerio). If yes, the strategy stays on the `fetch`
  // tier — the Node execute path will work without a browser. If any single
  // prereq needs the DOM (value is generated by JS, selector only matches after
  // hydration, etc.), the whole strategy is demoted to `page-script` because
  // the fast path would fail on that prereq.
  //
  // Starts optimistic. Only flips to false on a real signal — missing prereqs
  // entirely means the strategy is trivially Node-compatible.
  let allPrereqsNodeCompatible = true;
  let nodeIncompatReason = '';
  const probeWarnings: string[] = [];
  // Batch prereq probe failures so the agent sees every broken prereq in a
  // single rejection instead of fix-one-retry-find-next. Each entry is a
  // single-prereq failure message; the outer aggregator formats them in the
  // canonical "N issues — fix all before retrying" shape.
  const prereqFailures: string[] = [];

  try {
    const driver = pool.driverFor(session.id);
    for (const prereq of resolvedPrereqs) {
      try {
        const skipNodeCheck = await probeOnePrereq(driver, session, prereq, probeWarnings);
        // Browser probe passed (or login-wall soft-warn skipped selectors). If
        // the page-extract probe was skipped due to a login wall, skip the
        // Node-path probe too — the page selectors didn't actually run, so we
        // have no signal about whether Node would handle them.
        if (allPrereqsNodeCompatible && !skipNodeCheck) {
          const nodeCheck = await probeOnePrereqFromNode(prereq, platform);
          if (!nodeCheck.ok) {
            allPrereqsNodeCompatible = false;
            nodeIncompatReason = nodeCheck.reason;
          }
        }
      } catch (err) {
        prereqFailures.push(extractInvalidStrategyMessage(err));
      }
    }
    for (const prereq of resolvedFetchPrereqs) {
      try {
        await probeOneFetchPrereq(driver, session, prereq);
        // fetch-extract is always Node-compatible in principle (it's a JSON fetch
        // under the hood and Node's built-in fetch handles it natively), so the
        // browser probe is sufficient — no parallel Node check needed.
      } catch (err) {
        prereqFailures.push(extractInvalidStrategyMessage(err));
      }
    }
    for (const fetchHtml of resolvedFetchHtml) {
      try {
        await probeOneFetchHtml(driver, session, fetchHtml, probeWarnings);
        // fetch HTML response extraction already uses extractFromHtml (cheerio)
        // in the execute path, so the browser probe validates the same code that
        // runs on warm execute. No parallel check needed.
      } catch (err) {
        prereqFailures.push(extractInvalidStrategyMessage(err));
      }
    }
    for (const jsEval of resolvedJsEval) {
      try {
        await probeOneJsEvalPrereq(driver, session, jsEval, probeWarnings);
      } catch (err) {
        prereqFailures.push(extractInvalidStrategyMessage(err));
      }
      // js-eval prereqs run inside a live page, so they're browser-only by
      // definition. Any js-eval prereq flips the strategy to browser transport.
      allPrereqsNodeCompatible = false;
      nodeIncompatReason = `prerequisite "${jsEval.name}" uses kind: "js-eval" which needs a live page context`;
    }
    if (recordedSteps.length > 0) {
      // Recorded-path step selectors are NOT probed at save time. The probe
      // navigates fresh to steps[0].url and then tries step[1]'s click
      // selector, but hydrated SPAs render loading stubs first and the sidebar
      // isn't in the DOM within the probe's 3s timeout. The false- positive
      // "selector didn't resolve" rejection sends agents into selector-variant
      // retry loops on page-state mismatches. Recorded-path has its own
      // warm-time healing (multi-locator fallback through alternatives[], then
      // agent-driven patch_step on all-fail escalation) which is the right line
      // of defense. Every other recorded-path save guard still runs:
      // URL-observed check, pre-save audit, locator shape validation, and
      // the recorded-path-over-binary-WS guard.
      allPrereqsNodeCompatible = false;
      nodeIncompatReason = 'recorded-path steps require a browser';
    }
    if (wsOpenSteps.length > 0) {
      // Navigate to baseUrl first so the wsOpen steps have the right page
      // context to probe against. baseUrl is required on ws strategies (schema
      // enforces), so this is always safe.
      const baseUrl = typeof data.baseUrl === 'string' ? data.baseUrl : '';
      if (baseUrl) {
        try {
          await driver.navigate(session, baseUrl, { waitUntil: 'domcontentloaded' });
        } catch (err) {
          throw new Error(
            `invalid_strategy: wsOpen.steps save-time probe — could not navigate to baseUrl ${baseUrl}: ${
              err instanceof Error ? err.message : String(err)
            }`,
            { cause: err },
          );
        }
      }
      await probeRecordedPathSteps(driver, session, wsOpenSteps, examples);
      // ws + wsOpen.steps is browser-only by construction.
      allPrereqsNodeCompatible = false;
      nodeIncompatReason = 'wsOpen.steps requires a browser';
    }
  } finally {
    await pool.closeSession(session.id);
  }

  // Batched prereq failures — if any individual prereq probe threw, we
  // collected the message instead of rethrowing so every failing prereq
  // surfaces in one rejection. Canonical "N issues" shape matches the
  // shape-validator's output so the agent fixes them all before the next
  // save_strategy call.
  if (prereqFailures.length > 0) {
    const trailer = '\n\nSee klura://reference#capability-prereq.';
    if (prereqFailures.length === 1) {
      throw new Error(`${prereqFailures[0]}${trailer}`);
    }
    const header = `invalid_strategy: ${prereqFailures.length} prereq probe failures — fix all before retrying`;
    throw new Error([header, ...prereqFailures.map((m) => `  - ${m}`)].join('\n') + trailer);
  }

  // Stamp probe warnings on runtime_meta. These accumulate when the probe ran
  // but had to soft-warn on a login-wall redirect (selectors couldn't be
  // verified because the page bounced to /login). The save still goes through
  // — the alternative was a hard reject that cost an entire discovery run when
  // the cached storage-state was just slightly stale.
  if (probeWarnings.length > 0) {
    const meta = (data.runtime_meta as Record<string, unknown> | undefined) ?? {};
    meta.probe_warnings = probeWarnings;
    data.runtime_meta = meta;
  }

  // If the agent saved `fetch` but the probe found a prereq that can't run from
  // Node (JS-hydrated value, WebSocket-protocol call, or a selector that only
  // resolves in a live browser), demote the tier to `page-script`. The
  // environment is baked into the tier name, so this is how the save-time probe
  // propagates its "needs the page" finding into the saved shape. `page-script`
  // stays as-is.
  const tier = typeof data.strategy === 'string' ? data.strategy : null;
  if (tier === 'fetch') {
    const needsBrowser = data.protocol === 'websocket' || !allPrereqsNodeCompatible;
    if (needsBrowser) {
      data.strategy = 'page-script';
      if (nodeIncompatReason) {
        const meta = (data.runtime_meta as Record<string, unknown> | undefined) ?? {};
        meta.tier_demote_reason = nodeIncompatReason;
        data.runtime_meta = meta;
      }
    }
  }
}

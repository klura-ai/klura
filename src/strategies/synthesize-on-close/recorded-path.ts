// Recorded-path synthesis: replays the session's perform_action history as a
// recorded-path strategy, giving every declared capability a durable UI-flow
// fallback when no fetch / page-script capture-join landed.

import * as skills from '../skills';
import { assignAutoStepIds } from '../auto-step-id';
import type { Session, PerformActionRecord } from '../../drivers/types/session';
import { findLastIndex, pickDiscoveredFromUrl } from './helpers';
import { attachSaveWarningsToStrategy, detectTypedTextDrift } from './literals';
import { parseSnapshotSelector } from '../../execution/snapshot-selector';
import type { AutoSynthResult, SaveMarker, SynthDiagnosticEntry } from './types';

export function synthesizeRecordedPaths(
  session: Session,
  platform: string,
  saves: SaveMarker[],
  diag: SynthDiagnosticEntry[],
): AutoSynthResult[] {
  const history = session.performActionHistory ?? [];
  if (history.length === 0) return [];

  const out: AutoSynthResult[] = [];

  // Partition the history by save timestamp: a capability's flow is the actions
  // between the previous save and the current save. For the first save, the
  // window is the session start → first save.
  let windowStart = 0; // index into history
  for (let i = 0; i < saves.length; i += 1) {
    const save = saves[i];
    if (!save) continue;
    const endAt = save.at;
    // Find the history slice: all actions with `at <= endAt` that haven't been
    // consumed by an earlier window.
    let windowEnd = windowStart;
    while (windowEnd < history.length && (history[windowEnd]?.at ?? Infinity) <= endAt) {
      windowEnd += 1;
    }
    const slice = history.slice(windowStart, windowEnd);
    windowStart = windowEnd;

    // Skip if the agent already saved a recorded-path for this capability
    // (explicit save wins).
    const existing = skills.loadStrategies(platform, save.capability);
    if (existing.some((s) => s.strategy === 'recorded-path')) {
      diag.push({
        pass: 'synth_recorded',
        capability: save.capability,
        phase: 'skip',
        outcome: 'existing_recorded_path',
      });
      continue;
    }
    // Skip if a higher-tier strategy (fetch or page-script) already exists
    // for this capability. Recorded-path synthesized from discovery-time
    // clicks doesn't parameterize for later caller args: the click selectors
    // are frozen at whatever the discoverer clicked on, and warm-execute's
    // cascade silently falls through to this replay when page-script fails,
    // producing ok:true on a page-local flow that has nothing to do with
    // the current caller's arguments. Cleaner: strategy fails fast with
    // needs_rediscovery than masks the failure with a broken replay.
    const higherTier = existing.find((s) => s.strategy === 'fetch' || s.strategy === 'page-script');
    if (higherTier) {
      diag.push({
        pass: 'synth_recorded',
        capability: save.capability,
        phase: 'skip',
        outcome: 'higher_tier_saved',
        detail: { existing_tier: higherTier.strategy },
      });
      continue;
    }

    // Two shapes of flow are worth synthesizing as recorded-path:
    //
    //   (a) WRITE-shaped — type/fill followed by a click/key_press confirm.
    //       The classic form-submit, send-message, post-comment pattern.
    //       Needs the type step to template the caller's literal and the
    //       confirm to commit the action.
    //
    //   (b) READ-shaped navigation — no typing, but the session visited a
    //       URL that contains one of the caller's declared arg literals
    //       (e.g. start_session at https://x.com/emmawatson with
    //       args.username="emmawatson"). Warm execute needs only a
    //       templated navigate step; the agent's "read the page" is
    //       implicit in execute's a11y/DOM return.
    //
    // Anything else (pure click-chains with no typing and no templatable nav,
    // or type steps with no confirm) is too ambiguous to synthesize.
    const hasType = slice.some((a) => a.action === 'type' || a.action === 'fill_editor');
    const lastTypeIdx = findLastIndex(
      slice,
      (a) => a.action === 'type' || a.action === 'fill_editor',
    );
    const hasConfirmAfterType =
      lastTypeIdx >= 0 &&
      slice.slice(lastTypeIdx + 1).some((a) => a.action === 'click' || a.action === 'key_press');

    const declaredArgs = save.args ?? {};
    const lastVisitedForScan = (session.visitedUrls ?? [])
      .filter((u) => u && u !== 'about:blank')
      .at(-1);
    // Read-shape qualifies when a visited URL contains ≥ 4-char arg literal.
    // The 4-char floor matches detectEntityPinnedPrereqUrls's sensitivity —
    // short literals false-positive too easily.
    const navLiteralMatch = (() => {
      if (!lastVisitedForScan) return null;
      for (const [name, value] of Object.entries(declaredArgs)) {
        if (typeof value !== 'string' || value.length < 4) continue;
        if (lastVisitedForScan.includes(value)) return { name, value };
      }
      return null;
    })();
    const isWriteFlow = hasType && hasConfirmAfterType;
    const isReadNavFlow = !hasType && !!navLiteralMatch;
    if (!isWriteFlow && !isReadNavFlow) {
      diag.push({
        pass: 'synth_recorded',
        capability: save.capability,
        phase: 'skip',
        outcome: 'no_type_or_confirm_in_window',
        detail: {
          slice_len: slice.length,
          hasType,
          hasConfirmAfterType,
          lastVisitedForScan: lastVisitedForScan ?? null,
          navLiteralMatch,
        },
      });
      continue;
    }

    // Build steps. Params for template substitution come from the capability's
    // primary saved strategy (so we can swap the typed literal value back to a
    // {{param}} placeholder when possible). For read-nav flows (no prior save,
    // templating from declared args directly) we seed paramExamples with the
    // matched arg before buildStepsFromHistory runs — so the navigate-prepend
    // URL gets templated too.
    const primary = existing[0];
    const paramExamples = collectParamExamples(primary);
    // Seed from declared args too — `primary` is undefined when the agent
    // declared via start_session({capability, args}) without an explicit
    // save_strategy, and without this seed buildStepsFromHistory can't
    // templatize typed values (saves the discovery-time literal verbatim, so
    // warm execute sends the wrong text for a different caller's args).
    for (const [name, value] of Object.entries(save.args ?? {})) {
      if (typeof value !== 'string' || value.length < 2) continue;
      if (!paramExamples.has(name)) paramExamples.set(name, value);
    }
    if (navLiteralMatch && isReadNavFlow) {
      if (!paramExamples.has(navLiteralMatch.name)) {
        paramExamples.set(navLiteralMatch.name, navLiteralMatch.value);
      }
    }

    const steps = buildStepsFromHistory(slice, paramExamples);

    // Prepend a navigate prelude so warm execute lands on the right page
    // before the first action runs. Without this, cold warm sessions start
    // on about:blank and step[0] (click / type) fails immediately. The
    // discovery session already visited the target URL; session.visitedUrls
    // carries the last one it was on. No prepend when:
    //   (a) the agent already drove a `navigate` action (steps[0] is a
    //       navigate) — history faithfulness wins over runtime patching;
    //   (b) visitedUrls is empty (headless / programmatic path with no
    //       recorded navigation) — the strategy saves without navigate and
    //       warm-execute's healable-blocker flow handles it.
    const lastVisited = (session.visitedUrls ?? []).filter((u) => u && u !== 'about:blank').at(-1);
    const alreadyStartsWithNavigate = steps.length > 0 && steps[0]?.action === 'navigate';
    if (lastVisited && !alreadyStartsWithNavigate) {
      // Template the navigate URL against paramExamples: if a declared arg
      // literal appears inside the URL, replace it with {{name}} so warm
      // callers with different arg values get the right page. Without this the
      // recorded-path pins to the discovery entity.
      let navUrl = lastVisited;
      for (const [name, value] of paramExamples) {
        if (value.length >= 4 && navUrl.includes(value)) {
          navUrl = navUrl.split(value).join(`{{${name}}}`);
        }
      }
      steps.unshift({ action: 'navigate', url: navUrl });
    }

    // Assign stable slug ids to every step via the deterministic heuristic
    // in assignAutoStepIds. Non-LLM save path — agents who want descriptive
    // ids (e.g. "click_publish_button" instead of the heuristic default)
    // should either save explicitly via save_strategy or edit the step ids
    // post-hoc via patch_step.
    assignAutoStepIds(steps);

    const discoveredFromUrl = pickDiscoveredFromUrl(session);
    // Stamp the anchor: last step id in the emitted recorded-path. This is
    // the step that was live when the agent hit "save" / end-of-capability,
    // which is the point we want the revisit-fallback ladder to partial-
    // replay to.
    const anchorId =
      steps.length > 0 ? ((steps[steps.length - 1] as { id?: string }).id ?? null) : null;
    const runtimeMetaForRecorded: Record<string, unknown> = {};
    if (discoveredFromUrl) runtimeMetaForRecorded.discovered_from_url = discoveredFromUrl;
    if (anchorId) runtimeMetaForRecorded.discovered_at_step_id = anchorId;
    const strategy: Record<string, unknown> = {
      schema_version: 1,
      strategy: 'recorded-path',
      steps,
      notes: {},
      ...(Object.keys(runtimeMetaForRecorded).length > 0
        ? { runtime_meta: runtimeMetaForRecorded }
        : {}),
    };

    // Surface declared params so the recorded-path validator doesn't reject a
    // `{{message}}` step value as an undeclared placeholder.
    if (paramExamples.size > 0) {
      const params: Record<string, { description: string; example: string }> = {};
      for (const [name, example] of paramExamples) {
        params[name] = {
          description: `carried over from ${save.capability} auto-synthesis`,
          example,
        };
      }
      (strategy.notes as Record<string, unknown>).params = params;
    }
    attachSaveWarningsToStrategy(strategy, detectTypedTextDrift(session, save.args));
    // Read-nav fallback: this branch fired because no XHR carried the data AND
    // the agent didn't save explicitly. recorded-path is the honest auto-synth
    // outcome, but for SSR HTML reads (the typical shape: profile page loaded
    // by arg-templated URL, data in the initial document) the capability is
    // almost certainly upgradeable to `fetch` + `response.format:"html"` +
    // extract — ~100ms warm vs ~5s browser replay. Attach a SaveWarning naming
    // the upgrade target so the next session sees it on list_platform_skills.
    if (navLiteralMatch && isReadNavFlow) {
      attachSaveWarningsToStrategy(strategy, [
        {
          kind: 'read_nav_fallback',
          message: `Auto-synth saved this as recorded-path because no XHR carried the data and the capability wasn't explicitly saved before close_session. For server-rendered HTML reads (data in the initial document response at navigate-time), fetch + response.format:"html" + extract is ~100ms warm vs ~5s browser replay.`,
          hint: `Next session: inspect the initial document response via get_network_log, then save_strategy with strategy:"fetch", endpoint:"/{{${navLiteralMatch.name}}}", response:{format:"html", extract:{...}}. See klura://reference#fetch-schema.`,
        },
      ]);
    }

    try {
      const savedPath = skills.saveStrategy(
        platform,
        save.capability,
        strategy as unknown as skills.Strategy,
        'auto-synth: recorded-path from perform_action history',
      );
      out.push({
        capability: save.capability,
        tier: 'recorded-path',
        path: savedPath,
        reason: `${slice.length} actions replayed as steps`,
      });
      diag.push({
        pass: 'synth_recorded',
        capability: save.capability,
        phase: 'save',
        outcome: 'ok',
        detail: { slice_len: slice.length, path: savedPath },
      });
    } catch (err) {
      diag.push({
        pass: 'synth_recorded',
        capability: save.capability,
        phase: 'skip',
        outcome: 'validation_rejected',
        detail: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
  return out;
}

export function buildStepsFromHistory(
  history: PerformActionRecord[],
  paramExamples: Map<string, string>,
): Array<Record<string, unknown>> {
  const steps: Array<Record<string, unknown>> = [];
  // Note: the dismiss-prelude optional step is prepended by the caller
  // (synthesizeRecordedPaths via steps.unshift). Don't emit one here to avoid a
  // duplicate that fails save-time validation with empty locators.
  for (const rec of history) {
    if (rec.action === 'navigate') {
      if (typeof rec.url === 'string' && rec.url.length > 0) {
        steps.push({ action: 'navigate', url: rec.url });
      }
      continue;
    }
    if (rec.action === 'key_press') {
      const key = rec.key ?? rec.value ?? '';
      if (key) steps.push({ action: 'key_press', key });
      continue;
    }
    // click / type / fill_editor / select
    const locators = normalizeLocators(rec.selector);
    if (!locators) {
      // Agent passed no usable selector; unreplayable — skip this step rather
      // than emit a locators-less step that fails save-time validation.
      continue;
    }
    const step: Record<string, unknown> = {
      action: rec.action,
      locators,
    };

    // Template-substitute the typed value against declared params.
    if (
      (rec.action === 'type' || rec.action === 'fill_editor' || rec.action === 'select') &&
      rec.value !== undefined
    ) {
      const replaced = templatizeValue(rec.value, paramExamples);
      step.value = replaced;
    }
    // Forward the runtime-captured page fingerprint onto the synthesized step
    // under an underscore-prefixed internal field. The recorded-path step loop
    // reads this at warm-execute time to short-circuit when the page drifted
    // between discovery and replay. Only mutating actions carry a fingerprint
    // (navigate/key_press have none to compare against).
    if (
      (rec.action === 'click' ||
        rec.action === 'type' ||
        rec.action === 'fill_editor' ||
        rec.action === 'select') &&
      rec.page_fingerprint
    ) {
      step._fingerprint = rec.page_fingerprint;
    }
    steps.push(step);
  }
  return steps;
}

function normalizeLocators(selector: string | undefined): Record<string, unknown> | null {
  // Return a `{css}` locator when the selector is non-empty; return null
  // otherwise so the caller can skip the step. An empty-string CSS locator
  // fails the save-time validator (must declare a11y OR css).
  //
  // When the selector matches Playwright's a11y-snapshot syntax
  // (`<role> "<name>"` — what `perform_action` callers reach for after
  // reading an a11y tree), produce a structured `locators.a11y` alongside
  // the css string. The cascade and warm-execute self-heal both depend on
  // `a11y.role` to do role-based rescans; without this, the auto-synth
  // captures only an opaque string and heal can't engage.
  if (!selector || selector.length === 0) return null;
  const parsed = parseSnapshotSelector(selector);
  if (parsed) {
    return {
      a11y: parsed.name ? { role: parsed.role, name: parsed.name } : { role: parsed.role },
      css: selector,
    };
  }
  return { css: selector };
}

function templatizeValue(value: string, paramExamples: Map<string, string>): string {
  if (!value) return value;
  let out = value;
  for (const [name, example] of paramExamples) {
    if (example && example.length >= 2 && out.includes(example)) {
      out = out.split(example).join(`{{${name}}}`);
    }
  }
  return out;
}

export function collectParamExamples(strategy: skills.Strategy | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!strategy) return out;
  const notes = (strategy as { notes?: unknown }).notes;
  if (!notes || typeof notes !== 'object') return out;
  const params = (notes as { params?: unknown }).params;
  if (!params || typeof params !== 'object') return out;
  for (const [name, entry] of Object.entries(params as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue;
    const example = (entry as { example?: unknown }).example;
    if (typeof example === 'string' && example.length > 0) {
      out.set(name, example);
    }
  }
  return out;
}

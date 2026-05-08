// Recorded-path replay: drive a saved sequence of UI steps against a fresh
// browser session, with optional-step probe semantics, single-shot
// dismiss-then-retry on failure, post-navigation HTML extract, and
// healable-blocker handoff (a11y tree + screenshot + remote viewer URL) when a
// step truly fails.
//
// Also owns selector-resolution helpers — `withLocatorFallback`,
// `probeOptionalLocator`, the a11y/CSS candidate cascade — since the only
// callers are step execution.

import type { Session } from '../drivers/types/session';
import type { TokenCache } from '../strategies/tokens';
import * as skills from '../strategies/skills';
import { shapeNetworkLog } from '../response/network-log-shape';
import { extractFromHtml } from '../response/html-extract';
import { recordRecordedPathSuccess } from '../strategies/strategy-graduation';
import { trimA11yTree, HEALABLE_A11Y_BUDGET } from '../response/response-size';
import { fireInterrupts, type InterruptEntry } from '../strategies/interrupt-firing';
import { invokeCheckpointAndGate } from '../checkpoints';
import { resolveVariables } from './vars';
import { probeOptionalLocator, runResolvedRecordedStep } from './step-runner';
import { tryStructuralHeal, isHealableAction } from './heal';
import { runPrerequisites } from './fetch-browser';
import { loadConfig } from '../config/handler';
import {
  registerAutoExecuteAlias,
  clearAutoExecuteAlias,
  resolveAutoExecuteAlias,
} from './auto-execute-alias';
import {
  capturePageFingerprint,
  diffFingerprints,
  describeDrift,
  PageDriftError,
  type PageFingerprint,
} from '../strategies/page-fingerprint';
import { currentDeviceSessionOpts } from '../execution';
import type {
  AnyPool,
  ExecuteResult,
  Locators,
  RecordedPathStep,
  RecordedPathStrategy,
  ResponseSpec,
} from './types';

interface PausedExecution {
  /** Index of the step that failed. The resumed tail re-includes this step
   *  so a `patch_step` against it actually runs — slicing past it would
   *  silently skip the patched step on resume. */
  failedStepIndex: number;
  /** In-memory snapshot of the steps from `failedStepIndex` onward,
   *  captured at pause time. Used as a fallback when the on-disk
   *  strategy can't be reloaded at resume time. The primary path re-reads
   *  the strategy from disk so any `patch_step` that ran between pause
   *  and resume picks up. */
  remainingSteps: RecordedPathStep[];
  args: Record<string, unknown>;
  platform: string;
  capability: string;
  /** Preserved across a pause so the resumed tail still runs the post-
   *  navigation extract if the strategy declared one. */
  response?: ResponseSpec;
  /** Preserved across a pause so between_steps / pre_execution
   *  interrupts fire correctly when the resumed tail runs. */
  interrupts?: readonly InterruptEntry[];
}

const pausedExecutions = new Map<string, PausedExecution>();

export async function executeRecordedPath(
  strategy: RecordedPathStrategy,
  args: Record<string, unknown>,
  platform: string,
  capability: string,
  pool: AnyPool,
  tokenCache: TokenCache | null = null,
  identity?: string,
  ownerSessionId?: string,
): Promise<ExecuteResult> {
  // Run prerequisites BEFORE opening the recorded-path's own session.
  // Capability prereqs (the canonical "log in first" composition) recursively
  // execute their own strategy via resolveCapabilityPrereq, which writes
  // platform storage-state on completion. The recorded-path session opened
  // below loads that storage-state, so cookies set by a prereq capability
  // (e.g. bankid_login) flow through to the steps via the platform-keyed
  // jar. Browser-only prereqs (page-extract / fetch-extract / js-eval / browser)
  // run in their own short-lived session inside runPrerequisites.
  const { tokens } = await runPrerequisites({
    strategy,
    args,
    platform,
    pool,
    tokenCache,
    ...(identity !== undefined ? { identity } : {}),
  });
  const stepArgs: Record<string, unknown> = { ...args, ...tokens };

  const { opts: devOpts, device: resolvedDevice } = currentDeviceSessionOpts();
  const storageStatePath = skills.loadStorageStatePath(platform, identity);
  // Recorded-path opts out of ready-page reuse: step replay assumes a fresh DOM
  // (no leftover dialogs, scroll offsets, hover state). It still uses the
  // warm-CONTEXT slot — resetSession navigates to about:blank and wipes page
  // state while keeping the Chromium process warm.
  const session = await pool.createSession({
    platform,
    ...(identity ? { identity } : {}),
    ...devOpts,
    ...(storageStatePath ? { storageState: storageStatePath } : {}),
  });
  session.device = resolvedDevice;

  return await executeSteps(
    strategy.steps,
    stepArgs,
    platform,
    capability,
    pool,
    session,
    strategy.response,
    (strategy as { interrupts?: readonly InterruptEntry[] }).interrupts,
    ownerSessionId,
  );
}

/**
 * Revisit-fallback partial replay. Called from `execute()` when a primary
 * (fetch / page-script) strategy misses AND the capability's
 * `notes.discovered_at_step_id` names an anchor step in a sibling
 * recorded-path. Replays steps `0..anchor` (inclusive) to restore session
 * state, then the caller retries the primary. Returns `null` when the
 * anchor can't be found (id was renamed or step deleted) or the
 * recorded-path has no steps — the caller then falls through to full
 * replay.
 *
 * On partial-replay failure (selector miss, step throws) the error is
 * swallowed and `{ok: false}` is returned so the cascade can fall through
 * cleanly; no healable-blocker envelope surfaces here because partial
 * replay is a best-effort fix-up, not the tier itself.
 */
export async function replayRecordedPathToAnchor(
  strategy: RecordedPathStrategy,
  anchorId: string,
  args: Record<string, unknown>,
  platform: string,
  _capability: string,
  pool: AnyPool,
  identity?: string,
): Promise<{ ok: true; session: Session } | { ok: false; reason: string }> {
  const anchorIdx = strategy.steps.findIndex(
    (s) => typeof (s as { id?: unknown }).id === 'string' && (s as { id: string }).id === anchorId,
  );
  if (anchorIdx === -1) {
    return { ok: false, reason: 'anchor_not_found' };
  }
  const slice = strategy.steps.slice(0, anchorIdx + 1);
  if (slice.length === 0) {
    return { ok: false, reason: 'empty_slice' };
  }
  const { opts: devOpts, device: resolvedDevice } = currentDeviceSessionOpts();
  const storageStatePath = skills.loadStorageStatePath(platform, identity);
  const session = await pool.createSession({
    platform,
    ...(identity ? { identity } : {}),
    ...devOpts,
    ...(storageStatePath ? { storageState: storageStatePath } : {}),
  });
  session.device = resolvedDevice;

  try {
    const driver = pool.driverFor(session.id);
    for (const step of slice) {
      const resolved = resolveVariables(step, args);
      try {
        await runResolvedRecordedStep(driver, session, resolved);
      } catch (err) {
        await pool.endDrive(session.id).catch(() => {});
        return {
          ok: false,
          reason: `step_failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      await driver.delay(session, 200);
    }
    // Persist storage state so a subsequent Node-transport primary fetch
    // picks up any cookies the replay established. In-browser retries reuse
    // the session directly (see the caller's session.id pass-through).
    try {
      const statePath = skills.storageStatePath(platform, identity);
      await driver.saveStorageState(session, statePath);
    } catch {
      // Best-effort — partial replay still counts as a success; the
      // primary-retry will pick up whatever state IS in the jar.
    }
    return { ok: true, session };
  } catch (err) {
    await pool.endDrive(session.id).catch(() => {});
    return {
      ok: false,
      reason: `partial_replay_error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function resumeRecordedPath(sessionId: string, pool: AnyPool): Promise<ExecuteResult> {
  // Resolve outer (start_session-owned) ids to the auto-execute inner id
  // they alias. Direct lookup wins; fallback to alias when the agent uses
  // the outer id from start_session. See `runtime/src/execution/auto-execute-alias.ts`.
  let effectiveId = sessionId;
  let paused = pausedExecutions.get(sessionId);
  if (!paused) {
    const innerId = resolveAutoExecuteAlias(sessionId);
    if (innerId) {
      const innerPaused = pausedExecutions.get(innerId);
      if (innerPaused) {
        effectiveId = innerId;
        paused = innerPaused;
      }
    }
  }
  if (!paused) {
    throw new Error(`No paused execution for session ${sessionId}`);
  }
  pausedExecutions.delete(effectiveId);
  // Clear alias under whichever outer id mapped to this inner — the
  // paused-execution lifetime is over.
  if (effectiveId !== sessionId) {
    clearAutoExecuteAlias(sessionId);
  }

  const session = pool.getSession(effectiveId);

  // Re-read the strategy from disk so any `patch_step` that landed
  // between pause and resume is reflected. The in-memory snapshot
  // (paused.remainingSteps) is a fallback for the rare case where the
  // strategy is missing or no longer recorded-path tier (e.g. demoted
  // mid-flow).
  let stepsToRun: RecordedPathStep[] = paused.remainingSteps;
  const fresh = skills.loadStrategy(paused.platform, paused.capability);
  if (
    fresh &&
    (fresh as { strategy?: string }).strategy === 'recorded-path' &&
    Array.isArray((fresh as RecordedPathStrategy).steps)
  ) {
    const freshSteps = (fresh as RecordedPathStrategy).steps;
    if (paused.failedStepIndex < freshSteps.length) {
      stepsToRun = freshSteps.slice(paused.failedStepIndex);
    }
  }

  return await executeSteps(
    stepsToRun,
    paused.args,
    paused.platform,
    paused.capability,
    pool,
    session,
    paused.response,
    paused.interrupts,
  );
}

// eslint-disable-next-line sonarjs/cognitive-complexity
async function executeSteps(
  steps: RecordedPathStep[],
  args: Record<string, unknown>,
  platform: string,
  capability: string,
  pool: AnyPool,
  session: Session,
  response?: ResponseSpec,
  interrupts?: readonly InterruptEntry[],
  ownerSessionId?: string,
): Promise<ExecuteResult> {
  let keepSession = false;
  // Single-shot retry flag for the "failed step → run next optional dismiss →
  // retry failed step once" loop. Cleared on every successful required step so
  // each distinct failure gets one try at the dismiss path, but we don't
  // accumulate retries across a chain of failures.
  let retriedAfterOptional = false;

  // Tokens bound by interrupt handlers; interpolated into subsequent steps'
  // selector/value fields via the standard `{{name}}` mechanism. Separate from
  // args (caller-supplied) so step resolution can see both layers.
  const interruptTokens: Record<string, string> = {};
  const interruptCtx = {
    session,
    driver: pool.driverFor(session.id),
    tokens: interruptTokens,
    args,
  };

  const firedInterrupts: string[] = [];
  // Soft-drift advisories collected from pre-step fingerprint checks. Surfaced
  // on the success envelope so the agent sees which steps rode on a drifted-
  // but-not-aborting page — useful signal when warm runs later hard-drift at
  // the same spot.
  const driftAdvisories: Array<{
    step_id?: string;
    step_index: number;
    fields: string[];
    details: Record<string, unknown>;
  }> = [];
  // Heal advisories collected from in-process structural rescans. Surfaced on
  // the success envelope so the agent sees which steps were auto-patched
  // (locator drift caught + repaired before the checkpoint fired). The on-disk
  // strategy is patched via patchStep — these advisories are the runtime trail.
  const healAdvisories: Array<{
    step_id?: string;
    step_index: number;
    layer: 'substring' | 'role-only';
  }> = [];

  try {
    // pre_execution: fire interrupts that gate the whole flow before step[0]
    // runs — challenges already visible when execute begins.
    firedInterrupts.push(...(await fireInterrupts(interrupts, 'pre_execution', interruptCtx)));

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!step) continue;
      // Merge interruptTokens into args for this step's interpolation.
      // Later-defined keys in interruptTokens win over args so a handler can
      // override a caller arg if needed (rare but supported).
      const resolutionArgs = { ...args, ...interruptTokens };
      const resolved = resolveVariables(step, resolutionArgs);
      const isOptional = resolved.optional === true;

      try {
        // Runtime-auto drift detection. Mutating steps saved with a
        // `_fingerprint` compare the saved structural skeleton against a live
        // capture before the locator resolves. Hard drift (url_path changed,
        // dialog materialized, target form gone, target label missing) throws
        // PageDriftError — caught below and routed through the in-process
        // self-heal path first (a `target_missing` field is exactly the case
        // structural rescan handles), then through the existing
        // `recorded_step_failed` checkpoint when heal misses. Soft drift
        // (heading changed, new buttons added) attaches an advisory and
        // continues.
        const savedFp = (step as { _fingerprint?: PageFingerprint })._fingerprint;
        if (
          savedFp &&
          (resolved.action === 'click' ||
            resolved.action === 'type' ||
            resolved.action === 'fill_editor' ||
            resolved.action === 'select') &&
          !isOptional
        ) {
          const driver = pool.driverFor(session.id);
          const liveTree = await driver.getAccessibilityTree(session).catch(() => '');
          const liveUrl = await driver.getUrl(session).catch(() => '');
          const liveFp = capturePageFingerprint(liveTree, liveUrl);
          const targetLabel =
            resolved.locators?.a11y?.name ??
            (typeof (resolved.locators as { name?: string } | undefined)?.name === 'string'
              ? (resolved.locators as { name?: string }).name
              : undefined);
          const classification = diffFingerprints(savedFp, liveFp, targetLabel);
          if (classification.severity === 'hard') {
            throw new PageDriftError(
              `page_drifted_before_step: ${describeDrift(classification)}`,
              classification,
              typeof (step as { id?: unknown }).id === 'string'
                ? (step as { id: string }).id
                : undefined,
            );
          }
          if (classification.severity === 'soft') {
            driftAdvisories.push({
              step_id:
                typeof (step as { id?: unknown }).id === 'string'
                  ? (step as { id: string }).id
                  : undefined,
              step_index: i,
              fields: classification.fields,
              details: classification.details as Record<string, unknown>,
            });
          }
        }

        await runResolvedRecordedStep(pool.driverFor(session.id), session, resolved);
      } catch (err) {
        // Optional steps swallow failures silently — the semantics are "click
        // if visible, otherwise skip", so a race where the element disappears
        // between probe and click is the same no-op as an absent element. Move
        // on to the next step.
        if (isOptional) {
          await pool.driverFor(session.id).delay(session, 100);
          continue;
        }
        // Step failed. Before escalating to the agent, check whether the NEXT
        // step in the recorded-path is an `optional: true` dismiss- intent
        // step. If yes, an ad-hoc dialog (E2EE recovery prompt, one-time
        // banner, push-notification popup) may have appeared mid-replay and is
        // blocking the failed step's selector. Running the optional step first
        // clears that dialog via the structural- ARIA fallback, then we retry
        // the required step once. If the retry succeeds, continue normally; if
        // not, escalate as today.
        if (!retriedAfterOptional) {
          const next = steps[i + 1];
          if (
            next &&
            typeof next === 'object' &&
            (next as { optional?: boolean }).optional === true
          ) {
            try {
              const nextLocs = (next as { locators?: Locators }).locators;
              const nextAction = (next as { action?: string }).action ?? 'click';
              const found = await probeOptionalLocator(
                pool.driverFor(session.id),
                session,
                nextLocs,
              );
              if (found && nextAction === 'click') {
                await pool.driverFor(session.id).click(session, found);
                await pool.driverFor(session.id).delay(session, 300);
                // Rewind to retry the failed step once with the dialog now
                // cleared.
                retriedAfterOptional = true;
                i -= 1;
                continue;
              }
            } catch {
              // Optional dismissal path failed; fall through to the usual
              // blocker escalation below.
            }
          }
        }

        // In-process structural rescan. When all captured locator candidates
        // for a healable action have failed (cascade exhaustion OR fingerprint
        // pre-check classified the drift as `target_missing`, which IS
        // locator drift the rescan is built for), ask the driver whether a
        // unique role match exists on the live page (substring name first,
        // then role-only). On success: persist the new locator via patchStep
        // and continue the step loop with no checkpoint round-trip. On miss:
        // fall through to the existing recorded_step_failed envelope so the
        // session-driving LLM heals via patch_step + resume_execution.
        //
        // PageDriftError is NOT skipped — its hard-drift fields can include
        // `target_missing` (the captured button label isn't anywhere on the
        // live a11y tree), which is exactly the case heal handles. If the
        // drift is genuinely page-shaped (`url_path`, `form_signature`,
        // `has_dialog`), heal's uniqueness gate is the safety belt: the
        // rescan returns no unique match and we fall through to the existing
        // checkpoint path with one extra structural probe spent.
        if (isHealableAction(resolved.action)) {
          const healConfig = loadConfig().pool.heal;
          const healPageOpts =
            resolved.page && resolved.page !== 'main' ? { page: resolved.page } : undefined;
          const staticStep = steps[i] as RecordedPathStep | undefined;
          const healOutcome = await tryStructuralHeal(
            pool.driverFor(session.id),
            session,
            {
              staticLocators: staticStep?.locators,
              action: resolved.action,
              value: resolved.value,
            },
            healPageOpts,
            healConfig,
          );
          if (healOutcome.ok) {
            const stepIdRaw = (steps[i] as { id?: unknown } | undefined)?.id;
            const stepId = typeof stepIdRaw === 'string' ? stepIdRaw : undefined;
            // Persist the patched locators on disk so subsequent calls skip
            // the heal cost. Best-effort: a failed write (e.g. file race,
            // strategy moved between disk read and write) is non-fatal —
            // the in-memory action already succeeded for the live caller and
            // the next call will heal again. The advisory fires either way.
            if (stepId) {
              skills.patchStep(platform, capability, 'recorded-path', stepId, {
                locators: healOutcome.patchedLocators,
              });
            }
            healAdvisories.push({
              ...(stepId ? { step_id: stepId } : {}),
              step_index: i,
              layer: healOutcome.layer,
            });
            retriedAfterOptional = false;
            await pool.driverFor(session.id).delay(session, 300);
            continue;
          }
        }

        keepSession = true;
        pausedExecutions.set(session.id, {
          failedStepIndex: i,
          // Include the failed step itself — `patch_step` mutates it on
          // disk, and resume re-runs from this index so the patched
          // version executes. Slicing past it would skip the very step
          // the agent just fixed.
          remainingSteps: steps.slice(i),
          args,
          platform,
          capability,
          response,
        });
        // When auto-execute fired this from start_session, register the
        // outer→inner alias so resume_execution / ack_checkpoint with the
        // outer (agent-known) session id resolve to this inner session's
        // entries. See `runtime/src/execution/auto-execute-alias.ts` and
        // `runtime/docs/run-lifecycle.md#auto-execute-session-topology`.
        if (ownerSessionId && ownerSessionId !== session.id) {
          registerAutoExecuteAlias(ownerSessionId, session.id);
        }

        const rawA11y = await pool
          .driverFor(session.id)
          .getAccessibilityTree(session)
          .catch(() => '');
        const trimmedA11y = trimA11yTree(rawA11y, HEALABLE_A11Y_BUDGET);
        const url = await pool
          .driverFor(session.id)
          .getUrl(session)
          .catch(() => '');
        // JPEG instead of PNG — ~10× smaller on the wire. A 60% quality JPEG is
        // plenty for the agent to locate a broken selector in the page
        // screenshot, and inlining a 300+KB base64 PNG blows past agent-SDK
        // token limits and confuses the caller into thinking the execute itself
        // failed. Drivers expose `screenshotJpeg` returning a Buffer; we
        // base64-encode it here.
        const screenshot = await pool
          .driverFor(session.id)
          .screenshotJpeg(session, 55)
          .then((buf) => buf.toString('base64'))
          .catch(() => undefined);

        // Surface the mid-execute failure via direct-dispatch to the
        // checkpoint registry. The last-registered handler claiming
        // `recorded_step_failed` wins; default is the viewer-handover
        // plugin, which opens the remote viewer inline. Runtime never
        // opens a viewer unilaterally — the handler does.
        const failureMsg = err instanceof Error ? err.message : String(err);
        const failedStep = steps[i];
        const failedStepId =
          failedStep && typeof (failedStep as { id?: unknown }).id === 'string'
            ? (failedStep as { id: string }).id
            : undefined;
        const driftCtx =
          err instanceof PageDriftError
            ? {
                reason: 'page_drifted_before_step' as const,
                diff: err.diff.details,
                drift_fields: err.diff.fields,
              }
            : null;
        const { envelope: checkpointEnvelope } = await invokeCheckpointAndGate(
          'recorded_step_failed',
          {
            session_id: session.id,
            capability,
            context: {
              kind: 'recorded_step_failed',
              failed_step_index: i,
              ...(failedStepId ? { failed_step_id: failedStepId } : {}),
              failed_step: failedStep,
              error_message: failureMsg,
              platform,
              capability,
              a11y_tree: trimmedA11y.tree,
              a11y_truncated: trimmedA11y.truncated,
              url,
              healable: true,
              ...(driftCtx ?? {}),
            },
          },
        );

        return {
          status: 0,
          body: {
            session_id: session.id,
            failed_step_index: i,
            ...(failedStepId ? { failed_step_id: failedStepId } : {}),
            failed_step: failedStep,
            remaining_steps: steps.length - i - 1,
            error: failureMsg,
            platform,
            capability,
            a11yTree: trimmedA11y.tree,
            a11y_total_chars: trimmedA11y.total_chars,
            a11y_truncated: trimmedA11y.truncated,
            url,
            ...(screenshot ? { screenshot } : {}),
            ...(checkpointEnvelope ? { _checkpoint: checkpointEnvelope } : {}),
          },
        };
      }

      // Required step completed successfully — reset the retry flag so a later
      // step's failure gets its own one-shot optional-dismiss try.
      retriedAfterOptional = false;
      await pool.driverFor(session.id).delay(session, 300);

      // between_steps interrupts: fire on the step-completion edge. If a
      // challenge became visible as a side-effect of this step (e.g. the
      // Publish click revealed an hCaptcha iframe), the matching predicate
      // fires the handler here before moving to the next step. Never polled —
      // this is the edge we already had.
      firedInterrupts.push(
        ...(await fireInterrupts(interrupts, 'between_steps', {
          ...interruptCtx,
          driver: pool.driverFor(session.id),
        })),
      );
    }

    // On a successful recorded-path replay, return a minimal success body: just
    // `{ok, url}` plus a summary-shaped network log so the agent can scan it
    // for graduation opportunities (XHR/fetch calls that could be lifted to
    // T0/T1/T2) without paying a token tax for every execute. The a11y tree is
    // deliberately NOT included here — it's only useful on healable failures
    // (where we DO include it) to help the agent locate the failed step. On
    // success, inlining a 30-80KB a11y tree plus a raw network log blows past
    // agent-SDK token limits and confuses the caller into thinking execute
    // itself failed.
    const rawLog = await pool.driverFor(session.id).getInterceptedRequests(session);
    // Pull the ws frame buffer once and share it between the returned
    // networkLog (so callers see WS activity alongside HTTP) and the ws-echo
    // graduation hook below.
    const wsFrames = await pool
      .driverFor(session.id)
      .getInterceptedWebSocketFrames(session)
      .catch(() => []);
    const networkLog = shapeNetworkLog(rawLog, {}, wsFrames); // default: lightweight summary
    const finalUrl = await pool
      .driverFor(session.id)
      .getUrl(session)
      .catch(() => '');

    // Graduation tracker: observe the raw network log after a successful
    // recorded-path replay. After N consecutive runs show the same capturable
    // POST shape, the runtime synthesizes an fetch strategy alongside the
    // recorded-path and the cascade tries it first next time. Best-effort —
    // graduation never throws into the execute path.
    //
    // Ws-echo fallback: if the HTTP capture found nothing liftable (modern chat
    // sites send writes over a persistent WebSocket, no POST to capture), hand
    // the graduation layer the ws frame buffer + every typed-literal the step
    // list emitted so it can match payload echoes and synthesize a
    // protocol:"websocket" strategy after the threshold.
    const typedValues: string[] = [];
    for (const s of steps) {
      const resolved = resolveVariables(s, args);
      if (
        (resolved.action === 'type' || resolved.action === 'select') &&
        typeof resolved.value === 'string'
      ) {
        typedValues.push(resolved.value);
      }
    }
    recordRecordedPathSuccess(platform, capability, rawLog, {
      frames: wsFrames,
      typedValues,
      args,
    });

    const statePath = skills.storageStatePath(platform, session.identity);
    await pool.driverFor(session.id).saveStorageState(session, statePath);

    // Post-navigation extract. When the recorded-path declares `response:
    // {format: 'html', extract: {...}}`, read the serialized page HTML via the
    // driver and pipe it through the shared cheerio helper. The result replaces
    // the default `{ok, url}` body with a structured map of extracted fields —
    // the missing primitive that made navigate-only recorded-paths useless for
    // data-extraction flows (see REFERENCE.md#recorded-path-schema).
    //
    // JSON format is not yet supported for recorded-path extracts — the
    // expected use case is "navigate to a page, read fields from the DOM". JSON
    // extracts belong on fetch strategies where the HTTP response is already
    // JSON.
    if (response?.format === 'html' && response.extract) {
      let html: string;
      try {
        html = await pool.driverFor(session.id).getPageHtml(session);
      } catch (err) {
        return {
          status: 0,
          body: {
            error: 'page_html_read_failed',
            details: err instanceof Error ? err.message : String(err),
            url: finalUrl,
          },
        };
      }
      let extracted: Record<string, string | string[]>;
      try {
        extracted = extractFromHtml(html, response.extract);
      } catch (err) {
        return {
          status: 0,
          body: {
            error: 'html_extract_failed',
            details: err instanceof Error ? err.message : String(err),
            url: finalUrl,
          },
        };
      }
      return {
        status: 200,
        body: {
          ok: true,
          url: finalUrl,
          extracted,
          networkLog,
          ...(firedInterrupts.length > 0 ? { interrupts_fired: firedInterrupts } : {}),
          ...(driftAdvisories.length > 0 ? { _drift_advisory: driftAdvisories } : {}),
          ...(healAdvisories.length > 0 ? { _heal_advisory: healAdvisories } : {}),
        },
      };
    }

    return {
      status: 200,
      body: {
        ok: true,
        url: finalUrl,
        networkLog,
        ...(firedInterrupts.length > 0 ? { interrupts_fired: firedInterrupts } : {}),
        ...(driftAdvisories.length > 0 ? { _drift_advisory: driftAdvisories } : {}),
        ...(healAdvisories.length > 0 ? { _heal_advisory: healAdvisories } : {}),
      },
    };
  } finally {
    if (!keepSession) {
      await pool.endDrive(session.id);
    }
  }
}

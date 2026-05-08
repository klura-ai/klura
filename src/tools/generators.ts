import { pool } from '../runtime-state';
import {
  ensureAccumulator,
  ringPush,
  digestArgs,
  persistVerifiedExpressionFromGenerator,
} from '../strategies/discovery-artifact';
import { runGeneratorCode } from '../strategies/generators';
import { diffBinary } from '../response/generator-diff';
import type { GeneratorDiff } from '../response/generator-diff';
import { findIssuedStarter, codeReferencesStarter } from '../response/starter-cache';
import { computeConvergence } from '../response/convergence';
import { wrapAgentExpression } from '../response/js-eval-wrapper';

export interface TryGeneratorArgs {
  /** Required only when `verify_against.ws_i` is set — looks up the
   *  captured frame in that session's ring buffer. */
  session_id?: string;
  /** The generator snippet to test — identical shape to
   *  `strategy.generated.<name>.code`. */
  code: string;
  /** The sandbox's `args` object. LLM mirrors the execute-time shape. */
  args?: Record<string, unknown>;
  /** Optional ground truth to diff against. */
  verify_against?: { ws_i: number } | { ws_hash: string } | { base64: string };
  /** Comparison mode:
   *   - `'bytes'` (default) — ok iff output byte-for-byte matches
   *     expected. The established convergence-loop semantics.
   *   - `'structural'` — extract JSON from both sides (handling
   *     nested escaped-JSON envelopes), compare shape only. Value
   *     types match; actual values may differ. Good for
   *     complex-envelope RE where the agent has the right shape but
   *     the byte-for-byte path has diminishing returns. Binary
   *     envelopes with no embedded JSON fall back to a
   *     no_json_found diagnostic. See response/structural-match.ts. */
  match?: 'bytes' | 'structural';
  /** How the generator's return string is interpreted for comparison:
   *  'binary' base64-decodes before diffing against verify_against bytes;
   *  'text' compares byte-for-byte as UTF-8. Default 'binary' — the
   *  motivating case is binary-envelope WS frames. */
  encoding?: 'text' | 'binary';
}

export type TryGeneratorResult =
  | {
      ok: true;
      output: string;
      output_length: number;
      /** Only present when verify_against was supplied AND matched. */
      expected_length?: number;
      /** Per-session iteration counter — set when verify_against was supplied
       *  and a session was resolved. Lets the agent self-pace ("you've
       *  iterated N times") without manually counting tool calls. */
      attempt_in_session?: number;
      /** Soft nudge when the agent ran try_generator without referencing
       *  a previously-issued inspect_ws_frame starter. Not an error — the
       *  agent may have a reason — but iteration 1 with the starter is
       *  free, so a skip is worth flagging. */
      runtime_hint?: string;
      /** Present when ok=true was reached via structural match (opts.match
       *  === 'structural'). Carries the diagnostic info from the matcher
       *  so the agent sees "matched on shape, not bytes" in the response. */
      structural_match?: import('../response/structural-match').StructuralMatchResult['info'];
      /** Present when the runtime auto-persisted this successful generator
       *  as a verified expression on the discovery artifact (happens when
       *  the session has a declared capability). The agent doesn't need
       *  to call save_verified_expression manually — the runtime has
       *  ground truth that this code produced the captured bytes, so
       *  the persistence is free. Names the capability + reset the
       *  hardness-check counter. */
      auto_persisted_as_verified_expression?: {
        capability: string;
        binds_args: string[];
        returns: 'hex' | 'base64' | 'string' | 'object';
      };
      /** Present when the ok:true verify_against rode a captured WS
       *  frame (ws_i / ws_hash). Names the save shape the agent should
       *  emit next AND the fallback path when rotating fields remain
       *  that can't be templated from one capture. Close-to-execution
       *  priming — the agent reads its next move on the same response
       *  that confirmed the byte match. See principles.md §"Priming
       *  agents: close to execution" for rationale + external refs. */
      next_save_hint?: {
        verified: 'envelope_shape_byte_match';
        auto_persisted: boolean;
        captured_ws_url: string;
        next_steps: string[];
      };
    }
  | ({
      ok: false;
      /** Present on a successful run with a failed diff. Absent when the
       *  generator itself threw (see `error`). */
      output?: string;
      output_length?: number;
      error?: string;
      attempt_in_session?: number;
      runtime_hint?: string;
      /** Convergence signal: normalised progress trajectory across the
       *  session's recent verify_against iterations. Lets the agent see
       *  "iteration 3, envelope_correct, converging, hint:..." instead
       *  of raw byte offsets that have no gradient. */
      convergence?: import('../response/convergence').ConvergenceSignal;
    } & Partial<GeneratorDiff>);

// Cap on the base64 / string output returned in the response. The generator
// sandbox has a 100ms timeout so pathological loops are bounded; this cap just
// guards against a code path that successfully returns 100KB+ and blows the MCP
// tool-output budget.
const TRY_GENERATOR_OUTPUT_CAP = 20_000;

/** Compose the ok:true next_save_hint when verify_against rode a captured
 * WS frame. Returns undefined when no ws URL was resolved (explicit base64
 * path) — nothing to point the agent at.
 *
 * Framing intent: envelope-shape byte-match is the START line, not the finish
 * line. Rotating fields (epoch_id, otid, nonces, signatures…) are templated via
 * js-eval prereqs that re-derive them from the live page. Saving recorded-path
 * is gated by the user_confirmation classifier at save time — the user has the
 * final say on whether the proposed shape is acceptable for the capability.
 * See klura://reference#reverse-engineer-mode for the full flow rhythm.
 */
export function buildNextSaveHint(
  wsUrl: string | undefined,
  autoPersisted: boolean,
):
  | {
      verified: 'envelope_shape_byte_match';
      auto_persisted: boolean;
      captured_ws_url: string;
      next_steps: string[];
    }
  | undefined {
  if (!wsUrl) return undefined;
  return {
    verified: 'envelope_shape_byte_match',
    auto_persisted: autoPersisted,
    captured_ws_url: wsUrl,
    next_steps: [
      autoPersisted
        ? "Envelope shape is byte-match verified. Your generator code was auto-persisted to the capability's discovery_artifact (see auto_persisted_as_verified_expression above) — you don't need to call save_verified_expression."
        : 'Envelope shape is byte-match verified. No session-scoped persistence fired — this run had no declared capability.',
      "NEXT: template each rotating field (epoch_id, otid, request_id, task_id, version_id, nonces, per-send timestamps, signatures, …) via a js-eval prereq that re-derives the value from the live page. The page has the machinery that produced each captured value; your prereq's expression calls that machinery at execute time. Common patterns:",
      "  • counters / sequence ids → js_eval against the page's in-memory counter / queue state",
      "  • epoch_id / timestamp-derived → Date.now()-based expression, or call the page's own clock-normalizer",
      "  • otid / derived ids → locate the page's id-generator via search_js_source or set_breakpoint at the send callsite, then evaluate_on_frame on the paused scope",
      '  • nonces / signatures → search_js_source + read_js_function for the signer; js-eval prereq calls it',
      'Save one js-eval prereq per rotating field, bind each via prerequisites[].binds, reference in generated.frame.code via {{name}}.',
      "When every rotating field is templated, save_strategy as a COMPLETE strategy: {strategy:'fetch', protocol:'websocket', wsUrl, frameEncoding:'binary', prerequisites:[...], generated:{frame:{code}}, notes:{params:{...}}}. klura saves only complete, runnable strategies on disk.",
      "Stuck on one rotating field? DON'T FOLD. Options: (a) trigger_reference_send (token-gated Level-3 consent — first call returns consent_token + checklist, second call commits with consent_answers; Tier 2 requires the user's own acknowledgement quote) to capture a fresh reference frame and diff bytes to isolate which field changed; (b) ask the user 'could you send one more message to help me triangulate field X?' as a text-only turn.",
      'The session ends LIFT when save_strategy lands a complete runnable strategy. Every save passes through the user_confirmation classifier (the user approves or rejects the proposed shape at save time, with strategy summary inlined in the prompt); rejection stays in the current phase, so keep working. end_drive keeps returning the same handoff until a save lands. See klura://reference#reverse-engineer-mode.',
      'Three-tier preference: fetch (optimal when achievable) → page-script (realistic default for signed sites) → recorded-path (last resort).',
    ],
  };
}

/** Pool-lookup wrapper around `persistVerifiedExpressionFromGenerator`
 *  for the `try_generator` paths. Returns null on any lookup failure. */
function autoPersistGeneratorSuccess(
  sessionId: string | undefined,
  code: string,
  args: Record<string, unknown>,
  returns: 'hex' | 'base64' | 'string' | 'object',
  sampleByteLength: number,
): {
  capability: string;
  binds_args: string[];
  returns: 'hex' | 'base64' | 'string' | 'object';
} | null {
  if (!sessionId) return null;
  try {
    const session = pool.getSession(sessionId);
    return persistVerifiedExpressionFromGenerator(session, code, args, returns, sampleByteLength);
  } catch {
    return null;
  }
}

function recordTryGeneratorAttempt(opts: TryGeneratorArgs, ok: boolean): number | undefined {
  if (!opts.session_id || typeof pool.recordTryGeneratorCall !== 'function') {
    return undefined;
  }
  pool.recordTryGeneratorCall(opts.session_id, {
    hadVerifyAgainst: opts.verify_against !== undefined,
    ok,
  });
  try {
    const sess = pool.getSession(opts.session_id);
    ringPush(ensureAccumulator(sess).tryGeneratorCalls, {
      args_digest: digestArgs({
        code: opts.code,
        args: opts.args,
        verify_against: opts.verify_against,
      }),
      ok,
      at: new Date().toISOString(),
    });
  } catch {
    /* session might have been closed mid-iteration; skip tracing */
  }
  if (typeof pool.getTryGeneratorStats !== 'function') return undefined;
  const stats = pool.getTryGeneratorStats(opts.session_id) as {
    with_verify_against: number;
    total: number;
  } | null;
  if (!stats) return undefined;
  return opts.verify_against ? stats.with_verify_against : stats.total;
}

interface TryGeneratorVerification {
  expectedBytes: Uint8Array | null;
  starterIgnoredHint?: string;
  resolvedWsUrl?: string;
  error?: TryGeneratorResult;
}

async function resolveTryGeneratorVerification(
  opts: TryGeneratorArgs,
): Promise<TryGeneratorVerification> {
  const v = opts.verify_against;
  if (!v) return { expectedBytes: null };

  if ('base64' in v) {
    try {
      return { expectedBytes: new Uint8Array(Buffer.from(v.base64, 'base64')) };
    } catch (e) {
      return {
        expectedBytes: null,
        error: {
          ok: false,
          error: `verify_against.base64 is not a valid base64 string: ${(e as Error).message}`,
        },
      };
    }
  }

  if (!opts.session_id) {
    return {
      expectedBytes: null,
      error: {
        ok: false,
        error:
          'verify_against.ws_i/ws_hash requires session_id so the captured ws frame can be looked up',
      },
    };
  }

  let session;
  try {
    session = pool.getSession(opts.session_id);
  } catch (e) {
    return {
      expectedBytes: null,
      error: { ok: false, error: `unknown session_id: ${(e as Error).message}` },
    };
  }

  const driver = pool.driverFor(opts.session_id);
  await driver.getInterceptedWebSocketFrames(session).catch(() => []);
  const { resolveWsFrame } = await import('../response/ws-pin');
  const resolved = resolveWsFrame(session, {
    ...('ws_i' in v ? { ws_i: v.ws_i } : {}),
    ...('ws_hash' in v ? { ws_hash: v.ws_hash } : {}),
  });
  if (!resolved) {
    const handle = 'ws_hash' in v ? `hash "${v.ws_hash}"` : `index ${v.ws_i}`;
    return {
      expectedBytes: null,
      error: {
        ok: false,
        error: `no ws frame at ${handle} (not pinned, not in ring; session has ${(session.wsFrames ?? []).length} frames captured)`,
      },
    };
  }

  const frame = resolved.frame;
  let starterIgnoredHint: string | undefined;

  // Starter-ignore detector: if inspect_ws_frame previously emitted a starter
  // for this frame and this first verified iteration ignores it, nudge the
  // agent toward the free known-good attempt.
  const wsIForStarter = resolved.i ?? ('ws_i' in v ? v.ws_i : -1);
  const issuedStarter = findIssuedStarter(opts.session_id, wsIForStarter);
  if (issuedStarter && !codeReferencesStarter(opts.code, issuedStarter)) {
    const stats0 =
      typeof pool.getTryGeneratorStats === 'function'
        ? (pool.getTryGeneratorStats(opts.session_id) as { with_verify_against: number } | null)
        : null;
    if (!stats0 || stats0.with_verify_against === 0) {
      starterIgnoredHint =
        `You skipped the starter generator returned by inspect_ws_frame(ws_hash: ${resolved.hash}).starter — ` +
        `it returns ok:true on iteration 1 for the captured-args case, ` +
        `which confirms envelope shape in one round and turns the rest into refactor-not-discover. ` +
        `If you had a reason to write from scratch, disregard.`;
    }
  }

  if (resolved.stale_upgrade_note) {
    starterIgnoredHint = starterIgnoredHint
      ? `${resolved.stale_upgrade_note}\n\n${starterIgnoredHint}`
      : resolved.stale_upgrade_note;
  }

  return {
    expectedBytes: new Uint8Array(Buffer.from(frame.payload, 'binary')),
    resolvedWsUrl: frame.url,
    ...(starterIgnoredHint !== undefined ? { starterIgnoredHint } : {}),
  };
}

export async function tryGenerator(opts: TryGeneratorArgs): Promise<TryGeneratorResult> {
  if (typeof opts.code !== 'string' || opts.code.length === 0) {
    return { ok: false, error: 'code is required (non-empty string)' };
  }
  const encoding = opts.encoding ?? 'binary';
  const args = opts.args ?? {};

  const verification = await resolveTryGeneratorVerification(opts);
  if (verification.error) return verification.error;
  const { expectedBytes, starterIgnoredHint, resolvedWsUrl } = verification;

  const recordAttempt = (ok: boolean): number | undefined => recordTryGeneratorAttempt(opts, ok);

  let output: string;
  try {
    output = runGeneratorCode(opts.code, args);
  } catch (e) {
    const attempt_in_session = recordAttempt(false);
    return {
      ok: false,
      error: (e as Error).message,
      ...(attempt_in_session !== undefined ? { attempt_in_session } : {}),
      ...(starterIgnoredHint !== undefined ? { runtime_hint: starterIgnoredHint } : {}),
    };
  }

  const clippedOutput =
    output.length > TRY_GENERATOR_OUTPUT_CAP ? output.slice(0, TRY_GENERATOR_OUTPUT_CAP) : output;

  if (!expectedBytes) {
    const attempt_in_session = recordAttempt(true);
    // No verify_against was passed, so no decoded byte buffer exists to
    // measure. Report the encoded-string length — the only length we have.
    // Callers that also passed a verify_against get the decoded byte length
    // below, same unit as expected_length.
    return {
      ok: true,
      output: clippedOutput,
      output_length: output.length,
      ...(attempt_in_session !== undefined ? { attempt_in_session } : {}),
      ...(starterIgnoredHint !== undefined ? { runtime_hint: starterIgnoredHint } : {}),
    };
  }

  // Decode the output to bytes for comparison. Binary path base64-decodes; text
  // path treats the string as raw octets.
  let gotBytes: Uint8Array;
  if (encoding === 'binary') {
    try {
      gotBytes = new Uint8Array(Buffer.from(output, 'base64'));
    } catch (e) {
      const attempt_in_session = recordAttempt(false);
      // base64 decode failed, so no gotBytes exists. Report the raw string
      // length — the only number we have here.
      return {
        ok: false,
        output: clippedOutput,
        output_length: output.length,
        error: `encoding:"binary" requires the generator to return a valid base64 string, but Buffer.from failed: ${(e as Error).message}`,
        ...(attempt_in_session !== undefined ? { attempt_in_session } : {}),
        ...(starterIgnoredHint !== undefined ? { runtime_hint: starterIgnoredHint } : {}),
      };
    }
  } else {
    gotBytes = new Uint8Array(Buffer.from(output, 'binary'));
  }

  const diff = diffBinary(expectedBytes, gotBytes);
  if (diff.ok) {
    const attempt_in_session = recordAttempt(true);
    const autoPersist = autoPersistGeneratorSuccess(
      opts.session_id,
      opts.code,
      opts.args ?? {},
      encoding === 'binary' ? 'base64' : 'string',
      expectedBytes.length,
    );
    const next_save_hint = buildNextSaveHint(resolvedWsUrl, autoPersist !== null);
    return {
      ok: true,
      output: clippedOutput,
      // Decoded byte length, same unit as expected_length. For binary encoding,
      // output.length would be base64-string chars (4/3 of byte count) and
      // create a misleading apparent mismatch.
      output_length: gotBytes.length,
      expected_length: expectedBytes.length,
      ...(attempt_in_session !== undefined ? { attempt_in_session } : {}),
      ...(starterIgnoredHint !== undefined ? { runtime_hint: starterIgnoredHint } : {}),
      ...(autoPersist ? { auto_persisted_as_verified_expression: autoPersist } : {}),
      ...(next_save_hint ? { next_save_hint } : {}),
    };
  }

  // Structural match (opt-in via opts.match === 'structural'): if byte-level
  // diff failed but the agent asked for shape-only comparison, re-check via
  // JSON-structural comparison. Useful when the envelope is right and only
  // value differences remain — byte- perfect convergence has diminishing
  // returns past that point.
  if (opts.match === 'structural') {
    const { structuralMatch } = await import('../response/structural-match');
    const struct = structuralMatch(expectedBytes, gotBytes);
    if (struct.ok) {
      const attempt_in_session = recordAttempt(true);
      const autoPersist = autoPersistGeneratorSuccess(
        opts.session_id,
        opts.code,
        opts.args ?? {},
        encoding === 'binary' ? 'base64' : 'string',
        expectedBytes.length,
      );
      const next_save_hint = buildNextSaveHint(resolvedWsUrl, autoPersist !== null);
      return {
        ok: true,
        output: clippedOutput,
        output_length: gotBytes.length,
        expected_length: expectedBytes.length,
        structural_match: struct.info,
        ...(attempt_in_session !== undefined ? { attempt_in_session } : {}),
        ...(starterIgnoredHint !== undefined ? { runtime_hint: starterIgnoredHint } : {}),
        ...(autoPersist ? { auto_persisted_as_verified_expression: autoPersist } : {}),
        ...(next_save_hint ? { next_save_hint } : {}),
      };
    }
    // Structural mismatch — fall through to the normal byte-diff failure
    // reporting, but attach the structural diag so the agent can see where the
    // shapes diverge (typically a much clearer signal than a byte offset).
    (diff as { structural_match?: unknown }).structural_match = {
      ...struct.info,
      diff: struct.diff,
    };
  }

  // Convergence signal: read the per-session ring buffer of recent diffs BEFORE
  // recording this iteration, so `recent` reflects history relative to
  // `current`. Then push this iteration onto the ring buffer for the next
  // call's signal.
  const attempt_in_session = recordAttempt(false);
  const iteration = attempt_in_session ?? 1;
  let convergence: ReturnType<typeof computeConvergence> | undefined;
  if (
    diff.first_diff_offset !== undefined &&
    typeof pool.getRecentDiffs === 'function' &&
    typeof pool.recordTryGeneratorDiff === 'function' &&
    opts.session_id
  ) {
    const recent = pool.getRecentDiffs(opts.session_id) as Array<{
      first_diff_offset: number;
      expected_length: number;
      output_length: number;
      attempt: number;
    }>;
    convergence = computeConvergence(
      {
        first_diff_offset: diff.first_diff_offset,
        expected_length: diff.expected_length,
        output_length: diff.got_length,
      },
      recent,
      iteration,
    );
    pool.recordTryGeneratorDiff(opts.session_id, {
      attempt: iteration,
      first_diff_offset: diff.first_diff_offset,
      expected_length: diff.expected_length,
      output_length: diff.got_length,
    });
  }

  // Spread diff first so it supplies all the metrics, then overwrite ok +
  // output + output_length with the outer contract's values. The inverse order
  // collides on `ok` per TS TS2783. `output_length` is the decoded byte length
  // (same unit as expected_length), not the encoded-string length.
  return {
    ...diff,
    ok: false,
    output: clippedOutput,
    output_length: gotBytes.length,
    ...(attempt_in_session !== undefined ? { attempt_in_session } : {}),
    ...(convergence !== undefined ? { convergence } : {}),
    ...(starterIgnoredHint !== undefined ? { runtime_hint: starterIgnoredHint } : {}),
  };
}

export interface TryGeneratorInPageArgs {
  session_id: string;
  /**
   * A JS expression evaluated in the live page via driver.evaluateExpression.
   * The expression is interpolated with {{paramName}} against `args` first. It
   * must produce a string — hex or base64 encoding per `returns`. Identical
   * shape to a `frameFromPage.expression` so a successful try_generator_in_page
   * can land directly as a saved strategy.
   */
  expression: string;
  /** Template args substituted into `expression`. */
  args?: Record<string, unknown>;
  /** How the expression's return string is decoded to bytes for comparison. */
  returns?: 'hex' | 'base64';
  /** Ground truth — the captured ws frame the output must byte-match.
   *  Accepts the positional index (ws_i — fragile across ring rotation)
   *  or the stable content hash (ws_hash — survives rotation, required
   *  for pinned frames). Prefer ws_hash for any loop that spans multiple
   *  iterations. */
  verify_against: { ws_i: number } | { ws_hash: string };
  /** Timeout in ms for the page-side eval. Default 5000, capped 30000. */
  timeout_ms?: number;
  /** `'bytes'` (default) or `'structural'` — see try_generator's match
   *  field for semantics. */
  match?: 'bytes' | 'structural';
}

/**
 * Page-side mirror of `try_generator`: runs a `frameFromPage`-shaped expression
 * in the live page, decodes its hex/base64 output to bytes, and diffs against a
 * captured ws frame. Gives the agent the same convergence feedback loop
 * `try_generator` gives for Node-VM generators, but for expressions that can
 * read `document` / `window.*` / live session state.
 *
 * A successful run (ok:true) means the expression can be saved verbatim as
 * `frameFromPage.expression` on a `page-script` strategy.
 */
export async function tryGeneratorInPage(opts: TryGeneratorInPageArgs): Promise<
  | {
      ok: true;
      output_length: number;
      expected_length: number;
      attempt_in_session?: number;
      /** Set when the runtime detected the passed ws_i was stale and
       *  auto-upgraded to the previously-resolved hash. See ws-pin.ts. */
      stale_upgrade_note?: string;
    }
  | ({
      ok: false;
      error?: string;
      output?: string;
      output_length?: number;
      stale_upgrade_note?: string;
      attempt_in_session?: number;
      convergence?: import('../response/convergence').ConvergenceSignal;
    } & Partial<import('../response/generator-diff').GeneratorDiff>)
> {
  if (!opts.session_id) return { ok: false, error: 'session_id is required' };
  if (typeof opts.expression !== 'string' || opts.expression.length === 0) {
    return { ok: false, error: 'expression is required (non-empty string)' };
  }
  if (opts.expression.length > 4096) {
    return { ok: false, error: 'expression must be ≤ 4096 chars' };
  }
  const returns: 'hex' | 'base64' = opts.returns ?? 'hex';
  const va = opts.verify_against;
  const vaHasI = 'ws_i' in va && typeof va.ws_i === 'number';
  const vaHasHash = 'ws_hash' in va && typeof va.ws_hash === 'string' && va.ws_hash.length > 0;
  if (!vaHasI && !vaHasHash) {
    return {
      ok: false,
      error: 'verify_against requires ws_i or ws_hash (prefer ws_hash — survives ring rotation)',
    };
  }
  const timeoutMs = Math.min(Math.max(opts.timeout_ms ?? 5000, 50), 30_000);

  let session;
  try {
    session = pool.getSession(opts.session_id);
  } catch (e) {
    return { ok: false, error: `unknown session_id: ${(e as Error).message}` };
  }
  const driver = pool.driverFor(opts.session_id);
  await driver.getInterceptedWebSocketFrames(session).catch(() => []);
  const { resolveWsFrame } = await import('../response/ws-pin');
  const resolved = resolveWsFrame(session, {
    ...(vaHasI ? { ws_i: (va as { ws_i: number }).ws_i } : {}),
    ...(vaHasHash ? { ws_hash: (va as { ws_hash: string }).ws_hash } : {}),
  });
  if (!resolved) {
    const handle = vaHasHash
      ? `hash "${(va as { ws_hash: string }).ws_hash}"`
      : `index ${(va as { ws_i: number }).ws_i}`;
    return {
      ok: false,
      error: `no ws frame at ${handle} (not pinned, not in ring; session has ${(session.wsFrames ?? []).length} frames)`,
    };
  }
  const frame = resolved.frame;
  const expectedBytes = new Uint8Array(Buffer.from(frame.payload, 'binary'));
  // Preserve the stale-ws_i auto-upgrade note so every exit path can surface it
  // on the response. The ring may have rotated between iterations — the agent
  // needs to see that ws_i was treated as its prior content, not whatever is at
  // that index now.
  const staleNote = resolved.stale_upgrade_note;

  // Interpolate args into the expression, then wrap so binary returns come back
  // as hex across the driver boundary.
  const interpolated = (() => {
    let e = opts.expression;
    for (const [k, v] of Object.entries(opts.args ?? {})) {
      const token = `{{${k}}}`;
      if (!e.includes(token)) continue;
      let s = '';
      if (typeof v === 'string') {
        s = v;
      } else if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') {
        s = String(v);
      } else if (v !== undefined && v !== null) {
        s = JSON.stringify(v);
      }
      e = e.split(token).join(s);
    }
    return e;
  })();
  const wrapped = wrapAgentExpression(interpolated);

  // Record every attempt against the same counter try_generator uses, so the
  // agent's "iteration N" narration stays consistent across sandbox and
  // page-side attempts.
  const recordAttempt = (ok: boolean): number | undefined => {
    if (typeof pool.recordTryGeneratorCall !== 'function') return undefined;
    pool.recordTryGeneratorCall(opts.session_id, { hadVerifyAgainst: true, ok });
    if (typeof pool.getTryGeneratorStats !== 'function') return undefined;
    const stats = pool.getTryGeneratorStats(opts.session_id) as {
      with_verify_against: number;
    } | null;
    return stats?.with_verify_against;
  };

  let result: unknown;
  try {
    result = await driver.evaluateExpression(session, wrapped, { timeoutMs });
  } catch (e) {
    const attempt_in_session = recordAttempt(false);
    return {
      ok: false,
      error: `page-side eval threw: ${e instanceof Error ? e.message : String(e)}`,
      ...(attempt_in_session !== undefined ? { attempt_in_session } : {}),
      ...(staleNote !== undefined ? { stale_upgrade_note: staleNote } : {}),
    };
  }
  if (typeof result !== 'string') {
    const attempt_in_session = recordAttempt(false);
    return {
      ok: false,
      error: `expression returned ${typeof result}; expected a string (hex or base64 per returns:"${returns}")`,
      ...(attempt_in_session !== undefined ? { attempt_in_session } : {}),
      ...(staleNote !== undefined ? { stale_upgrade_note: staleNote } : {}),
    };
  }
  let gotBytes: Uint8Array;
  try {
    gotBytes = new Uint8Array(Buffer.from(result, returns === 'base64' ? 'base64' : 'hex'));
  } catch (e) {
    const attempt_in_session = recordAttempt(false);
    return {
      ok: false,
      error: `returns:"${returns}" decode failed: ${e instanceof Error ? e.message : String(e)}`,
      output: result.slice(0, 2048),
      output_length: result.length,
      ...(attempt_in_session !== undefined ? { attempt_in_session } : {}),
      ...(staleNote !== undefined ? { stale_upgrade_note: staleNote } : {}),
    };
  }

  const diff = diffBinary(expectedBytes, gotBytes);
  if (diff.ok) {
    const attempt_in_session = recordAttempt(true);
    return {
      ok: true,
      output_length: result.length,
      expected_length: expectedBytes.length,
      ...(attempt_in_session !== undefined ? { attempt_in_session } : {}),
      ...(staleNote !== undefined ? { stale_upgrade_note: staleNote } : {}),
    };
  }

  // Structural match opt-in: see try_generator above for semantics.
  if (opts.match === 'structural') {
    const { structuralMatch } = await import('../response/structural-match');
    const struct = structuralMatch(expectedBytes, gotBytes);
    if (struct.ok) {
      const attempt_in_session = recordAttempt(true);
      return {
        ok: true,
        output_length: result.length,
        expected_length: expectedBytes.length,
        ...(attempt_in_session !== undefined ? { attempt_in_session } : {}),
        ...(staleNote !== undefined ? { stale_upgrade_note: staleNote } : {}),
      };
    }
    (diff as { structural_match?: unknown }).structural_match = {
      ...struct.info,
      diff: struct.diff,
    };
  }

  // Convergence signal: same ring-buffer logic as try_generator so the agent's
  // progress narration is continuous across both paths.
  const attempt_in_session = recordAttempt(false);
  const iteration = attempt_in_session ?? 1;
  let convergence: ReturnType<typeof computeConvergence> | undefined;
  if (
    diff.first_diff_offset !== undefined &&
    typeof pool.getRecentDiffs === 'function' &&
    typeof pool.recordTryGeneratorDiff === 'function'
  ) {
    const recent = pool.getRecentDiffs(opts.session_id) as Array<{
      first_diff_offset: number;
      expected_length: number;
      output_length: number;
      attempt: number;
    }>;
    convergence = computeConvergence(
      {
        first_diff_offset: diff.first_diff_offset,
        expected_length: diff.expected_length,
        output_length: diff.got_length,
      },
      recent,
      iteration,
    );
    pool.recordTryGeneratorDiff(opts.session_id, {
      attempt: iteration,
      first_diff_offset: diff.first_diff_offset,
      expected_length: diff.expected_length,
      output_length: diff.got_length,
    });
  }
  return {
    ...diff,
    ok: false,
    output: result.slice(0, 2048),
    output_length: result.length,
    ...(attempt_in_session !== undefined ? { attempt_in_session } : {}),
    ...(convergence !== undefined ? { convergence } : {}),
    ...(staleNote !== undefined ? { stale_upgrade_note: staleNote } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tool registry metadata
// ---------------------------------------------------------------------------

import { TOOL_NAMES } from '../vocab';
import type { ToolDef } from '../tools/types';

export const TOOL_DEFS: ToolDef[] = [
  {
    name: TOOL_NAMES.tryGenerator,
    description:
      'Dry-run a candidate `generated.<name>.code` snippet in the warm-execute vm sandbox, optionally diffing output byte-for-byte against a captured WebSocket frame. On `ok:false` the response names `first_diff_offset` + `expected_byte` + `got_byte` + a 16-byte hex context window on each side. Sandbox globals: `Date`, `Math`, `Buffer`, `JSON`, string/number helpers, `encodeURIComponent`/`decodeURIComponent`, `crypto` (`randomUUID`, `randomBytes`, `createHash`, `createHmac`), `args` (frozen). 100ms timeout. Must return a string; for binary, return base64. Full loop + convergence signals + structural-match mode: klura://reference#try-generator.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description:
            'Session ID from start_session. Required only when verify_against.ws_i is used so the captured ws frame can be looked up.',
        },
        code: {
          type: 'string',
          description:
            'The JS snippet to run. Identical shape to strategy.generated.<name>.code. Wrapped in an IIFE at runtime, must use `return` to emit the frame. Return a string; return base64 for binary frames (encoding:"binary").',
        },
        args: {
          type: 'object',
          description:
            'The `args` object exposed to the sandbox. Mirror the execute-time shape (e.g. {message: "hello"}). Pass the same values you\'d pass to execute() so the test matches reality.',
        },
        encoding: {
          type: 'string',
          enum: ['text', 'binary'],
          description:
            'How to interpret the generator\'s return string when diffing: "binary" (default) base64-decodes before comparing; "text" compares the string verbatim. Must match the strategy\'s frameEncoding.',
        },
        verify_against: {
          type: 'object',
          description:
            'Optional ground truth to diff against. One of {ws_i}, {ws_hash}, or {base64}. ws_hash preferred over ws_i (survives ring rotation). Omit to just run the code and return its output without diffing.',
          properties: {
            ws_i: { type: 'number', description: 'Positional ring-buffer index (fragile).' },
            ws_hash: { type: 'string', description: 'Stable content hash. Preferred.' },
            base64: {
              type: 'string',
              description:
                'Explicit ground-truth bytes as base64. Use when you already have the expected bytes in hand (e.g. from a prior get_network_log response) without needing a live session.',
            },
          },
        },
        match: {
          type: 'string',
          enum: ['bytes', 'structural'],
          description:
            '"bytes" (default) — byte-perfect match required. "structural" — extract JSON from both sides, compare shapes (keys + value types) while ignoring actual values. Use when the envelope is right and only rotating-value differences remain; skips the diminishing-returns byte-perfect convergence.',
        },
      },
      required: ['code'],
    },
    handler: (args: any) =>
      tryGenerator({
        session_id: args.session_id,
        code: args.code,
        args: args.args ?? {},
        verify_against: args.verify_against,
        encoding: args.encoding,
        match: args.match,
      }),
  },

  {
    name: TOOL_NAMES.tryGeneratorInPage,
    description:
      'Page-side sibling of `try_generator`: runs a `frameFromPage`-shaped expression in the LIVE page (via `driver.evaluateExpression`), decodes its hex/base64 output to bytes, and diffs against a captured ws frame. Gives you the same convergence feedback `try_generator` gives for Node-VM generators, but for expressions that can read `document` / `window.*` / live session state. A successful run (`ok:true`) means the expression can be saved verbatim as `frameFromPage.expression` on a `page-script` strategy. Use this when you hit the "HARD PIVOT — write the encoder yourself" path on a binary-WS nag: iterate your expression against the captured frame until bytes match, then save.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        expression: {
          type: 'string',
          description:
            'JS expression run in the live page. Interpolated with {{paramName}} against `args` before eval. Must produce a string encoded per `returns`.',
        },
        args: {
          type: 'object',
          description:
            'Template args substituted into the expression. Mirror the warm-execute shape.',
        },
        returns: {
          type: 'string',
          enum: ['hex', 'base64'],
          description: 'How the expression\'s return string is decoded to bytes. Default "hex".',
        },
        verify_against: {
          type: 'object',
          description:
            'Captured ws frame to compare output against. Accepts ws_i (positional, fragile across ring rotation) or ws_hash (content-addressed, survives rotation and works for pinned frames). Prefer ws_hash for any iteration loop.',
          properties: {
            ws_i: { type: 'number', description: 'Positional ring-buffer index (fragile).' },
            ws_hash: { type: 'string', description: 'Stable content hash. Preferred.' },
          },
        },
        timeout_ms: {
          type: 'number',
          description: 'Page-eval timeout in ms. Default 5000, capped 30000.',
        },
        match: {
          type: 'string',
          enum: ['bytes', 'structural'],
          description:
            '"bytes" (default) — byte-perfect match required. "structural" — shape-only comparison; see try_generator for details.',
        },
      },
      required: ['session_id', 'expression', 'verify_against'],
    },
    handler: (args: any) =>
      tryGeneratorInPage({
        session_id: args.session_id,
        expression: args.expression,
        args: args.args ?? {},
        match: args.match,
        returns: args.returns,
        verify_against: args.verify_against,
        timeout_ms: args.timeout_ms,
      }),
  },
];

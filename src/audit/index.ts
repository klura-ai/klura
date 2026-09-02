// Audit class — single shape that absorbs every save-time commitment check.
//
// Each save-time concern is expressed as a Detector (pure structural check,
// optional reason-ack) or a Classifier (agent commits to a structured answer,
// token-gated). The Audit composes them and presents the agent ONE response
// shape regardless of which dimensions fired.
//
// Why one class:
//  - Single token, single rejection envelope, single set of args. The
//    agent's tool description is one paragraph, not a stack.
//  - Adding a new save-time concern is one Detector or Classifier entry
//    in the audit's spec — no new tokens, no new args, no new rejection
//    formatter.
//  - Hash-scoping per dimension (hashFields) prevents cascade-invalidation
//    when sibling dimensions mutate unrelated payload fields.
//
// Operational levels (gates.md taxonomy) map to this class:
//  - Level 1 (self-attest boolean) — Detector with ackReason: 'none' that
//    emits an issue the agent must fix; no ack path. Rare in practice.
//  - Level 2 (acked warning with reason) — Detector with
//    ackReason: 'required'. Issue is shown; agent acks with {kind, reason}.
//  - Level 3 (token-gated commitment) — Classifier. Token bound to
//    hashFields(payload). Agent commits structured answers; runtime
//    cross-checks for consistency.
//
// See runtime/docs/gates.md and runtime/docs/principles.md §pre-commit
// gates for taxonomy rationale.

import { hashGatePayload } from '../gate/hash';
import { issueToken, lookupToken, consumeToken } from '../gate/store';
import { extractBundledIssues } from '../strategies/validate/bundled-issues';
import { diffSlices, itemsAreNonEmpty } from './slices';
import { rejectionToErrorMessage } from './rejection-format';

// ---------- Public types ----------

/**
 * The structural alternative a Classifier offers alongside a rejection.
 * Required on every Classifier — the build won't compile without it.
 * Reject-with-remedy is a top-level klura principle: if the audit knows X
 * is wrong, it must also surface the data the agent needs to recover, not
 * just complain. See `runtime/docs/principles.md` §"Reject with remedy."
 *
 * Detectors emit Issues with a `hint` string — that field already serves
 * the "what to do instead" surface for warnings (read inline by the agent
 * when the warning fires). Remedies are reserved for Classifier rejections
 * because the structured shape composes into the per-classifier rejection
 * envelope; warning hints are agent-prose, classifier remedies are
 * tool-callable data.
 *
 * Discriminated by `kind`. The `no_programmatic_remedy` variant is the
 * explicit opt-out — fine to use when no structural alternative exists, but
 * the `reason` field forces the author to articulate WHY there's no remedy.
 * Skipping the question is what we're closing the door on.
 */
export type Remedy =
  /** Set of values / labels this slot accepted, drawn from runtime
   *  observation. Use for enum / observed_values / literal_provenance:
   *  the agent's declared value isn't observed; here are the values that
   *  ARE. `source` is the per-tuple provenance string ("ui_click on
   *  Italian", "url_variance from /restaurants?cuisine=mexican",
   *  "api_response.results[0].label"). */
  | {
      kind: 'observed_alternatives';
      observed_values: ReadonlyArray<{ value: string; label?: string; source: string }>;
      note?: string;
    }
  /** Use for classifications where the agent picked a category that's
   *  rejected and there's a small enumerable set of valid categories.
   *  `rationale` per option lets the renderer say WHY each is right —
   *  beats a bare list of allowed strings. */
  | {
      kind: 'classification_options';
      options: ReadonlyArray<{ choice: string; rationale: string }>;
    }
  /** Use when the agent's value isn't an exact match of anything observed
   *  but close in some structural distance (e.g. shared substring against
   *  captured strings, host-prefix overlap against captured URLs). The
   *  `distance_metric` names what the candidate was scored on. */
  | {
      kind: 'closest_matches';
      candidates: ReadonlyArray<{ value: string; distance_metric: string }>;
    }
  /** Use when the right shape is structurally a different prereq kind
   *  (e.g. agent baked a literal that should be a `{kind: "capability"}`
   *  prereq pointing at a sibling lookup). Names which kind + why. */
  | {
      kind: 'capability_alternative';
      suggested_capability_kind: string;
      reasoning: string;
    }
  /** Cross-session evidence from the platform logbook — informational,
   *  not eligible for inline `observed_values` (this-session-only).
   *  Useful for "the universe is too big for this session, try Path B
   *  with `source: "capability:list_<entity>"`." */
  | {
      kind: 'cross_session_evidence';
      values: ReadonlyArray<string>;
      sessions_observed: number;
      advisory: string;
    }
  /** Explicit opt-out. Use when the runtime genuinely has no
   *  structural alternative (e.g. "you must call declare_capability
   *  before this") — the remedy isn't data, it's an action. The
   *  `reason` field is required so the author articulates why no
   *  programmatic remedy applies; reviewers can challenge the choice. */
  | { kind: 'no_programmatic_remedy'; reason: string };

export interface Issue {
  /** Stable id namespacing the warning, e.g. `observed_property_keys`,
   *  `unparametrized_session_id`. The kind doubles as the ack key —
   *  agents ack with {kind: "<this>", reason: "..."}. */
  kind: string;
  message: string;
  /** Optional one-line "what to do instead" string. Required-by-convention
   *  for ackable detectors (the hint IS the remedy surface for warnings;
   *  Classifier remedies live on the Classifier interface where they're
   *  load-bearing for the structured rejection). */
  hint?: string;
  /** Free-form per-detector context the agent reads. Echoed verbatim
   *  in the rejection. Optional. */
  context?: Record<string, unknown>;
}

export interface Detector<TPayload, TCtx> {
  kind: string;
  /** Pure structural check. Returns 0+ issues. Issues without a `kind`
   *  inherit the detector's kind. */
  detect: (payload: TPayload, ctx: TCtx) => Issue[];
  /** Whether the agent must ack each emitted issue with a {kind, reason}
   *  pair to proceed. `'required'` is the canonical Level-2 shape. `'none'`
   *  means an emitted issue blocks the save unconditionally — agent fixes
   *  the strategy or the save fails (rare; use when there's no legitimate
   *  exception path). */
  ackReason: 'required' | 'none';
  /** Optional per-detector ack-validation beyond "reason is non-empty."
   *  Use this to require a specific shape — e.g., ack must mention one of
   *  the flagged keys to prove the rejection was read (anti-canned-ack),
   *  or to validate structured fields on the ack (`covered_by: [<slug>]`
   *  validated against the on-disk strategy registry, etc.).
   *  Returns 0+ issue bullets when the ack is structurally insufficient.
   *  Called only when `ackReason === 'required'` AND the agent supplied a
   *  non-empty reason. */
  validateAck?: (ack: NormalizedAck, emittedIssues: Issue[]) => string[];
  /** How this detector applies on UNATTENDED runs (`Audit.runUnattended`)
   *  — saves with no agent in the loop to fix or ack anything (auto-synth,
   *  graduation, programmatic API). Default derives from `ackReason`:
   *  `'none'` → `'block'` (an unfixable invariant violation refuses the
   *  save), `'required'` → `'warn'` (the issue persists as an advisory the
   *  next attended session reads). Annotate explicitly when the default is
   *  wrong for this detector:
   *    - `'skip'` — the check encodes an agent-workflow obligation
   *      (triage-flow bookkeeping) that has no meaning without an agent.
   *    - `'warn'` on an `ackReason: 'none'` detector — the violation is
   *      real but the remedy requires agent work no unattended producer
   *      can perform (e.g. factoring a sibling capability); blocking would
   *      only strip fallback strategies. */
  unattendedPolicy?: 'block' | 'warn' | 'skip';
}

// Ack types + normalizer live in `./ack-types.ts` — re-exported so callers
// outside this module can pick them up from the canonical `audit` import.
export type { AckValue, StructuredAck, NormalizedAck } from './ack-types';
import { type AckValue, type NormalizedAck, normalizeAck } from './ack-types';

export interface Classifier<TPayload, TCtx, TAnswer> {
  kind: string;
  /** What the agent sees on the first rejection — the checklist of items
   *  to classify. Free-shape; runtime echoes it verbatim. */
  buildItems: (payload: TPayload, ctx: TCtx) => unknown;
  /** Cross-check structural consistency of the agent's answer against
   *  the payload + ctx. Returns 0+ issue bullets. */
  validate: (payload: TPayload, ctx: TCtx, answer: TAnswer) => string[];
  /** REQUIRED. One-line signature of the audit_answers slot shape this
   *  classifier accepts. Rendered into the rejection's `how_to_respond:`
   *  block so the agent's retry knows exactly what to pass. Format:
   *  `<classifier_kind>: <shape>` where `<shape>` uses TypeScript-ish
   *  union notation for human readability. Required because the items
   *  block alone (a JSON dump of unprocessed input) doesn't tell the
   *  agent what the OUTPUT shape should look like — without this signature
   *  agents loop on first-call pending rejections submitting the strategy
   *  with no audit_answers, hitting the same "items only, no per-item
   *  classifier_issues" path repeatedly. See `runtime/docs/principles.md`
   *  §"Reject with remedy" — same enforcement pattern as `remedy`.
   *  Examples:
   *    `literal_provenance: {<path>: "static" | {caller_input: "<param>"}
   *      | {prereq_output: "<binds>"} | "single_entity"}`
   *    `user_confirmation: {user_decision: "approve" | "reject",
   *      user_quote: "<verbatim user reply>"}`
   */
  expectedAnswerShape: string;
  /** REQUIRED. The structural alternative this classifier offers when
   *  validation rejects an answer. Returned alongside the rejection so the
   *  agent's retry doesn't have to guess. Use
   *  `{kind: "no_programmatic_remedy"}` when no structural alternative
   *  applies. See the `Remedy` union docs. */
  remedy: (payload: TPayload, ctx: TCtx) => Remedy;
  /** Project the payload + ctx to just the fields whose edits should
   *  invalidate this classifier's token. Defaults to whole payload — supply
   *  this to prevent cascade-invalidation when sibling dimensions touch
   *  unrelated fields, OR to bind the token to ctx-derived items (e.g.
   *  observed_siblings whose checklist comes from ctx, not payload). See
   *  the hash-scoping precedent in
   *  runtime/test/pre-save-audit.test.js §"Hash scoping". */
  hashFields?: (payload: TPayload, ctx: TCtx) => unknown;
  /** Optional advisory projection for UNATTENDED runs. Classifiers are
   *  agent-commitment surfaces — with no agent to answer, the token flow
   *  is meaningless, so `Audit.runUnattended` skips classifiers by
   *  default. A classifier whose underlying structural check still
   *  carries signal for the saved artifact (e.g. an under-parameterization
   *  advisory the next session reads off `runtime_meta.save_warnings`)
   *  supplies this projection; the issues land warn-tier, never
   *  blocking. */
  unattendedWarnings?: (payload: TPayload, ctx: TCtx) => Issue[];
}

/**
 * Stage 0 — pure structural / shape check that runs before detectors. Each
 * check throws `invalid_strategy: ...` (or the audit's domain-specific
 * `invalid_<kind>:` prefix when needed) on a single issue, OR a bundled
 * "N issues — fix all before retrying:\n  - ..." string for batched issues.
 * The Audit framework catches these throws, unpacks them via
 * `extractBundledIssues`, and surfaces them in one combined `invalid_shape`
 * rejection envelope — same shape as the existing detector rejection.
 *
 * No ack semantics: a malformed payload can't be "acknowledged through" —
 * the agent has to fix the shape before semantic detectors / classifiers
 * even run. Stage 0 has no `validateAck` hook by design.
 */
export interface ShapeCheck<TPayload, TCtx> {
  kind: string;
  check: (payload: TPayload, ctx: TCtx) => void;
}

export interface AuditSpec<TPayload, TCtx> {
  /** Stable id used as the token-store namespace + in rejection envelopes. */
  kind: string;
  /** Stage 0 — structural shape checks. Run before detectors; fail fast
   *  when payload doesn't parse. Optional (audits without shape concerns
   *  omit). */
  shapeChecks?: ShapeCheck<TPayload, TCtx>[];
  detectors: Detector<TPayload, TCtx>[];
  /** Heterogeneous array — each Classifier has its own TAnswer shape.
   *  Typed as `unknown` here because TypeScript can't infer per-element
   *  TAnswer in an array literal; each Classifier validates its own
   *  answer shape inside `validate()`. */
  classifiers: Classifier<TPayload, TCtx, unknown>[];
}

export interface AuditInput<TAnswers extends Record<string, unknown> = Record<string, unknown>> {
  token?: string;
  answers?: Partial<TAnswers>;
  /** Acks for Detector-emitted warnings. Keyed by Detector.kind; value
   *  is the agent's one-sentence reason. */
  acks?: Record<string, AckValue>;
  /** When true, skip token consumption on payload_changed and on commit.
   *  Lets a caller pre-check audit verdict cheaply (before paying probe
   *  cost) without spending the agent's token. Token MINTING still
   *  happens — the agent gets a real token they can submit later — only
   *  consumption is deferred until the canonical audit pass. Used by
   *  `tools/save-strategy.ts` to short-circuit rejected attempts before
   *  the DOM probe runs. */
  dryRun?: boolean;
  /** Test-only escape hatch: skip Stage 0 shape checks. Lets unit tests
   *  exercise individual detectors / classifiers against deliberately-
   *  minimal fixtures that wouldn't pass shape validation. Production
   *  callers (tools/save-strategy.ts and skills.saveStrategy) leave this
   *  unset so shape always runs. */
  skipShapeChecks?: boolean;
}

export interface AuditRejection {
  reason:
    | 'invalid_shape'
    | 'pending'
    | 'token_unknown_or_expired'
    | 'payload_changed'
    | 'answers_inconsistent'
    | 'unacked_warnings';
  /** Stage-0 shape issues (one bullet per check failure). Present only on
   *  `reason: 'invalid_shape'` rejections. */
  shape_issues?: string[];
  /** Token to echo on the next call. Present whenever any classifier has
   *  items to ask about. */
  token?: string;
  /** Per-classifier checklist items. Keyed by Classifier.kind. */
  items?: Record<string, unknown>;
  /** Detector warnings the agent must ack OR fix to proceed. Empty when
   *  no detector emitted issues. */
  warnings: Issue[];
  /** Subset of `warnings[].kind` whose Detector has `ackReason: 'none'`
   *  — these blocking warnings have NO ack path. The agent must
   *  restructure the strategy (or accept the save won't land); a
   *  `notes.save_warnings_acked` entry for one of these kinds is a no-op.
   *  Renderer uses this to mark the warning explicitly in the envelope
   *  so the generic "ack via notes.save_warnings_acked" prose doesn't
   *  mislead. */
  non_ackable_warning_kinds?: string[];
  /** Classifier validation issues — one bullet per inconsistency. */
  classifier_issues?: string[];
  /** Detector ack-shape issues (ack referenced unemitted kind, missing
   *  reason, etc.). Bundled with classifier_issues in the message. */
  ack_issues?: string[];
  /** Warning kinds the runtime registered as acked on THIS call. Acks are
   *  per-call (not remembered across retries) — a re-ack must resend these plus
   *  an ack for every still-listed warning. */
  currently_acked?: string[];
  /** Per-classifier structural remedy — the alternative the agent's
   *  retry should consider. Keyed by Classifier.kind. Present whenever a
   *  classifier was active (mints item-list or has validation issues). */
  classifier_remedies?: Record<string, Remedy>;
  /** Per-classifier audit_answers slot signature — composed into the
   *  rendered `how_to_respond:` line. Keyed by Classifier.kind, value is
   *  the raw shape string from `Classifier.expectedAnswerShape`. */
  classifier_answer_shapes?: Record<string, string>;
  /** Paths that changed between the prior token's hashed slices and the
   *  current retry's slices. Present only on `reason: 'payload_changed'`
   *  rejections. Each entry is prefixed with `(<classifier_kind>) ` so
   *  the agent sees which dimension's hash slice the field belongs to. */
  payload_diff?: string[];
}

export type AuditResult =
  | {
      status: 'committed';
      /** Warnings detectors emitted that were acked through. Consumers may
       *  persist these on the saved artifact so a later session sees what
       *  the prior agent acknowledged (without needing to re-run detectors). */
      warnings: Issue[];
    }
  | { status: 'rejected'; rejection: AuditRejection };

// ---------- Implementation ----------

export class Audit<TPayload, TCtx> {
  private readonly kind: string;
  private readonly shapeChecks: ShapeCheck<TPayload, TCtx>[];
  private readonly detectors: Detector<TPayload, TCtx>[];
  private readonly classifiers: Classifier<TPayload, TCtx, unknown>[];

  constructor(spec: AuditSpec<TPayload, TCtx>) {
    this.kind = spec.kind;
    this.shapeChecks = spec.shapeChecks ?? [];
    this.detectors = spec.detectors;
    this.classifiers = spec.classifiers;
  }

  /** Kinds of every composed Detector. Public so parity tests (and
   *  authoring-contract composers) can enumerate the audit's concern
   *  vocabulary without reaching into private spec state. */
  detectorKinds(): string[] {
    return this.detectors.map((d) => d.kind);
  }

  /** Kinds of every composed Classifier. Same purpose as `detectorKinds`. */
  classifierKinds(): string[] {
    return this.classifiers.map((c) => c.kind);
  }

  /**
   * Run Stage 0 shape checks alone. Use this when a caller needs to validate
   * shape independently of the full audit pipeline — typically programmatic
   * saves (auto-synth, tests) that lack the session context Stage 1/2
   * detectors and classifiers depend on. Throws `invalid_<kind>: ...` on
   * issue; returns void on success.
   */
  runShapeChecks(payload: TPayload, ctx: TCtx): void {
    const result = this.collectAuditShapeIssues(payload, ctx);
    if (result.length === 0) return;
    const rejection: AuditRejection = {
      reason: 'invalid_shape',
      shape_issues: result,
      warnings: [],
    };
    throw new Error(rejectionToErrorMessage(this.kind, rejection));
  }

  private collectAuditShapeIssues(payload: TPayload, ctx: TCtx): string[] {
    const out: string[] = [];
    for (const c of this.shapeChecks) {
      try {
        c.check(payload, ctx);
      } catch (e) {
        if (e instanceof Error) {
          // Strip leading `invalid_*: ` prefix so the renderer can re-attach
          // a single canonical wrapper; bundled "N issues — fix all" strings
          // get unpacked into individual bullets.
          const bare = e.message.replace(/^invalid_[a-z_]+:\s*/, '');
          const inner = extractBundledIssues(bare);
          if (inner) out.push(...inner);
          else out.push(bare);
        } else {
          throw e;
        }
      }
    }
    return out;
  }

  /**
   * Stage-1-only pass for saves with no agent in the loop (auto-synth,
   * graduation, programmatic API). Runs every Detector, splitting emitted
   * issues by each detector's `unattendedPolicy` (default: `ackReason
   * 'none'` → blocking, `'required'` → warning; `'skip'` omits the
   * detector), plus each Classifier's optional `unattendedWarnings`
   * projection (always warn-tier).
   *
   * Deliberately outside `process()`: the token flow is an agent-commitment
   * protocol — running `process({dryRun: true})` on every unattended save
   * would mint a token per save and pollute the gate store with entries no
   * agent will ever consume. No token is minted or consumed here; Stage 0
   * shape checks are the caller's job (`runShapeChecks`).
   */
  runUnattended(payload: TPayload, ctx: TCtx): { blocking: Issue[]; warnings: Issue[] } {
    const blocking: Issue[] = [];
    const warnings: Issue[] = [];
    for (const d of this.detectors) {
      const policy = d.unattendedPolicy ?? (d.ackReason === 'none' ? 'block' : 'warn');
      if (policy === 'skip') continue;
      for (const i of d.detect(payload, ctx)) {
        const kind = i.kind && i.kind.length > 0 ? i.kind : d.kind;
        (policy === 'block' ? blocking : warnings).push({ ...i, kind });
      }
    }
    for (const c of this.classifiers) {
      if (!c.unattendedWarnings) continue;
      for (const i of c.unattendedWarnings(payload, ctx)) {
        const kind = i.kind && i.kind.length > 0 ? i.kind : c.kind;
        warnings.push({ ...i, kind });
      }
    }
    return { blocking, warnings };
  }

  /**
   * Run the audit. Returns 'committed' iff Stage 0 shape checks pass AND
   * every detector is satisfied (no issues, or every issue acked) AND
   * every classifier has consistent answers under the current token.
   */
  process(payload: TPayload, ctx: TCtx, input: AuditInput): AuditResult {
    // ---------- Stage 0: shape checks ----------
    // No token is minted or consumed at this stage — the agent fixes shape
    // before any token-bearing dimension fires. Tests pass
    // `skipShapeChecks: true` to exercise downstream detectors against
    // deliberately-minimal fixtures.
    if (!input.skipShapeChecks) {
      const shapeIssues = this.collectAuditShapeIssues(payload, ctx);
      if (shapeIssues.length > 0) {
        return {
          status: 'rejected',
          rejection: { reason: 'invalid_shape', shape_issues: shapeIssues, warnings: [] },
        };
      }
    }

    // ---------- 1. Detectors run first (pure structural) ----------
    const allWarnings: Issue[] = [];
    for (const d of this.detectors) {
      const issues = d.detect(payload, ctx);
      for (const i of issues) {
        // Default the issue's kind to the detector's kind so the agent
        // can ack via {kind: "<detector_kind>", reason: ...}.
        const kind = i.kind && i.kind.length > 0 ? i.kind : d.kind;
        allWarnings.push({ ...i, kind });
      }
    }

    // ---------- 2. Detector ack-check ----------
    const detectorByKind = new Map(this.detectors.map((d) => [d.kind, d]));
    const acks = input.acks ?? {};
    const ackIssues: string[] = [];
    const ackedKinds = new Set<string>();
    for (const [ackKind, rawAck] of Object.entries(acks)) {
      const normalized = normalizeAck(rawAck);
      if (!normalized) {
        ackIssues.push(
          `acks["${ackKind}"] requires a non-empty reason — pass either a string ("the one-` +
            `sentence justification") or an object {reason: "...", covered_by?: [<slug>, ...]}`,
        );
        continue;
      }
      const emittedForKind = allWarnings.filter((w) => w.kind === ackKind);
      if (emittedForKind.length === 0) {
        // Pre-ack for a warning that didn't fire this run — no-op. The agent
        // may ack a warning it expects defensively; if the detector stays
        // silent there is nothing to suppress, so skip it rather than reject.
        // A typo'd ack for a warning that DID fire is still caught: the real
        // warning stays unacked and blocks the save downstream.
        continue;
      }
      // Per-detector ack-validation hook — preserves anti-canned-ack
      // semantics (e.g., ack must mention a flagged key) AND lets the
      // detector validate structural fields like `covered_by` against
      // its own ground truth.
      const det = detectorByKind.get(ackKind);
      if (det && det.validateAck) {
        const issues = det.validateAck(normalized, emittedForKind);
        if (issues.length > 0) {
          for (const i of issues) ackIssues.push(`acks["${ackKind}"]: ${i}`);
          continue;
        }
      }
      ackedKinds.add(ackKind);
    }

    // Any unacked warning whose detector requires an ack blocks the save.
    const unackedBlocking: Issue[] = [];
    for (const w of allWarnings) {
      const det = detectorByKind.get(w.kind);
      if (!det) continue; // shouldn't happen, but safe
      const requiredButUnacked = det.ackReason === 'required' && !ackedKinds.has(w.kind);
      // ackReason 'none' means the detector NEVER allows an ack path — emit always.
      const neverAckable = det.ackReason === 'none';
      if (requiredButUnacked || neverAckable) {
        unackedBlocking.push(w);
      }
    }

    // ---------- 3. Stage-1 gate: detectors must clear before classifiers run ----------
    // Stage 1 (detectors) and Stage 2 (classifiers) are sequential, not
    // batched. When detectors emit non-acked blocking issues OR ack-input
    // is malformed, return a detector-only rejection: no classifier
    // items, no token mint, no remedies. This is the explicit ordering
    // that prevents save-audit thrash:
    //   - Without sequencing, the agent gets shape errors AND
    //     classifier items in one rejection. They fix shape (mutating
    //     the body), the classifier token's hash binds against the new
    //     body, fresh token mints, previous round's audit_answers are
    //     invalidated. Each round resets one dimension of progress.
    //   - With sequencing, the agent fixes shape on a token-free
    //     rejection. Body mutations during Stage 1 don't invalidate
    //     anything. Once detectors clear, Stage 2 fires and the
    //     existing token-binding kicks in over a stable body.
    // The token-binding semantics don't change — only the timing of
    // when the token is first minted.
    if (unackedBlocking.length > 0 || ackIssues.length > 0) {
      const nonAckableKinds = unackedBlocking
        .filter((w) => detectorByKind.get(w.kind)?.ackReason === 'none')
        .map((w) => w.kind);
      return {
        status: 'rejected',
        rejection: {
          reason: 'unacked_warnings',
          warnings: unackedBlocking,
          ...(nonAckableKinds.length > 0 ? { non_ackable_warning_kinds: nonAckableKinds } : {}),
          ...(ackIssues.length > 0 ? { ack_issues: ackIssues } : {}),
          // Acked THIS call (per-call, not remembered) — see currently_acked doc.
          ...(ackedKinds.size > 0 ? { currently_acked: [...ackedKinds] } : {}),
        },
      };
    }

    // ---------- 4. Classifiers — token mint or validate ----------
    const activeClassifiers = this.classifiers.filter((c) => {
      const items = c.buildItems(payload, ctx);
      return itemsAreNonEmpty(items);
    });

    // Detectors clean, no classifiers active → committed.
    if (activeClassifiers.length === 0) {
      return { status: 'committed', warnings: allWarnings };
    }

    // Detectors clean, classifiers active. Token-mint or validate.
    const slices = this.sliceFor(payload, ctx, activeClassifiers);
    const payloadHash = hashGatePayload(slices);

    if (!input.token) {
      // First call: mint, reject.
      const token = issueToken({ kind: this.kind, payloadHash, hashInput: slices });
      return {
        status: 'rejected',
        rejection: {
          reason: 'pending',
          token,
          items: this.collectItems(payload, ctx, activeClassifiers),
          warnings: allWarnings,
          classifier_remedies: this.collectRemedies(payload, ctx, activeClassifiers),
          classifier_answer_shapes: this.collectAnswerShapes(activeClassifiers),
          ...(ackIssues.length > 0 ? { ack_issues: ackIssues } : {}),
        },
      };
    }

    const stored = lookupToken(input.token);
    if (!stored || stored.kind !== this.kind) {
      const token = issueToken({ kind: this.kind, payloadHash, hashInput: slices });
      return {
        status: 'rejected',
        rejection: {
          reason: 'token_unknown_or_expired',
          token,
          items: this.collectItems(payload, ctx, activeClassifiers),
          warnings: allWarnings,
          classifier_remedies: this.collectRemedies(payload, ctx, activeClassifiers),
          classifier_answer_shapes: this.collectAnswerShapes(activeClassifiers),
        },
      };
    }
    if (stored.payloadHash !== payloadHash) {
      if (!input.dryRun) consumeToken(input.token);
      const token = issueToken({ kind: this.kind, payloadHash, hashInput: slices });
      const payload_diff = diffSlices(stored.hashInput, slices);
      return {
        status: 'rejected',
        rejection: {
          reason: 'payload_changed',
          token,
          items: this.collectItems(payload, ctx, activeClassifiers),
          warnings: allWarnings,
          classifier_remedies: this.collectRemedies(payload, ctx, activeClassifiers),
          classifier_answer_shapes: this.collectAnswerShapes(activeClassifiers),
          ...(payload_diff.length > 0 ? { payload_diff } : {}),
        },
      };
    }

    // Token valid. Validate answers + ack-shape together. Pass undefined
    // through to the classifier's own validate when the answer slot is
    // missing — each classifier owns its missing-answer behavior (some
    // generate per-item "classify ${path}" prompts; user_confirmation
    // calls a registered SaveConfirmationDecider when the embedder
    // installed one). Short-circuiting here would hide both per-item
    // granularity and the decider hook.
    const answers = input.answers ?? {};
    const classifierIssues: string[] = [];
    for (const c of activeClassifiers) {
      const a = (answers as Record<string, unknown>)[c.kind];
      classifierIssues.push(...c.validate(payload, ctx, a));
    }

    if (classifierIssues.length > 0) {
      // Stage 1 already drained any unackedBlocking / ackIssues — by the
      // time we're in Stage 2, only classifier consistency can fail.
      return {
        status: 'rejected',
        rejection: {
          reason: 'answers_inconsistent',
          token: input.token,
          items: this.collectItems(payload, ctx, activeClassifiers),
          warnings: allWarnings,
          classifier_issues: classifierIssues,
          classifier_remedies: this.collectRemedies(payload, ctx, activeClassifiers),
          classifier_answer_shapes: this.collectAnswerShapes(activeClassifiers),
        },
      };
    }

    if (!input.dryRun) consumeToken(input.token);
    return { status: 'committed', warnings: allWarnings };
  }

  private sliceFor(
    payload: TPayload,
    ctx: TCtx,
    active: Classifier<TPayload, TCtx, unknown>[],
  ): Array<{ kind: string; fields: unknown }> {
    // Per-classifier hash slices. A classifier without hashFields
    // contributes the whole payload to its slice. The token binds to the
    // union of all active classifiers' relevant fields. Materialized (not
    // just hashed) so a payload_changed rejection can diff old vs. new and
    // tell the agent which fields shifted.
    return active.map((c) => ({
      kind: c.kind,
      fields: c.hashFields ? c.hashFields(payload, ctx) : payload,
    }));
  }

  private collectItems(
    payload: TPayload,
    ctx: TCtx,
    active: Classifier<TPayload, TCtx, unknown>[],
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const c of active) {
      out[c.kind] = c.buildItems(payload, ctx);
    }
    return out;
  }

  private collectRemedies(
    payload: TPayload,
    ctx: TCtx,
    active: Classifier<TPayload, TCtx, unknown>[],
  ): Record<string, Remedy> {
    const out: Record<string, Remedy> = {};
    for (const c of active) {
      // Fail loud: a Classifier without `remedy` shouldn't reach runtime —
      // TypeScript enforces required at the call site. If something slips
      // through (untyped factory, JS file, `as any` cast), throw rather
      // than ship a fake `no_programmatic_remedy` rejection to the agent.
      // Same posture as `validate everything the LLM emits`: the runtime
      // doesn't paper over its own contract violations.
      if (typeof c.remedy !== 'function') {
        throw new Error(
          `Classifier "${c.kind}" missing required field "remedy" — every classifier must declare one. ` +
            `Use {kind: "no_programmatic_remedy", reason: "<why no structural alternative applies>"} as the explicit opt-out.`,
        );
      }
      out[c.kind] = c.remedy(payload, ctx);
    }
    return out;
  }

  private collectAnswerShapes(
    active: Classifier<TPayload, TCtx, unknown>[],
  ): Record<string, string> {
    const out: Record<string, string> = {};
    for (const c of active) {
      // Fail loud: same posture as collectRemedies. The expected-answer
      // shape is the strongest helper in the rejection envelope; missing
      // it forces agents into the "items-only, no shape" loop the field
      // reports caught.
      if (typeof c.expectedAnswerShape !== 'string' || c.expectedAnswerShape.length === 0) {
        throw new Error(
          `Classifier "${c.kind}" missing required field "expectedAnswerShape" — every classifier must declare a one-line audit_answers slot signature.`,
        );
      }
      out[c.kind] = c.expectedAnswerShape;
    }
    return out;
  }
}

// The rejection formatter (single human-readable envelope for every audit
// rejection) lives in ./rejection-format — re-exported so callers keep the
// canonical `audit` import path.
export { rejectionToErrorMessage };
export type { RejectionFormatOpts } from './rejection-format';

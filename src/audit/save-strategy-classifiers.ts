// Pre-save-audit classifiers (Level-3, token-gated). Split out of
// save-strategy.ts to keep the main audit file under the per-file line
// cap; save-strategy.ts wires these into the Audit instance.

import type { Classifier } from './index';
import type { Strategy } from '../strategies/skills';
import type { SaveStrategyCtx } from './save-strategy';
import { composeUserPrompt } from './save-confirmation-prompt';
import { getRegisteredSaveConfirmationDecider } from './save-confirmation-decider';
import {
  findLookupSegments,
  hasLookupShapedPrereq,
  validateLiteralAnswer,
  validateNameJustification,
  validateObservedSiblings,
  validateCallerInputKindsAndEnums,
  listDeclaredPrereqBinds,
  type AuditAnswers,
  type LiteralClassification,
  type LiteralItem,
  type NameSegmentItem,
} from '../gate/save-audit';
import { collectScannedFields } from '../strategies/validate/helpers';

// Resolve the placeholders in a field's value. A field with a single distinct
// placeholder name `{{X}}` (any number of repetitions) is unambiguous: X
// either matches a declared prereq.binds (→ prereq_output) or it doesn't
// (→ caller_input). Multiple distinct placeholder names, or no placeholder
// at all, leave the field for the agent to classify.
function autoClassifyTemplatedItem(
  value: string,
  prereqBinds: ReadonlySet<string>,
): LiteralClassification | null {
  const names: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const open = value.indexOf('{{', cursor);
    if (open < 0) break;
    const close = value.indexOf('}}', open + 2);
    if (close < 0) break;
    names.push(value.slice(open + 2, close));
    cursor = close + 2;
  }
  const name = names[0];
  if (name === undefined) return null;
  const distinct = new Set(names);
  if (distinct.size !== 1) return null;
  return prereqBinds.has(name) ? { prereq_output: name } : { caller_input: name };
}

// Build the literal items the agent classifies. Each item carries an
// `auto_classified` field when the runtime can derive the classification
// directly from the strategy's placeholders + prereq.binds — the agent is
// free to omit `audit_answers.literal_provenance[<path>]` for those entries
// and the audit fills in.
function literalItems(data: Strategy): LiteralItem[] {
  const fields = collectScannedFields(data);
  const prereqBinds = new Set(listDeclaredPrereqBinds(data));
  return fields.map((f) => {
    const auto = autoClassifyTemplatedItem(f.value, prereqBinds);
    return auto
      ? { path: f.path, value: f.value, auto_classified: auto }
      : { path: f.path, value: f.value };
  });
}

// literal_provenance — for each scanned literal in URL / header / body /
// recorded-path step values, agent classifies as
// "static" | {caller_input: "<param>"} | {prereq_output: "<binds>"} | "single_entity".
// Cross-checks include orphan-path rejection, placeholder-binding consistency,
// caller-input kind/enum grounding.
//
// hashFields scoped to JUST the literal items. Mutating prereq.expression,
// notes.save_warnings_acked, etc. doesn't invalidate the token. Same fix as
// the cascade-invalidation work earlier this session.
export const literalProvenanceClassifier: Classifier<Strategy, SaveStrategyCtx, unknown> = {
  kind: 'literal_provenance',
  expectedAnswerShape:
    'literal_provenance: {<path>: "static" | {caller_input: "<param>"} | {prereq_output: "<binds>"} | "single_entity"} ' +
    '— DEFAULT SUSPICIOUS: only "static" for tokens that will be the same on every future call regardless of caller ' +
    '(API paths, query-param KEYS like `?foo=`, hostnames, HTTP methods, scheme tokens). Anything you saw in observed ' +
    'traffic, anything the user typed, any value that could rotate across callers → caller_input (a `{{placeholder}}` ' +
    'fed by an arg) or prereq_output (resolved by a fetch-extract / page-extract / capability prereq). When in doubt, ' +
    'parameterize. "single_entity" is rare — only when the strategy is intentionally fixed to one entity AND that entity ' +
    'appears as `notes.params.<x>.example`.',
  buildItems: (data) => literalItems(data),
  hashFields: (data) => literalItems(data),
  validate: (data, ctx, answer) => {
    const items = literalItems(data);
    const rawProvenance = (answer ?? {}) as Record<string, unknown>;
    // Value-key tolerance: agents commonly key answers by the literal value
    // (e.g. "/api/x?q={{n}}") instead of the field path (e.g. "endpoint").
    // Both fields are visible in the items checklist; the value is the more
    // memorable string. Resolve any value-keyed answers to their path before
    // validating, so the agent's intent lands in `provenance` regardless of
    // which field they keyed by. Path-keyed entries always win on collision.
    const valueToPath = new Map<string, string>();
    for (const item of items) {
      if (!valueToPath.has(item.value)) valueToPath.set(item.value, item.path);
    }
    const provenance: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(rawProvenance)) {
      const resolvedPath = valueToPath.get(key);
      if (
        resolvedPath !== undefined &&
        !Object.prototype.hasOwnProperty.call(rawProvenance, resolvedPath)
      ) {
        provenance[resolvedPath] = val;
      } else {
        provenance[key] = val;
      }
    }
    const effective: Record<string, unknown> = {};
    for (const item of items) {
      if (Object.prototype.hasOwnProperty.call(provenance, item.path)) {
        effective[item.path] = provenance[item.path];
      } else if (item.auto_classified !== undefined) {
        effective[item.path] = item.auto_classified;
      }
    }
    const issues: string[] = [];
    for (const item of items) {
      issues.push(
        ...validateLiteralAnswer(
          data,
          item,
          effective[item.path] as Parameters<typeof validateLiteralAnswer>[2],
          ctx.observedParamValues,
        ),
      );
    }
    const validPaths = new Set(items.map((i) => i.path));
    for (const path of Object.keys(provenance)) {
      if (!validPaths.has(path)) {
        issues.push(
          `literal_provenance["${path}"] is not a field in this strategy. ` +
            `Keys must be the field PATH (e.g. "endpoint", "headers.X-Foo", "body.userId"), not the literal value at that path. ` +
            `Valid paths: ${items.map((i) => JSON.stringify(i.path)).join(', ')}`,
        );
      }
    }
    issues.push(
      ...validateCallerInputKindsAndEnums(
        data,
        effective as Record<string, AuditAnswers['literal_provenance'][string]>,
        ctx.observedParamValues,
      ),
    );
    return issues;
  },
  remedy: (_data, ctx) => {
    // Surface every observed param value the audit knows about so the
    // agent's classification has the actual data to draw from. Each entry
    // becomes an "observed_alternatives" item the renderer formats inline
    // with the rejection.
    const observedValues: Array<{ value: string; label?: string; source: string }> = [];
    for (const [paramName, observations] of Object.entries(ctx.observedParamValues)) {
      for (const obs of observations) {
        observedValues.push({
          value: `${paramName}=${obs.value}`,
          label: obs.source.label,
          source: obs.source.kind,
        });
      }
    }
    if (observedValues.length === 0) {
      return {
        kind: 'no_programmatic_remedy',
        reason:
          "no captured observations bound to any param this session. Either drive the page until the value lands in a captured XHR / URL / response, OR re-classify the literal as `static` / `single_entity` if it really doesn't come from a caller arg or prereq.",
      };
    }
    return {
      kind: 'observed_alternatives',
      observed_values: observedValues,
      note: "each entry is one (param, value) tuple the runtime captured this session. The agent's `caller_input:<param>` classifications must match an observed param name, and the literal value must appear in the value side.",
    };
  },
};

// capability_name_justification — fires only when slug has a lookup-implying
// segment AND no lookup-shaped prereq (capability / fetch-extract) is
// declared. The agent must justify the gap or split off a lookup sibling.
export const capabilityNameJustificationClassifier: Classifier<Strategy, SaveStrategyCtx, unknown> =
  {
    kind: 'capability_name_justification',
    expectedAnswerShape:
      'capability_name_justification: "<one-sentence reason this slug doesn\'t need a lookup-shaped prereq>"',
    buildItems: (data, ctx): NameSegmentItem[] => {
      if (hasLookupShapedPrereq(data)) return [];
      const segments = findLookupSegments(ctx.capability);
      return segments.map((s) => ({
        segment: s,
        hint:
          `segment "${s}" implies a lookup step. Declare a prereq with method "capability" ` +
          `or "fetch-extract" that resolves the lookup, or justify in capability_name_justification.`,
      }));
    },
    hashFields: (data) => ({
      prerequisites: (data as { prerequisites?: unknown }).prerequisites,
    }),
    validate: (data, ctx, answer) => {
      return validateNameJustification(
        ctx.capability,
        data,
        typeof answer === 'string' ? answer : undefined,
      );
    },
    remedy: () => ({
      kind: 'capability_alternative',
      suggested_capability_kind: 'capability',
      reasoning:
        'a slug containing a lookup-implying segment (search/find/get/lookup/by-name) without a lookup-shaped prereq is structurally a name→id flow that should chain to a sibling lookup capability via `{kind: "capability"}`. Either declare the prereq, OR justify in capability_name_justification why this slug doesn\'t need one.',
    }),
  };

// observed_siblings — for each captured endpoint not covered by a saved
// strategy, agent classifies as "recorded" or "not_worth_recording:<reason>".
// Hash binds to the siblings list (sourced from ctx, not payload) so adding
// a new captured endpoint between save attempts invalidates the token —
// the checklist changed and prior answers no longer cover the full list.
export const observedSiblingsClassifier: Classifier<Strategy, SaveStrategyCtx, unknown> = {
  kind: 'observed_siblings',
  expectedAnswerShape:
    'observed_siblings: {"<METHOD url>": "recorded" | "not_worth_recording:<reason>"}',
  buildItems: (_data, ctx) => ctx.observedSiblings,
  hashFields: (_data, ctx) => ctx.observedSiblings,
  validate: (_data, ctx, answer) => {
    return validateObservedSiblings(ctx.observedSiblings, (answer ?? {}) as Record<string, string>);
  },
  remedy: () => ({
    kind: 'classification_options',
    options: [
      {
        choice: 'recorded',
        rationale:
          "this captured sibling endpoint represents a separate capability worth saving alongside the current one. The agent commits to recording it (via a separate save_strategy call) so the platform's capability set covers it.",
      },
      {
        choice: 'not_worth_recording:<reason>',
        rationale:
          "the captured sibling is infrastructure (analytics, telemetry, vendor SDK init, prefetch) and shouldn't be lifted to a saved capability. Provide a one-sentence reason naming what kind of infrastructure it is.",
      },
    ],
  }),
};

// user_confirmation — surfaces the proposed save to the user for explicit
// approval before commit. Tier-agnostic: covers fetch / page-script /
// recorded-path uniformly. The Classifier's buildItems composes a prompt
// the agent reads back to the user verbatim; the agent's reply lands in
// audit_answers.user_confirmation as {user_decision, user_quote}. Test
// harnesses bypass the round trip by registering a SaveConfirmationDecider
// that auto-decides based on a scenario predicate (see
// `runtime/src/audit/save-confirmation-decider.ts`).
//
// **Pre-resolve at buildItems time when a decider is registered + approves.**
// Otherwise the agent sees `user_confirmation` in the items list,
// recognizes it as a "user input required" surface, and ends the turn
// asking the (nonexistent) user for yes/no — even though the obligation
// paragraph mentions decider auto-resolution. The fix: when a decider
// is registered, run it upfront. Approve → return null so the classifier
// becomes inactive (no item, no token, no validate round-trip). Reject →
// fall through to the prompt path so the agent sees the rejection and
// can surface it to the user via the existing flow.
//
// hashFields is intentionally omitted (binds to the whole strategy). Every
// distinct save shape needs its own user approval — changing any field
// (tier, anchor_type, prereqs, headers, body, even notes) invalidates the
// approval and forces a fresh ask.
export const userConfirmationClassifier: Classifier<Strategy, SaveStrategyCtx, unknown> = {
  kind: 'user_confirmation',
  expectedAnswerShape:
    'user_confirmation: {user_decision: "approve" | "reject", user_quote: "<the user\'s fresh reply to THIS save\'s prompt_for_user — do NOT reuse their reply to triage_plan, surface_changed, or any earlier turn>"}',
  buildItems: (data, ctx) => {
    // Pre-resolve via the registered decider when one exists. If the
    // decider approves, return null → classifier becomes inactive →
    // user_confirmation never appears in items. The agent sees only the
    // structural classifiers (literal_provenance / capability_name /
    // observed_siblings), all of which they can answer without user input.
    //
    // Decider returns the canonical `{decision, quote}` shape (see
    // SaveConfirmationDecider in `save-confirmation-decider.ts`). The
    // audit-answer slot uses `{user_decision, user_quote}` keys —
    // skills.ts:418-435 does the transformation when feeding the answer
    // through the audit's validate path. This pre-resolve mirrors the
    // same transformation before checking shape, then drops the
    // classifier from items only when the transformed answer is shape-valid
    // AND approves. Reject answers fall through to the prompt path so the
    // existing surfacing code runs unchanged.
    const decider = getRegisteredSaveConfirmationDecider();
    if (decider) {
      try {
        const synthesized = decider.decide(data, ctx);
        if (synthesized.decision === 'approve' && synthesized.quote.trim().length > 0) {
          return null;
        }
      } catch {
        // Decider threw — fall through to prompt path; the validate step
        // re-invokes the decider with proper try/catch downstream.
      }
    }
    return {
      prompt_for_user: composeUserPrompt(data, ctx),
      agent_note:
        "Per-save confirmation. Relay `prompt_for_user` verbatim to the user as your text turn, wait for their fresh yes/no reply about THIS save, and submit that reply as `user_quote`. Do NOT reuse the user's reply to a prior `ack_checkpoint` (triage_plan, surface_changed) or any earlier turn — the runtime cannot structurally distinguish a fresh reply from a recycled one, so this contract is on the agent. Self-resolving the gate by recycling a reply defeats the gate's purpose.",
    };
  },
  validate: (data, ctx, answer) => {
    // If a SaveConfirmationDecider is registered, the runtime synthesizes
    // the answer before this validate runs (see Audit.process integration).
    // By the time we get here, the answer is either agent-supplied or
    // decider-supplied, and the validate is just shape-checking.
    if (answer === undefined || answer === null) {
      // Decider may have synthesized but the runtime didn't apply (defensive).
      const d = getRegisteredSaveConfirmationDecider();
      if (d) {
        const synthesized = d.decide(data, ctx);
        return validateAnswerShape(synthesized);
      }
      return [
        `audit_answers.user_confirmation is required. Read prompt_for_user from items.user_confirmation, ` +
          `relay it VERBATIM to the user as your text turn, wait for their fresh yes/no reply about THIS save, ` +
          `then retry with audit_answers.user_confirmation: ` +
          `{user_decision: "approve" | "reject", user_quote: "<their fresh reply>"}. ` +
          `Do NOT reuse the user's reply to a prior ack_checkpoint (triage_plan, surface_changed) or any earlier turn — ` +
          `the runtime cannot detect recycled replies, so the contract is on you.`,
      ];
    }
    return validateAnswerShape(answer);
  },
  remedy: () => ({
    kind: 'no_programmatic_remedy',
    reason:
      "user confirmation is the user's decision about THIS save. The runtime has no structural alternative to surface — relay the prompt_for_user prose verbatim to the user, wait for their fresh yes/no reply about this specific save, and submit it as user_quote. Reusing the user's reply to a prior ack_checkpoint or any earlier turn defeats the gate; freshness is on the agent.",
  }),
};

function validateAnswerShape(answer: unknown): string[] {
  if (!answer || typeof answer !== 'object') {
    return ['user_confirmation answer must be an object {user_decision, user_quote}'];
  }
  const a = answer as Record<string, unknown>;
  const decision = a.user_decision;
  const quote = a.user_quote;
  const issues: string[] = [];
  if (decision !== 'approve' && decision !== 'reject') {
    issues.push(
      `user_confirmation.user_decision must be "approve" or "reject" (got ${JSON.stringify(decision)})`,
    );
  }
  if (typeof quote !== 'string' || quote.trim().length === 0) {
    issues.push(
      "user_confirmation.user_quote must be a non-empty string with the user's verbatim reply",
    );
  }
  if (decision === 'reject' && typeof quote === 'string' && quote.trim().length > 0) {
    issues.push(
      `user_confirmation: the user declined this save shape (their reply: ${JSON.stringify(quote.slice(0, 200))}). ` +
        `Go back to LIFT and propose a different tier or anchor — ` +
        `for closure-locked sends try a module-anchor page-script (locate the send module via search_js_source); ` +
        `for unsigned XHRs try fetch + html-extract; for genuinely DOM-only flows, document why fetch / page-script can't work in notes.discovery before saving recorded-path.`,
    );
  }
  return issues;
}

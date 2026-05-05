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
// recorded-path uniformly. The Classifier's buildItems emits a structural
// fact-set the agent must convey; the agent composes the user-facing
// prompt in their own voice and submits it as `agent_prompt` alongside
// the user's reply. The runtime structurally checks that agent_prompt
// covers the load-bearing facts (capability slug, tier, target host,
// anchor classification when page-script, presence of warnings) — same
// pattern as `tierJustificationUnciteable` in `audit/triage-plan.ts`.
//
// Test harnesses bypass the round trip by registering a
// SaveConfirmationDecider; the runtime synthesizes the answer (including
// agent_prompt) so validate's fact-checks pass without the agent loop.
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

interface RequiredFacts {
  capability: string;
  tier: string;
  target: string;
  anchor_type?: string | null;
  warning_kinds: string[];
}

const WARNING_ACK_SYNONYMS = ['warning', 'flagged', 'issue', 'concern'];

function extractRequiredFacts(data: Strategy, ctx: SaveStrategyCtx): RequiredFacts {
  const s = data as Record<string, unknown>;
  const tier = typeof s.strategy === 'string' ? s.strategy : 'unknown';
  let target = '';
  if (tier === 'fetch' || tier === 'page-script') {
    const baseUrl = typeof s.baseUrl === 'string' ? s.baseUrl : '';
    const endpoint = typeof s.endpoint === 'string' ? s.endpoint : '';
    target = baseUrl + endpoint || baseUrl || endpoint;
  } else if (tier === 'recorded-path') {
    const steps = Array.isArray(s.steps) ? (s.steps as unknown[]) : [];
    const navStep = steps.find(
      (st) =>
        st &&
        typeof st === 'object' &&
        (st as { action?: unknown }).action === 'navigate' &&
        typeof (st as { url?: unknown }).url === 'string',
    );
    target = navStep ? (navStep as { url: string }).url : '';
  }
  const notes =
    s.notes && typeof s.notes === 'object' ? (s.notes as Record<string, unknown>) : undefined;
  const anchor_type = notes && typeof notes.anchor_type === 'string' ? notes.anchor_type : null;
  const meta =
    s.runtime_meta && typeof s.runtime_meta === 'object'
      ? (s.runtime_meta as Record<string, unknown>)
      : undefined;
  const rawWarnings = Array.isArray(meta?.save_warnings) ? (meta.save_warnings as unknown[]) : [];
  const warning_kinds: string[] = [];
  for (const w of rawWarnings) {
    if (w && typeof w === 'object') {
      const k = (w as { kind?: unknown }).kind;
      if (typeof k === 'string' && !warning_kinds.includes(k)) warning_kinds.push(k);
    }
  }
  return {
    capability: ctx.capability,
    tier,
    target,
    anchor_type,
    warning_kinds,
  };
}

/** Extract the host portion of a URL string. Returns the input verbatim if
 *  it doesn't parse — leniency for templated/partial targets. */
function targetHost(target: string): string {
  if (target.length === 0) return target;
  try {
    return new URL(target).host;
  } catch {
    return target;
  }
}

/** Structural fact-check on the agent-composed prompt. Mirrors the
 *  `tierJustificationUnciteable` pattern: the prompt phrasing is free,
 *  but it MUST surface every load-bearing fact the user needs to make an
 *  informed approve/reject. */
function checkPromptFacts(prompt: string, facts: RequiredFacts): string[] {
  const out: string[] = [];
  if (!prompt.includes(facts.capability)) {
    out.push(
      `user_confirmation.agent_prompt must mention the capability slug "${facts.capability}" verbatim — the user needs to know what's being saved.`,
    );
  }
  if (!prompt.includes(facts.tier)) {
    out.push(
      `user_confirmation.agent_prompt must mention the tier "${facts.tier}" verbatim — durability classification is load-bearing for the user's approval.`,
    );
  }
  if (facts.target.length > 0) {
    const host = targetHost(facts.target);
    const hasFullTarget = prompt.includes(facts.target);
    const hasHost = host.length > 0 && prompt.includes(host);
    // Endpoint path fallback — sometimes the agent shortens to just the path.
    const endpointPathMatch = /^https?:\/\/[^/]+(\/.*)$/.exec(facts.target);
    const hasPath =
      !!endpointPathMatch && endpointPathMatch[1] !== undefined && endpointPathMatch[1].length > 1
        ? prompt.includes(endpointPathMatch[1])
        : false;
    if (!hasFullTarget && !hasHost && !hasPath) {
      out.push(
        `user_confirmation.agent_prompt must mention the save target — host "${host}" or full target "${facts.target}" — the user needs to know where the call lands.`,
      );
    }
  }
  if (facts.tier === 'page-script' && facts.anchor_type) {
    // Either the literal anchor_type value, or the generic word "anchor"
    // (e.g. "module-anchored", "unclassified anchor"). Allows the agent to
    // describe `unknown` as "unclassified" or "fragile" without naming the
    // raw enum value.
    const hasAnchorWord = /anchor|fragile|durable|unclassified|module|protocol/i.test(prompt);
    const hasAnchorType = prompt.includes(facts.anchor_type);
    if (!hasAnchorWord && !hasAnchorType) {
      out.push(
        `user_confirmation.agent_prompt must convey the anchor classification (notes.anchor_type "${facts.anchor_type}") — durability of a page-script strategy is load-bearing for the user's approval.`,
      );
    }
  }
  if (facts.warning_kinds.length > 0) {
    const lower = prompt.toLowerCase();
    const acknowledgesWarning = WARNING_ACK_SYNONYMS.some((s) => lower.includes(s));
    if (!acknowledgesWarning) {
      out.push(
        `user_confirmation.agent_prompt must acknowledge the open warning(s) [${facts.warning_kinds
          .map((k) => `"${k}"`)
          .join(
            ', ',
          )}] — burying flagged concerns defeats the user-confirmation gate. Mention "warning" / "flagged" / "issue" / "concern" or name a kind verbatim.`,
      );
    }
  }
  return out;
}

export const userConfirmationClassifier: Classifier<Strategy, SaveStrategyCtx, unknown> = {
  kind: 'user_confirmation',
  expectedAnswerShape:
    'user_confirmation: {agent_prompt: "<the 1-3 sentence prompt you showed the user, in your own voice, mentioning the capability slug, tier, target host, anchor classification (when page-script), and any open warnings>", user_decision: "approve" | "reject", user_quote: "<the user\'s fresh reply — do NOT reuse their reply to triage_plan, surface_changed, or any earlier turn>"}',
  buildItems: (data, ctx) => {
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
    const facts = extractRequiredFacts(data, ctx);
    return {
      required_facts: facts,
      agent_note:
        'Compose a 1-3 sentence prompt to the user explaining what is about to be saved. Use your own voice — match the user\'s tone. The prompt MUST mention every fact in `required_facts`: the capability slug verbatim, the tier verbatim, the target host (or path), the anchor classification when tier is page-script, and at least the word "warning" / "flagged" / "issue" / "concern" when `warning_kinds` is non-empty. End with an explicit yes/no ask. Submit your prompt as `audit_answers.user_confirmation.agent_prompt`; submit the user\'s reply as `user_quote` and their decision as `user_decision`. Do NOT reuse the user\'s reply to a prior ack_checkpoint (triage_plan, surface_changed) or any earlier turn — the runtime cannot detect recycled replies, so freshness is on you. Self-resolving the gate by recycling a reply defeats the gate\'s purpose.',
      debug_prompt: composeUserPrompt(data, ctx),
    };
  },
  validate: (data, ctx, answer) => {
    if (answer === undefined || answer === null) {
      const d = getRegisteredSaveConfirmationDecider();
      if (d) {
        const synthesized = d.decide(data, ctx);
        return validateAnswerShape(synthesized, data, ctx);
      }
      return [
        `audit_answers.user_confirmation is required. Read \`required_facts\` from items.user_confirmation, ` +
          `compose a 1-3 sentence prompt in your own voice that mentions every fact, relay it to the user, ` +
          `wait for their fresh yes/no reply about THIS save, then retry with audit_answers.user_confirmation: ` +
          `{agent_prompt: "<the prompt you showed them>", user_decision: "approve" | "reject", user_quote: "<their fresh reply>"}. ` +
          `Do NOT reuse the user's reply to a prior ack_checkpoint (triage_plan, surface_changed) or any earlier turn — ` +
          `the runtime cannot detect recycled replies, so the contract is on you.`,
      ];
    }
    return validateAnswerShape(answer, data, ctx);
  },
  remedy: () => ({
    kind: 'no_programmatic_remedy',
    reason:
      "user confirmation is the user's decision about THIS save. The runtime has no structural alternative to surface — read `required_facts`, compose the prompt in your own voice covering every fact, relay it to the user, and submit their fresh reply as `user_quote`. Reusing the user's reply to a prior ack_checkpoint or any earlier turn defeats the gate; freshness is on the agent.",
  }),
};

function validateAnswerShape(answer: unknown, data: Strategy, ctx: SaveStrategyCtx): string[] {
  if (!answer || typeof answer !== 'object') {
    return ['user_confirmation answer must be an object {agent_prompt, user_decision, user_quote}'];
  }
  const a = answer as Record<string, unknown>;
  const agentPrompt = a.agent_prompt;
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
  // agent_prompt is required for both agent-supplied and synthesized answers.
  // The runtime's decider integration in skills.ts injects a deterministic
  // composeUserPrompt-rendered string as agent_prompt — that prose covers
  // every required fact by construction, so the fact-check passes for the
  // decider path without special-casing.
  if (typeof agentPrompt !== 'string' || agentPrompt.trim().length === 0) {
    issues.push(
      'user_confirmation.agent_prompt must be a non-empty string — the prose you showed the user when asking for their approval. Read `required_facts` from items.user_confirmation and compose a 1-3 sentence prompt in your own voice covering every fact.',
    );
  } else {
    const facts = extractRequiredFacts(data, ctx);
    issues.push(...checkPromptFacts(agentPrompt, facts));
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

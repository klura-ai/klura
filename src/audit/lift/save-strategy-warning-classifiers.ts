// Token-bound classifiers for save-time concerns that need anti-canned
// reason validation. Promoted from Detector{ackReason:'required',
// validateAck} → Classifier per gates.md taxonomy: anti-canned substring
// matching against candidate anchors is a halfway measure — the agent can
// canned-answer if their fixed phrase happens to substring-match a real
// anchor of the strategy. Token binding closes that bypass: the agent must
// consume a token minted by a real rejection to commit, and the token's
// hashFields scope cascade-invalidates if the relevant slice mutates.

import type { Classifier, Issue } from '../index';
import { escapeRegExp } from '../../utils/regex';
import type { Strategy } from '../../strategies/skills';
import type { SaveStrategyCtx } from './save-strategy';
import {
  detectMutatingStrategyVerificationApproach,
  detectParameterizationDisclosureRequired,
  collectExecutableJsStrings,
  VERIFICATION_SHAPE_TAGS,
  CLAIMING_VERIFICATION_TAGS,
  FIRE_AND_FORGET_JUSTIFYING_NOUNS,
  NON_DOM_VERIFICATION_MARKERS,
} from '../../gate/save-warnings';
import { findObservedKeys, findObservedLiterals } from '../../response/observation-trace';

// Matches the structural path tokens an ack reason can name, mirroring the
// shapes `collectStructuralPaths` emits (save-warnings-mutating-verification.ts).
// Used to catch a reason that *claims* an anchor the saved strategy doesn't
// carry — even when a valid shape tag is co-present, a fabricated path is a lie.
// Kept as separate simple patterns (not one big alternation) to stay clear of
// the ReDoS / regex-complexity lint thresholds; segment char-classes exclude
// `.` so a token stops at its segment boundary.
const CLAIMED_PATH_RES: readonly RegExp[] = [
  /response\.extract\.[\w-]+/g,
  /response\.extract/g,
  /response\.from/g,
  /prerequisites\[\d+\]\.name=[\w-]+/g,
  /prerequisites\[\d+\]/g,
  /frameFromPage\.expression/g,
  /frameFromPage/g,
  /headers\.[\w-]+/g,
  /body\.[\w-]+/g,
  /steps\[\d+\]/g,
];

function extractClaimedPaths(answer: string): string[] {
  const out = new Set<string>();
  for (const re of CLAIMED_PATH_RES) {
    for (const m of answer.matchAll(re)) out.add(m[0]);
  }
  return [...out];
}

// ---------- parameterization_disclosure_required ----------

export const parameterizationDisclosureClassifier: Classifier<Strategy, SaveStrategyCtx, unknown> =
  {
    kind: 'parameterization_disclosure_required',
    expectedAnswerShape:
      'parameterization_disclosure_required: "<one-sentence reason naming a structural anchor of the saved strategy + why no caller-varying axis applies>"',
    buildItems: (data) => {
      const warnings = detectParameterizationDisclosureRequired(data);
      const w = warnings[0];
      if (!w) return null;
      const rawAnchors = w.context?.candidate_anchors;
      const candidate_anchors: string[] = Array.isArray(rawAnchors)
        ? rawAnchors.filter((a): a is string => typeof a === 'string')
        : [];
      return {
        issue: w.message,
        hint: w.hint,
        candidate_anchors,
      };
    },
    hashFields: (data) => {
      const obj = data as Record<string, unknown>;
      return {
        endpoint: obj.endpoint,
        body: obj.body,
        headers: obj.headers,
        prerequisites: obj.prerequisites,
        steps: obj.steps,
      };
    },
    validate: (data, _ctx, answer) => {
      if (typeof answer !== 'string' || answer.trim().length === 0) {
        return [
          `parameterization_disclosure_required: missing or empty reason. Submit a one-sentence string naming a structural anchor (body field, endpoint segment, prereq name) of the saved strategy + why no caller-varying axis applies.`,
        ];
      }
      const warnings = detectParameterizationDisclosureRequired(data);
      const w = warnings[0];
      if (!w) return [];
      const rawAnchors = w.context?.candidate_anchors;
      const anchors: string[] = Array.isArray(rawAnchors)
        ? rawAnchors.filter((x): x is string => typeof x === 'string' && x.length > 0)
        : [];
      if (anchors.length === 0) {
        return [
          `parameterization_disclosure_required: strategy has no structural anchors (endpoint, body, headers, prereqs, steps all empty). Either populate the strategy with the captured request data or save a recorded-path with steps.`,
        ];
      }
      const matched = [...anchors]
        .sort((a, b) => b.length - a.length)
        .filter((a) => answer.includes(a));
      if (matched.length === 0) {
        const sample = anchors.slice(0, 8).join(', ');
        return [
          `parameterization_disclosure_required: reason must reference at least one structural anchor of the saved strategy. Candidates include: ${sample}${anchors.length > 8 ? ', …' : ''}. Bare prose like "no params apply" or "this capability takes no input" is rejected — name the body field / endpoint segment / prereq / header that proves the rejection was read.`,
        ];
      }
      return [];
    },
    remedy: () => ({
      kind: 'no_programmatic_remedy',
      reason:
        'declare notes.params with the caller-varying axes you observed during discovery, OR provide a one-sentence reason naming a real structural anchor of the saved strategy that proves no axis applies.',
    }),
  };

// ---------- mutating_verification_required ----------

export const mutatingVerificationClassifier: Classifier<Strategy, SaveStrategyCtx, unknown> = {
  kind: 'mutating_verification_required',
  expectedAnswerShape:
    'mutating_verification_required: "<verification approach + structural anchor — reference a real path of the saved strategy (e.g. response.extract.<field>, prerequisites[N], frameFromPage.expression) OR include a shape tag (transaction-shape / chat-shape / dom-poll / intrinsic-to-caller / rpc-read / fire-and-forget)>"',
  buildItems: (data) => {
    const warnings = detectMutatingStrategyVerificationApproach(data);
    const w = warnings[0];
    if (!w) return null;
    return {
      issue: w.message,
      hint: w.hint,
      anchor_type: w.context?.anchor_type,
      valid_paths: w.context?.valid_paths,
      shape: w.context?.shape,
    };
  },
  hashFields: (data) => {
    const obj = data as Record<string, unknown>;
    return {
      strategy: obj.strategy,
      method: obj.method,
      endpoint: obj.endpoint,
      headers: obj.headers,
      body: obj.body,
      frameFromPage: obj.frameFromPage,
      steps: obj.steps,
      response: obj.response,
    };
  },
  validate: (data, _ctx, answer) => {
    if (typeof answer !== 'string' || answer.trim().length === 0) {
      return [
        `mutating_verification_required: missing or empty reason. Submit a string naming the verification approach + structural anchor.`,
      ];
    }
    const warnings = detectMutatingStrategyVerificationApproach(data);
    const w = warnings[0];
    if (!w) return [];
    const ctx = w.context as { anchor_type?: string; valid_paths?: string[] } | undefined;
    const anchorType =
      typeof ctx?.anchor_type === 'string'
        ? (ctx.anchor_type as 'module' | 'protocol' | 'dom' | 'unknown')
        : 'unknown';
    const validPaths: string[] = Array.isArray(ctx?.valid_paths) ? ctx.valid_paths : [];
    const out: string[] = [];
    // A named structural path must actually exist on the saved strategy. This
    // fires even when a recognized shape tag is co-present: a tag doesn't make a
    // fabricated anchor real. Closes the "transaction-shape: response.extract.X"
    // loophole where the strategy carries no response.extract at all.
    const fabricated = extractClaimedPaths(answer).filter((p) => !validPaths.includes(p));
    if (fabricated.length > 0) {
      const real =
        validPaths.length > 0
          ? validPaths.slice(0, 12).join(', ')
          : '(none — the saved strategy carries no structural confirmation surface)';
      const named = fabricated.map((p) => `"${p}"`).join(', ');
      out.push(
        `mutating_verification_required: the reason names ${named}, ` +
          `which ${fabricated.length === 1 ? 'is not a real path' : 'are not real paths'} on the saved strategy. ` +
          `Reference an anchor that actually exists (${real}), or — if the action has no structural confirmation surface — ` +
          `use a shape tag that doesn't claim one (fire-and-forget / rpc-read / intrinsic-to-caller).`,
      );
      return out;
    }
    const shapeTagsUsed = VERIFICATION_SHAPE_TAGS.filter((t) => answer.includes(t));
    const matchedPaths = [...validPaths]
      .sort((a, b) => b.length - a.length)
      .filter((p) => answer.includes(p));
    if (shapeTagsUsed.length === 0 && matchedPaths.length === 0) {
      out.push(
        `mutating_verification_required: reason must name the verification approach by structural anchor. Either reference a real path of the saved strategy (e.g. response.extract.<field>, prerequisites[N], frameFromPage.expression) OR include a shape tag (transaction-shape / chat-shape / dom-poll / intrinsic-to-caller / rpc-read / fire-and-forget). Prose-only reasons are rejected.`,
      );
      return out;
    }
    if (shapeTagsUsed.includes('fire-and-forget')) {
      const lower = answer.toLowerCase();
      const justified = FIRE_AND_FORGET_JUSTIFYING_NOUNS.some((n) => lower.includes(n));
      if (!justified) {
        out.push(
          `mutating_verification_required: fire-and-forget tag requires a justifying noun naming the kind of unverified action: one of ${FIRE_AND_FORGET_JUSTIFYING_NOUNS.join(', ')}. Most mutating actions have a confirmation surface — fire-and-forget is rare and must be specific.`,
        );
      }
    }
    if (anchorType === 'module' || anchorType === 'protocol') {
      const hasOnlyDomPoll =
        shapeTagsUsed.includes('dom-poll') &&
        !shapeTagsUsed.some(
          (t) => t === 'transaction-shape' || t === 'chat-shape' || t === 'intrinsic-to-caller',
        );
      const hasNonDomMarker = NON_DOM_VERIFICATION_MARKERS.some((m) => answer.includes(m));
      if (hasOnlyDomPoll && !hasNonDomMarker) {
        out.push(
          `mutating_verification_required: anchor mismatch — strategy is ${anchorType}-anchored but verification is DOM-anchored (dom-poll). DOM polling becomes the fragility bottleneck — when the UI rewrites, verification breaks even though the underlying ${anchorType} call still works. Either re-anchor verification to ${anchorType}-tier surfaces (response.extract / window.require page-global readback / frameFromPage parsing the wire response), or down-classify notes.anchor_type to "dom".`,
        );
      }
    }
    // A claiming tag (transaction-shape / chat-shape / dom-poll) asserts the
    // strategy can OBSERVE the side effect landing — but `validPaths` now carries
    // only verification surfaces (response.extract / prereq / frameFromPage /
    // steps; request-side body.*/headers.* are excluded). If none exist, the tag
    // claims a confirmation surface the strategy doesn't have: a bare POST whose
    // only structure is its request body can't verify anything. Steer to a
    // no-surface tag instead. Runs after the anchor-mismatch check so a strategy
    // with both problems surfaces the more specific mismatch too.
    const claimingTagUsed = CLAIMING_VERIFICATION_TAGS.some((t) => answer.includes(t));
    // A `fetch` strategy whose response is JSON (format absent or "json") DOES
    // have a verification surface: execute() returns the parsed response body
    // verbatim, so `transaction-shape` ("the body returns {ok,id}") is honest
    // without a response.extract anchor — response.extract is HTML-only. Only
    // page-script (return is constructed) and fetch+format:"html" (need extract
    // to pull structured data from the page) require an explicit anchor.
    const dataObj = data as { strategy?: unknown; response?: { format?: unknown } };
    const isFetchJson = dataObj.strategy === 'fetch' && dataObj.response?.format !== 'html';
    if (claimingTagUsed && validPaths.length === 0 && !isFetchJson) {
      out.push(
        `mutating_verification_required: ${shapeTagsUsed.join(' / ')} claims the strategy can confirm the side effect, but it carries no verification surface (no response.extract, no prerequisite, no frameFromPage — only the request body, which can't verify a mutation). Either add a confirmation anchor (response.extract.<field> on an HTML response, or a follow-up read prereq) OR, if the action genuinely has no observable confirmation, use a no-surface tag: fire-and-forget / rpc-read / intrinsic-to-caller.`,
      );
    }
    return out;
  },
  remedy: () => ({
    kind: 'classification_options',
    options: [
      {
        choice: 'transaction-shape',
        rationale:
          'server returns a confirmation field. For JSON the body IS the confirmation (execute returns it verbatim) — reference the body field (e.g. "transaction-shape: response body returns {ok:true,id} confirming the write"). Use response.extract.<field> only for response.format="html".',
      },
      {
        choice: 'chat-shape',
        rationale:
          'read back our own outbound from the page after the call (e.g. "chat-shape: frameFromPage.expression polls thread DOM for the typed text appearing as outbound before returning").',
      },
      {
        choice: 'dom-poll',
        rationale:
          'fragile but sometimes the only signal — only valid for dom-anchored strategies (e.g. "dom-poll: verify_sent js-eval prereq polls .toast-success for 2s after publish").',
      },
      {
        choice: 'intrinsic-to-caller',
        rationale:
          'the next capability IS the verification (e.g. "intrinsic-to-caller — caller\'s next move is read_messages").',
      },
      {
        choice: 'rpc-read',
        rationale:
          'POST envelope is a read, not a mutation — GraphQL query, JSON-RPC read, search endpoint (e.g. "rpc-read: GraphQL query; response.data is the payload, no side effect").',
      },
      {
        choice: 'fire-and-forget',
        rationale:
          'rare; specific noun required — telemetry beacon, idempotent (e.g. "fire-and-forget — telemetry beacon, no UI surface, idempotent").',
      },
    ],
  }),
};

// ---------- observed_property_keys ----------

function collectObservedPropertyKeys(
  data: Strategy,
  ctx: SaveStrategyCtx,
): { issues: Issue[]; allKeys: Set<string> } {
  const issues: Issue[] = [];
  const allKeys = new Set<string>();
  if (!ctx.session) return { issues, allKeys };
  for (const { location, text } of collectExecutableJsStrings(data)) {
    const flagged = findObservedKeys(text, ctx.session);
    if (flagged.length === 0) continue;
    const observed_keys = Array.from(new Set(flagged.map((f) => f.key)));
    for (const k of observed_keys) allKeys.add(k);
    issues.push({
      kind: 'observed_property_keys',
      message:
        `${location} bakes observed property keys [${observed_keys.map((k) => JSON.stringify(k)).join(', ')}] ` +
        `inside ${JSON.stringify(text).slice(0, 120)}…`,
      hint: `Replace with a shape-walk: Object.values(window.X).find(v => typeof v?.<knownField> === "string").`,
      context: { location, observed_keys, expression: text },
    });
  }
  return { issues, allKeys };
}

export const observedPropertyKeysClassifier: Classifier<Strategy, SaveStrategyCtx, unknown> = {
  kind: 'observed_property_keys',
  expectedAnswerShape:
    'observed_property_keys: "<one-sentence reason that references at least one flagged key by name, proving the rejection was read>"',
  buildItems: (data, ctx) => {
    const { issues, allKeys } = collectObservedPropertyKeys(data, ctx);
    if (issues.length === 0) return null;
    return {
      flagged_keys: [...allKeys],
      occurrences: issues.map((i) => ({
        location: i.context?.location,
        observed_keys: i.context?.observed_keys,
      })),
    };
  },
  hashFields: (data) => collectExecutableJsStrings(data),
  validate: (data, ctx, answer) => {
    if (typeof answer !== 'string' || answer.trim().length === 0) {
      return [
        `observed_property_keys: missing or empty reason. Submit a one-sentence string referencing at least one flagged key by name.`,
      ];
    }
    const { allKeys } = collectObservedPropertyKeys(data, ctx);
    if (allKeys.size === 0) return [];
    const referenced = [...allKeys].some((k) => {
      const escaped = escapeRegExp(k);
      const re = new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'i');
      return re.test(answer);
    });
    if (!referenced) {
      const quotedKeys = [...allKeys].map((k) => `"${k}"`).join(', ');
      return [
        `observed_property_keys: reason must reference at least one flagged key (${quotedKeys}) ` +
          `to prove the rejection was read — a generic "intentional" doesn't pass.`,
      ];
    }
    return [];
  },
  remedy: () => ({
    kind: 'no_programmatic_remedy',
    reason:
      'replace observed property keys with a shape-walk that doesn\'t depend on names that rotate across deploys (e.g. Object.values(window.X).find(v => typeof v?.<knownField> === "string")), OR provide a one-sentence reason referencing the flagged key(s) by name to prove the rejection was read.',
  }),
};

// ---------- observed_literal_values ----------

function collectObservedLiteralValues(
  data: Strategy,
  ctx: SaveStrategyCtx,
): { issues: Issue[]; allValues: Set<string> } {
  const issues: Issue[] = [];
  const allValues = new Set<string>();
  if (!ctx.session) return { issues, allValues };
  const flagged = findObservedLiterals(data, ctx.session);
  for (const l of flagged) {
    if (typeof l.value === 'string') allValues.add(l.value);
    issues.push({
      kind: 'observed_literal_values',
      message:
        `${l.location} bakes the literal value ${JSON.stringify(l.value).slice(0, 80)} ` +
        `which the agent observed during this session — that's by-construction a per-session ` +
        `or per-deploy artifact (rotating token, nonce, signed header), not a stable contract.`,
      hint:
        `Template via a prereq: declare a js-eval prereq that re-derives the value from ` +
        `the live page on every call, bind it (e.g. \`binds: "nonce"\`), and reference \`{{nonce}}\` ` +
        `in the header / body.`,
      context: { location: l.location, value: l.value },
    });
  }
  return { issues, allValues };
}

export const observedLiteralValuesClassifier: Classifier<Strategy, SaveStrategyCtx, unknown> = {
  kind: 'observed_literal_values',
  expectedAnswerShape:
    'observed_literal_values: "<one-sentence reason that references at least one flagged literal value, proving the rejection was read>"',
  buildItems: (data, ctx) => {
    const { issues, allValues } = collectObservedLiteralValues(data, ctx);
    if (issues.length === 0) return null;
    return {
      flagged_values: [...allValues],
      occurrences: issues.map((i) => ({
        location: i.context?.location,
        value: i.context?.value,
      })),
    };
  },
  hashFields: (data) => {
    const obj = data as Record<string, unknown>;
    return {
      headers: obj.headers,
      body: obj.body,
      steps: obj.steps,
      endpoint: obj.endpoint,
    };
  },
  validate: (data, ctx, answer) => {
    if (typeof answer !== 'string' || answer.trim().length === 0) {
      return [
        `observed_literal_values: missing or empty reason. Submit a one-sentence string referencing at least one flagged literal value.`,
      ];
    }
    const { allValues } = collectObservedLiteralValues(data, ctx);
    if (allValues.size === 0) return [];
    const referenced = [...allValues].some((v) => answer.includes(v));
    if (!referenced) {
      const previews = [...allValues].map((v) => JSON.stringify(v.slice(0, 12) + '…'));
      return [
        `observed_literal_values: reason must reference at least one flagged literal value (e.g. ${previews.join(', ')}) ` +
          `to prove the rejection was read — a generic "intentional" doesn't pass.`,
      ];
    }
    return [];
  },
  remedy: () => ({
    kind: 'no_programmatic_remedy',
    reason:
      'template via a js-eval prereq that re-derives the value from the live page on every call, OR provide a one-sentence reason referencing the flagged value to prove the rejection was read.',
  }),
};

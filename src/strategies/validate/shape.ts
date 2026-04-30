// Top-level strategy shape validator. Runs the required-field / array-item /
// optional-field checks, then batches the independent deep validators
// (interrupts, notes, websocket, response, generated, base-url) so the agent
// gets one aggregated rejection instead of playing whack-a-mole through
// sequential save attempts.

import type { Strategy } from '../skills';
import { describeEnum, didYouMeanSuffix } from '../../validators';
import { describeStrategyTiers, ARRAY_ITEM_REQUIRES, ARRAY_ITEM_ENUMS } from './constants';
import { isPlainObject } from './helpers';
import { parseOrThrow } from '../schemas/zod-helpers';
import { strategySchemas } from '../schemas/strategy';
import { validatePrereqShape } from './prereqs';
import {
  validateRecordedPathStepShape,
  validateRecordedPathStepIdUniqueness,
} from './recorded-path';
import { validateInterrupts } from './interrupts';
import { validateNotesAnchorType } from './anchor-type';
import { validateWebSocketShape } from './websocket';
import { validateResponseShape } from './response';
import { validateGeneratedShape } from './generated';
import { validateNotesParamsShape, validateBaseUrlScheme, validateNotesAllowlist } from './notes';
import { validateCacheShape } from './cache';
import { validateProvidesShape } from './provides';

export function validateStrategyShape(data: unknown): asserts data is Strategy {
  if (!isPlainObject(data)) {
    throw new Error('invalid_strategy: expected an object');
  }
  const tier = typeof data.strategy === 'string' ? data.strategy : '';

  // Re-prime on any unrecognized tier. The LLM's training priors include
  // several hallucinated tier names (http-fetch, api-call, script, scrape, etc.)
  // reached for out of habit from other frameworks — rather than special-casing
  // each, present the current three-tier vocabulary inline whenever the
  // submitted tier doesn't match. The response becomes a one-paragraph tutorial
  // on the live shape at the exact moment the agent acts on the wrong habit.
  //
  // See principles.md §"Priming agents: close to execution" — error responses
  // are a documented re-priming surface.
  if (tier !== 'fetch' && tier !== 'page-script' && tier !== 'recorded-path') {
    const submitted = tier === '' ? '(missing)' : JSON.stringify(tier);
    throw new Error(
      `invalid_strategy: "strategy" = ${submitted} is not one of klura's tiers. The three tiers, in optimality order:\n${describeStrategyTiers()}\n\n` +
        `For a JS expression that drives the page's own send: {strategy:"page-script", protocol:"websocket", origin:"<page URL>", frameFromPage:{expression:"...", returns:"hex"|"base64"}, frameEncoding:"binary", notes:{anchor_type:"module"|"protocol", params:{...}}}. For a pure Node-VM byte-splice generator with no page dependency: {strategy:"fetch", protocol:"websocket", wsUrl:"<captured>", frameEncoding:"binary", generated:{frame:{code:"..."}}, notes:{params:{...}}}. klura stores only complete, runnable strategies on disk; iterative work belongs in the discovery_artifact via save_verified_expression / add_discovery_note / add_resume_pointer. Detail: klura://reference#strategy-schemas-overview.`,
    );
  }

  const tierSchema = strategySchemas[tier];
  parseOrThrow(tierSchema, data, {
    where: 'strategy',
    kindLabel: `tier:"${tier}"`,
    referenceSlug: `${tier}-schema`,
  });

  if (tier === 'recorded-path' && Array.isArray(data.steps)) {
    data.steps.forEach((item, i) => {
      if (!isPlainObject(item)) {
        throw new Error(`invalid_strategy: recorded-path.steps[${i}] must be an object`);
      }
      validateRecordedPathStepShape(i, item);
    });
    validateRecordedPathStepIdUniqueness(data.steps as Array<Record<string, unknown>>);
  }

  // Validate `prerequisites` when present, even though the top-level Zod tier
  // schema treats it as optional — plenty of simple GETs have no prereqs.
  // Without this pass, page-extract / js-eval prereqs without
  // required `name` / `url` would pass save-time validation and crash at
  // execute time with a confusing "prereq undefined: ... requires url" error.
  if (Array.isArray(data.prerequisites)) {
    data.prerequisites.forEach((rawPrereq, i) => {
      if (!isPlainObject(rawPrereq)) {
        throw new Error(
          `invalid_strategy: ${tier}.prerequisites[${i}] must be an object.\n\n` +
            `Expected shape:\n  { "name": "<unique id>", "kind": "<prereq kind>", ... }\n\n` +
            `See klura://reference#capability-prereq.`,
        );
      }
      // Silent alias: agents consistently write `type: "js-eval"` instead of
      // `kind: "js-eval"`. Per principles.md §"If the LLM keeps making the
      // same mistake, the runtime is wrong," accept the term the LLM reaches
      // for — copy `type` into `kind` before the rest of validation runs.
      // None of the registered kind names overlap with a canonical `type`
      // value, so the rewrite is safe.
      if (
        typeof rawPrereq.kind !== 'string' &&
        typeof rawPrereq.type === 'string' &&
        rawPrereq.type.length > 0
      ) {
        rawPrereq.kind = rawPrereq.type;
      }
      // `type` is never a valid prereq field; strip it so strict-mode shape
      // validation doesn't flag it as an unknown key after the alias above
      // has already copied any usable value into `kind`.
      if ('type' in rawPrereq) delete rawPrereq.type;
      const missing: string[] = [];
      for (const key of ARRAY_ITEM_REQUIRES.prerequisites ?? []) {
        const v = rawPrereq[key];
        if (typeof v !== 'string' || v.length === 0) missing.push(key);
      }
      if (missing.length > 0) {
        const keyLabel = missing.length === 1 ? 'key' : 'keys';
        const missingList = missing.map((k) => `"${k}"`).join(', ');
        throw new Error(
          `invalid_strategy: ${tier}.prerequisites[${i}] missing required ${keyLabel}: ${missingList} (each must be a non-empty string). ` +
            `Each prereq needs a unique "name" (used in errors and resume-pointer references) and a "kind" ` +
            `(one of: ${describeEnum(ARRAY_ITEM_ENUMS.prerequisites?.kind ?? [])}).\n\n` +
            `Expected shape:\n  { "name": "<unique id>", "kind": "<one of the kinds above>", ... }\n\n` +
            `See klura://reference#capability-prereq.`,
        );
      }
      const enums = ARRAY_ITEM_ENUMS.prerequisites ?? {};
      for (const [enumKey, allowed] of Object.entries(enums)) {
        const v = rawPrereq[enumKey];
        if (typeof v === 'string' && !allowed.includes(v)) {
          throw new Error(
            `invalid_strategy: ${tier}.prerequisites[${i}].${enumKey} = "${v}" is not allowed; must be one of: ${describeEnum(allowed)}${didYouMeanSuffix(v, allowed)}.\n\n` +
              `Expected shape:\n  { "name": "<unique id>", "kind": "<one of the kinds above>", ... }\n\n` +
              `See klura://reference#capability-prereq.`,
          );
        }
      }
      validatePrereqShape(tier, i, rawPrereq);
    });
  }

  // Deep-validate a few nested shapes the executor relies on. Kept narrow on
  // purpose — only fields where a wrong shape crashes execution or has a
  // security impact.
  //
  // These deep validators are independent — one failing doesn't invalidate the
  // others' checks — so batch their errors instead of throwing on the first
  // miss. A save with four independent shape problems gets one multi-bullet
  // rejection instead of four sequential rounds of fix-one-resubmit. See
  // principles.md §"Priming agents: close to execution" — aggregated errors at
  // a single decision point are one of the documented corollaries.
  const deepErrors: Array<{ message: string; cause: unknown }> = [];
  const runDeep = (fn: () => void): void => {
    try {
      fn();
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('invalid_strategy:')) {
        deepErrors.push({
          message: e.message.slice('invalid_strategy:'.length).trimStart(),
          cause: e,
        });
      } else {
        // Non-invalid_strategy throws are real bugs — rethrow now, don't batch
        // them. Validator contract is that shape errors are `invalid_strategy:
        // ...`; anything else is runtime fault.
        throw e;
      }
    }
  };
  runDeep(() => {
    validateGeneratedShape(data);
  });
  runDeep(() => {
    validateNotesAllowlist(data);
  });
  runDeep(() => {
    validateNotesParamsShape(data);
  });
  runDeep(() => {
    validateNotesAnchorType(data, tier);
  });
  runDeep(() => {
    validateBaseUrlScheme(data);
  });
  runDeep(() => {
    validateResponseShape(data, tier);
  });
  runDeep(() => {
    validateWebSocketShape(data, tier);
  });
  runDeep(() => {
    validateInterrupts(data);
  });
  runDeep(() => {
    validateCacheShape(data);
  });
  runDeep(() => {
    validateProvidesShape(data);
  });
  const [firstErr, ...rest] = deepErrors;
  if (firstErr && rest.length === 0) {
    throw new Error(`invalid_strategy: ${firstErr.message}`, { cause: firstErr.cause });
  }
  if (firstErr) {
    const bullets = deepErrors.map((e) => `  • ${e.message}`).join('\n');
    throw new Error(
      `invalid_strategy: ${deepErrors.length} shape problems — fix all of these in one retry:\n${bullets}`,
      { cause: firstErr.cause },
    );
  }
}

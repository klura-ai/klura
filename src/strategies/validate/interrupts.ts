// `strategy.interrupts[]` validation — each entry's shape is driven by the
// predicate + handler registries so new kinds plugged in at startup are
// validated uniformly without editing this function. See
// runtime/docs/principles.md §"Pluggability is welcome" + corollary #4 on
// one-source-of-truth prose.

import { asEnum, ValidationError, didYouMeanSuffix, describeEnum } from '../../validators';
import { isPlainObject } from './helpers';
import { getPredicateKind, listPredicateKinds } from '../predicate-registry';
import { getInterruptHandler, listInterruptHandlerKinds } from '../interrupt-registry';
import { zodErrorToIssues } from '../schemas/zod-helpers';

// Valid values for `interrupts[].at` — the lifecycle edge at which the runtime
// evaluates the observer.
const INTERRUPT_AT_VALUES = ['pre_execution', 'between_steps', 'after_response'] as const;

// Known top-level fields on an interrupt entry. Unknown fields (e.g.
// `after_step`, a stray top-level `prompt`) are rejected at save time so the
// agent's mental model stays aligned with the schema — silently accepting
// invented fields is how shape drift enters on-disk strategies.
const INTERRUPT_ENTRY_ALLOWED_KEYS = new Set(['name', 'at', 'observe', 'handler', 'priority']);

export function validateInterrupts(data: Record<string, unknown>): void {
  if (!('interrupts' in data) || data.interrupts === undefined || data.interrupts === null) return;
  if (!Array.isArray(data.interrupts)) {
    throw new Error(
      `invalid_strategy: "interrupts" must be an array of {name, handler, at, observe?, priority?} entries`,
    );
  }
  const seenNames = new Set<string>();
  data.interrupts.forEach((rawEntry, i) => {
    const where = `interrupts[${i}]`;
    if (!isPlainObject(rawEntry)) {
      throw new Error(`invalid_strategy: ${where} must be a plain object`);
    }
    const entry = rawEntry;

    // Collect every issue for this entry into one bullet list so the agent sees
    // the whole shape problem in one rejection instead of discovering it
    // field-by-field across N save attempts. Matches the aggregated-error
    // principle documented in principles.md corollary #3.
    const issues: string[] = [];

    // name
    if (typeof entry.name !== 'string' || entry.name.length === 0) {
      issues.push(`${where}.name must be a non-empty string`);
    } else if (seenNames.has(entry.name)) {
      issues.push(
        `${where}.name = ${JSON.stringify(entry.name)} is a duplicate; each interrupt's name must be unique within a strategy`,
      );
    } else {
      seenNames.add(entry.name);
    }

    // at
    try {
      asEnum(entry.at, `${where}.at`, INTERRUPT_AT_VALUES);
    } catch (e) {
      if (e instanceof ValidationError) issues.push(e.message);
      else throw e;
    }

    // priority (optional)
    if ('priority' in entry && entry.priority !== undefined) {
      if (typeof entry.priority !== 'number' || !Number.isInteger(entry.priority)) {
        issues.push(`${where}.priority must be an integer (got ${JSON.stringify(entry.priority)})`);
      }
    }

    // observe (optional)
    if ('observe' in entry && entry.observe !== undefined && entry.observe !== null) {
      if (!isPlainObject(entry.observe)) {
        issues.push(`${where}.observe must be a predicate object {kind, ...}`);
      } else {
        const observeKind = entry.observe.kind;
        if (typeof observeKind !== 'string') {
          issues.push(
            `${where}.observe.kind must be a string (one of: ${describeEnum(listPredicateKinds())})`,
          );
        } else {
          const predicateSpec = getPredicateKind(observeKind);
          if (!predicateSpec) {
            issues.push(
              `${where}.observe.kind = ${JSON.stringify(observeKind)} is not a registered predicate kind; must be one of: ${describeEnum(listPredicateKinds())}${didYouMeanSuffix(observeKind, listPredicateKinds())}`,
            );
          } else {
            const parsed = predicateSpec.shape.safeParse(entry.observe);
            if (!parsed.success) {
              issues.push(...zodErrorToIssues(parsed.error, `${where}.observe`));
            }
          }
        }
      }
    }

    // handler (required)
    if (!isPlainObject(entry.handler)) {
      issues.push(`${where}.handler must be a handler object {kind, ...}`);
    } else {
      const handlerKind = entry.handler.kind;
      if (typeof handlerKind !== 'string') {
        issues.push(
          `${where}.handler.kind must be a string (one of: ${describeEnum(listInterruptHandlerKinds())})`,
        );
      } else {
        const handlerSpec = getInterruptHandler(handlerKind);
        if (!handlerSpec) {
          issues.push(
            `${where}.handler.kind = ${JSON.stringify(handlerKind)} is not a registered handler kind; must be one of: ${describeEnum(listInterruptHandlerKinds())}${didYouMeanSuffix(handlerKind, listInterruptHandlerKinds())}`,
          );
        } else {
          const parsed = handlerSpec.shape.safeParse(entry.handler);
          if (!parsed.success) {
            issues.push(...zodErrorToIssues(parsed.error, `${where}.handler`));
          }
        }
      }
    }

    // Unknown top-level fields on the entry itself (e.g. the observed
    // `after_step: 6` / stray top-level `prompt` leak from a wikipedia field
    // run).
    for (const k of Object.keys(entry)) {
      if (!INTERRUPT_ENTRY_ALLOWED_KEYS.has(k)) {
        issues.push(
          `${where} has unknown field "${k}"; interrupt entries accept: ${Array.from(
            INTERRUPT_ENTRY_ALLOWED_KEYS,
          )
            .map((a) => JSON.stringify(a))
            .join(
              ', ',
            )}. If you meant to pass extra handler data, nest it under handler.*. Positional hints like "after_step" aren't a thing — \`at\` selects the lifecycle edge and \`observe\` is the conditional gate.`,
        );
      }
    }

    if (issues.length > 0) {
      const bullets = issues.map((s) => `  - ${s}`).join('\n');
      const issueLabel = issues.length === 1 ? '1 issue' : `${issues.length} issues`;
      throw new Error(
        `invalid_strategy: ${where} has ${issueLabel} — fix all before retrying:\n${bullets}`,
      );
    }
  });
}

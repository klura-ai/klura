// Single-slot registry for a save-time user-confirmation auto-decider. Lets
// test harnesses (field-reports, llm-tests) supply a function that
// auto-decides "would the user approve this save?" without an actual human
// in the loop.
//
// Production runs leave this slot empty: the user_confirmation Classifier
// rejects on first call with a runtime-composed prompt the agent reads back
// to the user; the user replies; the agent resubmits with the answer.
//
// Test runs register a decider that takes (Strategy, ctx) → {decision,
// quote}. The Classifier checks the registry BEFORE issuing the token; if a
// decider is present and the agent didn't supply audit_answers, the runtime
// synthesizes the answer internally and the audit proceeds without a round
// trip to the agent. This is what makes scenario quality-predicates run
// inline during the bench instead of post-hoc.

import type { Strategy } from '../strategies/skills';
import type { SaveStrategyCtx } from './save-strategy';

export interface SaveConfirmationDecision {
  decision: 'approve' | 'reject';
  /** Verbatim user-quote attached to the decision. Required, ≥1 char.
   *  Travels into the audit answer slot under `user_quote`. */
  quote: string;
}

export interface SaveConfirmationDecider {
  name: string;
  decide(strategy: Strategy, ctx: SaveStrategyCtx): SaveConfirmationDecision;
}

let registered: SaveConfirmationDecider | null = null;

export function registerSaveConfirmationDecider(d: SaveConfirmationDecider): void {
  if (typeof d.name !== 'string' || d.name.length === 0) {
    throw new Error('registerSaveConfirmationDecider: decider.name is required (non-empty string)');
  }
  if (typeof d.decide !== 'function') {
    throw new Error('registerSaveConfirmationDecider: decider.decide must be a function');
  }
  registered = d;
}

export function unregisterSaveConfirmationDecider(name: string): void {
  if (registered && registered.name === name) registered = null;
}

export function getRegisteredSaveConfirmationDecider(): SaveConfirmationDecider | null {
  return registered;
}

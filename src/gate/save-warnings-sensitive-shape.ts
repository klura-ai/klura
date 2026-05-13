// Detector: refuses save_strategy when the strategy body or notes.params
// surface field names that are structurally sensitive — credit-card numbers,
// CVVs, SSNs, bank-routing, raw passwords. These shapes name an irreversible
// or PII-bearing action that warm execute would fire blindly on every call,
// often with caller-supplied literals that include real payment or identity
// data.
//
// `ackReason: 'none'` — there is no legitimate ack path. The right tool for
// observing this kind of endpoint is `record_observed_capability` (captures
// the structural fact without saving an executable strategy). Save_strategy
// is for safe-to-replay capabilities (reads, idempotent mutations whose
// surfaces match the user's intent on warm execute); checkout / payment /
// identity-update flows are categorically out.
//
// This Detector cannot be bypassed by the registered save-confirmation
// decider (`save-confirmation-decider.ts`): the decider only auto-resolves
// the `user_confirmation` Classifier, not Detectors. Production-shape
// embedders that want auto-approval still get it for safe saves; sensitive-
// shape saves require explicit human review of the strategy text — or, more
// commonly, the agent reclassifies the observation via
// `record_observed_capability` and the save attempt is abandoned.
//
// Repro: llm-tests/platform-map/map-lift-safe v8 — agent saved a strategy
// for klura-eats `place_order` with body
// `{address, card_number, exp, cvv}`. The save landed because the bench
// harness's auto-approve decider satisfied user_confirmation. The strategy
// on disk would fire the real checkout endpoint on warm execute. This
// Detector refuses such saves at the audit layer, before commit.
//
// The field-name list is curated — small, structural, intended to catch the
// common shapes. NOT a fuzzy keyword bank over agent-emitted prose
// (principles.md §"Crisp vs fuzzy"): this is exact-match against keys in
// the saved strategy's body / notes.params, structurally derived from the
// strategy payload.

import type { SaveWarning } from './save-warnings';
import type { Strategy } from '../strategies/skills';

/**
 * Curated set of field-name patterns that flag a strategy as touching
 * sensitive / irreversible action surfaces. Matching is case-insensitive
 * and tolerant of common variants (snake_case, camelCase, kebab-case,
 * pascalCase). Each entry's match function returns the normalized form
 * surfaced in the warning so the agent sees exactly which field tripped
 * the gate.
 *
 * Categories:
 *  - Payment instrument: card number, CVV/CVC, expiry — fields that move
 *    money or authorize charges.
 *  - Identity: SSN / tax-id / passport — high-value PII a hijacked
 *    strategy could exfiltrate or replay.
 *  - Banking: account / routing / IBAN — direct-debit attack surface.
 *  - Auth secrets: password, pin — when present in BODY (not in an `auth`
 *    prereq's args) suggests the strategy is itself a sign-in/credential
 *    submission, which belongs in a login capability, not a generic save.
 */
const SENSITIVE_FIELD_PATTERNS: ReadonlyArray<{ label: string; regex: RegExp }> = [
  { label: 'card_number', regex: /^(?:card[_-]?number|cardnum|cc[_-]?num(?:ber)?|pan)$/i },
  { label: 'cvv', regex: /^(?:cvv|cvc|cvv2|card[_-]?verification(?:[_-]?value)?)$/i },
  { label: 'card_expiry', regex: /^(?:exp(?:iry|iration)?|exp[_-]?(?:month|year|date))$/i },
  { label: 'ssn', regex: /^(?:ssn|social[_-]?security(?:[_-]?number)?|tax[_-]?id|tin)$/i },
  {
    label: 'passport_number',
    regex: /^(?:passport(?:[_-]?(?:number|num|no))?|national[_-]?id(?:[_-]?number)?)$/i,
  },
  {
    label: 'bank_account',
    regex: /^(?:bank[_-]?account|account[_-]?number|acct[_-]?num(?:ber)?|iban|swift|bic)$/i,
  },
  { label: 'routing_number', regex: /^(?:routing[_-]?number|aba|sort[_-]?code)$/i },
  // Password in body is the "credential-submit" shape — belongs in a login
  // capability with explicit auth-flow ownership, not a generic save. PIN
  // is similarly authentication material.
  { label: 'password_in_body', regex: /^(?:password|passwd|pwd|user[_-]?password)$/i },
  { label: 'pin_in_body', regex: /^(?:pin|pin[_-]?code|access[_-]?pin)$/i },
];

/**
 * Walk an object value emitting every key name encountered (recursive into
 * nested objects). Skips arrays' integer indices — only string keys count.
 * Returns a Set so the caller doesn't double-flag the same key path.
 */
function collectKeyNames(value: unknown, out: Set<string>): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const v of value) collectKeyNames(v, out);
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof k === 'string' && k.length > 0) out.add(k);
    collectKeyNames(v, out);
  }
}

/**
 * Detect sensitive-shape field names in the strategy's body and
 * notes.params. Returns one SaveWarning summarizing every match (one
 * warning per save_strategy call, not one per field — the corrective
 * action is the same regardless of which fields triggered).
 *
 * Returns [] when the strategy carries none of the sensitive patterns.
 */
export function detectSensitiveActionShape(data: Strategy): SaveWarning[] {
  const d = data as Record<string, unknown>;
  // Login / auth-establishing capabilities legitimately carry `password`
  // (and sometimes `pin`) in their body — that's what an authenticate-with-
  // credentials submission IS. The canonical klura pattern is a login
  // capability declaring `provides: ["auth"]` so sibling capabilities chain
  // through `prerequisites: [{kind: "tag", tag: "auth"}]`. When `provides`
  // names `"auth"`, the agent has explicitly owned the auth flow and the
  // credential-submit shape is the contract, not a leak. Repro: v9
  // llm-tests/login-sharing — the detector blocked the login save, the
  // agent pivoted to `record_observed_capability`, and downstream list /
  // create capabilities lost their auth-prereq chain. False positive
  // closes here.
  const provides = d.provides;
  if (Array.isArray(provides) && provides.some((p) => p === 'auth')) {
    return [];
  }
  const keys = new Set<string>();
  collectKeyNames(d.body, keys);
  collectKeyNames(d.notes, keys);
  // Also include declared param names in notes.params — agents sometimes
  // template these into the endpoint or headers rather than body, so the
  // body walk alone misses them.
  const notes = d.notes as { params?: unknown } | undefined;
  if (notes && typeof notes === 'object') {
    const params = notes.params;
    if (params && typeof params === 'object' && !Array.isArray(params)) {
      for (const k of Object.keys(params as Record<string, unknown>)) keys.add(k);
    }
  }

  const matched: Array<{ label: string; field: string }> = [];
  for (const k of keys) {
    for (const { label, regex } of SENSITIVE_FIELD_PATTERNS) {
      if (regex.test(k)) {
        matched.push({ label, field: k });
        break;
      }
    }
  }
  if (matched.length === 0) return [];

  // Dedupe by label (one mention per category in the message).
  const byLabel = new Map<string, string[]>();
  for (const { label, field } of matched) {
    const existing = byLabel.get(label);
    if (existing) existing.push(field);
    else byLabel.set(label, [field]);
  }
  const summary = [...byLabel.entries()]
    .map(([label, fields]) => {
      const quoted = fields.map((f) => `"${f}"`).join(', ');
      return `${label} (fields: ${quoted})`;
    })
    .join('; ');

  return [
    {
      kind: 'sensitive_action_must_be_recorded_not_saved',
      message:
        `Strategy body or params surface sensitive-shape fields: ${summary}. ` +
        `Save_strategy commits a strategy that the runtime will fire on every warm execute — for ` +
        `payment / identity / banking / credential-submit flows that means firing the real action ` +
        `with whatever literals the caller passes (or worse, the bench-time literals if the agent ` +
        `mis-classified them as static). The right tool for these observations is ` +
        `\`record_observed_capability(session_id, capability, observation)\` — it captures the ` +
        `structural fact (endpoint, body shape, response shape) without persisting a runnable ` +
        `strategy.`,
      hint:
        `Replace this save_strategy call with \`record_observed_capability\` carrying the same body ` +
        `shape + endpoint observation. If you genuinely intended to lift this surface as a real ` +
        `capability the user wants to invoke on warm runs (e.g. a payments integration the user ` +
        `explicitly asked for), the right shape is to land a narrower, less-attack-surface ` +
        `capability first (read-only "list_recent_orders" instead of write "place_order"), then ` +
        `surface the irreversible action to the user separately. There is no ack path here — ` +
        `the structural reality is that a strategy this shape should not live on disk.`,
      context: {
        matched_labels: [...byLabel.keys()],
        matched_fields: matched.map((m) => m.field),
      },
    },
  ];
}

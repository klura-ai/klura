// Rejection formatter — renders an AuditRejection as the single
// human-readable error string the agent sees, regardless of which audit
// (save_strategy, submit_triage_plan, end_drive) or which dimensions fired.
// The one-envelope shape is load-bearing: tool-result rendering never
// branches on rejection.reason, and every retry instruction, warning code,
// answer shape, and structured remedy the agent needs is assembled here.

import { TOOL_NAMES } from '../vocab';
import type { AuditRejection, Remedy } from './index';

export interface RejectionFormatOpts {
  /** Tool name the agent calls to retry. Defaults to `save_strategy` for the
   *  pre-save audit; pass the end-drive tool name for the end-drive
   *  audit. */
  toolName?: string;
}

/**
 * Render an AuditRejection as the human-readable error string the agent
 * sees. Single shape regardless of which dimensions fired — the agent's
 * tool-result rendering doesn't need to branch on rejection.reason.
 */
export function rejectionToErrorMessage(
  kind: string,
  rejection: AuditRejection,
  opts: RejectionFormatOpts = {},
): string {
  const toolName = opts.toolName ?? TOOL_NAMES.saveStrategy;
  const isSaveStrategy = toolName === TOOL_NAMES.saveStrategy;
  const lines: string[] = [];

  // Stage-0 shape rejection — bypass the classifier/token machinery
  // entirely. Render the same `N issues — fix all before retrying` shape
  // existing `err.message.startsWith('invalid_strategy:')` catchers expect.
  // For save_strategy specifically, append the live schema catalog so the
  // agent's retry has the canonical field list inline. Skipped on
  // classifier-issue rejections — those carry per-classifier
  // `expectedAnswerShape` strings already.
  if (rejection.reason === 'invalid_shape') {
    const shapeIssues = rejection.shape_issues ?? [];
    const head =
      shapeIssues.length === 1
        ? `invalid_strategy: ${shapeIssues[0]}`
        : `invalid_strategy: ${shapeIssues.length} issues — fix all before retrying:\n` +
          shapeIssues.map((i) => `  - ${i}`).join('\n');
    if (kind === 'save_strategy') {
      // Lazy-require: schema-catalog → schemas/prereqs → validate
      // constants. Eager top-of-file import would cycle through
      // `audit/lift/save-strategy.ts` ↔ `strategies/skills.ts`.
      /* eslint-disable @typescript-eslint/no-require-imports */
      const cat =
        require('../strategies/schema-catalog') as typeof import('../strategies/schema-catalog');
      /* eslint-enable @typescript-eslint/no-require-imports */
      return `${head}\n\n${cat.renderSaveStrategySchemaMarkdown()}`;
    }
    return head;
  }

  // Promote concrete diff lines into the headline. The bare reason label
  // (`(answers_inconsistent)`, `(payload_changed)`) on its own gives the
  // agent no actionable signal; surface every classifier_issue and ack_issue
  // up front so the retry edits the exact field that's wrong.
  const classifierIssues = rejection.classifier_issues ?? [];
  const ackIssues = rejection.ack_issues ?? [];
  const payloadDiff = rejection.payload_diff ?? [];
  const totalIssues = classifierIssues.length + ackIssues.length;
  if (totalIssues > 0) {
    lines.push(
      `invalid_strategy: ${kind}_rejected (${rejection.reason}) — ${totalIssues} issue${totalIssues === 1 ? '' : 's'}, fix all before retrying:`,
    );
    for (const i of classifierIssues) lines.push(`  • ${i}`);
    for (const i of ackIssues) lines.push(`  • ${i}`);
  } else if (payloadDiff.length > 0) {
    // payload_changed promotes the diff into the headline. Each bullet
    // names a field that shifted between the audited payload and the retry
    // — the agent reverts those (or re-confirms the new shape) instead of
    // hunting for what differs.
    lines.push(
      `invalid_strategy: ${kind}_rejected (${rejection.reason}) — ${payloadDiff.length} field${payloadDiff.length === 1 ? '' : 's'} changed since prior audit_token, revert or re-confirm:`,
    );
    for (const p of payloadDiff) lines.push(`  • ${p}`);
  } else if (rejection.reason === 'token_unknown_or_expired') {
    // The opaque "token_unknown_or_expired" reason name leaves the agent
    // guessing why their echoed token didn't validate. Three real causes:
    //   - cross-session token reuse (tokens are session-local)
    //   - payload mutated since the rejection that issued the prior token
    //     (token binds to (kind, payloadHash); any structural change forces
    //     re-audit and the prior token is a stranger)
    //   - the token is older than the gate-store TTL (rare in practice)
    // Surface the cause + the fresh token below so the retry uses the
    // most-recent rejection's token, not a stale one.
    lines.push(
      `invalid_strategy: ${kind}_rejected (token_unknown_or_expired) — the audit_token you echoed doesn't match the prior rejection from this session.`,
    );
    lines.push(
      `  Common causes: (a) cross-session reuse — tokens are session-local; (b) the strategy mutated since the rejection, so the prior token's payload-hash no longer matches; (c) the token's TTL elapsed (rare). Use the audit_token from the MOST RECENT rejection of THIS session.`,
    );
    lines.push(
      `  A fresh audit_token has been issued for this call (see below); echo that one on the next retry.`,
    );
  } else {
    lines.push(`invalid_strategy: ${kind}_rejected (${rejection.reason})`);
  }
  // Hard-line "not committed" right under the headline so the agent reads
  // this as a rejection requiring action rather than an in-flight notice.
  // The `pending` reason in particular reads as bureaucratic ("being
  // processed") unless the no-commit state is stated outright.
  lines.push(`  → Your ${kind} call is NOT committed. Nothing was saved.`);
  // Put the concrete warning codes and remedies before generic retry prose.
  // MCP output budgets may truncate long rejection envelopes; the agent must
  // always see the exact work it needs to perform even when later teaching
  // text is compacted.
  if (rejection.warnings.length > 0) {
    const nonAckable = new Set(rejection.non_ackable_warning_kinds ?? []);
    lines.push('  warnings:');
    for (const w of rejection.warnings) {
      const ackableTag = nonAckable.has(w.kind) ? ' [NOT ACKABLE — fix the strategy]' : '';
      lines.push(`    - [${w.kind}]${ackableTag} ${w.message}`);
      if (w.hint) lines.push(`      hint: ${w.hint}`);
    }
    if (nonAckable.size > 0) {
      lines.push(
        `    NOTE: warnings marked [NOT ACKABLE] cannot be cleared via ` +
          `notes.save_warnings_acked — the Detector emits unconditional blockers. ` +
          `Restructure the strategy per the per-warning hint, or abandon the save.`,
      );
    }
  }
  // save_strategy uniquely consumes acks via notes.save_warnings_acked on
  // the strategy itself (so they persist with the saved file), not via a
  // top-level acks parameter. submit_triage_plan and end_drive take a
  // top-level acks: {kind: reason} map. Render the contract that fits the
  // tool so the agent doesn't see contradictory hints in the same response.
  // unacked_warnings is a Stage-1 rejection — no audit_token is minted (see the
  // `reason: 'unacked_warnings'` branch above). Telling the agent to resend an
  // audit_token it was never issued drives sentinel-token invention. Render the
  // ack-only retry for this class.
  if (rejection.reason === 'unacked_warnings') {
    lines.push(
      isSaveStrategy
        ? `  → To commit: call ${toolName} again embedding notes.save_warnings_acked: [{kind, reason}] on the strategy for each warning above — no audit_token is needed for this rejection class (none was issued).`
        : `  → To commit: call ${toolName} again with {acks: {<kind>: "<reason>"}} for each warning above — no audit_token is needed for this rejection class (none was issued).`,
    );
    const currentlyAcked = rejection.currently_acked ?? [];
    if (currentlyAcked.length > 0) {
      lines.push(
        `  → Acks are PER-CALL and not remembered across retries. This call you acked: [${currentlyAcked.join(', ')}]. ` +
          `Your next call must RESEND those acks AND add one for every warning still listed above — acking only the new ` +
          `one drops the prior acks and re-emits them.`,
      );
    }
  } else {
    lines.push(
      isSaveStrategy
        ? `  → To commit: call ${toolName} again with {audit_token, audit_answers} and embed notes.save_warnings_acked: [{kind, reason}] on the strategy for any warnings (fix the issues above).`
        : `  → To commit: call ${toolName} again with {audit_token, audit_answers, acks} (fix the issues above).`,
    );
  }
  lines.push(
    `  → DO NOT end your turn after this rejection — the rejection IS the iteration loop, not a stop signal. Expect 1-3 retries before the save lands.`,
  );
  const retryClause =
    rejection.reason === 'unacked_warnings'
      ? `retry with the warning acks embedded immediately`
      : `The audit_answers IS the commit; retry with {audit_token, audit_answers} immediately`;
  lines.push(
    `  → Do NOT pause to ask the user for approval before retrying. Any real-world mutation (the message you sent, the form you submitted) already happened during drive — ${toolName} is internal bookkeeping for klura to persist the recipe. ${retryClause}, don't send the user a "ready to save?" message in between.`,
  );
  lines.push(
    `  → Do NOT call ToolSearch for the schema. The expected_answer_shape lines below + the per-classifier remedy block ARE the canonical schema; they were composed from the live Zod definitions. Retry with corrections directly. ToolSearch returns the same prose you're already reading — the lookup is pure latency.`,
  );
  // The unattended-retry guidance is about audit_token auto-resolving
  // user_confirmation — irrelevant to unacked_warnings, which mints no token and
  // has no user_confirmation classifier. Emitting it there contradicts the
  // "no audit_token was issued" line above.
  if (rejection.reason !== 'unacked_warnings') {
    lines.push(
      `  → In unattended runs (no human present), retry with just {audit_token} and the embedder's registered decider auto-resolves user_confirmation. You still owe answers for any literal_provenance / capability_name_justification / observed_siblings items in the rejection.`,
    );
  }
  if (toolName !== 'end_drive') {
    lines.push(
      `  → To abandon this draft: call end_drive — that flushes whatever else is pending.`,
    );
  }
  if (rejection.token) lines.push(`  audit_token: ${rejection.token}`);

  if (rejection.items && Object.keys(rejection.items).length > 0) {
    lines.push('  items:');
    for (const [k, v] of Object.entries(rejection.items)) {
      lines.push(`    ${k}: ${JSON.stringify(v)}`);
    }
  }

  // Compose a `how_to_respond:` block spelling out the audit_answers shape
  // the agent should pass on retry. EMPIRICALLY THE STRONGEST HELPER in
  // the rejection envelope — without it agents loop on first-call pending
  // rejections re-submitting the strategy alone (no audit_token, no
  // audit_answers), repeatedly hitting the "items only, no per-item
  // classifier_issues" path. The shape strings come from each Classifier's
  // required `expectedAnswerShape` field; this renderer just assembles
  // them. See `runtime/docs/principles.md` §"Reject with remedy" for the
  // diagnostic story (the prior `how_to_respond` example was deleted in
  // 9d2946c during the audit consolidation; field-reports caught the
  // regression on api-change / drift-offsets / platform-map cold runs).
  if (
    rejection.classifier_answer_shapes &&
    Object.keys(rejection.classifier_answer_shapes).length > 0
  ) {
    const hasWarnings = rejection.warnings.length > 0;
    let acksClause = '';
    if (hasWarnings) {
      acksClause = isSaveStrategy
        ? ' (and embed notes.save_warnings_acked on the strategy)'
        : ', acks';
    }
    lines.push(
      `  how_to_respond: call ${toolName} again with {audit_token, audit_answers}${acksClause}.`,
    );
    lines.push('    audit_answers shapes:');
    for (const shape of Object.values(rejection.classifier_answer_shapes)) {
      lines.push(`      - ${shape}`);
    }
    if (hasWarnings) {
      if (isSaveStrategy) {
        lines.push('    notes.save_warnings_acked shape (embed on the strategy):');
        lines.push('      - [{kind: "<warning_kind>", reason: "<one-sentence reason>"}, ...]');
      } else {
        lines.push('    acks shape:');
        lines.push('      - {<warning_kind>: "<one-sentence reason>"}');
      }
    }
  }

  if (rejection.classifier_remedies && Object.keys(rejection.classifier_remedies).length > 0) {
    lines.push('  remedies:');
    for (const [kind, remedy] of Object.entries(rejection.classifier_remedies)) {
      lines.push(`    ${kind}:`);
      const remedyLines = formatRemedy(remedy);
      for (const line of remedyLines) lines.push(`      ${line}`);
    }
  }

  return lines.join('\n');
}

/**
 * Render a structured `Remedy` as 1+ human-readable lines. Each variant
 * surfaces its data in a compact bullet form the agent can scan at the
 * decision point. The renderer is the single source of truth for remedy
 * formatting — detector authors think structurally (data shape), the
 * agent sees a consistent shape across every audit.
 */
function formatRemedy(remedy: Remedy): string[] {
  switch (remedy.kind) {
    case 'observed_alternatives': {
      if (remedy.observed_values.length === 0) {
        const noteSuffix = remedy.note ? ' — ' + remedy.note : '';
        return [
          `remedy (observed_alternatives): no values were observed for this slot${noteSuffix}`,
        ];
      }
      const lines = [
        `remedy (observed_alternatives): ${remedy.observed_values.length} value${remedy.observed_values.length === 1 ? '' : 's'} observed this session:`,
      ];
      for (const v of remedy.observed_values.slice(0, 20)) {
        const label = v.label ? ` "${v.label}"` : '';
        lines.push(`  - ${v.value}${label} (via ${v.source})`);
      }
      if (remedy.observed_values.length > 20) {
        lines.push(`  - ... +${remedy.observed_values.length - 20} more`);
      }
      if (remedy.note) lines.push(`  note: ${remedy.note}`);
      return lines;
    }
    case 'classification_options': {
      const lines = [
        `remedy (classification_options): ${remedy.options.length} valid choice${remedy.options.length === 1 ? '' : 's'}:`,
      ];
      for (const opt of remedy.options) {
        lines.push(`  - "${opt.choice}" — ${opt.rationale}`);
      }
      return lines;
    }
    case 'closest_matches': {
      if (remedy.candidates.length === 0) return [];
      const lines = [`remedy (closest_matches): nearest captured candidates:`];
      for (const c of remedy.candidates.slice(0, 10)) {
        lines.push(`  - ${c.value} (by ${c.distance_metric})`);
      }
      return lines;
    }
    case 'capability_alternative':
      return [
        `remedy (capability_alternative): use {kind: "${remedy.suggested_capability_kind}"} prereq instead.`,
        `  reasoning: ${remedy.reasoning}`,
      ];
    case 'cross_session_evidence': {
      if (remedy.values.length === 0) return [];
      const sample = remedy.values.slice(0, 10).join(', ');
      const more = remedy.values.length > 10 ? ` (+${remedy.values.length - 10} more)` : '';
      return [
        `remedy (cross_session_evidence): ${remedy.values.length} value${remedy.values.length === 1 ? '' : 's'} observed across ${remedy.sessions_observed} prior session${remedy.sessions_observed === 1 ? '' : 's'}: ${sample}${more}`,
        `  advisory: ${remedy.advisory}`,
      ];
    }
    case 'no_programmatic_remedy':
      return [`remedy (no_programmatic_remedy): ${remedy.reason}`];
  }
}

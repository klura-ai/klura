/**
 * Reject `notes.params.<X>` entries whose declared `example` matches an
 * opaque-internal-ID shape (base64 blob, UUID, `gid://`-style URI, long hex,
 * prefixed opaque ID like `R_kgDO*`) — provided the placeholder `{{X}}` is
 * actually referenced in the strategy's interpolable fields AND no prereq
 * produces the same variable name.
 *
 * The failure class this guards: the agent observes an opaque required value in
 * the captured request body, assumes "the caller must know this value," and
 * documents it under `notes.params` as a user arg. On warm execute the caller
 * provides `{owner, repo, title, body}` but not `repositoryId`, the runtime
 * throws `missing args repositoryId`, and the agent falls through to full
 * re-discovery — defeating the warm-path promise. The fix is to trace the
 * opaque value to its DOM source (SKILL.md step 7) and save a page-extract
 * prereq that produces it; `notes.params` is for values the human caller would
 * actually type verbatim (titles, bodies, slugs, usernames, emails, dates,
 * counts).
 *
 * Documentation-only params (declared but never referenced in any interpolable
 * field) are exempt — they don't affect execution. Params whose name is also
 * produced by a prereq are exempt too, since the prereq's value takes
 * precedence at resolve time and the params entry is just the legacy
 * description the runtime echoes back.
 */

import type { Strategy } from '../skills';
import { exampleLooksOpaque as helperExampleLooksOpaque } from './helpers';
import { OPAQUE_EXAMPLE_PATTERNS } from './constants';
import { collectDeclaredPlaceholders, collectPlaceholderUses } from '../placeholder-semantics';
import { paramDocSchema } from '../schemas/notes';
import { renderZodSkeletonInline } from '../schemas/zod-helpers';
import {
  findCandidatesForLiteral,
  findRawCaptureMatches,
} from '../../response/session-observations';
import { getTypedValuesProvider } from './providers';

export function validateNoOpaqueUserParams(
  data: Strategy,
  sessionId?: string,
  _platform?: string,
): void {
  const notes = (data as { notes?: { params?: Record<string, unknown> } }).notes;
  const params = notes?.params;
  if (!params || typeof params !== 'object') return;

  const used = new Set(collectPlaceholderUses(data).map((use) => use.ref));
  const declared = collectDeclaredPlaceholders(data);

  for (const [name, entry] of Object.entries(params)) {
    if (declared.prereqProducedNames.has(name)) continue;
    if (typeof entry !== 'object' || entry === null) continue;

    const example = (entry as Record<string, unknown>).example;
    if (typeof example !== 'string' || example.length === 0) continue;

    const kindVal = (entry as Record<string, unknown>).kind;
    const kind = typeof kindVal === 'string' ? kindVal : undefined;

    // Primary signal: ground-truth accumulator match. The classifier saw the
    // exact value in captured session traffic — strong evidence it's
    // server-produced, not user-typed. BUT: user-typed display names, slugs,
    // emails, etc. legitimately appear in responses too (servers echo them back
    // in search results, profile pages, etc.). So this signal only counts when
    // the agent themselves declared the param as an identifier kind (`id` or
    // `uuid`). Text/slug/email/url/enum declarations are the agent asserting
    // "this is a user-typed value" — the accumulator match doesn't override
    // that assertion.
    const kindTreatsAsOpaque = kind === 'id' || kind === 'uuid';
    const observedInLookup = kindTreatsAsOpaque
      ? accumulatorMatchesLiteral(sessionId, example)
      : false;

    // Caller-arg exemption: when the literal value was typed by the user
    // into the page this session via perform_action(type / fill_editor),
    // it is by-construction caller-sourced — even when the same value
    // appears in a captured response body (autocomplete echo, suggestion
    // list returning the typed prefix back, search result containing the
    // typed term). The on-the-wire ground truth is "the user typed this";
    // an accumulator match is downstream of that source.
    if (observedInLookup && wasTypedThisSession(sessionId, example)) continue;

    // Secondary signal: shape match against known opaque-id patterns. Kept as a
    // narrow backstop for saves without session context (programmatic saves,
    // tests) — the LLM still owns the decision; these patterns only catch
    // values almost certainly not user-typed (UUIDs, base64 blobs, MongoDB
    // ObjectIds). When the agent declared `kind: "url"`, the URI-scheme
    // pattern (https://...) is by-construction expected and not a useful
    // signal — the agent is asserting "this is a public URL the caller can
    // pass." The other shape patterns (UUID, ObjectId, base64 blob, etc.)
    // still fire because they're not URL-shaped.
    const shape =
      kind === 'url'
        ? helperExampleLooksOpaque(
            example,
            OPAQUE_EXAMPLE_PATTERNS.filter(([, label]) => label !== 'URI-scheme opaque ID'),
          )
        : helperExampleLooksOpaque(example, OPAQUE_EXAMPLE_PATTERNS);

    // "Unused param is exempt" is a friendly rule for documentation-only
    // entries. When the accumulator ground-truths this param as server-
    // produced, the exemption is withdrawn (documentation of a captured value
    // isn't really documentation — it's a memo of a value the agent decided to
    // call a caller arg). Shape-only matches still respect the exemption (UUIDs
    // in unused documentation entries are common).
    if (!observedInLookup && !used.has(name)) continue;
    if (!observedInLookup && !shape) continue;

    const reason = observedInLookup
      ? `the per-session lookup accumulator observed this exact value in the response body of a lookup-shaped request — it is produced by the server, not typed by the caller`
      : `matches an opaque-internal-ID shape (${shape}) — only the web app's own JS knows how to produce values of this form`;

    throw new Error(
      `invalid_strategy: notes.params.${name}.example = ${JSON.stringify(example)} ` +
        `is declared as a user arg, but ${reason}. ` +
        `This is the "I missed step 7" hallucination class: you observed the value in captured traffic, ` +
        `assumed the caller would pass it, and documented it under notes.params instead of tracing it. ` +
        `Fix: replace notes.params.${name} with a prereq that produces \`${name}\` — either a ` +
        `\`{kind: "capability"}\` prereq that chains to a lookup_<entity>_by_<key> strategy, or a ` +
        `\`page-extract\`/\`js-eval\` prereq reading from the page. The placeholder \`{{${name}}}\` stays the same — ` +
        `the runtime resolves it from prereq vars instead of caller args.\n\n` +
        `Expected shape for notes.params.<name>:\n  ${renderZodSkeletonInline(paramDocSchema)}\n\n` +
        `See SKILL.md steps 7-8 + klura://reference#capability-parameters.`,
    );
  }
}

/** True when the per-session accumulator has at least one candidate
 * whose response body returned the literal value. Used to decide
 *  whether to withdraw the one_capture_insufficient waiver. */
function accumulatorMatchesLiteral(sessionId: string | undefined, literal: string): boolean {
  if (!sessionId) return false;
  if (findCandidatesForLiteral(sessionId, literal).length > 0) return true;
  if (findRawCaptureMatches(sessionId, literal).length > 0) return true;
  return false;
}

/** True when the user typed the literal value into the page this session
 *  via perform_action({action: 'type'|'fill_editor', value}). Caller-arg
 *  exemption from the opaque-params accumulator-match rejection. */
function wasTypedThisSession(sessionId: string | undefined, literal: string): boolean {
  if (!sessionId) return false;
  const provider = getTypedValuesProvider();
  if (!provider) return false;
  const typed = provider(sessionId);
  return typed instanceof Set && typed.has(literal);
}

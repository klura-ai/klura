// Notes + URL hygiene validators: shape-check notes.params, lock down the
// top-level `notes` allowlist, validate the runtime-owned `runtime_meta`
// shape, and reject non-http(s) URL schemes on baseUrl / origin.

import { z } from 'zod';
import { closestAllowed, didYouMeanSuffix } from '../../validators';
import { isPlainObject } from './helpers';
import { notesSchema, notesParamsSchema } from '../schemas/notes';
import { renderZodSkeletonInline, zodErrorToIssues } from '../schemas/zod-helpers';

// Derive the allowlist directly from the Zod schema so renames in
// `schemas/notes.ts` cascade. A hand-written parallel table is the canonical
// drift point this module is designed to eliminate.
export const NOTES_ALLOWED_KEYS: ReadonlySet<string> = new Set(Object.keys(notesSchema.shape));

// Render the agent-facing notes-allowlist synopsis. Walks notesSchema's
// fields and emits one bullet per field via `renderZodSkeletonInline`. The
// inline renderer surfaces each field's `.describe()` as a `// <text>` tail
// comment on the type — single source for the description, no doubling.
// Adding / renaming / removing a notes field needs only a Zod edit; this
// renderer picks it up automatically.
export function describeNotesAllowlist(): string {
  const lines: string[] = [];
  for (const [key, child] of Object.entries(notesSchema.shape)) {
    const childSchema = child as z.ZodType;
    lines.push(`  ${key}: ${renderZodSkeletonInline(childSchema)}`);
  }
  return lines.join('\n');
}

// Accept the JSON-Schema-style array form of notes.params and rewrite it in
// place to the canonical object form. Per principles.md §"Forgive surface
// variance, reject semantic regression": both shapes carry the same parameter
// declarations, so we normalize before the rest of the pipeline runs instead
// of forcing the agent to relearn klura's preferred dialect.
//   array form:   [{name: "recipient_name", kind: "text", example: "Adam"}, ...]
//   object form:  {recipient_name: {kind: "text", example: "Adam"}, ...}
function normalizeNotesParams(notes: Record<string, unknown>): void {
  const params = notes.params;
  if (!Array.isArray(params)) return;
  const normalized: Record<string, unknown> = {};
  params.forEach((entry, idx) => {
    if (!isPlainObject(entry)) {
      throw new Error(
        `invalid_strategy: notes.params[${idx}] must be an object with a "name" field when notes.params is given as an array`,
      );
    }
    const name = entry.name;
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`invalid_strategy: notes.params[${idx}] missing required "name" (string)`);
    }
    if (Object.prototype.hasOwnProperty.call(normalized, name)) {
      throw new Error(
        `invalid_strategy: notes.params has duplicate name "${name}" — each parameter must be declared once`,
      );
    }
    const rest = { ...entry };
    delete rest.name;
    normalized[name] = rest;
  });
  notes.params = normalized;
}

// notes.params is LLM-owned documentation that the runtime echoes back in error
// bodies, so we stay hands-off about content — but we do reject shapes the
// error-echo path would choke on (wrong types, oversized blobs) and invalid
// enum values for `kind` so the LLM's tab-complete hints stay meaningful.
export function validateNotesParamsShape(data: Record<string, unknown>): void {
  const notes = data.notes;
  if (!isPlainObject(notes)) return;
  normalizeNotesParams(notes);
  const params = notes.params;
  if (params === undefined || params === null) return;
  if (!isPlainObject(params)) {
    throw new Error(
      `invalid_strategy: notes.params must be an object or array of {name, ...} objects`,
    );
  }
  const parsed = notesParamsSchema.safeParse(params);
  if (!parsed.success) {
    const issues = zodErrorToIssues(parsed.error, 'notes.params');
    const bullets = issues.map((issue) => `  - ${issue}`).join('\n');
    const issueLabel = issues.length === 1 ? '1 issue' : `${issues.length} issues`;
    const expectedShape = renderZodSkeletonInline(notesParamsSchema);
    throw new Error(
      `invalid_strategy: notes.params has ${issueLabel} — fix all before retrying:\n${bullets}\n\nExpected shape: notes.params is ${expectedShape}`,
    );
  }
}

// baseUrl / endpoint go through the fetcher as a plain URL. Reject scheme-based
// attacks at save time — `javascript:` / `data:` / `file:` have no place in an
// HTTP strategy and only show up when the agent has misunderstood the field or
// something hostile has been injected.
export function validateBaseUrlScheme(data: Record<string, unknown>): void {
  for (const field of ['baseUrl', 'origin'] as const) {
    const v = data[field];
    if (typeof v !== 'string' || v.length === 0) continue;
    try {
      const u = new URL(v);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        // Specific hint when the scheme is ws: or wss: — the agent almost
        // certainly meant to use `wsUrl` instead. baseUrl is the HTTP component
        // (for prereqs, redirects, cookie origin); wsUrl is the WebSocket
        // endpoint. For a pure-ws capability, baseUrl is optional — just drop
        // it.
        const isWs = u.protocol === 'ws:' || u.protocol === 'wss:';
        const hint = isWs
          ? ` — did you mean to use the "wsUrl" field? baseUrl is the HTTP component of a strategy (prereq URLs, cookie origin). For a pure-websocket capability, baseUrl is optional; set protocol:"websocket" + wsUrl instead`
          : '';
        throw new Error(
          `invalid_strategy: ${field} = ${JSON.stringify(v)} uses ${u.protocol} scheme; ` +
            `must be http: or https:${hint}`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('invalid_strategy:')) throw err;
      throw new Error(`invalid_strategy: ${field} = ${JSON.stringify(v)} is not a parseable URL`, {
        cause: err,
      });
    }
  }
}

// Lock down the top-level shape of `notes`. Stops the cover-story pattern
// where the agent invents a sub-key under `notes.<anything>` to embed
// free-text rationale that no save-time guard inspects.
// Observed-capability pointers live on the platform logbook, not in notes —
// record them via the `record_observed_capability` MCP tool. Runtime-stamped
// metadata (probe outputs, capture provenance, audit advisories) lives on
// the sibling `runtime_meta` field — see validateRuntimeMetaShape.
export function validateNotesAllowlist(data: Record<string, unknown>): void {
  const notes = data.notes;
  if (!isPlainObject(notes)) return;
  const notesAllowedFields = [...NOTES_ALLOWED_KEYS];
  const unknownKeys = Object.keys(notes).filter((k) => !NOTES_ALLOWED_KEYS.has(k));
  if (unknownKeys.length === 1) {
    const key = unknownKeys[0] as string;
    throw new Error(
      `invalid_strategy: notes has unknown field "${key}". Allowed top-level notes fields:\n${describeNotesAllowlist()}\n` +
        `${didYouMeanSuffix(key, notesAllowedFields)}Companion capabilities you observed but didn't lift are recorded via the \`record_observed_capability\` MCP tool (writes to the platform logbook), not in \`notes\`.` +
        topLevelRedirectHint(unknownKeys),
    );
  }
  if (unknownKeys.length > 1) {
    const list = unknownKeys.map((k) => `"${k}"`).join(', ');
    const perKeyHints = unknownKeys
      .map((k) => {
        const suggestion = closestAllowed(k, notesAllowedFields);
        return suggestion ? `"${k}" → "${suggestion}"` : null;
      })
      .filter((s): s is string => s !== null)
      .join(', ');
    const hintLine = perKeyHints.length > 0 ? `Did you mean: ${perKeyHints}?\n` : '';
    throw new Error(
      `invalid_strategy: notes has unknown fields ${list}. Allowed top-level notes fields:\n${describeNotesAllowlist()}\n` +
        `${hintLine}Companion capabilities you observed but didn't lift are recorded via the \`record_observed_capability\` MCP tool (writes to the platform logbook), not in \`notes\`.` +
        topLevelRedirectHint(unknownKeys),
    );
  }
}

// Known save_strategy top-level argument names that agents most commonly
// misplace under `notes`. The reflex is "metadata about the save lives in
// notes" — but `changelog` is a top-level arg of save_strategy (logged to
// history alongside the strategy), `capability`/`platform`/`session_id`/
// `strategy` are the call's own positional-shaped args, and `audit_token`/
// `audit_answers` belong on the retry call body. When one of these appears
// under notes, the rejection redirects explicitly so the agent doesn't
// have to guess.
const KNOWN_TOP_LEVEL_SAVE_STRATEGY_ARGS: ReadonlySet<string> = new Set([
  'changelog',
  'capability',
  'platform',
  'session_id',
  'strategy',
  'audit_token',
  'audit_answers',
]);

function topLevelRedirectHint(unknownKeys: string[]): string {
  const matches = unknownKeys.filter((k) => KNOWN_TOP_LEVEL_SAVE_STRATEGY_ARGS.has(k));
  if (matches.length === 0) return '';
  if (matches.length === 1) {
    const k = matches[0] as string;
    return `\nNote: \`${k}\` is a top-level argument on save_strategy itself, not a notes field. Move it out of \`notes\` to the save_strategy call's body.`;
  }
  const list = matches.map((k) => `\`${k}\``).join(', ');
  return `\nNote: ${list} are top-level arguments on save_strategy itself, not notes fields. Move them out of \`notes\` to the save_strategy call's body.`;
}

// `runtime_meta` is runtime-owned — agents must not emit it. Run this on
// the raw save_strategy payload before any runtime stamping. Empty objects
// pass (no-op) so round-trip flows that re-submit an unmodified agent
// draft don't trip on a stale empty container.
export function rejectAgentEmittedRuntimeMeta(data: Record<string, unknown>): void {
  const meta = data.runtime_meta;
  if (meta === undefined || meta === null) return;
  if (!isPlainObject(meta) || Object.keys(meta).length > 0) {
    throw new Error(
      `invalid_strategy: \`runtime_meta\` is runtime-owned — the agent must not emit it. The runtime stamps fields like discovered_from_url / probe_warnings / save_warnings / tier_demote_reason on save and a later session reads them via list_platform_skills / get_strategy. Drop \`runtime_meta\` from your save_strategy payload.`,
    );
  }
}

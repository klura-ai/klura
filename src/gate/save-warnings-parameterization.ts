// Parameterization-disclosure detector — every saved strategy must either
// declare the caller-varying axes (`notes.params`) or explicitly justify
// why none apply.
//
// Why this fires: end-drive's auto-derive populates `notes.params` only
// from caller-typed literals — when the agent drove discovery with
// `args:{}`, the synthesized strategy lands with `notes.params` empty
// (`runtime/src/strategies/synthesize-on-close/fetch.ts`). Warm callers
// then can't customize the call (count, cursor, query text, id, locale).
// Most capabilities have at least one axis; a paramless save is suspicious
// by default. Genuinely parameterless capabilities (logout, viewer-scoped
// reads) take the ack path.
//
// `ackReason: 'required'`. Anti-canned at the audit-wrapper site: the ack
// reason must reference at least one structural anchor of the saved
// strategy (a body field key, header key, endpoint path segment, prereq
// name, recorded-path step id, or the literal endpoint / method). The
// detector emits the candidate anchor list as `context.candidate_anchors`;
// `validateAck` reads it back.

import type { Strategy } from '../strategies/skills';
import type { SaveWarning } from './save-warnings';

export function detectParameterizationDisclosureRequired(data: Strategy): SaveWarning[] {
  const obj = data as Record<string, unknown>;
  const tier = typeof obj.strategy === 'string' ? obj.strategy : '';
  if (tier !== 'fetch' && tier !== 'page-script' && tier !== 'recorded-path') return [];

  const notes = (data as { notes?: { params?: unknown } }).notes;
  const params = notes?.params;
  const hasDeclaredParams =
    params !== undefined &&
    params !== null &&
    typeof params === 'object' &&
    !Array.isArray(params) &&
    Object.keys(params as Record<string, unknown>).length > 0;

  if (hasDeclaredParams) return [];

  const candidateAnchors = collectParameterizationAnchors(data);

  return [
    {
      kind: 'parameterization_disclosure_required',
      message:
        `Saved strategy declares no notes.params — no caller-varying axes. Most capabilities have at least ` +
        `one (count, cursor, query text, id, locale, ordering); a paramless save means warm callers can't ` +
        `customize the call. Either declare the axes you observed during discovery, or ack with a reason ` +
        `naming the structural elements that prove this capability is genuinely parameterless.`,
      hint:
        `Declare params via notes.params = { <name>: { kind, description, example } }, and template the ` +
        `value as {{<name>}} in the body/endpoint/headers. End-drive auto-derive populates this only from ` +
        `caller-typed literals — re-discover with start_session({args:{...}}) carrying the literals you want ` +
        `parameterized, OR fix the saved strategy by hand.\n\n` +
        `Or ack inline: notes.save_warnings_acked: [{kind: "parameterization_disclosure_required", reason: ` +
        `"<structural anchor + why parameterless>"}]. The reason must name a real element of the saved strategy ` +
        `(a body field key, header key, endpoint path segment, prereq name). Bare prose like "no params apply" ` +
        `is rejected. Examples:\n` +
        `  • "endpoint /api/me/logout: no path params, body absent, prereq csrf_token covers the only ` +
        `caller-invariant secret"\n` +
        `  • "viewer-scoped — endpoint /api/viewer/profile returns the calling user; no input axis"\n` +
        `  • "body fields query and doc_id are static GraphQL operation metadata; the only caller-varying ` +
        `value would be variables, which the captured request didn't include"`,
      context: {
        candidate_anchors: candidateAnchors,
      },
    },
  ];
}

/** Enumerate structural-path tokens an agent's ack reason can reference to
 *  prove the rejection was read. Anti-canned-ack mechanism: the validateAck
 *  wrapper requires the reason to substring-match at least one of these. */
export function collectParameterizationAnchors(data: Strategy): string[] {
  const out = new Set<string>();
  const obj = data as Record<string, unknown>;

  if (typeof obj.endpoint === 'string' && obj.endpoint.length > 0) {
    out.add(obj.endpoint);
    try {
      const u = new URL(obj.endpoint, 'https://__klura_placeholder__/');
      for (const seg of u.pathname.split('/').filter((s) => s.length > 0)) {
        out.add(seg);
      }
      for (const k of u.searchParams.keys()) {
        out.add(k);
      }
    } catch {
      // Not parseable as URL — keep raw endpoint only.
    }
  }

  if (typeof obj.method === 'string' && obj.method.length > 0) {
    out.add(obj.method.toUpperCase());
    out.add('method');
  }

  const body = obj.body;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const k of Object.keys(body as Record<string, unknown>)) {
      out.add(`body.${k}`);
      out.add(k);
    }
  }
  if (body !== undefined && body !== null) {
    out.add('body');
  }

  if (obj.headers && typeof obj.headers === 'object') {
    for (const k of Object.keys(obj.headers as Record<string, unknown>)) {
      out.add(`headers.${k}`);
      out.add(k);
    }
  }

  if (Array.isArray(obj.prerequisites)) {
    obj.prerequisites.forEach((p, i) => {
      if (!p || typeof p !== 'object') return;
      const pp = p as Record<string, unknown>;
      out.add(`prerequisites[${i}]`);
      if (typeof pp.name === 'string') out.add(pp.name);
      if (typeof pp.binds === 'string') out.add(pp.binds);
    });
  }

  if (Array.isArray(obj.steps)) {
    obj.steps.forEach((s, i) => {
      if (!s || typeof s !== 'object') return;
      const ss = s as Record<string, unknown>;
      out.add(`steps[${i}]`);
      if (typeof ss.id === 'string') out.add(ss.id);
      if (typeof ss.action === 'string') out.add(ss.action);
    });
  }

  if (typeof obj.frameFromPage === 'object' && obj.frameFromPage !== null) {
    out.add('frameFromPage');
  }

  return [...out];
}

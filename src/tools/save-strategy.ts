import { pool } from '../runtime-state';
import {
  asNonEmptyBoundedString,
  asPlatformSlug,
  asIdentifierSlug,
  ValidationError,
} from '../validators';
import { invokeCheckpointAndGate, type CheckpointEnvelope } from '../checkpoints';
import { probeStrategySelectors } from '../strategies/probe';
import { collectParamExamples } from '../strategies/probe-helpers';
import { isMutatingStrategy } from '../gate/save-warnings-mutating-verification';
import {
  verifySavedStrategy,
  type VerifySavedStrategyResult,
} from '../strategies/verify-saved-strategy';
import { verifyWsUrlObserved, verifyRecordedPathOverBinaryWs } from '../strategies/verify-observed';
import * as skills from '../strategies/skills';
import type { Strategy, AuditAnswers } from '../strategies/skills';
import { commitValidatedStrategy } from '../strategies/skills';
import { ensureAccumulator } from '../strategies/discovery-artifact';
import {
  saveStrategyAudit,
  extractAcksFromNotes,
  persistWarningsOnRuntimeMeta,
} from '../audit/lift/save-strategy';
import { rejectionToErrorMessage } from '../audit';
import { getRegisteredSaveConfirmationDecider } from '../audit/lift/save-confirmation-decider';
import {
  getRegisteredSaveWarningAcker,
  type SaveWarningAck,
} from '../audit/lift/save-warning-acker';
import {
  recordParamObservation,
  getAllParamObservations,
  harvestUrlVarianceObservations,
  harvestUiClickObservationsForEntry,
  type ParamObservation,
} from '../response/session-observations';
import { enumerateStringParams, readCurrentUrl } from './_internals';
import { collectScannedFields } from '../strategies/validate/helpers';
import { rejectAgentEmittedRuntimeMeta } from '../strategies/validate/notes';
import type { LiteralClassification } from '../gate/save-audit';
import { detectAuthGatedWithoutAuthPrereq } from '../gate/save-warnings';
import { composeBudgetWarning } from '../session-obligations/budget-warning';

/** Per-phase wall-clock timings for one save_strategy call. Returned on
 *  success; attached to the thrown error on rejection (see
 *  `SaveStrategyRejection`). Lets the runner / harness see where time goes
 *  per attempt — most notably, that `probe_ms` is 0 on the rejected-attempt
 *  fast path. Mirrors the `result.elapsedMs` pattern in
 *  `runtime/src/execution/index.ts`. */
export interface SaveStrategyTimings {
  total_ms: number;
  validators_ms: number;
  audit_precheck_ms: number;
  probe_ms: number;
  audit_postcheck_ms: number;
  probe_skipped: boolean;
  audit_postcheck_skipped: boolean;
}

/** Error subclass that carries `SaveStrategyTimings` on rejected save
 *  attempts. Catchers that match by `err.message.startsWith('invalid_strategy:')`
 *  continue to work; the runner unwraps `err.timings` to capture cost data. */
export class SaveStrategyRejection extends Error {
  timings: SaveStrategyTimings;
  constructor(message: string, timings: SaveStrategyTimings) {
    super(message);
    this.name = 'SaveStrategyRejection';
    this.timings = timings;
  }
}

/** When every warning on a save_strategy audit rejection is
 *  `endpoint_collides_with_saved_capability`, the agent isn't failing to save —
 *  the runtime is refusing to overwrite an already-working strategy. Counting
 *  the attempt would force the end_drive `save_attempted_none_landed` Detector
 *  to refuse close on a session that did no new work. Rolls back the
 *  increment so the counter reflects "save attempts that could have landed". */
function decrementOnDuplicateOnlyRejection(
  sessionId: string,
  warnings: ReadonlyArray<{ kind: string }>,
): void {
  if (warnings.length === 0) return;
  const everyWarningDuplicate = warnings.every(
    (w) => w.kind === 'endpoint_collides_with_saved_capability',
  );
  if (!everyWarningDuplicate) return;
  try {
    const session = pool.getSession(sessionId);
    const current = session.saveAttemptCount ?? 0;
    if (current > 0) session.saveAttemptCount = current - 1;
  } catch {
    // Session may already be torn down; counter is best-effort.
  }
}

function newTimings(): SaveStrategyTimings {
  return {
    total_ms: 0,
    validators_ms: 0,
    audit_precheck_ms: 0,
    probe_ms: 0,
    audit_postcheck_ms: 0,
    probe_skipped: true,
    audit_postcheck_skipped: true,
  };
}

/** True when the strategy carries any prereq the save-time probe would walk —
 *  page-extract, fetch-extract, js-eval, recorded-path steps, or wsOpen.steps.
 *  Mirrors the early-exit guard inside `probeStrategySelectors` (probe/index.ts:70-79)
 *  but lifts it to the tool layer so we can skip the session-create overhead
 *  too when there's nothing to probe. */
function hasProbeablePrereqs(data: Strategy): boolean {
  const obj = data as Record<string, unknown>;
  const prereqs = obj.prerequisites;
  if (Array.isArray(prereqs)) {
    for (const p of prereqs) {
      if (!p || typeof p !== 'object') continue;
      const kind = (p as { kind?: unknown }).kind;
      if (kind === 'page-extract' || kind === 'fetch-extract' || kind === 'js-eval') return true;
    }
  }
  if (Array.isArray(obj.steps) && obj.steps.length > 0) return true;
  const wsOpen = obj.wsOpen as { steps?: unknown } | undefined;
  if (wsOpen && Array.isArray(wsOpen.steps) && wsOpen.steps.length > 0) return true;
  const response = obj.response as { format?: unknown } | undefined;
  if (response?.format === 'html') return true;
  return false;
}

// Pull the `save_probe_target_crashed` entry off `notes.save_warnings_acked`
// when present. Returns null if the agent didn't ack. Same on-disk shape as
// every other `save_warnings_acked` entry: `{kind, reason}`.
function extractCrashAck(data: Strategy): { reason: string } | null {
  const notes = (data as { notes?: Record<string, unknown> }).notes;
  if (!notes || typeof notes !== 'object') return null;
  const acks = notes.save_warnings_acked;
  if (!Array.isArray(acks)) return null;
  for (const entry of acks) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (e.kind === 'save_probe_target_crashed' && typeof e.reason === 'string') {
      return { reason: e.reason };
    }
  }
  return null;
}

/**
 * Save a strategy directly from a captured HTTP request by index. The one-call
 * path from "here are the candidates" to a persisted strategy — agent picks the
 * `intercepted_i` that matches what they reported to the user, runtime builds
 * the strategy shape from the captured request (baseUrl / endpoint / method /
 * headers, plus tier-decision from the Cookie header), saves.
 *
 * Saves without response.extract rules (agent supplies them on a re-save with
 * the refined strategy). Default tier is `page-script` when the captured
 * request had cookies, `fetch` otherwise.
 *
 * The decline-gate from close_session's refusal flow: this tool doesn't count
 * as "inspection", it counts as "save". Agents pick a candidate only AFTER
 * inspecting via get_network_log / body_preview in the refusal; this tool is
 * the save shortcut that removes the friction of authoring the strategy schema
 * from scratch.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity
export async function saveStrategyFromCapture(args: {
  session_id: string;
  platform: string;
  capability: string;
  intercepted_i: number;
  extract?: Record<string, string>;
}): Promise<{
  ok: true;
  path: string;
  tier: 'fetch' | 'page-script';
  cleanups: string[];
}> {
  // Reject missing required args at the boundary instead of letting
  // pool.getSession crash with "Session not found: undefined" — Nemotron
  // (and probably other open models) sometimes drops session_id from the
  // call. Validator surfaces a fixable error; the runtime crash didn't.
  try {
    asNonEmptyBoundedString(args.session_id, 'session_id', 200);
    asPlatformSlug(args.platform, 'platform');
    asIdentifierSlug(args.capability, 'capability');
    if (
      typeof args.intercepted_i !== 'number' ||
      !Number.isInteger(args.intercepted_i) ||
      args.intercepted_i < 0
    ) {
      throw new ValidationError(
        'intercepted_i',
        'must be a non-negative integer (the candidate_xhrs[*].i value from close_session)',
      );
    }
  } catch (e) {
    if (e instanceof ValidationError) {
      throw new Error(`invalid_save_strategy_from_capture: ${e.message}`, { cause: e });
    }
    throw e;
  }
  const session = pool.getSession(args.session_id);
  const req = session.intercepted[args.intercepted_i];
  if (!req) {
    throw new Error(
      `saveStrategyFromCapture: no captured request at intercepted_i=${args.intercepted_i}. Session has ${session.intercepted.length} captured request(s).`,
    );
  }
  let baseUrl: string;
  let endpoint: string;
  try {
    const u = new URL(req.url);
    baseUrl = `${u.protocol}//${u.host}`;
    endpoint = `${u.pathname}${u.search}`;
  } catch {
    throw new Error(`saveStrategyFromCapture: captured URL is not parseable: ${req.url}`);
  }

  // The captured URL is saved verbatim. If it has session-scoped query params
  // (signing tokens, device ids, timestamps), the validator will reject the
  // save — at which point the agent uses the RE toolkit to understand what
  // needs templating. The runtime does NOT guess which params are
  // session-scoped via hardcoded names or value-shape regex; that decision
  // belongs to the agent who can diff multiple captured fires of the same path
  // to see what varies. See SKILL.md's LIFT handoff for the
  // workflow.
  const cleanups: string[] = [];

  const headers = req.headers;
  let hasCookie = false;
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === 'cookie' && headers[k] && headers[k].length > 0) {
      hasCookie = true;
      break;
    }
  }
  const tier: 'fetch' | 'page-script' = hasCookie ? 'page-script' : 'fetch';

  // Detect JSON response shape — agent-supplied `extract` rules only apply to
  // HTML (per the strategy validator). Drop them silently for JSON responses
  // with an explicit cleanup message; the JSON body is returned verbatim and
  // callers project fields themselves.
  const ct = (() => {
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === 'content-type') return v;
    }
    const rb = req.responseBody;
    if (typeof rb === 'string' && rb.trim().startsWith('{')) return 'application/json';
    if (rb && typeof rb === 'object') return 'application/json';
    return '';
  })();
  const isJson = /\bapplication\/json\b/i.test(ct);
  let extractForSave = args.extract;
  if (isJson && args.extract && Object.keys(args.extract).length > 0) {
    extractForSave = undefined;
    cleanups.push(
      `dropped response.extract (JSON endpoint — extract rules are HTML-only; warm execute returns parsed JSON verbatim, caller projects fields).`,
    );
  }

  // Stamp where the capability was discovered so a later session can re-open it
  // directly instead of re-discovering from root. Prefer the captured request's
  // own Referer (the page the mechanism lived on) over the current page URL,
  // which at save time is often a post-submit redirect / landing page. Best-
  // effort — if neither resolves, the field stays unstamped and revisit flows
  // fall back to root + re-discovery.
  const discoveredFromUrl =
    refererFromHeaders(req.headers) ?? (await readCurrentUrl(args.session_id));
  const notesBlock: Record<string, unknown> = {};
  const runtimeMetaBlock: Record<string, unknown> = {};
  if (discoveredFromUrl) runtimeMetaBlock.discovered_from_url = discoveredFromUrl;
  // If a sibling recorded-path already exists for this capability, stamp
  // its last-step id as the partial-replay anchor. When no sibling exists
  // yet (the common case — save_strategy_from_capture often runs before
  // the recorded-path synth on close), the field stays absent and the
  // revisit-fallback ladder skips to full-replay.
  const anchorId = lookupLastRecordedPathStepId(args.platform, args.capability);
  if (anchorId) runtimeMetaBlock.discovered_at_step_id = anchorId;

  // Pre-record param observations from the full session.intercepted history
  // so the auto-lift below can read them. Routes through
  // `harvestUiClickObservationsForEntry` — same pure helper getNetworkLog
  // calls — so the typed-value filter (caller-input suppression) fires here
  // too. recordParamObservation dedupes on (value, label, source.kind), so
  // running this at save time is idempotent with anything getNetworkLog
  // already recorded during drive.
  for (let i = 0; i < session.intercepted.length; i += 1) {
    const entry = session.intercepted[i];
    if (!entry) continue;
    try {
      const derived = harvestUiClickObservationsForEntry(
        entry,
        session.performActionHistory ?? [],
        i,
      );
      for (const obs of derived) recordParamObservation(args.session_id, obs);
    } catch {
      // best-effort; observation must not break saves
    }
  }

  // Auto-lift: walk the captured request being saved; for any string query
  // param whose (name, value) has at least one ui_click observation in this
  // session, template the value to {{name}} in the endpoint and pre-populate
  // notes.params.<name> with {kind:"enum", observed_values:[...]} from every
  // ui_click observation for that name. This is structural derivation from
  // runtime ground truth (the click→XHR correlator), not a heuristic.
  const allObs = getAllParamObservations(args.session_id);
  const liftedParams: Record<
    string,
    { kind: 'enum'; observed_values: Array<{ value: string; label: string }> }
  > = {};
  let liftedEndpoint = endpoint;
  try {
    const u = new URL(req.url);
    const lifted = new Set<string>();
    for (const [paramName, paramValue] of enumerateStringParams(req)) {
      if (lifted.has(paramName)) continue;
      const obsList: ParamObservation[] = allObs[paramName] ?? [];
      const matchingClick = obsList.find(
        (o) => o.value === paramValue && o.source.kind === 'ui_click',
      );
      if (!matchingClick) continue;
      // Only lift query params here; body lifting would require splitting
      // by content-type and is out of scope for the shortcut path. Audit
      // still scans body literals via the verbose path.
      if (u.searchParams.get(paramName) !== paramValue) continue;
      lifted.add(paramName);

      const observed_values: Array<{ value: string; label: string }> = [];
      const seen = new Set<string>();
      for (const o of obsList) {
        if (o.source.kind !== 'ui_click') continue;
        const key = `${o.value} ${o.source.label}`;
        if (seen.has(key)) continue;
        seen.add(key);
        observed_values.push({ value: o.value, label: o.source.label });
      }
      liftedParams[paramName] = { kind: 'enum', observed_values };
    }
    if (lifted.size > 0) {
      const parts: string[] = [];
      for (const [k, v] of u.searchParams.entries()) {
        const ek = encodeURIComponent(k);
        parts.push(lifted.has(k) ? `${ek}={{${k}}}` : `${ek}=${encodeURIComponent(v)}`);
      }
      liftedEndpoint = parts.length > 0 ? `${u.pathname}?${parts.join('&')}` : u.pathname;
      cleanups.push(
        `auto-lifted ${lifted.size} enum param(s) (${[...lifted].join(', ')}) from click→XHR observations into {{${[...lifted].join('}}/{{')}}} placeholder(s); populated notes.params.* with grounded observed_values.`,
      );
    }
  } catch {
    // non-URL or unexpected shape — fall through with literal endpoint
  }
  // Body capture + auto-template: legacy HTML form POSTs (and JSON-bodied
  // APIs) carry caller-supplied values verbatim in req.postData. Without
  // including a `body` here, warm-execute fires the request with NO body —
  // the server still returns 2xx (e.g. creates an empty record + redirects),
  // the agent thinks it succeeded, but downstream the data is wrong. So:
  // parse postData by content-type, template every string field as
  // {{<fieldName>}} (HTML form convention: field name = caller arg name),
  // declare each field in notes.params as kind:"text" (no observation =>
  // no enum grounding possible), and add corresponding literal_provenance
  // entries below.
  const bodyParams: Record<string, string> = {};
  const bodyTemplate: Record<string, string> = {};
  if (
    req.postData !== null &&
    req.postData !== undefined &&
    req.method &&
    req.method.toUpperCase() !== 'GET'
  ) {
    const ct = (() => {
      for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === 'content-type') return v;
      }
      return '';
    })();
    const isFormBody = /\bapplication\/x-www-form-urlencoded\b/i.test(ct);
    const isJsonBody = /\bapplication\/json\b/i.test(ct);
    let parsedFields: Record<string, string> | null = null;
    if (typeof req.postData === 'object' && !Array.isArray(req.postData)) {
      parsedFields = {};
      for (const [k, v] of Object.entries(req.postData as Record<string, unknown>)) {
        if (typeof v === 'string') parsedFields[k] = v;
      }
    } else if (typeof req.postData === 'string' && req.postData.length > 0) {
      if (isFormBody || /^[^=&\s]+=[^&]*(?:&[^=&\s]+=[^&]*)*$/.test(req.postData)) {
        try {
          parsedFields = {};
          for (const [k, v] of new URLSearchParams(req.postData)) parsedFields[k] = v;
        } catch {
          parsedFields = null;
        }
      } else if (isJsonBody || req.postData.trim().startsWith('{')) {
        try {
          const parsed = JSON.parse(req.postData) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            parsedFields = {};
            for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
              if (typeof v === 'string') parsedFields[k] = v;
            }
          }
        } catch {
          parsedFields = null;
        }
      }
    }
    if (parsedFields) {
      for (const [k, v] of Object.entries(parsedFields)) {
        if (k.length === 0 || v.length === 0) continue;
        // Skip if the field name collides with an auto-lifted query param —
        // its templating already covers this name.
        if (liftedParams[k]) continue;
        bodyParams[k] = v;
        bodyTemplate[k] = `{{${k}}}`;
      }
    }
  }

  if (Object.keys(liftedParams).length > 0) {
    notesBlock.params = liftedParams;
  }
  // Add notes.params entries for body-templated fields. Default kind:"text"
  // (no UI-click observation backs typed-into-form values; the agent can
  // upgrade to enum on edit if appropriate, e.g. a <select> field).
  if (Object.keys(bodyTemplate).length > 0) {
    const params = (notesBlock.params as Record<string, unknown> | undefined) ?? {};
    for (const k of Object.keys(bodyTemplate)) {
      if (params[k]) continue;
      params[k] = { kind: 'text' };
    }
    notesBlock.params = params;
    cleanups.push(
      `auto-templated ${Object.keys(bodyTemplate).length} body field(s) (${Object.keys(bodyTemplate).join(', ')}) into {{<name>}} placeholder(s); declared as kind: "text" in notes.params.`,
    );
  }

  const strategy: Record<string, unknown> = {
    strategy: tier,
    baseUrl,
    endpoint: liftedEndpoint,
    method: req.method,
    headers,
    ...(Object.keys(bodyTemplate).length > 0 ? { body: bodyTemplate } : {}),
    notes: notesBlock,
    ...(Object.keys(runtimeMetaBlock).length > 0 ? { runtime_meta: runtimeMetaBlock } : {}),
    ...(extractForSave ? { response: { extract: extractForSave } } : {}),
  };

  // Auto-classify literal_provenance for the scanned fields the runtime can
  // mechanically derive: a single {{name}} placeholder where `name` was
  // auto-lifted (query enum) or auto-templated (body field) is unambiguously
  // {caller_input: name}; a field with no placeholders is "static". Mixed
  // shapes (multiple placeholders, or partial templating) are left
  // unclassified — the audit will reject and the agent will classify on retry.
  const knownCallerInputs = new Set([...Object.keys(liftedParams), ...Object.keys(bodyTemplate)]);
  const literalAnswers: Record<string, LiteralClassification> = {};
  for (const field of collectScannedFields(strategy as Strategy)) {
    // eslint-disable-next-line sonarjs/slow-regex
    const placeholders = [...field.value.matchAll(/\{\{([^}]+)\}\}/g)].map((m) => m[1]);
    if (placeholders.length === 0) {
      literalAnswers[field.path] = 'static';
      continue;
    }
    const only = placeholders[0];
    if (placeholders.length === 1 && only && knownCallerInputs.has(only)) {
      literalAnswers[field.path] = { caller_input: only };
    }
    // else: leave unclassified; audit will surface and agent will resolve.
  }

  // Route through the verbose saveStrategy so the consolidated audit fires
  // (literal_provenance + grounding check, observed_property_keys, unobserved
  // URLs, etc.). Mint the audit token first via a dry process() call, then
  // commit with our auto-classified answers — the runtime is supplying the
  // classifications because they're structurally derived (not LLM judgment),
  // so the token-gate's anti-canned-ack property still holds at the agent
  // boundary. If the audit emits classifiers we can't auto-fill (multiple
  // placeholders, observed_siblings, capability_name_justification), the
  // verbose path's normal rejection surfaces to the agent for resolution.
  const observedUrlsForAudit: string[] = [];
  for (const e of session.intercepted) {
    if (typeof e.url === 'string') observedUrlsForAudit.push(e.url);
  }
  const capturedEndpointPaths = new Set<string>();
  for (const e of session.intercepted) {
    if (typeof e.url !== 'string') continue;
    try {
      const u = new URL(e.url);
      capturedEndpointPaths.add(`${u.origin}${u.pathname}`);
    } catch {
      // skip non-URL entries
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const auditSaveStrategy = require('../audit/lift/save-strategy') as typeof import('../audit/lift/save-strategy'); // prettier-ignore
  const { saveStrategyAudit } = auditSaveStrategy;
  const ctxForAudit = {
    sessionId: args.session_id,
    platform: args.platform,
    capability: args.capability,
    session,
    observedSiblings: [],
    observedParamValues: getAllParamObservations(args.session_id),
    capturedEndpointPaths,
    observedUrls: observedUrlsForAudit,
  };
  const probeResult = saveStrategyAudit.process(strategy as Strategy, ctxForAudit, {});
  let auditInput: { token?: string; answers?: AuditAnswers } | undefined;
  if (probeResult.status === 'rejected' && probeResult.rejection.token) {
    auditInput = {
      token: probeResult.rejection.token,
      answers: { literal_provenance: literalAnswers, observed_siblings: {} },
    };
  }
  const verboseResult = await saveStrategy(
    args.platform,
    args.capability,
    strategy as Strategy,
    undefined,
    args.session_id,
    auditInput,
  );
  return {
    ok: true,
    path: verboseResult.path,
    tier,
    cleanups,
  };
}

function lookupLastRecordedPathStepId(platform: string, capability: string): string | undefined {
  const strategies = skills.loadStrategies(platform, capability);
  const recorded = strategies.find((s) => s.strategy === 'recorded-path');
  if (!recorded) return undefined;
  const steps = (recorded as { steps?: Array<{ id?: unknown }> }).steps ?? [];
  if (steps.length === 0) return undefined;
  const last = steps[steps.length - 1];
  const id = last?.id;
  return typeof id === 'string' ? id : undefined;
}

/**
 * True when the strategy declares an auth-providing prerequisite — `{kind:
 * "tag", tag: "auth"}` or `{kind: "capability"}` pointing at a capability that
 * `provides: ["auth"]`. The save-time post-save probe re-fires the full prereq
 * chain cold; an auth prereq's login needs credentials the probe can't supply
 * (they're caller-input on the login, not on this dependent capability's args),
 * so the chain 401s and a WORKING strategy gets archived — which trains the
 * agent to drop the auth prereq as a workaround. We skip the probe for these
 * (stamping unverified) instead, the same way unsatisfied placeholders skip it.
 */
export function strategyHasAuthPrereq(data: Strategy, platform: string): boolean {
  const prereqs = (data as { prerequisites?: unknown }).prerequisites;
  if (!Array.isArray(prereqs)) return false;
  let authCaps: Set<string> | null = null;
  for (const p of prereqs) {
    if (!p || typeof p !== 'object') continue;
    const pp = p as { kind?: unknown; tag?: unknown; capability?: unknown };
    if (pp.kind === 'tag' && pp.tag === 'auth') return true;
    if (pp.kind === 'capability' && typeof pp.capability === 'string') {
      if (authCaps === null) authCaps = new Set(skills.findCapabilitiesProviding(platform, 'auth'));
      if (authCaps.has(pp.capability)) return true;
    }
  }
  return false;
}

/** Extract a usable http(s) Referer URL from a captured request's headers
 *  (header name casing varies by transport). Returns undefined otherwise. */
export function refererFromHeaders(headers: unknown): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const h = headers as Record<string, unknown>;
  const ref = h.referer ?? h.Referer ?? h.REFERER;
  return typeof ref === 'string' && /^https?:\/\//i.test(ref) ? ref : undefined;
}

/**
 * Pick the URL a saved strategy was "discovered from" by evidence rather than by
 * whatever page the browser happens to sit on at save time. The Referer of the
 * captured request that fired the strategy's own endpoint is the page the
 * mechanism actually lived on — for a form-POST that's the form page, not the
 * post-submit redirect landing; for an XHR it's the real page, not the
 * start_session URL. Matches by origin + the static (pre-`{{token}}`) path
 * prefix so a templated endpoint still finds its capture. Returns undefined when
 * no captured request matches (caller falls back to the current page URL).
 */
export function discoveredFromUrlForStrategy(
  data: Strategy,
  intercepted: ReadonlyArray<{ url?: string; headers?: unknown }>,
): string | undefined {
  const obj = data as Record<string, unknown>;
  const baseUrl = typeof obj.baseUrl === 'string' ? obj.baseUrl : '';
  const endpoint = typeof obj.endpoint === 'string' ? obj.endpoint : '';
  if (!baseUrl || !endpoint) return undefined;
  const endpointPath = endpoint.split('?')[0] ?? endpoint;
  let targetOrigin: string;
  let targetPathPrefix: string;
  try {
    const u = new URL(baseUrl);
    targetOrigin = u.origin;
    const combined = u.pathname.replace(/\/$/, '') + endpointPath;
    const ph = combined.indexOf('{{');
    targetPathPrefix = ph >= 0 ? combined.slice(0, ph) : combined;
  } catch {
    return undefined;
  }
  for (const entry of intercepted) {
    if (typeof entry.url !== 'string') continue;
    let parsed: URL;
    try {
      parsed = new URL(entry.url);
    } catch {
      continue;
    }
    if (parsed.origin !== targetOrigin) continue;
    if (!parsed.pathname.startsWith(targetPathPrefix)) continue;
    const ref = refererFromHeaders(entry.headers);
    if (ref) return ref;
  }
  return undefined;
}

// eslint-disable-next-line sonarjs/cognitive-complexity
export async function saveStrategy(
  platform: string,
  capability: string,
  data: Strategy,
  changelog?: string,
  sessionId?: string,
  audit?: { token?: string; answers?: import('../strategies/skills').AuditAnswers },
): Promise<{
  ok: true;
  path: string;
  advisory?: string;
  _checkpoint?: CheckpointEnvelope;
  validation_target?: { method: string; url: string };
  save_warnings?: Array<{ kind: string; message: string; hint?: string }>;
  save_warnings_acked?: Array<{ kind: string; reason: string }>;
  /** Surfaced when the runtime added a prereq the agent didn't supply.
   *  Currently fires for the auth-gated → typed-auth prereq injection (see
   *  runtime/src/tools/save-strategy.ts). */
  auto_injected?: {
    prerequisites: Array<{ name: string; kind: 'tag'; tag: string }>;
    reason: string;
  };
  /** Long-lived-session budget warning. Decorates save responses past
   *  the soft session-age cap so agents see the budget before getting
   *  SIGKILLed mid-thrash by an orchestrator wall-clock cap. See
   *  `runtime/src/session-obligations/budget-warning.ts`. */
  _budget_warning?: string;
  /** Per-phase wall-clock timings. Lets the harness see where time goes;
   *  in particular, `probe_ms` is 0 (and `probe_skipped: true`) on rejected
   *  attempts that failed shape validation or the audit pre-check. */
  timings?: SaveStrategyTimings;
}> {
  const t0 = Date.now();
  const timings = newTimings();
  // Helper to throw `invalid_strategy:` errors with timings attached so the
  // runner can read where time went on rejected attempts.
  const rejectWithTimings = (message: string): never => {
    timings.total_ms = Date.now() - t0;
    throw new SaveStrategyRejection(message, { ...timings });
  };

  // Track every save attempt on the session — including ones that throw on
  // audit rejection or validation. close-session reads this counter against
  // savedCapabilities to refuse a clean close when the agent hammered save
  // without ever landing a successful one. Best-effort: programmatic saves
  // with no session skip the counter entirely.
  if (sessionId) {
    try {
      const trackingSession = pool.getSession(sessionId);
      trackingSession.saveAttemptCount = (trackingSession.saveAttemptCount ?? 0) + 1;
      // Session-platform cross-check. When the agent passes a `platform` that
      // disagrees with the slug start_session opened on, the save commits
      // under a fresh `~/.klura/skills/<wrong-slug>/` dir invisible to the
      // session's prior on-disk strategies — observations and saves split
      // across parallel namespaces. Reject before committing.
      if (
        typeof trackingSession.platform === 'string' &&
        trackingSession.platform.length > 0 &&
        trackingSession.platform !== platform
      ) {
        rejectWithTimings(
          `invalid_strategy: platform mismatch — session ${JSON.stringify(sessionId)} opened on ` +
            `platform ${JSON.stringify(trackingSession.platform)}, but save_strategy was called ` +
            `with platform ${JSON.stringify(platform)}. Saving here would write under the wrong ` +
            `~/.klura/skills/${platform}/ dir, invisible to the session's prior observations + ` +
            `on-disk strategies. Pass platform ${JSON.stringify(trackingSession.platform)} (the ` +
            `slug start_session opened on) so the save lands in the canonical namespace.`,
        );
      }
    } catch (e) {
      if (e instanceof SaveStrategyRejection) throw e;
      // Session may already be torn down; counter is best-effort.
    }
  }

  // `runtime_meta` is runtime-owned. Reject any agent-emitted value before
  // stamping our own fields.
  try {
    rejectAgentEmittedRuntimeMeta(data as Record<string, unknown>);
  } catch (e) {
    if (e instanceof Error) rejectWithTimings(e.message);
    throw e;
  }

  // ---- Build observation inputs (shared by validators, audit, probe) ----
  // Single `getInterceptedRequests` read; reuse for capturedUrls,
  // capturedEndpointPaths, and ws-frame verification.
  let observedUrlsForAudit: readonly string[] = [];
  let sessionForAudit: import('../drivers/types/session').Session | null = null;
  let capturedEndpointPaths: Set<string> | undefined;
  if (sessionId) {
    try {
      const session = pool.getSession(sessionId);
      const driver = pool.driverFor(session.id);
      const captured = await driver.getInterceptedRequests(session).catch(() => []);
      const capturedUrls = captured
        .map((r) => (typeof r.url === 'string' ? r.url : null))
        .filter((u): u is string => !!u);
      const visited = Array.isArray(session.visitedUrls) ? session.visitedUrls : [];
      observedUrlsForAudit = [...capturedUrls, ...visited];
      sessionForAudit = session;
      harvestUrlVarianceObservations(sessionId, captured);
      const wsFrames = await driver.getInterceptedWebSocketFrames(session).catch(() => []);
      // WS-shape verifications — these throw `invalid_strategy:` for
      // structural rejections (wsUrl not observed, recorded-path-over-WS),
      // which short-circuit before probe.
      verifyWsUrlObserved(data as unknown as Record<string, unknown>, wsFrames);
      verifyRecordedPathOverBinaryWs(
        data as unknown as Record<string, unknown>,
        captured,
        wsFrames,
        sessionId,
      );
      // Build capturedEndpointPaths and record click→XHR observations from
      // the same captured array.
      capturedEndpointPaths = new Set<string>();
      for (let i = 0; i < captured.length; i += 1) {
        const entry = captured[i];
        if (!entry) continue;
        try {
          const u = new URL(entry.url);
          capturedEndpointPaths.add(`${u.origin}${u.pathname}`);
        } catch {
          // skip non-URL entries
        }
        try {
          const derived = harvestUiClickObservationsForEntry(
            entry,
            session.performActionHistory ?? [],
            i,
          );
          for (const obs of derived) recordParamObservation(sessionId, obs);
        } catch {
          // best-effort; observation must not break saves
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('invalid_strategy:')) {
        rejectWithTimings(err.message);
      }
      // best-effort guard — leave observation inputs empty on driver errors
    }
  }

  // ---- Stamp runtime_meta.discovered_from_url ----
  // Audit's unobserved_url detector reads this — set before audit runs. Prefer
  // the Referer of the captured request that fired this strategy's endpoint (the
  // page the mechanism lived on) over the current page URL, which at save time
  // is frequently a post-submit redirect / the start_session URL.
  if (sessionId) {
    try {
      const intercepted = pool.getSession(sessionId).intercepted;
      const url =
        discoveredFromUrlForStrategy(data, intercepted) ?? (await readCurrentUrl(sessionId));
      if (url) {
        const meta = (data as { runtime_meta?: Record<string, unknown> }).runtime_meta ?? {};
        meta.discovered_from_url = url;
        (data as { runtime_meta?: Record<string, unknown> }).runtime_meta = meta;
      }
    } catch {
      // best-effort
    }
  }

  // ---- Auto-inject typed-auth prereq (moved earlier in the pipeline) ----
  // Mutates `data.prerequisites`. `capabilityNameJustificationClassifier.hashFields`
  // binds against `data.prerequisites`, so this MUST run before the audit
  // pre-check; otherwise a token minted on the un-injected payload would hash-
  // mismatch on the post-injection retry.
  let authPrereqAutoInjected = false;
  const selfProvidesAuth = Array.isArray((data as { provides?: unknown }).provides)
    ? (data as { provides: unknown[] }).provides.includes('auth')
    : false;
  if (
    !selfProvidesAuth &&
    sessionId &&
    ((data as { strategy?: unknown }).strategy === 'fetch' ||
      (data as { strategy?: unknown }).strategy === 'page-script')
  ) {
    const existing = (data as { prerequisites?: unknown[] }).prerequisites;
    const hasCapOrTagPrereq =
      Array.isArray(existing) &&
      existing.some((p) => {
        if (!p || typeof p !== 'object') return false;
        const kind = (p as { kind?: unknown }).kind;
        return kind === 'capability' || kind === 'tag';
      });
    const authProviders = skills.findCapabilitiesProviding(platform, 'auth');
    if (!hasCapOrTagPrereq && authProviders.length > 0) {
      const authGatedWarnings = detectAuthGatedWithoutAuthPrereq(data, sessionId);
      if (authGatedWarnings.length > 0) {
        const next = Array.isArray(existing) ? [...existing] : [];
        next.push({ name: 'auth', kind: 'tag', tag: 'auth' });
        (data as { prerequisites?: unknown[] }).prerequisites = next;
        authPrereqAutoInjected = true;
      }
    }
  }

  // ---- Build audit context ----
  const observedParamValues = sessionId ? getAllParamObservations(sessionId) : undefined;
  const auditCtx = {
    sessionId: sessionId ?? '',
    platform,
    capability,
    session: sessionForAudit,
    observedSiblings: [],
    observedParamValues: observedParamValues ?? {},
    capturedEndpointPaths: capturedEndpointPaths ?? new Set<string>(),
    observedUrls: observedUrlsForAudit,
  };

  // ---- Stage 0 shape checks ----
  // Throws an `invalid_strategy:` rejection bundling every shape issue at
  // once. Runs unconditionally so programmatic-shape saves still get
  // validated even when the audit pipeline is gated on sessionId below.
  const tValStart = Date.now();
  try {
    saveStrategyAudit.runShapeChecks(data, auditCtx);
  } catch (e) {
    timings.validators_ms = Date.now() - tValStart;
    if (e instanceof Error) rejectWithTimings(e.message);
    throw e;
  }
  timings.validators_ms = Date.now() - tValStart;

  // ---- Pre-check audit (dryRun) ----
  // Catches all rejections that don't depend on probe-side mutations.
  // When this rejects, we throw immediately — probe never runs. This is
  // the main latency win for the rejected-attempt path.
  // SaveConfirmationDecider injection mirrors `skills.saveStrategy` so the
  // unattended-bench path auto-resolves user_confirmation.
  const buildAuditAnswers = (): Record<string, unknown> => {
    const agentAnswers = (audit?.answers as Record<string, unknown> | undefined) ?? {};
    const decider = getRegisteredSaveConfirmationDecider();
    if (decider) {
      const synthesized = decider.decide(data, auditCtx);
      return {
        ...agentAnswers,
        user_confirmation: {
          user_decision: synthesized.decision,
          user_quote: synthesized.quote,
        },
      };
    }
    return agentAnswers;
  };

  // Resolve save-warning acks via the harness acker when registered —
  // hijacks `notes.save_warnings_acked` so the LLM's inline reasons are
  // ignored in favor of harness-attested user replies. Falls back to
  // `extractAcksFromNotes` when no acker. Done OUTSIDE the audit
  // pipeline so the audit class stays sync; the acker is async because
  // harnesses (CLI stdin, GUI dialog, etc.) need that.
  const harnessAcker = getRegisteredSaveWarningAcker();
  let resolvedAcks: Record<string, string> = extractAcksFromNotes(data);
  if (harnessAcker && sessionId) {
    // First dry-run audit (with whatever acks the LLM had) to discover
    // which ackable warnings emit. Then ack each one via the harness,
    // override `resolvedAcks` with the user-attested verdicts, and let
    // the canonical preAudit below see the harness-attested values.
    const discoveryAudit = saveStrategyAudit.process(data, auditCtx, {
      token: audit?.token,
      answers: buildAuditAnswers(),
      acks: {},
      dryRun: true,
    });
    if (discoveryAudit.status === 'rejected') {
      const emitted = discoveryAudit.rejection.warnings;
      const harnessAcks: Record<string, string> = {};
      const tier =
        typeof (data as { strategy?: string }).strategy === 'string'
          ? (data as { strategy: string }).strategy
          : undefined;
      for (const warning of emitted) {
        const verdict = await invokeWarningAcker(harnessAcker, warning, {
          platform,
          capability,
          tier,
        }).catch((err: unknown) => {
          rejectWithTimings(
            `save_warning_acker_threw:${warning.kind}: ${err instanceof Error ? err.message : String(err)}`,
          );
          return null as never;
        });
        if (verdict.decision === 'reject') {
          rejectWithTimings(
            `user_rejected_save_warning:${warning.kind} — user reply: ${JSON.stringify(verdict.reason.slice(0, 200))}`,
          );
        }
        if (verdict.reason.trim().length === 0) {
          rejectWithTimings(
            `save_warning_acker_empty_reason:${warning.kind} — harness must return a non-empty reason on approve`,
          );
        }
        harnessAcks[warning.kind] = verdict.reason;
      }
      resolvedAcks = harnessAcks;
      // Persist harness-attested acks to the strategy so the saved file
      // records what the USER said (not the LLM's prior canned text).
      const notes = ((data as { notes?: Record<string, unknown> }).notes ??= {});
      notes.save_warnings_acked = Object.entries(harnessAcks).map(([kind, reason]) => ({
        kind,
        reason,
      }));
    }
  }

  if (sessionId) {
    const tAuditPreStart = Date.now();
    const preAudit = saveStrategyAudit.process(data, auditCtx, {
      token: audit?.token,
      answers: buildAuditAnswers(),
      acks: resolvedAcks,
      dryRun: true,
    });
    timings.audit_precheck_ms = Date.now() - tAuditPreStart;
    if (preAudit.status === 'rejected') {
      // Decrement saveAttemptCount when the ONLY rejection cause is
      // `endpoint_collides_with_saved_capability` — that warning is
      // "duplicate correctly rejected" (the platform already has a
      // working strategy for this endpoint), not "save attempt failed".
      // Counting it as a failed attempt would force the end_drive
      // `save_attempted_none_landed` Detector to refuse close, leaving
      // the agent with no clean exit on a session that did no new work.
      decrementOnDuplicateOnlyRejection(sessionId, preAudit.rejection.warnings);
      rejectWithTimings(rejectionToErrorMessage('save_strategy', preAudit.rejection));
    }
  }

  // ---- DOM probe ----
  // Runs ONLY when (a) audit pre-check committed, AND (b) the strategy
  // carries probe-able prereqs. Most rejected-attempt paths never reach
  // this block.
  if (hasProbeablePrereqs(data)) {
    timings.probe_skipped = false;
    const tProbeStart = Date.now();
    try {
      await probeStrategySelectors({
        data: data as unknown as Record<string, unknown>,
        platform,
        pool,
      });
    } catch (err) {
      timings.probe_ms = Date.now() - tProbeStart;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith('invalid_strategy: save_probe_target_crashed:')) {
        // Crash-during-probe escape hatch. The save still proceeds when
        // `notes.save_warnings_acked` includes a `save_probe_target_crashed`
        // ack whose reason quotes ≥40 chars of a prior session js_eval
        // expression — the runtime structurally validates the quoted
        // substring against `session.jsEvalCalls`.
        const acked = extractCrashAck(data);
        const session = sessionId ? pool.getSession(sessionId) : null;
        const priorCalls = (session?.artifactAccumulator?.jsEvalCalls ?? [])
          .map((c) => (typeof c.expression === 'string' ? c.expression : ''))
          .filter((e) => e.length >= 40);
        const reason = acked?.reason ?? '';
        const validated =
          acked &&
          reason.length >= 40 &&
          priorCalls.some((expr: string) => {
            for (let i = 0; i + 40 <= reason.length; i += 1) {
              const candidate = reason.slice(i, i + 40);
              if (expr.includes(candidate)) return true;
            }
            return false;
          });
        if (!validated) rejectWithTimings(msg);
        // Ack validated structurally — let the save through.
      } else {
        rejectWithTimings(msg);
      }
    }
    timings.probe_ms = Date.now() - tProbeStart;
  }

  // ---- Post-probe audit (canonical pass — consumes token + persists warnings) ----
  // Probe may have demoted `data.strategy` (fetch → page-script). The
  // user_confirmation classifier's hash binds to the whole payload, so a
  // tier change re-rejects with payload_changed — correct behavior, the
  // agent approved a fetch but we're saving page-script. The post-check
  // also runs when tier is unchanged so the token gets consumed and any
  // emitted warnings persist on `runtime_meta.save_warnings`.
  if (sessionId) {
    timings.audit_postcheck_skipped = false;
    const tAuditPostStart = Date.now();
    const finalAudit = saveStrategyAudit.process(data, auditCtx, {
      token: audit?.token,
      answers: buildAuditAnswers(),
      // resolvedAcks already reflects harness-attested verdicts when an
      // acker was registered, or falls back to the LLM's notes when not.
      // Re-read from notes here to pick up any post-probe mutations to
      // save_warnings_acked (the harness-mode write above is already in
      // place at this point).
      acks: harnessAcker ? resolvedAcks : extractAcksFromNotes(data),
    });
    timings.audit_postcheck_ms = Date.now() - tAuditPostStart;
    if (finalAudit.status === 'rejected') {
      rejectWithTimings(rejectionToErrorMessage('save_strategy', finalAudit.rejection));
    } else {
      persistWarningsOnRuntimeMeta(data, finalAudit.warnings);
    }
  }

  // ---- Commit ----
  const filePath = commitValidatedStrategy(platform, capability, data, changelog, sessionId);
  // Track the save on the session so close_session auto-synthesis knows which
  // capabilities to build fallbacks for. Only the capability name + tier +
  // timestamp are kept here — the synthesizer re-loads the saved strategy from
  // disk when it needs the full body.
  if (sessionId) {
    try {
      const session = pool.getSession(sessionId);
      if (!session.savedCapabilities) session.savedCapabilities = [];
      const tier =
        typeof (data as { strategy?: unknown }).strategy === 'string'
          ? (data as { strategy: string }).strategy
          : 'unknown';
      session.savedCapabilities.push({ capability, at: Date.now(), tier });
      // A committed save/update supersedes the stale-strategy flag set when
      // auto-execute failed at start_session. Without this clear, the flag
      // persists and the end_drive reverse-engineer handoff keeps routing the
      // capability through LIFT even though a fresh strategy just landed —
      // contradicting STRATEGY_AMEND's drive-tier amend contract (the agent
      // sees both "saved" and "stale_existing_strategy: true" at once).
      session.staleStrategyCapabilities?.delete(capability);
    } catch {
      // Session may already be torn down (programmatic save from a test, etc.)
    }
  }
  // Auto-clear any prior AGENT decline hypothesis for this capability on a
  // successful save. Invariant: a saved strategy supersedes a decline
  // hypothesis. close_session already short-circuits on `hasAny:true` before
  // consulting the hypothesis path, so leaving the hypothesis on disk makes it
  // dead data — a future strategy cleanup could delete the strategy and
  // resurrect a stale hypothesis. Keep the two states in sync on disk. USER
  // POLICY is untouched — only the user can change that. Post-save validation
  // handoff. The save's URL-observation + DOM-probe guards catch hallucinated
  // URLs and missing selectors, but they don't catch "the composed endpoint
  // returns 4xx at warm-execute" — observed failure mode: agent saves a
  // page-script with an endpoint that works in one probe fetch but misses
  // required signing/session params, and the save lands broken. Hand off to the
  // agent: compose a one-call validation, classify per pre_action_consent Tier
  // 1/2, fire (Tier 1) or ask user (Tier 2), confirm the response shape
  // matches. The runtime can't classify Tier safely — it lacks recipient /
  // monetary-flow context — so this is a consent handoff, same shape as
  // start_session's mutating-args advisory. See
  // klura://reference#checkpoints.
  // Post-save verification fires for every HTTP-tier save. It is gated on the
  // TIER, not on `buildValidationTarget` — a page-script strategy whose request
  // lives entirely inside a js-eval prereq has no top-level baseUrl/endpoint, so
  // no `{method,url}` can be derived, yet that is exactly the shape that most
  // needs verifying. `verifySavedStrategy` runs the whole strategy through
  // `execute()`, which loads it from disk and resolves the full prereq chain —
  // it never needs a pre-derived target. `validation_target` rides along only
  // as informational context for the agent's Tier classification.
  const validation = buildValidationTarget(data);
  const verifiableTier =
    (data as { strategy?: string }).strategy === 'fetch' ||
    (data as { strategy?: string }).strategy === 'page-script';
  let validationCheckpoint: CheckpointEnvelope | undefined;
  let postSaveValidation: VerifySavedStrategyResult | undefined;
  if (verifiableTier && sessionId) {
    try {
      // Stage the deferred verification on the session. `ack_checkpoint` reads
      // `pendingPostSaveValidation` on consented resolution and runs
      // `verifySavedStrategy` — the runtime owns the execute+2xx+archive, the
      // agent only relays consent. Args come from the session's declared
      // capability, falling back to notes.params examples.
      const session = pool.getSession(sessionId);
      const declared = session.declaredCapabilities?.find((d) => d.capability === capability);
      const verifyArgs: Record<string, unknown> =
        declared?.args && Object.keys(declared.args).length > 0
          ? declared.args
          : collectParamExamples(data);

      // If the saved strategy templates any {{placeholder}} that verifyArgs
      // doesn't satisfy, running execute() with the unsatisfied keys produces
      // `undefined` substitutions — prereqs see `args.X = undefined`, expressions
      // emit `JSON.stringify(undefined)`-shaped garbage, return-shape validation
      // fails with noise like "string of length 14". That noise is structural,
      // not a real strategy bug. Skip the verification entirely; the strategy
      // stands unverified and the response carries the skip reason.
      const unsatisfied = findUnsatisfiedPlaceholders(data, verifyArgs);
      if (unsatisfied.size > 0) {
        const placeholderList = [...unsatisfied].map((n) => '{{' + n + '}}').join(', ');
        postSaveValidation = {
          ok: true,
          status: 0,
          archived: false,
          message:
            `post_save_validation skipped: strategy templates ${unsatisfied.size} placeholder(s) ` +
            `(${placeholderList}) that neither session-declared ` +
            `args nor notes.params.*.example can satisfy. Re-running with undefined args would produce ` +
            `false-negative failures. Either declare these args via start_session({args}) or add ` +
            `notes.params.<name>.example values; then re-save.`,
        };
      } else if (strategyHasAuthPrereq(data, platform)) {
        // Auth-prereq strategies can't be probed cold — the login the prereq
        // resolves to needs credentials that aren't on this capability's args.
        // Re-firing it would 401 and archive a working strategy, training the
        // agent to drop the auth prereq. Stamp unverified; a later authed
        // session (live cookie jar) validates it.
        session.pendingPostSaveValidation = undefined;
        skills.stampRuntimeMeta(platform, capability, { post_save_validation: 'skipped' });
        postSaveValidation = {
          ok: true,
          status: 0,
          archived: false,
          message:
            `post_save_validation skipped: \`${capability}\` declares an auth prerequisite whose ` +
            `credentials can't be supplied at save-time probe (they're caller-input on the login, ` +
            `not on this capability). Re-running cold would 401 and wrongly archive a working ` +
            `strategy. Saved unverified (runtime_meta.post_save_validation: "skipped") — it ` +
            `validates on the next execute in an authenticated session.`,
        };
      } else {
        session.pendingPostSaveValidation = { platform, capability, args: verifyArgs };

        const mutating = isMutatingStrategy(data);
        const { resolution, envelope } = await invokeCheckpointAndGate(
          'post_save_validation_consent',
          {
            session_id: sessionId,
            capability,
            context: {
              kind: 'post_save_validation_consent',
              capability,
              pendingAction: `the runtime re-running the saved \`${capability}\` strategy once, end-to-end, to verify it returns 2xx`,
              contextSummary: `Strategy tier: ${(data as { strategy?: string }).strategy ?? 'unknown'}${mutating ? ', mutating-shaped — re-running repeats a real side effect, classify Tier 2 unless the action is genuinely idempotent' : ' — likely Tier 1 if the request is idempotent'}. On your consent (ack_checkpoint, non-cancelled) the RUNTIME itself re-runs the saved strategy end-to-end and asserts 2xx — a non-2xx archives it as broken and you fix + re-save this session. You do not fire anything yourself; classify Tier 1 (idempotent/read — ack immediately) vs Tier 2 (mutation / real-account side-effect / third-party recipient — explain, then ack only on user OK)`,
              declineHandler: `the save stands but is recorded unverified (runtime_meta.post_save_validation: "declined"); a later session can re-validate. Add a discovery note saying why consent was withheld.`,
              ...(validation ? { validation_target: validation } : {}),
            },
          },
        );
        if (envelope) {
          // Interactive host: the agent acks the checkpoint and `ackCheckpoint`
          // runs `verifySavedStrategy`. The deferred payload stays staged.
          validationCheckpoint = envelope;
        } else if (resolution.status === 'continue') {
          // Unattended host (no interactive consenter) pre-consented by
          // resolving the checkpoint to `continue` instead of handing over.
          session.pendingPostSaveValidation = undefined;
          if (mutating) {
            // A blanket `continue` from a non-interactive decider is NOT the
            // Tier-2 user OK the consent prompt requires for a mutating action.
            // Re-running the saved strategy end-to-end repeats the real side
            // effect (a second form submit / message / order / email). Record
            // the save as unverified instead of double-firing; an interactive
            // session can re-validate later.
            skills.stampRuntimeMeta(platform, capability, { post_save_validation: 'declined' });
            postSaveValidation = {
              ok: true,
              status: 0,
              archived: false,
              message:
                `post_save_validation skipped: \`${capability}\` is mutating-shaped and the host ` +
                `pre-consented non-interactively. Re-running end-to-end would repeat the real ` +
                `side effect, so the runtime did not re-fire it. The save stands, recorded ` +
                `unverified (runtime_meta.post_save_validation: "declined") — re-validate in an ` +
                `interactive session.`,
            };
          } else {
            // Read/idempotent (Tier 1): run the verification inline now — there
            // is no later ack — and fold the result into this response. A
            // non-2xx archives the strategy.
            postSaveValidation = await verifySavedStrategy(platform, capability, verifyArgs, pool);
          }
        }
      }
    } catch {
      // Best-effort — a missing session just means no advisory lands; the
      // save itself still succeeds.
    }
  }
  // Surface save-time warnings + agent acks on the immediate response so the
  // agent sees them on the turn it saved — not behind a subsequent
  // list_skills() lookup. Close-to-execution priming per principles.md
  // §"Priming agents": the advisory sits on the response the agent is already
  // reading. runtime_meta.save_warnings is runtime-emitted (audit advisories);
  // notes.save_warnings_acked is the agent's own override that unblocked the
  // save, echoed back so the agent can double-check its ack text.
  const notes = (data as { notes?: Record<string, unknown> }).notes ?? {};
  const runtimeMetaForResponse =
    (data as { runtime_meta?: Record<string, unknown> }).runtime_meta ?? {};
  const persistedWarnings = Array.isArray(runtimeMetaForResponse.save_warnings)
    ? (runtimeMetaForResponse.save_warnings as Array<{
        kind: string;
        message: string;
        hint?: string;
      }>)
    : [];
  const persistedAcks = Array.isArray(notes.save_warnings_acked)
    ? (notes.save_warnings_acked as Array<{ kind: string; reason: string }>)
    : [];

  // Cross-session-resume hint: when the strategy includes a non-trivial
  // js-eval prereq (the agent reverse-engineered something — chained crypto,
  // signing routine, request-builder walk) AND the session hasn't dropped a
  // single artifact breadcrumb yet (no verified_expression, no discovery_note,
  // no resume_pointer), surface a one-line nudge to ALSO persist the
  // expression via save_verified_expression. The strategy file is the
  // runtime; the artifact is the breadcrumb trail that lets graduation,
  // resume, and cross-session re-derivation skip the discovery work entirely.
  // Without this nudge the agent commonly ships a strategy with the RE
  // baked into the prereq and leaves the artifact empty — same content, but
  // only retrievable by `get_strategy`, not by `list_platform_skills.
  // discovery_artifact`. Fires only when *all three* artifact channels are
  // empty for this capability (we don't second-guess an agent who's already
  // breadcrumbing).
  const substantiveJsEvalExpr = findSubstantiveJsEvalPrereqExpression(data);
  let artifactBreadcrumbHint: string | undefined;
  if (substantiveJsEvalExpr && sessionId) {
    try {
      const session = pool.getSession(sessionId);
      const acc = ensureAccumulator(session);
      const hasVerified =
        Array.isArray(acc.verifiedExpressions[capability]) &&
        acc.verifiedExpressions[capability].length > 0;
      const hasNotes = Array.isArray(acc.notes[capability]) && acc.notes[capability].length > 0;
      const hasPointers =
        Array.isArray(acc.agentResumePointers[capability]) &&
        acc.agentResumePointers[capability].length > 0;
      if (!hasVerified && !hasNotes && !hasPointers) {
        const exprPreview = substantiveJsEvalExpr.slice(0, 60).replace(/\s+/g, ' ');
        artifactBreadcrumbHint =
          `Saved strategy includes a substantive js-eval prereq (~${substantiveJsEvalExpr.length} chars: "${exprPreview}…"). ` +
          `Also call \`save_verified_expression({session_id, capability: "${capability}", expression, returns, binds_args})\` ` +
          `so the RE work is independently queryable via the discovery artifact — future sessions read it from ` +
          `\`list_platform_skills().discovery_artifact.verified_expressions\` and can skip re-deriving when graduating ` +
          `the strategy or resuming partway through. The strategy file is the runtime; the artifact is the breadcrumb trail.`;
      }
    } catch {
      // Session may already be torn down (programmatic save from a test);
      // hint is best-effort.
    }
  }

  timings.total_ms = Date.now() - t0;

  // Long-lived-session budget warning. When the session has been driving
  // past the soft cap, decorate the save response so the agent sees the
  // budget before getting SIGKILLed by an orchestrator wall-clock cap.
  // See loop pattern #15 (session-timeout-no-end-drive-no-retrospective).
  let budgetWarning: string | undefined;
  if (sessionId) {
    try {
      budgetWarning = composeBudgetWarning(pool.getSession(sessionId)) ?? undefined;
    } catch {
      // session may be torn down — warning is best-effort
    }
  }

  return {
    ok: true,
    path: filePath,
    ...(validationCheckpoint
      ? { _checkpoint: validationCheckpoint, validation_target: validation }
      : {}),
    ...(postSaveValidation ? { post_save_validation: postSaveValidation } : {}),
    ...(persistedWarnings.length > 0 ? { save_warnings: persistedWarnings } : {}),
    ...(persistedAcks.length > 0 ? { save_warnings_acked: persistedAcks } : {}),
    ...(authPrereqAutoInjected
      ? {
          auto_injected: {
            prerequisites: [{ name: 'auth', kind: 'tag', tag: 'auth' }],
            reason:
              'auth-gated strategy save on a platform with a saved capability advertising `provides: ["auth"]` — runtime added the typed auth prereq so warm execute will refresh the auth context first when storage_state is empty/stale.',
          },
        }
      : {}),
    ...(artifactBreadcrumbHint ? { _hint: artifactBreadcrumbHint } : {}),
    ...(budgetWarning !== undefined ? { _budget_warning: budgetWarning } : {}),
    timings: { ...timings },
  };
}

/** Thin wrapper around `harnessAcker.ack` that returns a Promise — lets
 *  the call-site use `.catch(...)` for a typed rejectWithTimings path
 *  instead of try/catch with non-null-assertions on the verdict variable. */
function invokeWarningAcker(
  acker: import('../audit/lift/save-warning-acker').SaveWarningAcker,
  warning: import('../audit/index').Issue,
  ctx: import('../audit/lift/save-warning-acker').SaveWarningAckCtx,
): Promise<SaveWarningAck> {
  return acker.ack(warning, ctx);
}

/**
 * Names of `{{name}}` placeholders that appear in scanned strategy fields
 * (URL / headers / body / recorded-path step values) but aren't keys in
 * `args` with a non-empty value. Used by post-save validation staging to
 * skip the verification rather than run it with `undefined` substitutions
 * that produce false-negative failures. Generator placeholders
 * (`{{__gen.X}}`) are excluded — those resolve from `generated` definitions
 * at execute time, not from caller args.
 */
const PLACEHOLDER_RE = /\{\{(\w+(?:\.\w+)*)\}\}/g;

/** Collect `{{placeholder}}` names (excluding `__gen.*`) from any string nested
 *  inside `value` (string / array / object). Used to read a prereq's inputs. */
function collectPlaceholderNames(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    let m: RegExpExecArray | null;
    PLACEHOLDER_RE.lastIndex = 0;
    while ((m = PLACEHOLDER_RE.exec(value)) !== null) {
      const n = m[1];
      if (n && !n.startsWith('__gen.')) out.add(n);
    }
  } else if (Array.isArray(value)) {
    for (const v of value) collectPlaceholderNames(v, out);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>))
      collectPlaceholderNames(v, out);
  }
}

/**
 * The set of prereq-bound placeholder names that the prereq chain can actually
 * mint at execute() time given `baseSatisfiable` (the keys verifyArgs supplies).
 *
 * A prereq output is *runnable* when every `{{...}}` input token in its
 * producing prereq (url / expression / args) is itself satisfiable — from
 * baseSatisfiable or from another runnable prereq's output. Fixpoint closure,
 * bounded by node count (cycle-safe). A capability/lookup prereq whose input
 * (e.g. `{{query}}`) is neither declared nor exampled is NOT runnable, so its
 * output stays "unsatisfied" and post-save validation still skips — we never
 * inject a stub value to force a false pass.
 */
function computeRunnablePrereqBinds(data: Strategy, baseSatisfiable: Set<string>): Set<string> {
  const prereqs = (data as { prerequisites?: unknown }).prerequisites;
  if (!Array.isArray(prereqs)) return new Set();
  const nodes = prereqs
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .map((p) => {
      const outputs = new Set<string>();
      if (typeof p.binds === 'string' && p.binds) outputs.add(p.binds);
      if (p.vars && typeof p.vars === 'object' && !Array.isArray(p.vars)) {
        for (const k of Object.keys(p.vars as Record<string, unknown>)) outputs.add(k);
      }
      const inputs = new Set<string>();
      collectPlaceholderNames(p.url, inputs);
      collectPlaceholderNames(p.expression, inputs);
      collectPlaceholderNames(p.args, inputs);
      for (const o of outputs) inputs.delete(o); // a prereq doesn't feed itself
      return { outputs, inputs };
    });
  const satisfiable = new Set(baseSatisfiable);
  const runnable = new Set<string>();
  let changed = true;
  let guard = 0;
  while (changed && guard++ <= nodes.length) {
    changed = false;
    for (const node of nodes) {
      if ([...node.outputs].every((o) => runnable.has(o))) continue;
      if ([...node.inputs].every((i) => satisfiable.has(i))) {
        for (const o of node.outputs) {
          if (!runnable.has(o)) {
            runnable.add(o);
            satisfiable.add(o);
            changed = true;
          }
        }
      }
    }
  }
  return runnable;
}

function findUnsatisfiedPlaceholders(data: Strategy, args: Record<string, unknown>): Set<string> {
  const argKeys = new Set(
    Object.keys(args).filter((k) => {
      const v = args[k];
      return v !== undefined && v !== null && v !== '';
    }),
  );
  // Prereq-bound placeholders the chain can mint for real at execute() time are
  // not "unsatisfied" — excluding them lets verifySavedStrategy actually run the
  // chain (the canonical signed-fetch / lookup shape). Bound to argKeys (the same
  // set verifyArgs supplies) so a prereq whose own inputs are undeclared stays
  // unsatisfied and validation still skips. See computeRunnablePrereqBinds.
  const runnableBinds = computeRunnablePrereqBinds(data, argKeys);
  const missing = new Set<string>();
  // \w+ avoids the unbounded-non-close-brace pattern that sonarjs flags as
  // backtracking-friendly. Placeholder names in klura are
  // `[A-Za-z0-9_]+`-shaped per the TEMPLATE_RE in `probe-helpers.ts`.
  const re = /\{\{(\w+(?:\.\w+)*)\}\}/g;
  for (const field of collectScannedFields(data)) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(field.value)) !== null) {
      const name = m[1];
      if (!name) continue;
      if (name.startsWith('__gen.')) continue;
      if (runnableBinds.has(name)) continue;
      if (!argKeys.has(name)) missing.add(name);
    }
  }
  return missing;
}

/**
 * Detect whether the saved strategy carries a `js-eval` prereq whose
 * `expression` is substantive — i.e. long enough to suggest the agent did
 * non-trivial RE work to produce it. The 120-char threshold catches multi-
 * line crypto / signing / decoder routines while skipping one-liner DOM
 * reads (e.g. `document.cookie`, `window.X.id`). Returns the first matching
 * expression so the hint can quote a preview.
 */
const SUBSTANTIVE_JS_EVAL_MIN_CHARS = 120;
function findSubstantiveJsEvalPrereqExpression(data: Strategy): string | null {
  const prereqs = (data as { prerequisites?: unknown }).prerequisites;
  if (!Array.isArray(prereqs)) return null;
  for (const p of prereqs) {
    if (!p || typeof p !== 'object') continue;
    const pr = p as { kind?: unknown; expression?: unknown };
    if (pr.kind !== 'js-eval') continue;
    if (typeof pr.expression !== 'string') continue;
    if (pr.expression.length < SUBSTANTIVE_JS_EVAL_MIN_CHARS) continue;
    return pr.expression;
  }
  return null;
}

/**
 * Compose the concrete method + example URL for the post-save validation
 * handoff. Returns null when the strategy doesn't have a single-call HTTP shape
 * (e.g. ws-only strategies, recorded-path — those need different validation
 * patterns the agent can derive from the saved shape itself).
 *
 * Best-effort template substitution with notes.params.*.example values. If
 * templates don't resolve, we still return the unresolved URL — the agent can
 * see the {{placeholder}}s and reason about what to fill.
 */
function buildValidationTarget(data: Strategy): { method: string; url: string } | undefined {
  const d = data as unknown as Record<string, unknown>;
  const strategy = d.strategy;
  if (strategy !== 'fetch' && strategy !== 'page-script') return undefined;
  const baseUrl = typeof d.baseUrl === 'string' ? d.baseUrl : '';
  const endpointRaw = typeof d.endpoint === 'string' ? d.endpoint : '';
  if (!baseUrl || !endpointRaw) return undefined;
  const firstSpace = endpointRaw.indexOf(' ');
  const methodToken = firstSpace > 0 ? endpointRaw.slice(0, firstSpace) : '';
  let methodMatch = methodToken.length > 0;
  for (const ch of methodToken) {
    if (ch < 'A' || ch > 'Z') {
      methodMatch = false;
      break;
    }
  }
  let method = 'GET';
  if (methodMatch) {
    method = methodToken;
  } else if (typeof d.method === 'string') {
    method = d.method;
  }
  const endpointPath = methodMatch ? endpointRaw.slice(firstSpace + 1) : endpointRaw;
  // Substitute notes.params.<name>.example into the template, best-effort.
  const notes = d.notes;
  const params =
    (notes && typeof notes === 'object' && 'params' in notes
      ? (notes as { params?: Record<string, { example?: unknown }> }).params
      : undefined) ?? {};
  let url = `${baseUrl}${endpointPath}`;
  for (const [name, spec] of Object.entries(params)) {
    if (typeof spec.example === 'string') {
      url = url.replaceAll(`{{${name}}}`, encodeURIComponent(spec.example));
    }
  }
  return { method, url };
}

/**
 * Amend an already-saved strategy. klura's lifecycle has *create* (discover →
 * lift → save) and *repair* (auto-execute fails → stale → re-lift) but no way
 * to improve a *healthy* saved strategy — editing the JSON on disk would
 * bypass the save audit. `update_strategy` closes that gap: it re-runs the
 * SAME full `saveStrategyAudit` + probe + commit as `save_strategy` (delegates
 * to it), so an amend clears exactly the bar a create does. The only
 * difference is the precondition — a saved strategy must already exist — and
 * that it's admissible from the normal driving phases (drive/execute), not
 * lift-only, so the agent can improve a working strategy without forcing a
 * re-discovery. Triage-coupled gates skip naturally off the live session phase
 * (the surface was already triaged at create time); the payload-level gates
 * (literal_provenance, enum grounding, mutating verification, user_confirmation)
 * all run against the amended body.
 */
export async function updateStrategy(
  platform: string,
  capability: string,
  data: Strategy,
  changelog?: string,
  sessionId?: string,
  audit?: { token?: string; answers?: AuditAnswers },
): ReturnType<typeof saveStrategy> {
  const existing = skills.loadStrategies(platform, capability);
  if (existing.length === 0) {
    throw new SaveStrategyRejection(
      `no_saved_strategy_to_update: ${platform}/${capability} has no saved strategy to amend. ` +
        `update_strategy improves an EXISTING strategy; to create the first one, run the ` +
        `discover → lift → save_strategy flow.`,
      newTimings(),
    );
  }
  return saveStrategy(
    platform,
    capability,
    data,
    changelog ?? 'update_strategy amend',
    sessionId,
    audit,
  );
}

// ---------------------------------------------------------------------------
// Tool registry metadata
// ---------------------------------------------------------------------------

import { TOOL_NAMES } from '../vocab';
import type { ToolDef } from '../tools/types';
import { patchStep } from '../public-api';

export const TOOL_DEFS: ToolDef[] = [
  {
    name: TOOL_NAMES.saveStrategy,
    description:
      'Save a discovered execution strategy for a platform capability. klura stores only complete, runnable strategies on disk; iterative progress goes into the capability\'s discovery_artifact via `save_verified_expression` / `add_discovery_note` / `add_resume_pointer`, and into the platform logbook via `record_observed_capability`. On `end_drive` with no complete save, auto-synth drops a recorded-path fallback from perform_action history.\n\n**save_strategy commits the strategy file only.** It does not close the session. The session stays open until you explicitly call `end_drive`. Multi-capability sessions: save each capability, then `end_drive` to finalize. Single-capability sessions: save, persist any RE findings via `add_discovery_note` / `add_resume_pointer`, then `end_drive`. The close-time audit (re_persistence, capability_declaration_required, auto-synth, logbook flush) all live on `end_drive`.\n\nCommon save-time rejections (error message names the field; catalog here to front-load):\n  - **Pre-save audit (two-phase, token-gated)** — first call always rejected with `audit_token` + checklist. Echo on next call with `audit_answers` classifying every literal. The rejection envelope enumerates every classifier inline.\n  - **`user_confirmation` audit** — every save requires the user\'s explicit approval. The first call returns `items.user_confirmation.prompt_for_user` — relay it verbatim to the user, get yes/no, retry with `audit_answers.user_confirmation: {user_decision: "approve"|"reject", user_quote: "<verbatim user reply>"}`. Token binds to the whole strategy hash, so any structural change forces a fresh ask.\n  - **Selector self-reference** — prereq extract that reads the id already in `endpoint`/`wsUrl`. Extract from a structural source (URL regex, page global, JSON script tag).\n  - **recorded-path over observed binary WS write** — capability is liftable above recorded-path; start with `inspect_ws_frame` + `try_generator`. Persist partial progress to discovery_artifact and let end_drive auto-synth the fallback.\n  - **fetch with empty `prerequisites: []` that needs in-page cookies** — set `transport: "browser"`.\n  - **`notes.<unknown_subkey>`** — allowlisted keys: `params`, `quirks`, `auth`, `discovery` (string), `observed_capabilities[]`, `changelog`, `anchor_type`, `save_warnings`, `save_warnings_acked`.\n  - **Save-time warnings** — `unparametrized_session_id`, `unresolved_name_to_id_gap`, `entity_pinned_infra_prereq`. Either fix the strategy or ack inline via `notes.save_warnings_acked: [{kind, reason}]`. Reason required.\n  - **URL not observed in discovery network log** — pass `session_id` so the cross-reference catches recalled-from-training-data endpoints.\n  - **Enum param without grounding** — `kind: "enum"` caller_input needs `observed_values: [{value, label}...]` from captured traffic, or `source: "capability:<slug>"`.\n  - **`status` field on strategy body** — not in the schema. Iterative progress lives in the discovery_artifact, not the strategy body.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string' },
        capability: { type: 'string' },
        strategy: {
          type: 'object',
          description:
            'Strategy body. `strategy` field: "fetch" | "page-script" | "recorded-path". For fetch/page-script: method, baseUrl, endpoint, headers, body. Use page-script (with `origin`) when bot-protection cookies can\'t replay outside the browser — runtime fires the fetch from inside the page. For page-script, declare `notes.anchor_type`: "module" | "protocol" | "dom" | "unknown" (default; treated as fragile). HTML reads add `response: {format: "html", extract: {name: {selector, attr?, multiple?}}}`. Auto-generated values via `generated.<name>`; reference as {{__gen.<name>}}. The canonical schema catalog inlines on every `save_strategy` rejection; anchor durability details at klura://reference#page-script-anchors.',
        },
        changelog: {
          type: 'string',
          description: 'Human-readable summary of what changed (logged to history)',
        },
        session_id: {
          type: 'string',
          description:
            'Discovery session id (REQUIRED for agent-driven saves). The session anchors the pre-save audit — URL cross-check against the captured network log, literal_provenance classifier, user_confirmation decider integration. Without it, the audit is skipped (the audit-skip path is reserved for in-process programmatic callers like auto-synth and tests, which call `saveStrategy()` directly rather than going through MCP).',
        },
        audit_token: {
          type: 'string',
          description: 'Echo the audit_token returned on the prior save_strategy rejection.',
        },
        audit_answers: {
          type: 'object',
          description:
            'Classification answers per the checklist from the prior rejection. Shape: {literal_provenance: {<path>: "static"|{caller_input:"<param>"}|{prereq_output:"<binds>"}|"single_entity"}, capability_name_justification?: string, observed_siblings: {<"METHOD url">: "recorded"|"not_worth_recording:<reason>"}, user_confirmation: {user_decision: "approve"|"reject", user_quote: "<verbatim user reply>"}}. The rejection envelope enumerates each classifier inline.',
        },
      },
      required: ['platform', 'capability', 'strategy', 'session_id'],
    },
    handler: (args: any) => {
      // session_id is in `required` above, but enforce it at the boundary too:
      // without it, `saveStrategy` silently skips the ENTIRE save-time audit
      // (literal provenance, user_confirmation, …) AND post-save validation,
      // committing an unverified strategy. Agents occasionally drop it (see the
      // same guard in saveStrategyFromCapture). A loud reject beats a silent
      // unaudited save.
      if (typeof args.session_id !== 'string' || args.session_id.trim().length === 0) {
        throw new Error(
          'invalid_strategy: save_strategy requires session_id — without it the save-time ' +
            'audit and post-save validation are skipped and the strategy would commit ' +
            'unverified. Pass the session_id from start_session.',
        );
      }
      return saveStrategy(
        args.platform,
        args.capability,
        args.strategy,
        args.changelog,
        args.session_id,
        {
          token: args.audit_token,
          answers: args.audit_answers,
        },
      );
    },
  },

  {
    name: TOOL_NAMES.updateStrategy,
    description:
      "Improve an ALREADY-SAVED strategy without re-discovery. Use when you have a better/enriched expression for a healthy capability (e.g. add fields to a page-script). Loads the saved strategy, applies your full replacement `strategy` body, and re-runs the SAME save-time audit + probe + commit as save_strategy (incl. user_confirmation) — an amend is held to a create's bar, so editing the JSON by hand is never needed. Load the current body via get_strategy, edit, resubmit. Rejects if no saved strategy exists yet (use save_strategy to create the first one). Admissible from drive/execute — no need to re-enter lift.",
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string' },
        capability: { type: 'string' },
        strategy: {
          type: 'object',
          description:
            'Full replacement strategy body (same shape save_strategy takes). This REPLACES the saved strategy for {platform, capability}; supply the complete body (load the current one via get_strategy, then edit). Same schema/audit as save_strategy.',
        },
        changelog: {
          type: 'string',
          description: 'Human-readable summary of what changed (logged to history)',
        },
        session_id: {
          type: 'string',
          description:
            'Active session id (REQUIRED). Supplies the live audit context + the pool the post-save probe needs — the amend runs the same audit a create does, so without it the save would be unverified.',
        },
        audit_token: {
          type: 'string',
          description: 'Echo the audit_token returned on the prior update_strategy rejection.',
        },
        audit_answers: {
          type: 'object',
          description:
            'Classification answers per the checklist from the prior rejection — same shape as save_strategy.audit_answers.',
        },
      },
      required: ['platform', 'capability', 'strategy', 'session_id'],
    },
    handler: (args: any) => {
      if (typeof args.session_id !== 'string' || args.session_id.trim().length === 0) {
        throw new Error(
          'invalid_strategy: update_strategy requires session_id — the amend runs the full ' +
            'save-time audit + probe, which need a live session. Pass the session_id from start_session.',
        );
      }
      return updateStrategy(
        args.platform,
        args.capability,
        args.strategy,
        args.changelog,
        args.session_id,
        {
          token: args.audit_token,
          answers: args.audit_answers,
        },
      );
    },
  },

  {
    name: TOOL_NAMES.patchStep,
    description:
      'Patch a single step in a recorded-path strategy by its stable slug id. Use for step-level healing when execution fails at a specific step — update the locators, action, or value without rewriting the whole strategy. Steps carry a required `id` field (e.g. "click_send", "type_message"); pass that id as `step_id`. 404 error names the known ids in the strategy.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string' },
        capability: { type: 'string' },
        strategy_type: { type: 'string', description: 'Strategy type (e.g. "recorded-path")' },
        step_id: {
          type: 'string',
          description:
            'Slug id of the step to patch (matches the `id` field on the recorded-path step, e.g. "click_send"). See klura://reference#recorded-path-schema.',
        },
        patch: {
          type: 'object',
          description:
            'Fields to merge into the step (e.g. {"locators": {"css": "button.new-class"}})',
        },
      },
      required: ['platform', 'capability', 'strategy_type', 'step_id', 'patch'],
    },
    handler: (args: any) =>
      patchStep(args.platform, args.capability, args.strategy_type, args.step_id, args.patch),
  },
];

// Save-warning detectors for capability collisions and auth gating. Split
// out of save-warnings.ts to keep the main detector file under the per-file
// line cap; the public surface (save-strategy audit) imports both files.

import type { Strategy } from '../strategies/skills';
import { getCapturedRequestsProvider } from '../strategies/validate/providers';
import type { SaveWarning } from './save-warnings';

/**
 * The capability slug should name what the capability does in the
 * abstract, not bake one of its own enum-param values into the name.
 * `find_top_italian_restaurants` is the wrong shape when `category` is a
 * declared enum param with `observed_values: [{value: "italian"}]` — it
 * implies a parallel `find_top_mexican_restaurants` save for every value
 * the user could request, when the right shape is one
 * `find_top_restaurants(category)` capability with the values grounded
 * under `notes.params.category.observed_values`.
 *
 * Structural signal: the saved slug contains a substring that's also a
 * `value` (or `label`) on one of its own observed_values entries. No
 * fuzzy matching, no keyword bank — agent's own metadata contradicts
 * itself. ackReason: 'required' — the usual fix is to rename the slug
 * (drop the value) or remove the enum from `notes.params`, but legitimate
 * noun-overlap exists (e.g. `create_issue` whose param `context` happens
 * to enumerate `issue` as one label among many). The ack-with-reason path
 * is the escape hatch for those cases; the warning still emits and the
 * agent has to articulate why the overlap is incidental.
 */
export function detectEnumValueInCapabilitySlug(data: Strategy, capability: string): SaveWarning[] {
  if (typeof capability !== 'string' || capability.length === 0) return [];
  const params = (data as { notes?: { params?: Record<string, unknown> } }).notes?.params;
  if (!params || typeof params !== 'object') return [];
  const slugTokens = capability
    .toLowerCase()
    .split(/[_\-/]/)
    .filter(Boolean);
  const slugTokenSet = new Set(slugTokens);
  for (const [paramName, info] of Object.entries(params)) {
    if (!info || typeof info !== 'object') continue;
    const i = info as { kind?: unknown; observed_values?: unknown };
    if (i.kind !== 'enum' || !Array.isArray(i.observed_values)) continue;
    for (const ov of i.observed_values) {
      if (!ov || typeof ov !== 'object') continue;
      const value = (ov as { value?: unknown }).value;
      if (typeof value !== 'string' || value.length === 0) continue;
      const valueLower = value.toLowerCase();
      // Exact-token match keeps this crisp: slug `find_top_italian_restaurants`
      // tokenizes to {find, top, italian, restaurants}, and value `italian`
      // exact-matches `italian`. Substring matching would false-positive on
      // generic short tokens (`a` in `category` vs `a` in `pasta`); token
      // equality avoids that.
      if (slugTokenSet.has(valueLower)) {
        return [
          {
            kind: 'enum_value_baked_into_slug',
            message:
              `Capability slug "${capability}" contains "${value}", which is also an observed_values entry ` +
              `under \`notes.params.${paramName}\` (kind: enum). The slug should name the capability in the abstract — ` +
              `if "${paramName}" is a parameter the user picks, the slug must not bake one of its values in. ` +
              `Saving this shape implies a parallel capability per value (e.g. one slug per category) when the ` +
              `right shape is a single capability that takes "${paramName}" as an arg with the values grounded ` +
              `in observed_values.`,
            hint: buildSlugRenameHint(capability, value, paramName),
          },
        ];
      }
    }
  }
  return [];
}

function buildSlugRenameHint(capability: string, value: string, paramName: string): string {
  const cleanedSlug = capability
    .toLowerCase()
    .replace(new RegExp(`[_-]?${value.toLowerCase()}[_-]?`, 'g'), '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return (
    `Rename the capability so the slug doesn't contain "${value}" (e.g. drop the value: ` +
    `"${cleanedSlug}"). ` +
    `If "${paramName}" really IS part of the capability identity (not a parameter), remove it from ` +
    `\`notes.params\` instead.`
  );
}

/**
 * Catch a parallel-capability save: agent is committing capability X with
 * an endpoint that exactly matches another saved capability Y on the same
 * platform. Common shape: enum param value drift — Y was saved with
 * `category=italian` and grounded `observed_values: [italian]`; agent gets
 * a "show me pizza" prompt, fails to map pizza→italian via observed
 * labels, and saves a parallel `find_top_pizza_*` capability targeting
 * the same `/top-restaurants?category=...` path. Two capability files on
 * disk for the same endpoint silently bake the same data twice and
 * fragment future warm execution.
 *
 * Structural signal: canonicalize endpoint to origin+path (drop query +
 * fragment + templates) and compare against existing capabilities'
 * canonical endpoints under this platform. Match → fire. The agent has
 * two clean fixes: consolidate (re-use the existing capability slug; if
 * the new arg value isn't in observed_values yet, drive once more so the
 * runtime grounds it) or justify why the new save is structurally
 * different (different verb, different auth, different response shape).
 */
export function detectEndpointCollidesWithSavedCapability(
  data: Strategy,
  capability: string,
  loadStrategiesForPlatform: ((capabilityName: string) => Strategy[]) | undefined,
  listSavedCapabilityNames: (() => string[]) | undefined,
): SaveWarning[] {
  if (!loadStrategiesForPlatform || !listSavedCapabilityNames) return [];
  const obj = data as Record<string, unknown>;
  const mine = canonicalizeEndpointKey(obj);
  if (!mine) return [];
  const allCaps = listSavedCapabilityNames();
  for (const cap of allCaps) {
    if (cap === capability) continue;
    let strategies: Strategy[];
    try {
      strategies = loadStrategiesForPlatform(cap);
    } catch {
      continue;
    }
    for (const other of strategies) {
      const otherKey = canonicalizeEndpointKey(other as unknown as Record<string, unknown>);
      if (!otherKey) continue;
      if (otherKey.canonical !== mine.canonical) continue;
      // Same path + different HTTP method is a legitimate sibling
      // (e.g. GET /resource list vs POST /resource create). Only fire
      // when both axes match — that's the structural duplicate signal.
      if (otherKey.method !== mine.method) continue;
      const otherTierRaw = (other as { strategy?: unknown }).strategy;
      const otherTier = typeof otherTierRaw === 'string' ? otherTierRaw : '?';
      const otherParams = collectParamSummary(other);
      const observed = collectObservedEnumPairs(other);
      const example = collectExampleSummary(other);
      const message = buildCollisionMessage({
        capability,
        cap,
        mine,
        otherKey,
        otherTier,
        otherParams,
        observed,
        example,
      });
      return [
        {
          kind: 'endpoint_collides_with_saved_capability',
          message,
          hint:
            `Pick one of the three branches above. The first two (consolidate / overwrite) are the ` +
            `right move 90% of the time. The third — genuinely different operation multiplexed onto ` +
            `the same path+method (GraphQL gateway, JSON-RPC router, generic /api/v1/) — acks via ` +
            `notes.save_warnings_acked: [{kind: "endpoint_collides_with_saved_capability", reason: ` +
            `"<one sentence naming the structural diff: body field, operationName, response shape>"}]. ` +
            `The runtime trusts the articulation; the rejection still surfaces the existing capability ` +
            `so a future reviewer sees both side-by-side.`,
        },
      ];
    }
  }
  return [];
}

interface CollisionMessageInput {
  capability: string;
  cap: string;
  mine: { canonical: string; method: string };
  otherKey: { canonical: string; method: string };
  otherTier: string;
  otherParams: string;
  observed: Array<{ value: string; label?: string }>;
  example: string;
}

function buildCollisionMessage(input: CollisionMessageInput): string {
  const { capability, cap, mine, otherKey, otherTier, otherParams, observed, example } = input;
  const lines: string[] = [];
  lines.push(`SAVE BLOCKED — duplicate capability detected.`);
  lines.push('');
  lines.push(
    `You are saving "${capability}" against \`${mine.method} ${mine.canonical}\`, but THIS PLATFORM ALREADY HAS:`,
  );
  lines.push('');
  lines.push(`  Name:        ${cap}`);
  lines.push(`  Tier:        ${otherTier}`);
  lines.push(`  Endpoint:    ${otherKey.method} ${otherKey.canonical}`);
  if (otherParams) lines.push(`  Args:        ${otherParams}`);
  if (observed.length > 0) {
    const sample = observed
      .slice(0, 8)
      .map((p) => p.value)
      .join(', ');
    const more = observed.length > 8 ? ` (+${observed.length - 8} more)` : '';
    lines.push(`  Observed:    ${sample}${more}`);
  }
  if (example) lines.push(`  Example:     ${example}`);
  lines.push('');
  lines.push(`STOP and READ. Is this the same operation as what you are saving?`);
  lines.push('');
  lines.push(`  ✓ SAME OPERATION → don't save a duplicate.`);
  lines.push(
    `    Call execute({platform, capability: "${cap}", args: {...your args...}}) instead.`,
  );
  lines.push(
    `    Running an existing strategy is faster than forking. If the user's value isn't in`,
  );
  lines.push(
    `    observed_values yet, drive once with that value so the runtime grounds it under "${cap}".`,
  );
  lines.push('');
  lines.push(`  ✓ THE EXISTING ONE IS WRONG / STALE → re-save under "${cap}".`);
  lines.push(
    `    Call save_strategy({capability: "${cap}", ...your fixed shape...}) — overwrite, don't fork.`,
  );
  lines.push('');
  lines.push(
    `  ✓ GENUINELY DIFFERENT (different request body / operationName / response shape / auth)`,
  );
  lines.push(
    `    on the SAME path+query+method — common on multiplexed gateways (GraphQL, JSON-RPC).`,
  );
  lines.push(
    `    → ack via notes.save_warnings_acked: [{kind: "endpoint_collides_with_saved_capability",`,
  );
  lines.push(
    `      reason: "<one sentence naming the structural diff: e.g. 'body.operationName=updateCurrentStore`,
  );
  lines.push(
    `      vs marketModal — different mutation' or 'response.data.user vs response.data.posts'>"}].`,
  );
  return lines.join('\n');
}

/** Canonical (path+query, method) key — what `endpoint_collides_with_saved_capability`
 *  uses to compare two strategies. Same key + different method is a legitimate
 *  sibling (GET vs POST on a REST resource); same key + same method is the
 *  duplicate signal. Returns null when the strategy isn't HTTP-shaped.
 *
 *  Includes the sorted query string in the canonical so multiplexed endpoints
 *  (GraphQL `?operationName=foo` vs `?operationName=bar`, JSON-RPC routers
 *  that key on a query param) read as different operations. Templates
 *  (`{{placeholder}}`) survive the canonical so two strategies templating the
 *  same param still collide — the parallel-capability bake signal stays. */
function canonicalizeEndpointKey(
  data: Record<string, unknown>,
): { canonical: string; method: string } | null {
  const canonical = canonicalizeEndpoint(data);
  if (canonical === null) return null;
  const m = data.method;
  const method = typeof m === 'string' && m.length > 0 ? m.toUpperCase() : 'GET';
  return { canonical, method };
}

/** One-line summary of `notes.params` for inline rendering in the
 *  collision rejection. Format: `key: kind[, key: kind, ...]`. Drops
 *  example values (no PII risk). */
function collectParamSummary(strategy: Strategy): string {
  const params = (strategy as { notes?: { params?: Record<string, unknown> } }).notes?.params;
  if (!params || typeof params !== 'object') return '';
  const parts: string[] = [];
  for (const [name, info] of Object.entries(params)) {
    if (!info || typeof info !== 'object') {
      parts.push(name);
      continue;
    }
    const i = info as { kind?: unknown; source?: unknown };
    const kind = typeof i.kind === 'string' ? i.kind : '?';
    const source =
      typeof i.source === 'string' && i.source.length > 0 ? `, source=${i.source}` : '';
    parts.push(`${name}: ${kind}${source}`);
  }
  return parts.join(', ');
}

/** First entry from `notes.example_responses[].response_excerpt`,
 *  rendered as a compact one-line preview. Empty when absent. */
function collectExampleSummary(strategy: Strategy): string {
  const examples = (strategy as { notes?: { example_responses?: unknown } }).notes
    ?.example_responses;
  if (!Array.isArray(examples) || examples.length === 0) return '';
  const first = examples[0] as { response_excerpt?: unknown } | undefined;
  if (!first || typeof first !== 'object') return '';
  const excerpt = first.response_excerpt;
  if (excerpt === undefined) return '';
  let serialized: string;
  try {
    serialized = typeof excerpt === 'string' ? excerpt : JSON.stringify(excerpt);
  } catch {
    return '';
  }
  if (serialized.length > 180) return `${serialized.slice(0, 177)}...`;
  return serialized;
}

/** Canonicalize a strategy's endpoint to origin+pathname+sorted-query for
 *  collision comparison. Drops fragment and trailing slash. Returns null when
 *  the strategy doesn't have an HTTP-shaped endpoint (recorded-path strategies,
 *  ws-only strategies).
 *
 *  Query string is preserved with params sorted by key so multiplexed gateways
 *  read as different operations: GraphQL `?operationName=marketModal` vs
 *  `?operationName=updateCurrentStore` get different canonicals and don't
 *  collide. Templates (`{{placeholder}}`) round-trip through `URLSearchParams`
 *  unchanged, so two strategies templating the same param still produce
 *  identical canonicals — the parallel-capability bake signal (e.g. two
 *  saves of `?category={{category}}`) is preserved. */
export function canonicalizeEndpoint(data: Record<string, unknown>): string | null {
  const baseUrl = data.baseUrl;
  const endpoint = data.endpoint;
  if (typeof endpoint !== 'string' || endpoint.length === 0) return null;
  const fullUrl = (() => {
    if (typeof baseUrl === 'string' && baseUrl.length > 0) {
      try {
        return new URL(endpoint, baseUrl).toString();
      } catch {
        return endpoint;
      }
    }
    return endpoint;
  })();
  try {
    const u = new URL(fullUrl);
    let pathname = u.pathname || '/';
    if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
    const params = [...u.searchParams.entries()].sort((a, b) => {
      const k = a[0].localeCompare(b[0]);
      return k !== 0 ? k : a[1].localeCompare(b[1]);
    });
    const queryString =
      params.length > 0 ? '?' + params.map(([k, v]) => `${k}=${v}`).join('&') : '';
    return `${u.protocol}//${u.host.toLowerCase()}${pathname}${queryString}`;
  } catch {
    return null;
  }
}

/** Pull `notes.params.<name>.observed_values[]` pairs off a saved
 *  strategy. Used to surface what enum values are already grounded
 *  against a colliding capability so the agent can decide whether to
 *  consolidate. */
function collectObservedEnumPairs(strategy: Strategy): Array<{ value: string; label?: string }> {
  const params = (strategy as { notes?: { params?: Record<string, unknown> } }).notes?.params;
  if (!params || typeof params !== 'object') return [];
  const out: Array<{ value: string; label?: string }> = [];
  for (const info of Object.values(params)) {
    if (!info || typeof info !== 'object') continue;
    const i = info as { kind?: unknown; observed_values?: unknown };
    if (i.kind !== 'enum' || !Array.isArray(i.observed_values)) continue;
    for (const v of i.observed_values) {
      if (!v || typeof v !== 'object') continue;
      const value = (v as { value?: unknown }).value;
      if (typeof value !== 'string') continue;
      const label = (v as { label?: unknown }).label;
      out.push(typeof label === 'string' ? { value, label } : { value });
    }
  }
  return out;
}

/**
 * Auth-gated capability without an auth prereq. Fires when this session
 * captured at least one HTTP response that set cookies AND the strategy
 * being saved targets the same origin AND declares no `{kind: "capability"}`
 * or `{kind: "tag"}` prereq, AND doesn't itself advertise `provides: ["auth"]`.
 *
 * Why structural, not keyword: the signal is `setCookieNames.length > 0` on a
 * captured request — a server told the browser to remember session state, by
 * construction. No path/text matching, no `/login|signin|auth/` regex bank.
 *
 * Why ackable: the agent may legitimately be saving a non-auth cookie-setter
 * (preferences, A/B test). Without ack, the warning surfaces the structural
 * fact and points at the typed-edge auth pattern.
 */
export function detectAuthGatedWithoutAuthPrereq(
  data: Strategy,
  sessionId?: string,
): SaveWarning[] {
  if (!sessionId) return [];
  const tier = (data as { strategy?: string }).strategy;
  if (tier !== 'fetch' && tier !== 'page-script') return [];
  // Scope to mutating methods. Public read endpoints on auth-bearing origins
  // (e.g. a storelocator GET on a site whose homepage sets analytics cookies)
  // were the dominant false-positive shape: cookies in the jar are auto-sent
  // by the browser on every same-origin request, so the structural signal
  // "the strategy's request rode a session cookie" is true even when the
  // endpoint is provably anonymous-friendly. POST/PUT/DELETE/PATCH narrows
  // to the cases where session-cookie dependence is materially load-bearing.
  // Truly auth-gated GETs that fail cold-execute fall through to the auth-
  // wall recovery layer at execute time.
  const method = ((data as { method?: string }).method ?? '').toUpperCase();
  const MUTATING = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);
  if (!MUTATING.has(method)) return [];
  const provider = getCapturedRequestsProvider();
  if (!provider) return [];
  const captured = provider(sessionId);
  if (!Array.isArray(captured)) return [];

  const baseUrl = (data as { baseUrl?: string }).baseUrl;
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) return [];
  let strategyOrigin: string;
  try {
    strategyOrigin = new URL(baseUrl).origin;
  } catch {
    return [];
  }

  const cookieSetters = collectCookieSetters(captured, strategyOrigin);
  if (cookieSetters.length === 0) return [];

  // The only opt-out is the typed-edge marker `provides: ["auth"]` — the
  // agent declaring "this strategy IS the auth provider." Path-matching the
  // strategy's endpoint against captured cookie-setters is too coarse: any
  // gateway that multiplexes operations under one path (GraphQL, JSON-RPC,
  // generic /api/v1/) silently bypasses the warning when an unrelated
  // operation on the same path happened to set cookies. The typed-edge
  // requirement closes that bypass — agents saving the actual auth flow
  // declare `provides: ["auth"]`; everyone else gets the warning and
  // chains a `{kind: "tag", tag: "auth"}` prereq.
  const strategyEndpoint = (data as { endpoint?: string }).endpoint ?? '';
  const provides = (data as { provides?: unknown }).provides;
  if (Array.isArray(provides) && provides.includes('auth')) return [];

  // Already chains a capability- or tag-kind prereq → assume the agent
  // factored it. Presence of ANY cap/tag prereq is the structural signal;
  // resolving "is the referenced one actually auth-providing" depends on
  // platform state and is left to execute-time auth-wall recovery.
  const prereqs = (data as { prerequisites?: unknown[] }).prerequisites;
  if (Array.isArray(prereqs)) {
    const hasCapPrereq = prereqs.some((p) => {
      if (!p || typeof p !== 'object') return false;
      const kind = (p as { kind?: unknown }).kind;
      return kind === 'capability' || kind === 'tag';
    });
    if (hasCapPrereq) return [];
  }

  // Surface up to 3 cookie-setting requests so the agent can identify the
  // auth flow they should factor out.
  const sample = cookieSetters
    .slice(0, 3)
    .map((s) => `  - ${s.method} ${s.url} → set: [${s.cookieNames.slice(0, 3).join(', ')}]`)
    .join('\n');
  const moreNote = cookieSetters.length > 3 ? `\n  - … (${cookieSetters.length - 3} more)` : '';

  return [
    {
      kind: 'auth_gated_without_auth_prereq',
      message:
        `${tier}.endpoint ${strategyEndpoint} targets origin ${strategyOrigin}, where this session captured ` +
        `${cookieSetters.length} request(s) whose response set cookies — but the saved strategy declares no ` +
        `{kind: "capability"} or {kind: "tag"} prereq. Cold-execute (fresh storage_state) and expired-cookie ` +
        `callers will hit the auth wall because the cookie that this strategy silently relies on never gets ` +
        `re-established.\n\n` +
        `Cookie-setting requests this session:\n${sample}${moreNote}\n\n` +
        `The canonical fix is to factor the cookie-setting flow into its own capability that declares ` +
        `\`provides: ["auth"]\`, and chain it via \`prerequisites: [{name: "auth", kind: "tag", tag: "auth"}]\` ` +
        `on this strategy. Warm-execute then refreshes the auth context first when storage_state is empty/stale, ` +
        `and any sibling capability that also needs auth chains the same typed-edge prereq. ` +
        `See klura://reference#tag-prereq.`,
      hint:
        `Ack with notes.save_warnings_acked: [{kind: "auth_gated_without_auth_prereq", reason: "<one sentence>"}] ` +
        `if the cookie isn't auth (e.g. an A/B test bucket or preferences cookie this strategy doesn't depend on), ` +
        `or if you're saving an auth-providing capability itself (declare \`provides: ["auth"]\` on the strategy ` +
        `and re-save).`,
    },
  ];
}

function collectCookieSetters(
  captured: unknown[],
  strategyOrigin: string,
): Array<{ url: string; method: string; cookieNames: string[] }> {
  const out: Array<{ url: string; method: string; cookieNames: string[] }> = [];
  for (const raw of captured) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as {
      url?: unknown;
      method?: unknown;
      setCookieNames?: unknown;
    };
    const url = typeof entry.url === 'string' ? entry.url : '';
    const method = typeof entry.method === 'string' ? entry.method : '';
    const setCookieNames = entry.setCookieNames;
    if (!url || !Array.isArray(setCookieNames) || setCookieNames.length === 0) continue;
    let entryOrigin: string;
    try {
      entryOrigin = new URL(url).origin;
    } catch {
      continue;
    }
    if (entryOrigin !== strategyOrigin) continue;
    const names = setCookieNames.filter((n): n is string => typeof n === 'string');
    out.push({ url, method, cookieNames: names });
  }
  return out;
}

// Did the navigation actually arrive where it was sent?
//
// A prereq that navigates and then evaluates assumes the document it evaluates
// against is the one it asked for. An origin that redirects some visitors —
// a consent interstitial, a region gate, a login wall — breaks that assumption
// silently: navigation resolves, the page loads, the expression runs, and it
// runs against the wrong document. What the caller sees is whatever the
// expression makes of a page it was never written for.
//
// The check compares two URLs the runtime already holds, so it needs no
// knowledge of any particular site. A miss is one of exactly two structural
// marks, both meaning "sent elsewhere by something that knew where you were
// going":
//
//   - the reached ORIGIN differs from the requested one, or
//   - the reached URL carries the requested URL as a query-parameter value.
//
// Path is deliberately not compared on its own. Single-page applications
// rewrite their own path after load as a matter of course — a maps place page
// appends the viewport to its path seconds after DOMContentLoaded — so a
// pathname comparison would report a miss on healthy navigations far more often
// than on real ones. Origin survives that rewriting; a redirect away does not.
// The cost is that a same-origin page which moved or was withdrawn, and does
// not carry the requested URL forward, reads as an arrival. That case is
// genuinely indistinguishable from an in-app rewrite at this layer, and
// under-reporting it is the correct trade against firing on every SPA.
//
// `requested_carried_as_parameter` is what makes the finding legible rather
// than merely true. A redirect that intends to come back embeds the original
// URL in its own query string (`?continue=`, `?return_to=`, `?next=` — the name
// varies and is never read here; only the containment is). When it is set, the
// destination is holding the requested URL for later, which is the shape of an
// interstitial rather than a moved or dead page. It is derived by looking for
// the requested URL among the reached URL's decoded query VALUES, so a path
// that merely resembles it cannot trip it.

/** A navigation that resolved somewhere other than where it was sent. */
export interface NavigationReachMiss {
  requested: string;
  reached: string;
  /**
   * The requested URL appears as a query-parameter value on the reached URL —
   * the destination is holding it to return to, which distinguishes a gate in
   * front of the page from the page being gone.
   */
  requested_carried_as_parameter: boolean;
}

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** True when `requested` appears among `reached`'s query-parameter values. */
function carriedAsParameter(reached: URL, requested: URL): boolean {
  for (const value of reached.searchParams.values()) {
    if (!value) continue;
    const nested = parse(value);
    if (!nested) continue;
    if (nested.origin === requested.origin && nested.pathname === requested.pathname) return true;
  }
  return false;
}

/**
 * Report whether a navigation landed somewhere other than its target, or `null`
 * when it arrived (or when either URL is unparseable, since a comparison that
 * cannot be made must not accuse).
 */
export function assessNavigationReach(
  requestedUrl: string,
  reachedUrl: string,
): NavigationReachMiss | null {
  const requested = parse(requestedUrl);
  const reached = parse(reachedUrl);
  if (!requested || !reached) return null;
  const carried = carriedAsParameter(reached, requested);
  if (requested.origin === reached.origin && !carried) return null;
  return {
    requested: requestedUrl,
    reached: reachedUrl,
    requested_carried_as_parameter: carried,
  };
}

/**
 * Thrown when a prereq navigation resolved somewhere other than its target.
 *
 * A distinct type because the remedy is distinct: nothing about the strategy is
 * wrong, so the caller must not archive it, and the agent must not be sent to
 * fix an expression that never ran. Callers that can act on the divergence read
 * `miss`; the rest see an ordinary Error with legible prose.
 */
export class NavigationReachError extends Error {
  constructor(
    message: string,
    readonly miss: NavigationReachMiss,
    readonly prereqName: string,
  ) {
    super(message);
    this.name = 'NavigationReachError';
  }
}

/**
 * Recover the reach miss from a thrown value, following `cause` links.
 *
 * The prereq layer throws this deep inside the execute cascade, which wraps
 * failures as it unwinds, so the type is looked for along the whole chain
 * rather than only at the surface. Returns `null` for anything else — an
 * ordinary failure must keep its ordinary handling.
 */
export function navigationReachMissFrom(error: unknown): NavigationReachMiss | null {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if (current instanceof NavigationReachError) return current.miss;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** Agent-facing prose for a navigation that never arrived. */
export function describeNavigationReachMiss(miss: NavigationReachMiss, prereqName: string): string {
  const held = miss.requested_carried_as_parameter
    ? ` The requested URL is carried as a query parameter on the destination, so the origin is ` +
      `holding it to return to — this is a gate in front of the page, not a page that moved.`
    : ` The requested URL does not appear on the destination, so this reads as a moved, renamed ` +
      `or withdrawn page rather than a gate.`;
  return (
    `prereq ${JSON.stringify(prereqName)} (js-eval) never reached its target: it navigated to ` +
    `${JSON.stringify(miss.requested)} and the document that loaded was ${JSON.stringify(miss.reached)}.` +
    held +
    ` The expression was not evaluated — running it against a document it was not written for ` +
    `produces a result that cannot be told apart from a real one.`
  );
}

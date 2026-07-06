// Origin-blocked detector: surfaces structural signals that the initial
// navigation didn't land on a normal page. Called once at start_session
// after navigate; result attaches to StartSessionResult.origin_blocked
// when fired.
//
// **Vendor-agnostic by design.** No brand names, no per-vendor cookie
// banks, no per-vendor host suffixes, no per-vendor Server header
// tokens. Anti-bot defenses come and go, get renamed, get re-skinned;
// the moment runtime code carries a list of "known stoppers" it starts
// rotting and pretends to be smarter than it is. The agent reaches the
// same understanding from structural shape; the detector only surfaces
// shape, never identity.
//
// Why this detector exists at all: without an upfront signal, agents
// waste 5-15 s of session init + 30-60 s of failed clicks before
// realizing the page they're driving is a challenge / refusal / dead
// landing. The downstream end-drive `map_session_no_observations`
// detector catches the same shape post-hoc, but by then the session
// is torn down with no machine-readable abort_event on the platform
// ledger.
//
// Five orthogonal structural signals:
//   1. `http_failure` — initial nav response status ≥ 400. Definitive
//      refusal shape; alone sufficient to fire.
//   2. `cross_host_redirect` — final host differs from requested host.
//      Alone too noisy (legit auth/login subdomains redirect cross-host);
//      contributes to fire only when combined with `shape_anomaly` or
//      `challenge_iframe_shape`.
//   3. `shape_anomaly` — rendered a11y tree is iframe-dominated with
//      very few semantic landmarks. Pure DOM-shape test, not text.
//   4. `challenge_iframe_shape` — ≥1 cross-origin iframe AND landmarks < 5.
//      The page's interactive UI lives inside a frame whose origin differs
//      from the page origin; top-level a11y / selectors cannot reach into
//      it, so the agent's clicks fail silently. Alone sufficient to fire.
//   5. `block_page_shape` — `http_failure` AND landmarks ≥ 5. The server
//      sent a 4xx/5xx but the page rendered as a styled error page (nav,
//      footer, "browse our help center" links). Those links almost
//      certainly return the same status — clicking around is a waste.
//      Purely additive prose; the underlying `http_failure` already fires.
//
// Fire rule: `http_failure` OR `challenge_iframe_shape` OR
// (`cross_host_redirect` AND `shape_anomaly`). All raw signals get
// emitted in the advisory so the agent can read the full structural
// picture; the fire rule decides whether the advisory surfaces at all.

export type OriginBlockedSignal =
  | 'http_failure'
  | 'http_legal_block'
  | 'cross_host_redirect'
  | 'shape_anomaly'
  | 'challenge_iframe_shape'
  | 'block_page_shape';

export interface OriginBlockedAdvisory {
  /** Always true when present. Lets agent code branch on `if
   *  (result.origin_blocked) { … }` without null-checking the whole object. */
  detected: true;
  /** Host of the requested URL (the agent's input). */
  requested_host: string;
  /** Host of the final URL after navigation (may equal requested_host). */
  final_host: string;
  /** HTTP status of the initial nav request, when captured. `null` when
   *  the driver didn't surface a status. */
  nav_status: number | null;
  /** Structural signals observed on the landing. */
  signals: ReadonlyArray<OriginBlockedSignal>;
  /** Informational try-first prose. The runtime never recommends
   *  `abort_session` as primary path — klura's purpose is to figure out
   *  HOW, not bail. abort is the documented last resort. */
  recommended_action: string;
}

/**
 * Inspect the start_session outcome for origin-blocked signals. Returns
 * an advisory object when the fire rule is met, `null` otherwise. Pure
 * structural; no side effects.
 */
export function detectOriginBlocked(input: {
  requestedUrl: string;
  finalUrl: string;
  /** HTTP status of the initial nav response. `null` when the driver
   *  didn't capture it. */
  navStatus: number | null;
  /** Rendered a11y tree (trimmed). Optional — when omitted the
   *  shape-derived signals can't fire and the detector reduces to the
   *  URL- and status-derived signals. */
  a11yTree?: string;
  /** Top-level iframes on the landing, with their `src` attributes.
   *  Optional — when omitted, `challenge_iframe_shape` can't fire. */
  iframes?: ReadonlyArray<{ src: string }>;
  /** Whether the session runs in connect mode (drives a normally-launched
   *  Chrome over CDP). When `false` and the landing is challenge-shaped, the
   *  advisory nudges toward `pool.connect.enabled` — an automation-launched
   *  browser fingerprint is the tell that makes such challenges loop. Omitted
   *  or `true` suppresses the nudge (unknown state, or already on). */
  connectEnabled?: boolean;
}): OriginBlockedAdvisory | null {
  let requestedHost: string;
  let finalHost: string;
  try {
    requestedHost = new URL(input.requestedUrl).host.toLowerCase();
    finalHost = new URL(input.finalUrl).host.toLowerCase();
  } catch {
    return null;
  }

  const signals: OriginBlockedSignal[] = [];
  const isHttpFailure = typeof input.navStatus === 'number' && input.navStatus >= 400;
  if (isHttpFailure) signals.push('http_failure');
  // HTTP 451 (RFC 7725 "Unavailable For Legal Reasons") is a legal/geo block,
  // not a bot gate — keyed to the request's egress region, not its session
  // shape. Flag it distinctly so the advisory steers to egress-change / remote
  // viewer instead of the bot-evasion playbook (which never unblocks a 451).
  if (input.navStatus === 451) signals.push('http_legal_block');
  if (finalHost !== requestedHost) signals.push('cross_host_redirect');

  const a11y = typeof input.a11yTree === 'string' ? input.a11yTree : null;
  const landmarkCount = a11y === null ? null : countSemanticLandmarks(a11y);
  if (a11y !== null && landmarkCount !== null && landmarkCount < 5) {
    if (/\biframe\b/i.test(a11y)) signals.push('shape_anomaly');
  }

  if (a11y !== null && landmarkCount !== null && landmarkCount < 5) {
    const xOriginIframeCount = countCrossOriginIframes(input.iframes, requestedHost);
    if (xOriginIframeCount >= 1) signals.push('challenge_iframe_shape');
  }

  if (isHttpFailure && landmarkCount !== null && landmarkCount >= 5) {
    signals.push('block_page_shape');
  }

  // Fire rule: HTTP failure is a definitive refusal alone; a cross-host
  // redirect is informational unless the landing also has anomalous
  // shape; cross-origin iframe with minimal landmarks is a near-certain
  // challenge proxy (no vendor names needed to recognize the pattern).
  const fire =
    signals.includes('http_failure') ||
    signals.includes('challenge_iframe_shape') ||
    (signals.includes('cross_host_redirect') && signals.includes('shape_anomaly'));
  if (!fire) return null;

  return {
    detected: true,
    requested_host: requestedHost,
    final_host: finalHost,
    nav_status: input.navStatus,
    signals,
    recommended_action: composeRecommendedAction(signals, input.connectEnabled),
  };
}

/** Count cross-origin iframes (any `src` whose host differs from
 *  `requestedHost`). Same-origin and protocol-relative-same-origin
 *  iframes don't count — they're regular embedded content the agent
 *  can usually reach via frame switches. Returns 0 when the iframe
 *  list is missing/empty. */
function countCrossOriginIframes(
  iframes: ReadonlyArray<{ src: string }> | undefined,
  requestedHost: string,
): number {
  if (!iframes || iframes.length === 0) return 0;
  let n = 0;
  for (const frame of iframes) {
    if (typeof frame.src !== 'string' || frame.src.length === 0) continue;
    try {
      const host = new URL(frame.src, `https://${requestedHost}`).host.toLowerCase();
      if (host && host !== requestedHost) n += 1;
    } catch {
      continue;
    }
  }
  return n;
}

/** Count semantic-landmark tokens in the serialized a11y tree. Stable
 *  threshold proxy for "is this a real page or a challenge / minimal
 *  splash". Used by multiple signals so factored out. */
function countSemanticLandmarks(a11yTree: string): number {
  return (a11yTree.match(/\b(?:navigation|main|article|button|link|heading)\b/gi) ?? []).length;
}

/** Compose the informational try-first prose. klura's job is to
 *  reverse-engineer sites; bailing on first friction is the opposite of
 *  the mission. abort_session is the documented last resort, never the
 *  primary recommendation. */
function composeRecommendedAction(
  signals: ReadonlyArray<OriginBlockedSignal>,
  connectEnabled?: boolean,
): string {
  // 451 legal/geo block short-circuits the bot-evasion playbook. The refusal is
  // keyed to the request's egress region/jurisdiction, not its session shape, so
  // alternate paths / same-origin fetch / wait+resnap / JS-challenge RE cannot
  // change the outcome — pointing the agent at them wastes rounds (and reads as
  // a false promise of bypass).
  if (signals.includes('http_legal_block')) {
    return (
      `LEGAL / GEO BLOCK — HTTP 451 (RFC 7725 "Unavailable For Legal Reasons"). This is NOT a ` +
      `bot-detection gate: the refusal is keyed to the request's egress region/jurisdiction, not ` +
      `your session shape. The bot-evasion moves (alternate paths, same-origin fetch, wait+resnap, ` +
      `JS-challenge RE) do NOT apply — they cannot change a region decision. The only things that ` +
      `change the outcome: an egress IP from a non-blocked region (different network / proxy), or ` +
      `start_remote_session handed to a person in an allowed region. If neither is available, ` +
      `abort_session({kind: "origin_blocked", reason}) is the correct exit — note in the reason that ` +
      `the block is region-conditional so the next session knows it's not a transient challenge.`
    );
  }
  const heads: string[] = [];
  if (signals.includes('challenge_iframe_shape')) {
    heads.push(
      `The visible UI is rendered inside a cross-origin iframe — top-level a11y / selectors ` +
        `cannot reach into it. perform_action against top-level elements will fail silently. ` +
        `Either start_remote_session for a human to click through, or try an alternate URL ` +
        `path on the same host that doesn't trigger the iframe gate.`,
    );
  }
  if (signals.includes('block_page_shape')) {
    heads.push(
      `The server returned a ≥400 status but the landing rendered a styled page with ` +
        `multiple links / nav / footer. Those links almost certainly return the same status — ` +
        `it's a server-side block, not a navigation issue. Don't click around; try API ` +
        `sub-paths or RE the gate.`,
    );
  }
  // Connect-mode nudge — only for challenge-shaped landings (interstitial /
  // iframe-only), and only when connect mode is off. A managed challenge that
  // fingerprints the automation launch profile loops forever for a
  // Playwright-launched browser but clears for a normally-launched Chrome
  // driven over CDP. Enabling it needs a local Chrome install and a browser
  // relaunch, so it's a user-consented change, not a silent self-heal.
  const challengeShaped =
    signals.includes('challenge_iframe_shape') || signals.includes('shape_anomaly');
  if (challengeShaped && connectEnabled === false) {
    heads.push(
      `This is a managed-browser challenge shape. Connect mode (drive a normally-launched real ` +
        `Chrome over CDP instead of a Playwright-launched browser) usually clears it — the tell ` +
        `is the automation launch profile, not the CDP connection. It's off by default because ` +
        `it needs a local Chrome install and a browser relaunch. To enable, ask the user, then ` +
        `\`configure({path: "pool.connect.enabled", value: true})\` and restart the runtime ` +
        `(see \`pool.connect\` in \`describe_config\`). Do NOT flip it silently — it changes ` +
        `which browser drives every session.`,
    );
  }
  const tryFirst = [
    `In-page navigation from a warmed session — the cheapest first move when the homepage ` +
      `or a category index already 200:ed. A cold direct-nav (\`perform_action({action: ` +
      `"navigate"})\`) to a protected path LOSES the bot-session cookies the homepage set. ` +
      `Instead drive the page in-place: click an in-page link, type into the search box, ` +
      `click a category tile. The XHRs that fire from that interaction carry the cookies the ` +
      `site itself set, and routinely 200 even when the same URL cold-naved would 403.`,
    `Same-origin \`fetch()\` from a healthy page rides the existing cookie jar. ` +
      `\`js_eval({expression: "fetch('/api/...').then(r => r.status)"})\` from the warmed ` +
      `homepage probes the protected endpoint cheaply; a working probe is the seed for a ` +
      `saved page-script strategy.`,
    `Context-bound request rejection: if a captured request 200:ed live but a replay ` +
      `(Node-side OR in-page \`fetch()\`) returns 401/403, the server may bind tokens to the ` +
      `JS context that generated them (vendor SDK init in an iframe, proof-of-work bound to a ` +
      `WebWorker origin, iframe-init-bound CSRF cookies). Use \`evaluate_in_iframe\` / ` +
      `\`evaluate_in_iframe_chain\` / \`evaluate_in_worker\` to fire the request from inside ` +
      `the imitating context. Same shape as \`inspect_ws_frame\` + \`try_generator\` for binary ` +
      `WS — third RE-toolkit axis, runtime hosts the context, you compose the JS.`,
    `Wait + re-snap: some JS challenges auto-resolve in 5-10 s. start_session does one ` +
      `automatic wait+resnap pass ONLY when the challenge redirected cross-host; a same-host ` +
      `JS challenge gets no auto-pass, so poll \`get_a11y_tree\` + \`get_network_log\` yourself ` +
      `for another ~10 s before treating the response as terminal.`,
    `Try alternate entry paths on the same host: many sites 403 the bare root \`/\` but ` +
      `serve API / typeahead / category sub-paths without a challenge. \`get_network_log\` + ` +
      `\`perform_action({action:"navigate"})\` to candidate sub-paths is cheap; the captures ` +
      `from those sub-paths are often where real save_strategy candidates live.`,
    `RE the challenge surface itself if it's a JS-fingerprint gate: \`search_js_source\` + ` +
      `\`read_js_function\` + \`js_eval\` can reach the signer / fingerprint check and let you ` +
      `template a fetch or page-script strategy that includes the right values. That's klura's ` +
      `core use-case — the harder the gate, the higher the value of the save.`,
    `Engage the human via start_remote_session when interactive consent is genuinely required ` +
      `(captcha, MFA). The remote viewer hands control to a person; they authenticate / solve ` +
      `/ hand back.`,
  ];
  const lastResort =
    `Only after the above options are exhausted (or you've structurally confirmed an ` +
    `IP-level network block via repeated cross-egress retries failing identically) does ` +
    `\`abort_session({kind: "origin_blocked", reason})\` become the right exit. When you DO ` +
    `abort, the ledger entry is informational for future sessions — it does NOT cause future ` +
    `start_sessions to skip the nav, so you can always retry from a different IP / fresh jar ` +
    `/ stealth driver and the next agent gets a fresh shot.`;
  const headBlock = heads.length > 0 ? heads.join('\n\n') + '\n\n' : '';
  return (
    `INFORMATIONAL — klura's job is to figure out HOW, not to bail. Observed signals: ` +
    `[${signals.join(', ')}].\n\n` +
    headBlock +
    `Try these first (cheap, klura-shape, do at least 1-2 before considering abort):\n` +
    tryFirst.map((s, i) => `  (${i + 1}) ${s}`).join('\n') +
    `\n\nLast resort:\n  ${lastResort}`
  );
}

/**
 * Could the page that just emitted `advisory` plausibly auto-resolve
 * given a few seconds of wait time? Pure structural check.
 *
 *   1. `cross_host_redirect` fired — the landing is a different host
 *      from the requested one, the typical "challenge page proxies the
 *      origin" shape. A bare same-host `http_failure` is a definitive
 *      refusal; no re-snap changes it.
 *   2. The current page looks like a challenge UI: iframe-dominated
 *      minimal a11y. Real landings have nav / main / multiple headings;
 *      challenge pages have an iframe + maybe a button.
 *
 * 5xx statuses are excluded — those mean the upstream is unhealthy, not
 * that a challenge is in flight. 4xx is allowed because some challenges
 * serve the initial nav with a 403 that flips to 200 after JS completes.
 */
export function isResolvableChallengeShape(
  advisory: OriginBlockedAdvisory,
  a11yTree: string,
  navStatus: number | null,
): boolean {
  if (!advisory.signals.includes('cross_host_redirect')) return false;
  if (typeof navStatus === 'number' && navStatus >= 500) return false;
  return isIframeOnlyMinimalContent(a11yTree);
}

/**
 * Structural test: does the a11y tree look like a near-empty page
 * dominated by iframes? Threshold tuned for accessibility tree
 * serialization where nodes appear as text tokens (role: iframe,
 * role: navigation, role: main, role: button, role: link, role:
 * heading). A real landing renders at least 5 of those landmark
 * tokens; a challenge page typically has 0-2 landmarks + 1-3 iframes.
 *
 * Pure regex over the serialized tree — no DOM parsing, no driver
 * coupling. False positives on truly minimal real pages (a static
 * "Coming soon" splash) are acceptable: the wait+resnap that consumes
 * this will just confirm the page didn't change and re-emit the
 * advisory.
 */
export function isIframeOnlyMinimalContent(a11yTree: string): boolean {
  const semanticTokens = countSemanticLandmarks(a11yTree);
  const iframeTokens = (a11yTree.match(/\biframe\b/gi) ?? []).length;
  return iframeTokens >= 1 && semanticTokens < 5;
}

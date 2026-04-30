import * as skills from '../skills';
import type { BrowserDriver } from '../../drivers/interface';
import type { Session } from '../../drivers/types/session';
import { extractFromHtml } from '../../response/html-extract';
import {
  getDeviceProfile,
  resolveClientHints,
  DEFAULT_ACCEPT_LANGUAGE,
} from '../../identity/devices';
import { isLoginWallUrl, tryGetUrl } from '../../response/auth-wall';

export interface PageExtractPrereq {
  name: string;
  kind: 'page-extract';
  url: string;
  vars: Record<string, { selector: string; attr?: string }>;
}

export function extractPageExtractPrereqs(data: Record<string, unknown>): PageExtractPrereq[] {
  if (data.strategy !== 'fetch' && data.strategy !== 'page-script') return [];
  const prerequisites = data.prerequisites;
  if (!Array.isArray(prerequisites)) return [];

  const out: PageExtractPrereq[] = [];
  for (const raw of prerequisites) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as Record<string, unknown>;
    if (p.kind !== 'page-extract') continue;
    if (typeof p.url !== 'string' || typeof p.name !== 'string') continue;
    if (!p.vars || typeof p.vars !== 'object') continue;
    // Re-narrow vars: skills.ts validation already ran, but re-validate because
    // we're reading unknown-typed data.
    const narrowedVars: Record<string, { selector: string; attr?: string }> = {};
    for (const [k, v] of Object.entries(p.vars as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue;
      const spec = v as Record<string, unknown>;
      if (typeof spec.selector !== 'string') continue;
      narrowedVars[k] = {
        selector: spec.selector,
        ...(typeof spec.attr === 'string' ? { attr: spec.attr } : {}),
      };
    }
    out.push({
      name: p.name,
      kind: 'page-extract',
      url: p.url,
      vars: narrowedVars,
    });
  }
  return out;
}

export async function probeOnePrereq(
  driver: BrowserDriver,
  session: Session,
  prereq: { name: string; url: string; vars: Record<string, { selector: string; attr?: string }> },
  warnings: string[],
): Promise<boolean> {
  try {
    // domcontentloaded is enough for the probe: every selector that
    // page-extract prereqs target (meta[name=csrf-token], data-* attributes on
    // server-rendered HTML, etc.) is in the initial document and doesn't need
    // JS or XHR settles. networkidle is a trap on modern sites that run
    // continuous analytics pings and never reach idle — the probe would time
    // out on every save.
    await driver.navigate(session, prereq.url, { waitUntil: 'domcontentloaded' });
  } catch (err) {
    throw new Error(
      `invalid_strategy: prerequisite "${prereq.name}" failed save-time probe — ` +
        `could not navigate to ${prereq.url}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  // Login-wall soft-warn: if the navigation 302'd to a login page (cached
  // storage-state stale or never written for this platform), the selectors —
  // which exist on the authenticated page — won't resolve on /login. A hard
  // reject here costs the agent the entire discovery run for a recoverable
  // cookie-staleness issue. Skip selector checks, append a warning the agent
  // can read after save, return true to also skip the Node-path probe.
  const finalUrl = await tryGetUrl(driver, session);
  if (isLoginWallUrl(finalUrl)) {
    warnings.push(
      `prerequisite "${prereq.name}" navigated to ${prereq.url} but was redirected to a login wall ` +
        `at ${finalUrl}. The platform's storage-state may be stale or missing auth. ` +
        `Re-login via start_remote_session and save again, or close + recreate the session to refresh ` +
        `cookies. Strategy saved without probe verification for this prereq.`,
    );
    return true;
  }

  for (const [varName, spec] of Object.entries(prereq.vars)) {
    let value: string;
    try {
      value = spec.attr
        ? await driver.getAttribute(session, spec.selector, spec.attr)
        : await driver.getText(session, spec.selector);
    } catch (err) {
      throw new Error(
        `invalid_strategy: prerequisite "${prereq.name}" var "${varName}" failed save-time probe — ` +
          `selector ${JSON.stringify(spec.selector)} did not resolve on ${prereq.url}: ${
            err instanceof Error ? err.message.split('\n')[0] : String(err)
          }. ` +
          `The agent likely guessed this selector instead of verifying it against the live DOM. ` +
          `Re-discover by reading the actual page (a11y tree or screenshot) and use a selector that exists.`,
        { cause: err },
      );
    }
    if (!value || value.length === 0) {
      const missingValue = spec.attr ? `attribute "${spec.attr}"` : 'text content';
      throw new Error(
        `invalid_strategy: prerequisite "${prereq.name}" var "${varName}" failed save-time probe — ` +
          `selector ${JSON.stringify(spec.selector)} resolved on ${prereq.url} but returned an empty value. ` +
          `Either the element exists but is empty, or the ${missingValue} is missing. ` +
          `Verify the selector picks the right element.`,
      );
    }
  }
  return false;
}

// Fetch the prereq URL via Node + cheerio and verify every selector resolves
// with a non-empty value. Returns `ok: false` with a diagnostic reason if the
// Node path can't handle this prereq — the caller uses that to demote the saved
// strategy to the page-script tier.
export async function probeOnePrereqFromNode(
  prereq: { name: string; url: string; vars: Record<string, { selector: string; attr?: string }> },
  platform: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // Build request headers from the device profile so the probe's Node path
  // looks as Chrome-like as warm execution will. If the site already accepts
  // the browser navigate, the HTTP-layer match should be close enough for the
  // probe; TLS-layer gap is accepted as a known false negative — if cheerio
  // can't parse the response because Cloudflare blocked us at the TLS level, we
  // stamp 'browser' which is correct.
  const profile = getDeviceProfile();
  const hints = resolveClientHints(profile);
  const headers: Record<string, string> = {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': profile.acceptLanguage ?? DEFAULT_ACCEPT_LANGUAGE,
  };
  if (profile.userAgent) headers['User-Agent'] = profile.userAgent;
  if (hints['sec-ch-ua']) headers['sec-ch-ua'] = hints['sec-ch-ua'];
  if (hints['sec-ch-ua-mobile']) headers['sec-ch-ua-mobile'] = hints['sec-ch-ua-mobile'];
  if (hints['sec-ch-ua-platform']) headers['sec-ch-ua-platform'] = hints['sec-ch-ua-platform'];
  const jar = skills.readStorageStateCookies(platform, prereq.url);
  if (jar.header) headers['Cookie'] = jar.header;

  let response: Response;
  try {
    response = await fetch(prereq.url, { method: 'GET', headers, redirect: 'follow' });
  } catch (err) {
    return {
      ok: false,
      reason: `node fetch to ${prereq.url} threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (response.status < 200 || response.status >= 300) {
    return {
      ok: false,
      reason: `node fetch to ${prereq.url} returned HTTP ${response.status}`,
    };
  }
  let html: string;
  try {
    html = await response.text();
  } catch (err) {
    return {
      ok: false,
      reason: `node fetch body read failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const selectorSpec: Record<string, { selector: string; attr?: string }> = {};
  for (const [varName, spec] of Object.entries(prereq.vars)) {
    const specOut: { selector: string; attr?: string } = { selector: spec.selector };
    if (spec.attr) specOut.attr = spec.attr;
    selectorSpec[varName] = specOut;
  }

  let extracted: Record<string, string | string[]>;
  try {
    extracted = extractFromHtml(html, selectorSpec);
  } catch (err) {
    return {
      ok: false,
      reason: `cheerio parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  for (const [varName, value] of Object.entries(extracted)) {
    const stringValue = Array.isArray(value) ? (value[0] ?? '') : value;
    if (stringValue === '') {
      return {
        ok: false,
        reason: `prereq "${prereq.name}" var "${varName}" selector "${selectorSpec[varName]?.selector}" resolved empty via cheerio — value is likely JS-generated; the strategy needs the page-script tier`,
      };
    }
  }
  return { ok: true };
}

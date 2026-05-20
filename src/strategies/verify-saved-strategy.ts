// Post-commit verification for a just-saved strategy.
//
// `save_strategy` commits a strategy, then emits the `post_save_validation_consent`
// checkpoint. When the agent resolves that checkpoint with consent, the runtime
// calls `verifySavedStrategy` — it runs the saved strategy end-to-end through
// `execute()`. A strategy that doesn't actually work (wrong header, stale token,
// bad endpoint) is archived to `.broken.json` here, in the same turn, so it
// never reaches another session's warm run.
//
// "Works" is not "HTTP 2xx" — a 2xx only proves the call left the building.
// `execute()` loads the strategy from disk and runs the full prereq chain,
// enforcing the strategy's own declared success contract (prereq `return_shape`,
// `response.from`, `response.extract`): a failed contract *throws*. So failure
// here is "execute threw OR non-2xx", which already inherits that enforcement —
// including failures buried inside a `js-eval` prerequisite's own `fetch()`,
// which no save-time shape check can see. The irreducible "did the mutation hit
// the right entity" question is not checked here — that stays the
// `mutating_verification_required` (agent-declared) + user layer.

import { execute } from '../execution';
import { loadStrategy, archiveStrategy, stampRuntimeMeta } from './skills';
import type { BrowserPool } from '../drivers/types/session';
import { refUrl, REF_LINKS } from '../vocab';

export interface VerifySavedStrategyResult {
  /** True when `execute()` returned a 2xx status. */
  ok: boolean;
  /** The HTTP status `execute()` returned; 0 when execute threw. */
  status: number;
  /** True when a non-2xx result caused the strategy to be archived. */
  archived: boolean;
  /** Agent-facing rejection envelope — present only when `ok` is false. */
  message?: string;
}

function previewBody(body: unknown): string {
  let s: string;
  if (typeof body === 'string') s = body;
  else {
    try {
      s = JSON.stringify(body);
    } catch {
      s = String(body);
    }
  }
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

/**
 * Run the just-saved `{platform, capability}` strategy via `execute()`. On a
 * clean run (no throw, 2xx) the active file is stamped
 * `runtime_meta.post_save_validation: "passed"`. On an execute throw or a
 * non-2xx status the strategy is archived to `.broken.json` and a
 * `post_save_validation_failed:` envelope is returned for the agent to fix and
 * re-save this session.
 */
export async function verifySavedStrategy(
  platform: string,
  capability: string,
  args: Record<string, unknown>,
  pool: BrowserPool,
): Promise<VerifySavedStrategyResult> {
  let status: number;
  let bodyPreview: string;
  try {
    const result = await execute(platform, capability, args, pool);
    status = result.status;
    bodyPreview = previewBody(result.body);
  } catch (err) {
    status = 0;
    bodyPreview = err instanceof Error ? err.message : String(err);
  }

  if (status >= 200 && status < 300) {
    stampRuntimeMeta(platform, capability, { post_save_validation: 'passed' });
    return { ok: true, status, archived: false };
  }

  const statusLabel = status === 0 ? 'a runtime error' : `HTTP ${status}`;
  const strat = loadStrategy(platform, capability);
  let archived = false;
  if (strat) {
    archiveStrategy(
      platform,
      capability,
      strat.strategy,
      `post-save validation failed: ${statusLabel}`,
    );
    archived = true;
  }

  return {
    ok: false,
    status,
    archived,
    message:
      `post_save_validation_failed: the saved \`${capability}\` strategy returned ${statusLabel} ` +
      `when executed end-to-end — it does not work as saved` +
      (archived ? ' and has been archived (.broken.json).' : '.') +
      `\n  Response: ${bodyPreview}` +
      `\n  Fix the strategy and re-save it this session — the capability has no working strategy until you do. ` +
      `See ${refUrl(REF_LINKS.selfVerifyingStrategies)}.`,
  };
}

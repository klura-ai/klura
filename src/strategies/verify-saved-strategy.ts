// Post-commit verification for a just-saved strategy.
//
// `save_strategy` commits a strategy, then emits the `post_save_validation_consent`
// checkpoint. When the agent resolves that checkpoint with consent, the runtime
// calls `verifySavedStrategy` — it runs the saved strategy end-to-end through
// `execute()`. A strategy that doesn't actually work (wrong header, stale token,
// bad endpoint) is archived to `.broken.json` here, in the same turn, so it
// never reaches another session's warm run.
//
// `execute()` loads the strategy from disk and runs the full prereq chain.
// A boolean `body.ok` is the local factory's explicit semantic signal: false
// fails validation even on HTTP 2xx. A 2xx body without that field proves only
// end-to-end transport; published semantic outcomes remain the signed package
// manifest's responsibility. The irreducible "did the mutation hit the right
// entity" question stays at the mutating-verification + user layer.

import { execute } from '../execution';
import {
  classifyFactoryExecutionResult,
  describeFactoryExecutionFailure,
  type FactoryExecutionClassification,
} from '../execution/result-classification';
import { loadStrategy, archiveStrategy, stampRuntimeMeta } from './skills';
import type { BrowserPool } from '../drivers/types/session';
import { refUrl, REF_LINKS } from '../vocab';

export interface VerifySavedStrategyResult {
  /** True only when the local strategy explicitly returned `body.ok:true`. */
  ok: boolean;
  /** Structural strength of the factory-side verification. */
  classification: FactoryExecutionClassification;
  /** The HTTP status `execute()` returned; 0 when execute threw. */
  status: number;
  /** True when transport failure or explicit `body.ok:false` caused archival. */
  archived: boolean;
  /** Bounded response evidence for LLM review; absent when validation was not run. */
  body_preview?: string;
  /** Agent-facing reason or rejection envelope for non-passed results. */
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
 * clean explicit run the active file is stamped
 * `runtime_meta.post_save_validation: "passed"`. A transport-only 2xx is
 * stamped `"transport_passed"`. On an execute throw, non-2xx status, or
 * explicit `body.ok:false`, the strategy is archived to `.broken.json` and a
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
  let classification: FactoryExecutionClassification = 'transport_failure';
  try {
    const result = await execute(platform, capability, args, pool);
    status = result.status;
    bodyPreview = previewBody(result.body);
    classification = classifyFactoryExecutionResult(result);
  } catch (err) {
    status = 0;
    bodyPreview = err instanceof Error ? err.message : String(err);
  }

  if (classification === 'explicit_success') {
    stampRuntimeMeta(platform, capability, { post_save_validation: 'passed' });
    return { ok: true, classification, status, archived: false, body_preview: bodyPreview };
  }

  if (classification === 'transport_accepted') {
    stampRuntimeMeta(platform, capability, { post_save_validation: 'transport_passed' });
    return {
      ok: false,
      classification,
      status,
      archived: false,
      body_preview: bodyPreview,
    };
  }

  const statusLabel = describeFactoryExecutionFailure(classification, status);
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
    classification,
    status,
    archived,
    body_preview: bodyPreview,
    message:
      `post_save_validation_failed: the saved \`${capability}\` strategy returned ${statusLabel} ` +
      `when executed end-to-end — it does not work as saved` +
      (archived ? ' and has been archived (.broken.json).' : '.') +
      `\n  Response: ${bodyPreview}` +
      `\n  Fix the strategy and re-save it this session — the capability has no working strategy until you do. ` +
      `See ${refUrl(REF_LINKS.selfVerifyingStrategies)}.`,
  };
}

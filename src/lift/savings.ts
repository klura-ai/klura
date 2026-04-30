// Reference cost of a fresh LLM-driven discovery run, and the savings delta
// when the user instead executes a cached strategy. Used by the CLI to print
// the run-2 "credit-card moment" green-text block.
//
// Why a static reference and not a per-skill measurement: the runtime doesn't
// know how long the LLM spent driving a discovery (start_session → ... →
// save_strategy is a sequence of independent tool calls from the runtime's
// perspective) and it can't know the token count because that lives in the
// LLM's context, not in klura's process. Using a conservative reference keeps
// the number honest — every constant below is easy to audit and tune.

/**
 * Typical total tokens burned by a fresh LLM-driven discovery of a single
 * capability. Conservative mid-range: simple T0 sites run 10-15k, complex T3
 * sites run 30-60k. 20k covers most real cases without cherry-picking.
 */
const FRESH_DISCOVERY_TOKENS = 20_000;

/**
 * Typical wall-clock of a fresh discovery, in seconds. Matches README.
 */
const FRESH_DISCOVERY_SECONDS = 40;

/**
 * Claude Sonnet 4.6 API pricing (USD per 1M tokens). Sonnet is the default
 * klura users run because it's the cheapest model that holds up on agent loops;
 * cost savings computed against Opus would be 5x higher. We publish the Sonnet
 * number to stay conservative.
 */
const INPUT_PRICE_PER_1M_USD = 3;
const OUTPUT_PRICE_PER_1M_USD = 15;

/**
 * Typical input/output split for a browser-agent discovery loop. Most tokens
 * are input: accumulated a11y trees, tool results, screenshot descriptions,
 * platform notes. Output is tool calls + brief planning. 80/20 holds across
 * most real runs we've observed.
 */
const INPUT_SHARE = 0.8;
const OUTPUT_SHARE = 0.2;

/**
 * Default monthly run rate used for the "$X/mo at your current rate" line. 100
 * runs/mo ≈ 3/day — a conservative estimate for a single automated workflow. A
 * power user running 10/day lands at $33/mo on a $0.11/run skill, which matches
 * the launch-plan example.
 */
const DEFAULT_MONTHLY_RUNS = 100;

function freshDiscoveryUsd(tokens: number = FRESH_DISCOVERY_TOKENS): number {
  const inputTokens = tokens * INPUT_SHARE;
  const outputTokens = tokens * OUTPUT_SHARE;
  return (
    (inputTokens * INPUT_PRICE_PER_1M_USD + outputTokens * OUTPUT_PRICE_PER_1M_USD) / 1_000_000
  );
}

interface RunSavings {
  tier: string;
  thisRunMs: number;
  freshDiscoverySeconds: number;
  freshDiscoveryTokens: number;
  freshDiscoveryUsd: number;
  savedUsdPerRun: number;
  monthlyUsdAtDefault: number;
}

export function estimateRunSavings(tier: string, thisRunMs: number): RunSavings {
  const freshUsd = freshDiscoveryUsd();
  return {
    tier,
    thisRunMs,
    freshDiscoverySeconds: FRESH_DISCOVERY_SECONDS,
    freshDiscoveryTokens: FRESH_DISCOVERY_TOKENS,
    freshDiscoveryUsd: freshUsd,
    savedUsdPerRun: freshUsd,
    monthlyUsdAtDefault: freshUsd * DEFAULT_MONTHLY_RUNS,
  };
}

// Tier name → short display label.
const TIER_DISPLAY: Record<string, string> = {
  fetch: 'fetch',
  'page-script': 'page-script',
  'recorded-path': 'recorded-path',
};

/**
 * Format the run-2 savings block. Uses ANSI color when `colors` is true.
 * Designed to print to stderr so stdout stays clean for scripts piping JSON.
 */
export function formatRunSavings(savings: RunSavings, colors: boolean): string {
  const green = colors ? '\x1b[32m' : '';
  const bold = colors ? '\x1b[1m' : '';
  const dim = colors ? '\x1b[2m' : '';
  const reset = colors ? '\x1b[0m' : '';

  const display = TIER_DISPLAY[savings.tier] ?? savings.tier;
  const thisSeconds = (savings.thisRunMs / 1000).toFixed(2);
  const freshSecs = savings.freshDiscoverySeconds;
  const freshTokens = savings.freshDiscoveryTokens.toLocaleString('en-US');
  const freshUsd = savings.freshDiscoveryUsd.toFixed(2);
  const savedRun = savings.savedUsdPerRun.toFixed(2);
  const monthly = savings.monthlyUsdAtDefault.toFixed(0);

  return [
    `${green}${bold}⚡ Skill cached at ${display} — this run: ${thisSeconds}s, 0 tokens.${reset}`,
    `${dim}   Fresh discovery typically: ~${freshSecs}s, ~${freshTokens} tokens ≈ $${freshUsd}${reset}`,
    `${green}   Saved ~$${savedRun}/run · ~$${monthly}/mo at ${DEFAULT_MONTHLY_RUNS} runs/mo${reset}`,
  ].join('\n');
}

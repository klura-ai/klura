'use strict';

// Auto-continue handler-of-last-resort for the checkpoint kinds the CLI agent
// can safely take itself. Returns `{status:'continue'}`, so klura does not
// surface a `_checkpoint` user-prompt detour and the agent proceeds with the
// session's natural flow.
//
// `session_expired` and bot-defense interruptions (CAPTCHA, auth wall, 2FA)
// are deliberately NOT claimed: those need a real human and fall through to
// klura's default handover handler, which the agent then surfaces.
//
// Registered last, so it wins over klura's defaults; a scenario handler that
// registers afterwards still wins over this. See
// runtime/src/checkpoints/registry.ts (last-registered-wins).

const { loadKluraRuntime } = require('./klura-modules');

const SAFE_KINDS = [
  'triage_plan',
  'surface_changed',
  'recorded_step_failed',
  'post_save_validation_consent',
];
const HANDLER_NAME = 'klura-agent-auto-continue';

/** Register the auto-continue handler. Returns an unregister function. */
function registerAgentCheckpoints() {
  const klura = loadKluraRuntime();
  const known = Array.isArray(klura.CHECKPOINT_KINDS) ? klura.CHECKPOINT_KINDS : SAFE_KINDS;
  const kinds = SAFE_KINDS.filter((k) => known.includes(k));
  klura.registerCheckpointHandler({
    name: HANDLER_NAME,
    kinds,
    async handle() {
      return { status: 'continue' };
    },
  });
  return function unregister() {
    try {
      klura.unregisterCheckpointHandler(HANDLER_NAME);
    } catch {
      /* best-effort */
    }
  };
}

module.exports = { registerAgentCheckpoints, SAFE_KINDS, HANDLER_NAME };

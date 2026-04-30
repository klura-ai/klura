// Singletons that back every agent-facing tool. Created once at module-load
// time when any tool file first imports from here — the ESM load order
// guarantees pool / tokenCache / listenerManager exist before the first tool
// handler runs.
//
// Split out of index.ts so the tool handlers in src/tools/ can import the state
// without also pulling in every other tool's transitive surface. index.ts is
// the agent-facing barrel; runtime-state.ts is the daemon's shared backbone.

import { createPool } from './pool/pool';
import { TokenCache } from './strategies/tokens';
import { defaultCapabilityCache } from './cache/capability-cache';
import { ListenerManager } from './listeners';
import * as skills from './strategies/skills';
import { runPrerequisites } from './execution';
import {
  registerDefaults as registerInterruptionDefaults,
  setViewerOpener as setInterruptionViewerOpener,
} from './interruptions';
import {
  registerCheckpointDefaults,
  setViewerOpener as setCheckpointViewerOpener,
} from './checkpoints';
import { startRemoteSession } from './remote';
// Default plugins that ship with klura. Imported for side-effect — each
// plugin file calls `registerInterruptionHandler(...)` at module load,
// the same way an enterprise plugin would. Removing an import here is
// how a deployment opts out of a shipped plugin.
import './plugins/credential-autofill';

// Register built-in interruption + checkpoint handlers at module-load
// time. Scenario / enterprise plugins register after to pre-empt these
// defaults. See runtime/docs/interruptions.md and
// runtime/docs/checkpoints.md.
registerInterruptionDefaults();
registerCheckpointDefaults();

export const pool = createPool();

// Inject the viewer opener into both the interruption and checkpoint
// default-handover handlers so they can spin up a remote viewer inline
// and return the URL in their resolution. Without this, the plugins
// degrade to returning intent only (`target: 'viewer'` with no URL)
// and the agent has to make a separate start_remote_session call.
const openViewer = async (
  sessionId: string,
  session: Parameters<typeof startRemoteSession>[2],
  opts: { prompt?: string },
): Promise<{ viewerUrl: string }> => {
  const driver = pool.driverFor(sessionId);
  const remote = await startRemoteSession(sessionId, driver, session, opts);
  return { viewerUrl: remote.viewerUrl };
};
setInterruptionViewerOpener(openViewer);
setCheckpointViewerOpener(openViewer);
export const tokenCache = new TokenCache();
// Capability return-value cache. Memoizes `execute(platform, capability,
// args)` results when the saved strategy declares `cache: {ttl: ...}`.
// In-memory per daemon; survives across execute calls, dies on restart.
// Re-exports the cache module's singleton so both tool-execute and the
// prereq-resolution path read the same store. See
// klura://reference#capability-cache.
export const capabilityCache = defaultCapabilityCache;
capabilityCache.start();
export const listenerManager = new ListenerManager();
listenerManager.setTokenCache(tokenCache);
// Inject the pool so browser-event listeners can spin up long-lived browser
// sessions to tap into cookie-bound push channels (chat, order tracking,
// notifications) that aren't reachable from a Node-side WebSocket connection.
listenerManager.setPool(pool);
// Inject the prereq runner so the proactive-refresh watcher can repopulate the
// token cache before cached tokens hit their TTL. Without this the watcher
// silently no-ops and listeners fall back to reactive 401 handling.
listenerManager.setPrereqRunner((opts) =>
  runPrerequisites({
    strategy: opts.strategy as { prerequisites?: never; baseUrl?: string },
    args: opts.args,
    platform: opts.platform,
    pool,
    tokenCache,
  }),
);

// Wire the per-session try_generator counter into the save-time validators in
// skills.ts. Without this the validators have no ground truth to clamp
// agent-claimed verify_iterations against, and fold-without-try drafts would
// slip through.
skills.setTryGeneratorStatsProvider((sessionId) => {
  if (typeof pool.getTryGeneratorStats !== 'function') return null;
  return pool.getTryGeneratorStats(sessionId) as {
    total: number;
    with_verify_against: number;
    ok_true: number;
    verified_ok: number;
  } | null;
});

// Declared-args provider — feeds the save-time detectors that cross-check the
// saved strategy against the caller's typed args (detectNameIdMismatch,
// detectEntityPinnedPrereqUrls in gate/save-warnings.ts). Returns the `args` map declared
// via start_session({capability, args}) on the most recent capability
// declaration for the session, or null when no session / no declared capability
// is available.
skills.setDeclaredArgsProvider((sessionId) => {
  try {
    const session = pool.getSession(sessionId);
    const declared = session.declaredCapabilities ?? [];
    const latest = declared[declared.length - 1];
    if (!latest) return null;
    return latest.args;
  } catch {
    return null;
  }
});

// Captured-requests provider — feeds detectPrereqBindKeyMismatch and any
// future detector that needs ground truth from the wire rather than what the
// agent declared. Returns the session's live intercepted array; the detector
// is responsible for narrowing to its relevant subset (e.g. requests whose
// path matches the strategy's endpoint template).
skills.setCapturedRequestsProvider((sessionId) => {
  try {
    const session = pool.getSession(sessionId);
    return session.intercepted;
  } catch {
    return null;
  }
});

// Start proactive token refresh — emits log when tokens are about to expire.
// Actual re-auth is triggered by the LLM (via 401 → needs_reauth response), but
// this ensures we don't silently hold stale tokens.
tokenCache.startRefreshLoop();

process.on('exit', () => {
  tokenCache.stopRefreshLoop();
  capabilityCache.stop();
  void listenerManager.stopAll();
  void pool.shutdown();
});
process.on('SIGINT', () => {
  void pool.shutdown().then(() => process.exit(0));
});
process.on('SIGTERM', () => {
  void pool.shutdown().then(() => process.exit(0));
});

#!/usr/bin/env node
'use strict';

const { isDaemonRunning, ensureDaemon, sendToDaemon } = require('../dist/daemon');

const args = process.argv.slice(2);
const command = args[0];

const COMMANDS = {
  'start-session': 'Open browser at URL',
  'action': 'Perform action (click/type/select)',
  'network-log': 'Show intercepted network requests',
  'screenshot': 'Take page screenshot',
  'end-drive': 'Close browser session',
  'save-strategy': 'Save a strategy from stdin',
  'execute': 'Execute a saved strategy',
  'start-remote': 'Start remote viewer (returns URL for user to interact)',
  'stop-remote': 'Stop remote viewer',
  'start-listener': 'Start real-time event listener',
  'stop-listener': 'Stop event listener',
  'get-events': 'Get queued listener events',
  'hook-events': 'Claude Code hook helper — drain queue into hook JSON',
  'patch-step': 'Patch a step in a recorded-path strategy',
  'mark-healed': 'Mark a strategy as healed after patching',
  'resume': 'Resume paused recorded-path execution',
  'history': 'Show mutation history for a platform',
  'device': "Manage this daemon's device profile (optional; default desktop preset accepts mouse+touch)",
  'policy': 'Manage per-platform policy (show/set/clear)',
  'identity': 'Manage per-platform identities (show/set/list/clear)',
  'secret': 'Manage secret resolvers (add/list/remove)',
  'list': 'List discovered skills',
  'lift-rate': 'Report LIFT rate — how many skills skip the browser',
  'status': 'Show daemon status',
  'daemon': 'Manage daemon (start/stop/status)',
  'warmup': 'Pre-warm DNS/TLS/browser caches (internal dev use)',
};

function usage() {
  console.log('klura — web automation skill runtime\n');
  console.log('Usage: klura <command> [options]\n');
  console.log('Commands:');
  for (const [name, desc] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(18)} ${desc}`);
  }
  console.log('\nDaemon:');
  console.log('  klura daemon start    Start background daemon');
  console.log('  klura daemon stop     Stop daemon');
  console.log('  klura daemon status   Check if daemon is running');
  console.log('\nOther commands auto-start the daemon if needed.');
}

if (!command || command === '--help' || command === '-h') {
  usage();
  process.exit(0);
}

if (command === '--version') {
  console.log(require('../package.json').version);
  process.exit(0);
}

if (!COMMANDS[command]) {
  console.error(`Unknown command: ${command}`);
  console.error(`Run 'klura --help' for available commands`);
  process.exit(1);
}

function out(data) {
  console.log(JSON.stringify(data, null, 2));
}

function parseFlag(flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

// --- Daemon management ---

async function handleDaemon() {
  const sub = args[1];
  if (sub === 'start') {
    if (isDaemonRunning()) {
      console.log('Daemon already running');
    } else {
      ensureDaemon();
      console.log('Daemon started');
    }
  } else if (sub === 'stop') {
    if (!isDaemonRunning()) {
      console.log('Daemon not running');
    } else {
      await sendToDaemon('POST', '/shutdown', {});
      console.log('Daemon stopped');
    }
  } else if (sub === 'status') {
    if (!isDaemonRunning()) {
      console.log('Daemon not running');
    } else {
      out(await sendToDaemon('GET', '/status'));
    }
  } else {
    console.error('Usage: klura daemon <start|stop|status>');
    process.exit(1);
  }
}

// --- Main: all commands route through daemon ---

async function main() {
  // Catch --help / -h anywhere in the args so e.g. `klura start-session --help`
  // doesn't accidentally treat "--help" as a URL or selector.
  if (args.includes('--help') || args.includes('-h')) {
    usage();
    process.exit(0);
  }

  if (command === 'daemon') {
    await handleDaemon();
    return;
  }

  if (command === 'device') {
    await handleDevice();
    return;
  }

  if (command === 'policy') {
    handlePolicy();
    return;
  }

  if (command === 'identity') {
    handleIdentity();
    return;
  }

  if (command === 'secret') {
    handleSecret();
    return;
  }

  if (command === 'hook-events') {
    await handleHookEvents();
    return;
  }

  // Auto-start daemon for all other commands (skip if remote daemon configured)
  if (!process.env.KLURA_DAEMON_ADDR) {
    ensureDaemon();
  }

  try {
    switch (command) {
      case 'start-session': {
        const url = args[1];
        if (!url) { console.error('Usage: klura start-session <url> [--platform name]'); process.exit(1); }
        const platform = parseFlag('--platform');
        out(await sendToDaemon('POST', '/session/start', { url, platform }));
        break;
      }

      case 'action': {
        const sessionId = args[1];
        const action = args[2];
        const selector = args[3];
        const value = parseFlag('--value') ?? args[4];
        if (!sessionId || !action || !selector) {
          console.error('Usage: klura action <sessionId> <click|type|select> <selector> [--value text]');
          process.exit(1);
        }
        out(await sendToDaemon('POST', '/session/action', { sessionId, action, selector, value }));
        break;
      }

      case 'network-log': {
        const sessionId = args[1];
        if (!sessionId) { console.error('Usage: klura network-log <sessionId>'); process.exit(1); }
        out(await sendToDaemon('GET', `/session/network?sessionId=${sessionId}`));
        break;
      }

      case 'screenshot': {
        const sessionId = args[1];
        if (!sessionId) { console.error('Usage: klura screenshot <sessionId>'); process.exit(1); }
        const outputFile = parseFlag('--output');
        const result = await sendToDaemon('GET', `/session/screenshot?sessionId=${sessionId}`);
        if (outputFile) {
          require('fs').writeFileSync(outputFile, Buffer.from(result, 'base64'));
          console.log(`Screenshot saved to ${outputFile}`);
        } else {
          console.log(result);
        }
        break;
      }

      case 'end-drive': {
        const sessionId = args[1];
        if (!sessionId) { console.error('Usage: klura end-drive <sessionId> [--platform name]'); process.exit(1); }
        const platform = parseFlag('--platform');
        out(await sendToDaemon('POST', '/session/close', { sessionId, platform }));
        break;
      }

      case 'save-strategy': {
        const platform = args[1];
        const capability = args[2];
        if (!platform || !capability) {
          console.error('Usage: echo \'{"strategy":"fetch",...}\' | klura save-strategy <platform> <capability> [--validate \'{"arg":"val"}\']');
          process.exit(1);
        }
        const chunks = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        const data = JSON.parse(Buffer.concat(chunks).toString());
        const changelog = parseFlag('--changelog');
        // Optional: pass --session <sess_id> during discovery so the
        // save-time validator can cross-reference strategy URLs against
        // the captured network log for that session.
        const sessionId = parseFlag('--session');
        const saved = await sendToDaemon('POST', '/strategy/save', {
          platform,
          capability,
          data,
          changelog,
          sessionId,
        });
        // Opt-in smoke test: immediately execute the strategy so discovery bugs
        // (missing required param, wrong endpoint, bad template) surface now
        // instead of at first real use. Only runs when the caller explicitly
        // asks for it — the flag value is the JSON args object to execute with.
        const validateArgsIdx = args.indexOf('--validate');
        if (validateArgsIdx !== -1) {
          const validateArgsRaw = args[validateArgsIdx + 1];
          const execArgs = validateArgsRaw ? JSON.parse(validateArgsRaw) : {};
          const validation = await sendToDaemon('POST', '/execute', { platform, capability, args: execArgs });
          out({ saved, validation });
        } else {
          out(saved);
        }
        break;
      }

      case 'execute': {
        const platform = args[1];
        const capability = args[2];
        if (!platform || !capability) {
          console.error('Usage: klura execute <platform> <capability> [--args \'{"key":"val"}\']');
          process.exit(1);
        }
        const argsJson = parseFlag('--args');
        const execArgs = argsJson ? JSON.parse(argsJson) : {};
        const result = await sendToDaemon('POST', '/execute', { platform, capability, args: execArgs });
        out(result);
        // Run-2 green-text moment: a saved strategy executed in milliseconds
        // with zero LLM tokens. Show the cliff where the user can see it.
        // Skip recorded-path (no LIFT cliff there — full DOM replay) and skip
        // anything that didn't actually succeed.
        if (
          result &&
          typeof result.elapsedMs === 'number' &&
          typeof result.tier === 'string' &&
          result.tier !== 'recorded-path' &&
          typeof result.status === 'number' &&
          result.status >= 200 &&
          result.status < 400
        ) {
          const { estimateRunSavings, formatRunSavings } = require('../dist/lift/savings');
          const savings = estimateRunSavings(result.tier, result.elapsedMs);
          const useColor = Boolean(process.stderr.isTTY) && !process.env.NO_COLOR;
          process.stderr.write(formatRunSavings(savings, useColor) + '\n');
        }
        break;
      }

      case 'start-remote': {
        const sessionId = args[1];
        if (!sessionId) { console.error('Usage: klura start-remote <sessionId> [--prompt "..."]'); process.exit(1); }
        const prompt = parseFlag('--prompt') ?? undefined;
        out(await sendToDaemon('POST', '/remote/start', { sessionId, prompt }));
        break;
      }

      case 'stop-remote': {
        const sessionId = args[1];
        if (!sessionId) { console.error('Usage: klura stop-remote <sessionId>'); process.exit(1); }
        out(await sendToDaemon('POST', '/remote/stop', { sessionId }));
        break;
      }

      case 'start-listener': {
        const platform = args[1];
        const capability = args[2];
        if (!platform || !capability) {
          console.error('Usage: klura start-listener <platform> <capability> [--args \'{"key":"val"}\']');
          process.exit(1);
        }
        const argsJson = parseFlag('--args');
        const listenerArgs = argsJson ? JSON.parse(argsJson) : {};
        out(await sendToDaemon('POST', '/listener/start', { platform, capability, args: listenerArgs }));
        break;
      }

      case 'stop-listener': {
        const listenerId = args[1];
        if (!listenerId) { console.error('Usage: klura stop-listener <listenerId>'); process.exit(1); }
        out(await sendToDaemon('POST', '/listener/stop', { listenerId }));
        break;
      }

      case 'get-events': {
        const since = parseFlag('--since');
        out(await sendToDaemon('GET', since ? `/listener/events?since=${since}` : '/listener/events'));
        break;
      }

      case 'patch-step': {
        const platform = args[1];
        const capability = args[2];
        const strategyType = args[3];
        const stepId = args[4];
        if (!platform || !capability || !strategyType || !stepId) {
          console.error('Usage: klura patch-step <platform> <capability> <strategyType> <stepId> --patch \'{"locators":{"css":".new"}}\'');
          process.exit(1);
        }
        const patchJson = parseFlag('--patch');
        if (!patchJson) { console.error('--patch is required'); process.exit(1); }
        const patch = JSON.parse(patchJson);
        out(await sendToDaemon('POST', '/strategy/patch-step', { platform, capability, strategyType, stepId, patch }));
        break;
      }

      case 'mark-healed': {
        const platform = args[1];
        const capability = args[2];
        const strategyType = args[3];
        if (!platform || !capability || !strategyType) {
          console.error('Usage: klura mark-healed <platform> <capability> <strategyType>');
          process.exit(1);
        }
        out(await sendToDaemon('POST', '/strategy/mark-healed', { platform, capability, strategyType }));
        break;
      }

      case 'resume': {
        const sessionId = args[1];
        if (!sessionId) { console.error('Usage: klura resume <sessionId>'); process.exit(1); }
        out(await sendToDaemon('POST', '/execute/resume', { sessionId }));
        break;
      }

      case 'history': {
        const platform = args[1];
        if (!platform) { console.error('Usage: klura history <platform> [--capability name] [--limit N]'); process.exit(1); }
        const capability = parseFlag('--capability');
        const limit = parseFlag('--limit');
        let qs = `platform=${platform}`;
        if (capability) qs += `&capability=${capability}`;
        if (limit) qs += `&limit=${limit}`;
        out(await sendToDaemon('GET', `/history?${qs}`));
        break;
      }

      case 'list': {
        out(await sendToDaemon('GET', '/platform-skills'));
        break;
      }

      case 'lift-rate': {
        const report = await sendToDaemon('GET', '/lift-rate');
        if (args.includes('--json')) {
          out(report);
        } else {
          const { formatLiftRateReport } = require('../dist/lift/report');
          console.log(formatLiftRateReport(report));
        }
        break;
      }

      case 'status': {
        out(await sendToDaemon('GET', '/status'));
        break;
      }

      case 'warmup': {
        // Internal developer command: pre-warm DNS / TLS / Playwright browser
        // binary / JIT caches before a benchmark run. Opens a session per URL,
        // idles briefly so the browser finishes bootstrapping, then closes.
        // Not exposed as an MCP tool — this is not agent-facing.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const v = require('../dist/validators');
        // Collect positional URL args, skipping known flags and their values.
        // Only --idle-ms is supported here; any other `--` token is rejected
        // so a typo'd flag can't silently slip into the URL list.
        const KNOWN_FLAGS = new Set(['--idle-ms']);
        const urls = [];
        for (let i = 1; i < args.length; i++) {
          const a = args[i];
          if (KNOWN_FLAGS.has(a)) { i++; continue; }
          if (a.startsWith('--')) {
            console.error(`Unknown flag for warmup: ${a}`);
            process.exit(1);
          }
          urls.push(a);
        }
        if (urls.length === 0) {
          console.error('Usage: klura warmup <url> [<url> ...] [--idle-ms N]');
          process.exit(1);
        }
        const idleRaw = parseFlag('--idle-ms');
        let idleMs = 2000;
        if (idleRaw !== undefined) {
          const parsed = Number(idleRaw);
          try {
            idleMs = v.asPositiveInt(parsed, '--idle-ms');
          } catch (e) {
            console.error(e.message);
            process.exit(1);
          }
        }
        // `about:blank` is allowed as a special case so benchmarks can warm
        // the browser binary / JIT caches without pointing at any real host.
        const ABOUT_BLANK = 'about:blank';
        for (const raw of urls) {
          if (raw === ABOUT_BLANK) continue;
          try { v.asUrl(raw, 'warmup url'); }
          catch (e) { console.error(e.message); process.exit(1); }
        }
        const warmedResults = [];
        for (const url of urls) {
          const t0 = Date.now();
          let sessionId;
          try {
            const started = await sendToDaemon('POST', '/session/start', { url });
            sessionId = started && started.sessionId;
            if (!sessionId) throw new Error(started && started.error ? started.error : 'start failed');
            await new Promise(resolve => setTimeout(resolve, idleMs));
            await sendToDaemon('POST', '/session/close', { sessionId });
            warmedResults.push({ url, ok: true, elapsedMs: Date.now() - t0 });
          } catch (e) {
            // Best-effort close if the session got created before the error
            if (sessionId) {
              try { await sendToDaemon('POST', '/session/close', { sessionId }); } catch { /* ignore */ }
            }
            warmedResults.push({ url, ok: false, error: e.message, elapsedMs: Date.now() - t0 });
          }
        }
        out({ warmed: warmedResults });
        const anyFailed = warmedResults.some(r => !r.ok);
        if (anyFailed) process.exit(1);
        break;
      }
    }
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

async function handleDevice() {
  // Device commands are direct file I/O — no daemon needed
  const { getDeviceProfile, setDeviceProfile, resetDeviceProfile, startDeviceProbe, DEVICE_PRESETS } = require('../dist/index');
  const sub = args[1];

  function describe(profile) {
    const label = profile.name ? `${profile.name}  ` : '';
    const scale = profile.deviceScaleFactor ? `  scale=${profile.deviceScaleFactor}` : '';
    const ua = profile.userAgent ? `\n  userAgent: ${profile.userAgent}` : '';
    return `  ${label}${profile.viewport.width}x${profile.viewport.height}  touch=${profile.hasTouch}  mobile=${profile.isMobile}${scale}${ua}`;
  }

  if (sub === 'show' || sub === undefined) {
    const profile = getDeviceProfile();
    console.log(describe(profile));
  } else if (sub === 'probe') {
    console.log('Starting device probe...');
    const profile = await startDeviceProbe();
    console.log('Device profile written to device.json:');
    console.log(describe(profile));
  } else if (sub === 'set') {
    const presetName = parseFlag('--preset');
    let profile;
    if (presetName) {
      if (!DEVICE_PRESETS[presetName]) {
        console.error(`Unknown preset: ${presetName}. Available: ${Object.keys(DEVICE_PRESETS).join(', ')}`);
        process.exit(1);
      }
      profile = { ...DEVICE_PRESETS[presetName] };
    } else {
      profile = { ...getDeviceProfile() };
    }
    const vpRaw = parseFlag('--viewport');
    if (vpRaw) {
      const [w, h] = vpRaw.split('x').map(Number);
      if (!Number.isFinite(w) || !Number.isFinite(h)) {
        console.error('--viewport must be WxH (e.g. 1280x720)');
        process.exit(1);
      }
      profile.viewport = { width: w, height: h };
    }
    const ua = parseFlag('--ua');
    if (ua !== undefined) profile.userAgent = ua;
    if (args.includes('--touch')) profile.hasTouch = true;
    if (args.includes('--no-touch')) profile.hasTouch = false;
    if (args.includes('--mobile')) profile.isMobile = true;
    if (args.includes('--no-mobile')) profile.isMobile = false;
    const scale = parseFlag('--scale');
    if (scale !== undefined) {
      const n = Number(scale);
      if (!Number.isFinite(n)) { console.error('--scale must be a number'); process.exit(1); }
      profile.deviceScaleFactor = n;
    }
    const name = parseFlag('--name');
    if (name !== undefined) profile.name = name;
    setDeviceProfile(profile);
    console.log('Device profile updated:');
    console.log(describe(profile));
  } else if (sub === 'reset') {
    resetDeviceProfile();
    console.log('Device profile reset to desktop default.');
  } else {
    console.error('Usage: klura device <show|probe|set|reset>');
    console.error('');
    console.error('  Device registration is optional. The default `desktop` preset accepts both');
    console.error('  mouse and touch input, so mouse/touch viewer handoff works out of the box.');
    console.error('  Configure a specific profile only when you want this daemon to emulate a');
    console.error('  named device (mobile-only flow, tablet-only UI) or need strict hover-only');
    console.error('  rendering. See docs/identities-and-device.md for rationale.');
    console.error('');
    console.error('  klura device show                               Print current profile');
    console.error('  klura device probe                              Interactively capture from a real');
    console.error('                                                  device you want this daemon to emulate');
    console.error('  klura device set [--preset desktop|desktop-strict|iphone-15|pixel-8]');
    console.error('                   [--viewport WxH] [--ua "..."]');
    console.error('                   [--touch|--no-touch] [--mobile|--no-mobile]');
    console.error('                   [--scale N] [--name "label"]');
    console.error('  klura device reset                              Revert to desktop default');
    process.exit(1);
  }
}

function handleIdentity() {
  const { getIdentity, setIdentity, listIdentities, clearIdentity } = require('../dist/index');
  const sub = args[1];

  if (sub === 'show') {
    const platform = args[2];
    if (!platform) { console.error('Usage: klura identity show <platform>'); process.exit(1); }
    const identity = getIdentity(platform);
    if (Object.keys(identity).length === 0) {
      console.log(`No identity set for '${platform}'`);
    } else {
      console.log(JSON.stringify(identity, null, 2));
    }
  } else if (sub === 'set') {
    const platform = args[2];
    const pairs = args.slice(3);
    if (!platform || pairs.length === 0) {
      console.error('Usage: klura identity set <platform> key=value [key=value ...]');
      process.exit(1);
    }
    for (const pair of pairs) {
      const eq = pair.indexOf('=');
      if (eq === -1) { console.error(`Invalid format: ${pair} (expected key=value)`); process.exit(1); }
      const key = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      setIdentity(platform, key, value);
    }
    console.log(`Identity for '${platform}' updated`);
    console.log(JSON.stringify(getIdentity(platform), null, 2));
  } else if (sub === 'list') {
    const all = listIdentities();
    if (Object.keys(all).length === 0) {
      console.log('No identities configured');
    } else {
      for (const [platform, fields] of Object.entries(all)) {
        const summary = Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(', ');
        console.log(`  ${platform.padEnd(20)} ${summary}`);
      }
    }
  } else if (sub === 'clear') {
    const platform = args[2];
    if (!platform) { console.error('Usage: klura identity clear <platform>'); process.exit(1); }
    clearIdentity(platform);
    console.log(`Identity for '${platform}' cleared`);
  } else {
    console.error('Usage: klura identity <show|set|list|clear>');
    process.exit(1);
  }
}

function handleSecret() {
  const { addSecretResolver, removeSecretResolver, listSecretResolvers } = require('../dist/index');
  const sub = args[1];

  if (sub === 'add') {
    const scheme = args[2];
    const command = args[3];
    if (!scheme || !command) {
      console.error('Usage: klura secret add <scheme> "<command with {{ref}}>"');
      console.error('Example: klura secret add op "op read {{ref}}"');
      process.exit(1);
    }
    addSecretResolver(scheme, command);
    console.log(`Secret resolver '${scheme}' added: ${command}`);
  } else if (sub === 'list') {
    const resolvers = listSecretResolvers();
    if (Object.keys(resolvers).length === 0) {
      console.log('No secret resolvers configured');
    } else {
      for (const [scheme, command] of Object.entries(resolvers)) {
        console.log(`  ${scheme.padEnd(12)} ${command}`);
      }
    }
  } else if (sub === 'remove') {
    const scheme = args[2];
    if (!scheme) { console.error('Usage: klura secret remove <scheme>'); process.exit(1); }
    removeSecretResolver(scheme);
    console.log(`Secret resolver '${scheme}' removed`);
  } else {
    console.error('Usage: klura secret <add|list|remove>');
    process.exit(1);
  }
}

// Claude Code hook helper. Wired up via ~/.claude/settings.json under the
// Stop / SessionStart / UserPromptSubmit hook events. Reads the hook payload
// that Claude Code pipes on stdin, drains the daemon's listener event queue,
// and emits the corresponding hook-protocol JSON so pending events land in
// the agent's context on the next turn. See runtime/README.md
// "Real-time events with Claude Code" for the settings.json snippet.
async function handleHookEvents() {
  // No daemon → no listeners → nothing to deliver. Don't auto-start from a
  // hook; Stop fires every turn and the latency would add up fast.
  if (!isDaemonRunning()) {
    process.exit(0);
  }

  // Default to the UserPromptSubmit response shape if we can't read stdin —
  // it's the safest generic additionalContext channel. Interactive TTYs
  // (manual invocation) skip stdin entirely so the command doesn't block.
  let hookEvent = 'UserPromptSubmit';
  if (!process.stdin.isTTY) {
    try {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      if (chunks.length > 0) {
        const payload = JSON.parse(Buffer.concat(chunks).toString());
        if (payload && typeof payload.hook_event_name === 'string') {
          hookEvent = payload.hook_event_name;
        }
      }
    } catch {
      /* fall through to default */
    }
  }

  let events;
  try {
    events = await sendToDaemon('GET', '/listener/events');
  } catch {
    process.exit(0);
  }
  if (!Array.isArray(events) || events.length === 0) {
    process.exit(0);
  }

  const header = `klura: ${events.length} pending listener event${events.length === 1 ? '' : 's'}`;
  const lines = [header];
  for (const ev of events) {
    let body;
    try {
      body = typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data);
    } catch {
      body = String(ev.data);
    }
    if (body.length > 500) body = body.slice(0, 497) + '...';
    const ts = new Date(ev.timestamp).toISOString();
    lines.push(`- [${ts}] ${ev.platform}/${ev.capability}: ${body}`);
  }
  const context = lines.join('\n');

  if (hookEvent === 'Stop') {
    // Block the stop so the agent takes another turn with the events in
    // context. On the next Stop tick the queue is empty and the hook
    // no-ops, letting the turn end normally.
    console.log(JSON.stringify({ decision: 'block', reason: context }));
  } else {
    // SessionStart / UserPromptSubmit / PreCompact all accept the
    // hookSpecificOutput.additionalContext channel.
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: hookEvent,
          additionalContext: context,
        },
      }),
    );
  }
  process.exit(0);
}

function handlePolicy() {
  const { loadPolicy, savePolicy, clearPolicy, getEffectivePolicy, setCapabilityPolicy } = require('../dist/index');
  const sub = args[1];

  // Parse a `--reason "..."` / `--reason=...` flag out of the args array.
  // Returns the reason string + a filtered args list with the flag removed.
  const parseReason = () => {
    let reason;
    const filtered = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--reason') {
        reason = args[++i];
      } else if (a && a.startsWith('--reason=')) {
        reason = a.slice('--reason='.length);
      } else {
        filtered.push(a);
      }
    }
    return { reason, filtered };
  };
  const { reason, filtered } = parseReason();
  const pArgs = filtered; // positional args after stripping flags

  if (sub === 'show') {
    const platform = pArgs[2];
    if (!platform) { console.error('Usage: klura policy show <platform>'); process.exit(1); }
    const policy = getEffectivePolicy(platform);
    console.log(JSON.stringify(policy, null, 2));
  } else if (sub === 'set') {
    // Two signatures:
    //   klura policy set <platform> <key> <value>                         (platform-level)
    //   klura policy set <platform> <capability>.max_strategy_tier <tier> (per-capability)
    const platform = pArgs[2];
    const key = pArgs[3];
    const value = pArgs[4];
    if (!platform || !key || value === undefined) {
      console.error('Usage:');
      console.error('  klura policy set <platform> <key> <value>                               # platform-level');
      console.error('  klura policy set <platform> <capability>.max_strategy_tier <tier> [--reason "..."]   # per-capability');
      console.error('Platform keys: max_strategy_tier, forbid_capabilities (comma-separated), notes');
      console.error('Tiers: recorded-path, page-script, fetch');
      process.exit(1);
    }
    // Per-capability shape: `<cap>.max_strategy_tier`
    const dotIdx = key.indexOf('.');
    if (dotIdx > 0) {
      const capability = key.slice(0, dotIdx);
      const subKey = key.slice(dotIdx + 1);
      if (subKey !== 'max_strategy_tier') {
        console.error(`Per-capability key must be "<capability>.max_strategy_tier" (got "${subKey}")`);
        process.exit(1);
      }
      const valid = ['recorded-path', 'page-script', 'fetch'];
      if (!valid.includes(value)) { console.error(`Invalid tier. Must be one of: ${valid.join(', ')}`); process.exit(1); }
      setCapabilityPolicy(platform, capability, value, reason);
      console.log(`User policy for '${platform}/${capability}' set: max_strategy_tier = ${value}${reason ? ` (reason: "${reason}")` : ''}`);
      console.log('Note: user policy is permanent and does not auto-review. Agent cannot override.');
      return;
    }
    const policy = loadPolicy(platform);
    if (key === 'forbid_capabilities') {
      policy.forbid_capabilities = value.split(',').map(s => s.trim());
    } else if (key === 'max_strategy_tier') {
      const valid = ['recorded-path', 'page-script', 'fetch'];
      if (!valid.includes(value)) { console.error(`Invalid tier. Must be one of: ${valid.join(', ')}`); process.exit(1); }
      policy.max_strategy_tier = value;
    } else if (key === 'notes') {
      policy.notes = value;
    } else {
      console.error(`Unknown policy key: ${key}`);
      process.exit(1);
    }
    savePolicy(platform, policy);
    console.log(`Policy for '${platform}' updated: ${key} = ${value}`);
  } else if (sub === 'clear') {
    // Two signatures:
    //   klura policy clear <platform>              (clears entire platform policy)
    //   klura policy clear <platform> <capability> (clears a single per-capability entry)
    const platform = pArgs[2];
    const capability = pArgs[3];
    if (!platform) { console.error('Usage: klura policy clear <platform> [<capability>]'); process.exit(1); }
    if (capability) {
      const policy = loadPolicy(platform);
      if (policy.per_capability && policy.per_capability[capability]) {
        delete policy.per_capability[capability];
        savePolicy(platform, policy);
        console.log(`User policy for '${platform}/${capability}' cleared.`);
      } else {
        console.log(`No user policy entry for '${platform}/${capability}'.`);
      }
    } else {
      clearPolicy(platform);
      console.log(`Policy for '${platform}' cleared`);
    }
  } else {
    console.error('Usage: klura policy <show|set|clear>');
    console.error('  show <platform>                                         Display effective platform policy');
    console.error('  set <platform> <key> <value>                            Set platform-level key');
    console.error('  set <platform> <cap>.max_strategy_tier <tier> [--reason "..."]  Set user cap on a capability (permanent)');
    console.error('  clear <platform>                                        Remove platform policy');
    console.error('  clear <platform> <capability>                           Remove per-capability cap');
    console.error('');
    console.error('Note: policy is user-owned. Agent self-reports ("I tried and couldnt") live');
    console.error('in the per-session working-dir logbook, surfaced via get_platform_logbook.');
    process.exit(1);
  }
}

main();

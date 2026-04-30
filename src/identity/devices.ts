// Device profile for this daemon.
//
// Every klura daemon IS one device. The profile is stored at
// {KLURA_HOME}/device.json and applied to every session the daemon creates.
// Power users who want multiple devices run multiple daemons with different
// KLURA_HOME values. See docs/identities-and-device.md for rationale.
//
// The profile's primary job is input-modality parity when a human connects to
// an already-running browser session via the remote viewer. The page was laid
// out under the daemon's profile; if the human's device doesn't match
// (hover-only client on a touch-laid page, or touch-only client on a hover-laid
// page), the UX breaks. The default `desktop` preset addresses this by
// reporting `hasTouch: true` alongside desktop dimensions — the "Windows
// Surface / touch-Chromebook" class of real device — so hover menus still
// render AND touch taps from a mobile viewer client work against the same
// rendered page, without a context reload. Stealth / fingerprint parity is a
// secondary side effect, not the main point.
//
// There is deliberately no registry of named devices, no per-platform override
// map, and no fallback chain. A daemon has one profile, full stop.
// getDeviceProfile() returns it; setDeviceProfile() writes it;
// resetDeviceProfile() deletes the file and reverts to the desktop preset.
//
// startDeviceProbe() is the interactive setup path: spin up an HTML page on a
// cloudflared tunnel, the user opens the link on the target device, the page
// reads navigator.userAgent / screen / devicePixelRatio / maxTouchPoints via
// JS, POSTs back, and the profile is written directly to device.json.

import fs from 'fs';
import path from 'path';
import http from 'http';
import { openTunnel, type Tunnel } from '../tunnel';
import { getKluraHome } from '../paths';

export interface DeviceProfile {
  /** Optional human-readable label — "my laptop", "work iPad". Not used for
   *  lookup. */
  name?: string;
  /** Empty string leaves the browser's native UA intact. */
  userAgent: string;
  viewport: { width: number; height: number };
  hasTouch: boolean;
  isMobile: boolean;
  deviceScaleFactor?: number;
  /**
   * `Accept-Language` header value the Node fire path sends. Populated from
   * `navigator.languages` during device probe. Unset → Node path sends the
   * `DEFAULT_ACCEPT_LANGUAGE` below. Ignored by the in-browser fire path
   * (Chrome generates its own).
   */
  acceptLanguage?: string;
  /**
   * Literal override for the Client Hint headers sent on Node fetch. Rarely
   * needed — the primary source of these values is per-strategy headers
   * captured from the discovery network log. This field is a device-wide
   * fallback, and even that fallback is usually synthesized from `userAgent`
   * via `synthesizeClientHints()`. Use when you want to pin a specific brand
   * string for every strategy without re-running discovery.
   */
  clientHints?: {
    'sec-ch-ua'?: string;
    'sec-ch-ua-platform'?: string;
    'sec-ch-ua-mobile'?: string;
  };
}

// Default `Accept-Language` when the device profile doesn't capture one.
// Sending nothing is a fingerprint giveaway (Node's default); picking a
// reasonable en-US value is closer to a real browser baseline than silence.
export const DEFAULT_ACCEPT_LANGUAGE = 'en-US,en;q=0.9';

/**
 * Preset profile templates. Use via `klura device set --preset <name>` or
 * programmatically as `setDeviceProfile(DEVICE_PRESETS['iphone-15'])`.
 *
 * `desktop` is a desktop viewport with touch input enabled — the "Windows
 * Surface / touch-Chromebook" class of real device — so a human connecting via
 * the remote viewer from a touch client can interact with the already-rendered
 * page without a modality reload. `desktop-strict` is the hover-only desktop
 * profile for the rare case of testing a site that serves materially different
 * content to touch-capable UAs.
 */
export const DEVICE_PRESETS: Record<string, DeviceProfile> = {
  desktop: {
    name: 'desktop',
    userAgent: '',
    viewport: { width: 1280, height: 720 },
    hasTouch: true,
    isMobile: false,
  },
  'desktop-strict': {
    name: 'desktop-strict',
    userAgent: '',
    viewport: { width: 1280, height: 720 },
    hasTouch: false,
    isMobile: false,
  },
  'iphone-15': {
    name: 'iPhone 15',
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 3,
  },
  'pixel-8': {
    name: 'Pixel 8',
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    viewport: { width: 412, height: 915 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2.625,
  },
};

/** The default profile — used when no device.json exists. Structurally
 *  guaranteed by the DEVICE_PRESETS literal above. */
const DEFAULT_PROFILE: DeviceProfile = DEVICE_PRESETS.desktop ?? {
  name: 'desktop',
  userAgent: '',
  viewport: { width: 1280, height: 720 },
  hasTouch: true,
  isMobile: false,
};

interface CacheEntry {
  resolvedPath: string;
  mtimeMs: number;
  profile: DeviceProfile;
}

let _cached: CacheEntry | null = null;

function resolveDevicePath(): string {
  return path.join(getKluraHome(), 'device.json');
}

function readCachedProfile(resolvedPath: string): DeviceProfile | null {
  if (!_cached || _cached.resolvedPath !== resolvedPath) return null;
  // Invalidate if the file changed on disk between calls.
  try {
    const stat = fs.statSync(resolvedPath);
    if (stat.mtimeMs !== _cached.mtimeMs) return null;
  } catch {
    // File gone since we cached — cache entry is stale.
    return null;
  }
  return _cached.profile;
}

function cacheProfile(resolvedPath: string, profile: DeviceProfile): void {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(resolvedPath).mtimeMs;
  } catch {
    /* file may not exist, cache with 0 so it gets re-read next time */
  }
  _cached = { resolvedPath, mtimeMs, profile };
}

function parseProfile(raw: unknown): DeviceProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.userAgent !== 'string') return null;
  if (typeof p.viewport !== 'object' || !p.viewport) return null;
  const viewport = p.viewport as Record<string, unknown>;
  if (typeof viewport.width !== 'number' || typeof viewport.height !== 'number') return null;
  if (typeof p.hasTouch !== 'boolean') return null;
  if (typeof p.isMobile !== 'boolean') return null;
  const profile: DeviceProfile = {
    userAgent: p.userAgent,
    viewport: { width: viewport.width, height: viewport.height },
    hasTouch: p.hasTouch,
    isMobile: p.isMobile,
  };
  if (typeof p.name === 'string') profile.name = p.name;
  if (typeof p.deviceScaleFactor === 'number') profile.deviceScaleFactor = p.deviceScaleFactor;
  if (typeof p.acceptLanguage === 'string' && p.acceptLanguage.length > 0) {
    profile.acceptLanguage = p.acceptLanguage;
  }
  if (p.clientHints && typeof p.clientHints === 'object') {
    const ch = p.clientHints as Record<string, unknown>;
    const hints: DeviceProfile['clientHints'] = {};
    if (typeof ch['sec-ch-ua'] === 'string') hints['sec-ch-ua'] = ch['sec-ch-ua'];
    if (typeof ch['sec-ch-ua-platform'] === 'string') {
      hints['sec-ch-ua-platform'] = ch['sec-ch-ua-platform'];
    }
    if (typeof ch['sec-ch-ua-mobile'] === 'string') {
      hints['sec-ch-ua-mobile'] = ch['sec-ch-ua-mobile'];
    }
    if (Object.keys(hints).length > 0) profile.clientHints = hints;
  }
  return profile;
}

/**
 * Return the daemon's device profile. Falls back to the desktop preset if
 * device.json is missing, empty, or malformed. Caches in module scope,
 * invalidates on file mtime change (so `klura device set` followed by a fresh
 * session sees the new profile without a daemon restart).
 */
export function getDeviceProfile(): DeviceProfile {
  const resolvedPath = resolveDevicePath();
  const cached = readCachedProfile(resolvedPath);
  if (cached) return cached;

  let profile: DeviceProfile;
  if (fs.existsSync(resolvedPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8')) as unknown;
      const parsed = parseProfile(raw);
      if (parsed) {
        profile = parsed;
      } else {
        console.warn(
          `[klura] device.json at ${resolvedPath} is malformed — falling back to desktop default`,
        );
        profile = DEFAULT_PROFILE;
      }
    } catch (err) {
      console.warn(
        `[klura] failed to read device.json at ${resolvedPath} (${String(err)}) — falling back to desktop default`,
      );
      profile = DEFAULT_PROFILE;
    }
  } else {
    profile = DEFAULT_PROFILE;
  }

  cacheProfile(resolvedPath, profile);
  return profile;
}

/** Overwrite the daemon's device profile. Creates KLURA_HOME if missing. */
export function setDeviceProfile(profile: DeviceProfile): void {
  const kluraDir = getKluraHome();
  fs.mkdirSync(kluraDir, { recursive: true, mode: 0o700 });
  const filePath = path.join(kluraDir, 'device.json');
  fs.writeFileSync(filePath, JSON.stringify(profile, null, 2), { mode: 0o600 });
  _cached = null; // invalidate cache; next get rereads + re-caches
}

/** Delete device.json, reverting to the desktop default. */
export function resetDeviceProfile(): void {
  const filePath = resolveDevicePath();
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* file may not exist, that's fine */
  }
  _cached = null;
}

/** Test-only: clear the module-scope cache. */
export function _resetDeviceProfileCacheForTests(): void {
  _cached = null;
}

// ---------------------------------------------------------------------------
// Client hint synthesis from user-agent
// ---------------------------------------------------------------------------
//
// Preferred source of sec-ch-ua-* headers is the discovery network capture —
// Chrome sends them on every request, the classifier saves them verbatim, the
// Node fire path replays them. This helper is the fallback for strategies saved
// before client-hint preservation existed: we derive a plausible set of client
// hints from the device-profile userAgent.
//
// It is strictly fallback-only. A strategy whose captured headers include
// sec-ch-ua-* always wins over synthesis. The synthesis is deliberate best-
// effort: if the UA doesn't parse cleanly, we return an empty object rather
// than emit a guessed value. Silent acceptance of wrong data is worse than
// missing data.
//
// The GREASE brand (the `"Not_A Brand"` / `"Not;A=Brand"` third entry Chrome
// ships for defense against server-side brand pinning) is emitted alongside the
// canonical brand so a server-side brand-count check sees the expected three
// entries. The exact GREASE string rotates per Chrome version upstream; we ship
// a best-effort table for the ones that shipped with this repo.

interface SynthesizedClientHints {
  'sec-ch-ua'?: string;
  'sec-ch-ua-mobile'?: string;
  'sec-ch-ua-platform'?: string;
}

// Per-major-version GREASE entry. The exact string rotates per Chrome release
// as part of the "Greasing HTTP Headers" defense — pinning it here is a best
// guess for pre-client-hint-captured strategies. Matches what Chrome M116–M125
// actually shipped.
const GREASE_BY_MAJOR: Record<string, string> = {
  '125': 'Not/A)Brand";v="24"',
  '124': '"Not-A.Brand";v="99"',
  '123': '"Not:A-Brand";v="8"',
  '122': '"Not(A:Brand";v="24"',
  '121': '"Not A(Brand";v="99"',
  '120': '"Not_A Brand";v="8"',
  '119': '"Not?A_Brand";v="24"',
  '118': '"Not/A)Brand";v="99"',
  '117': '"Not;A=Brand";v="8"',
  '116': '"Not)A;Brand";v="24"',
};

// Default GREASE for Chrome majors outside the table. Chosen so the header
// parses to the same shape clients expect.
const GREASE_DEFAULT = '"Not_A Brand";v="99"';

function synthesizeClientHints(profile: DeviceProfile): SynthesizedClientHints {
  const ua = profile.userAgent;
  if (typeof ua !== 'string' || ua.length === 0) return {};

  const chromeMatch = /Chrome\/(\d+)\./.exec(ua);
  if (!chromeMatch?.[1]) {
    // Non-Chrome or unparseable UA — we don't synthesize for Firefox / Safari
    // because those browsers don't send sec-ch-ua-* at all, so emitting them
    // would be a fingerprint mismatch, not a fingerprint match.
    return {};
  }
  const major = chromeMatch[1];

  let platform: string;
  if (/iPhone|iPad|iPod/.test(ua)) platform = '"iOS"';
  else if (/Android/.test(ua)) platform = '"Android"';
  else if (/Macintosh|Mac OS X/.test(ua)) platform = '"macOS"';
  else if (/Windows/.test(ua)) platform = '"Windows"';
  else if (/Linux/.test(ua)) platform = '"Linux"';
  else platform = '"Unknown"';

  const mobile = profile.isMobile ? '?1' : '?0';

  const grease = GREASE_BY_MAJOR[major] ?? GREASE_DEFAULT;
  // Chromium ships two canonical brands ("Chromium", "Google Chrome") plus the
  // GREASE entry. Order is not strictly defined by the spec but Chrome
  // consistently ships GREASE first — we match that.
  const brand = `${grease}, "Chromium";v="${major}", "Google Chrome";v="${major}"`;

  return {
    'sec-ch-ua': brand,
    'sec-ch-ua-mobile': mobile,
    'sec-ch-ua-platform': platform,
  };
}

/**
 * Resolve the set of client hints to send on a Node fetch for this device.
 * Priority: explicit per-device override > synthesis from UA > empty.
 * Strategy-level captured headers are applied at the call site (they win over
 * device-level defaults).
 */
export function resolveClientHints(profile: DeviceProfile): SynthesizedClientHints {
  const override = profile.clientHints ?? {};
  const synthesized = synthesizeClientHints(profile);
  return {
    'sec-ch-ua': override['sec-ch-ua'] ?? synthesized['sec-ch-ua'],
    'sec-ch-ua-mobile': override['sec-ch-ua-mobile'] ?? synthesized['sec-ch-ua-mobile'],
    'sec-ch-ua-platform': override['sec-ch-ua-platform'] ?? synthesized['sec-ch-ua-platform'],
  };
}

// ---------------------------------------------------------------------------
// Device probe
// ---------------------------------------------------------------------------

const PROBE_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Klura Device Setup</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; max-width: 400px; margin: 40px auto; padding: 0 20px; text-align: center; }
    .status { margin-top: 24px; font-size: 18px; }
    .info { margin-top: 16px; color: #666; font-size: 14px; }
  </style>
</head>
<body>
  <h2>Klura Device Setup</h2>
  <div class="status" id="status">Detecting device...</div>
  <div class="info" id="info"></div>
  <script>
    (async () => {
      const data = {
        userAgent: navigator.userAgent,
        screenWidth: screen.width,
        screenHeight: screen.height,
        devicePixelRatio: window.devicePixelRatio || 1,
        maxTouchPoints: navigator.maxTouchPoints || 0,
        hasTouch: ('ontouchstart' in window) || (navigator.maxTouchPoints > 0),
      };
      try {
        const res = await fetch('/probe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        if (res.ok) {
          document.getElementById('status').textContent = 'Device registered!';
          document.getElementById('info').textContent = 'You can close this tab.';
        } else {
          document.getElementById('status').textContent = 'Registration failed.';
        }
      } catch (e) {
        document.getElementById('status').textContent = 'Connection error.';
      }
    })();
  </script>
</body>
</html>`;

interface ProbeData {
  userAgent: string;
  screenWidth: number;
  screenHeight: number;
  devicePixelRatio: number;
  maxTouchPoints: number;
  hasTouch: boolean;
}

/**
 * Start a device probe server and block until a client connects and posts
 * profile data. Captured profile is written directly to the current daemon's
 * device.json via setDeviceProfile.
 */
export async function startDeviceProbe(): Promise<DeviceProfile> {
  return new Promise<DeviceProfile>((resolve, reject) => {
    let tunnel: Tunnel | null = null;

    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(PROBE_HTML);
        return;
      }

      if (req.method === 'POST' && req.url === '/probe') {
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk.toString()));
        req.on('end', () => {
          try {
            const data = JSON.parse(body) as ProbeData;
            const isMobile = /Mobile|Android|iPhone/i.test(data.userAgent);
            const profile: DeviceProfile = {
              userAgent: data.userAgent,
              viewport: { width: data.screenWidth, height: data.screenHeight },
              hasTouch: data.hasTouch || data.maxTouchPoints > 0,
              isMobile,
              deviceScaleFactor: data.devicePixelRatio,
            };

            setDeviceProfile(profile);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));

            server.close();
            if (tunnel) tunnel.kill();
            resolve(profile);
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid probe data' }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    server.listen(0, () => {
      void (async () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('Failed to start probe server'));
          return;
        }
        const port = addr.port;

        try {
          tunnel = await openTunnel(port);
          console.log(`\nOpen this link on the device you want to register:\n\n  ${tunnel.url}\n`);
          console.log('Waiting for device...');
        } catch {
          console.log(
            `\nOpen this link on the device (local network only):\n\n  http://localhost:${port}\n`,
          );
          console.log('Waiting for device...');
        }
      })();
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      if (tunnel) tunnel.kill();
      reject(new Error('Device probe timed out after 5 minutes'));
    }, 300000).unref();
  });
}

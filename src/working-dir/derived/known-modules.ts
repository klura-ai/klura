// Cross-session known-modules memory — scans the platform's saved strategies
// (fetch / page-script / recorded-path) and extracts every in-page module name
// the agent successfully called. A "module name" here is any identifier passed
// to a bundler-style module loader: `require("X")`, `__d._r._r("X")`,
// `__r("X")`, or a top-level global referenced via `globalThis.X` / `window.X`
// / `self.X` inside any JS text field (frameFromPage.expression,
// generated.frame.code, prerequisites[*].expression, etc.).
//
// Purpose: when a new session enters LIFT and starts probing for the page's
// signer / transport / builder, the logbook surfaces "previous successful saves
// on this platform used these modules: [...]" — the agent probes those names
// FIRST via js_eval instead of enumerating dozens of training-prior guesses.
// Observed in the 2026-04-21T09-18 messenger run: 30 rounds burned on
// module-name guesses before landing on LSMqttChannel. That name now lives in
// the saved strategy on disk; this file extracts it so the next session gets it
// for free.
//
// Pure: reads the platform's skills/<subdir>/<cap>.json files, no I/O
// side-effects beyond writing the derived file at derivedPath( platform,
// 'known-modules').

import fs from 'fs';
import path from 'path';
import { derivedPath } from '../layout';
import { SKILLS_DIR } from '../../paths';

const STRATEGY_SUBDIRS = ['fetch', 'scripts', 'paths'] as const;

// Module-loader reference: require("X") | require('X') | __r("X") |
// __d._r._r("X"). Captures the first argument if it's a plain string literal.
// Stops at quote match; doesn't try to parse escape sequences inside (none of
// the loaders klura sees in practice put backslashes in module ids).
const MODULE_REF_PATTERNS: Array<{ re: RegExp; source: 'require' | 'global' }> = [
  { re: /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g, source: 'require' },
  { re: /__r\s*\(\s*['"]([^'"]+)['"]\s*\)/g, source: 'require' },
  { re: /__d(?:\._r)?(?:\._r)?\s*\(\s*['"]([^'"]+)['"]\s*\)/g, source: 'require' },
  // globalThis / window / self global references — only when the agent wrote
  // the identifier in dotted form. Reasonable cap on the identifier so we don't
  // greedy-match across expressions.
  { re: /(?:globalThis|window|self)\.([A-Za-z_$][A-Za-z0-9_$]{2,60})/g, source: 'global' },
];

interface KnownModule {
  /** Module identifier as it appears in the source (e.g. "LSMqttChannel",
   *  or "signRequest" for a top-level global). */
  name: string;
  /** How the identifier is referenced — loader call vs top-level global. */
  source: 'require' | 'global';
  /** Capability slugs whose saved strategies reference this module. */
  used_by: string[];
  /** Number of saved strategies that reference it. */
  strategy_count: number;
}
export interface KnownModulesReport {
  schema_version: 1;
  platform: string;
  computed_at: string;
  /** Modules sorted by usage count desc; the higher the count, the
   *  stronger the signal that this is the platform's canonical entry. */
  modules: KnownModule[];
}

/**
 * Scan every saved strategy for the platform, extract module references, write
 * the derived report to disk, and return it.
 */
export function recomputeKnownModules(platform: string): KnownModulesReport {
  const aggregated = new Map<string, KnownModule>();
  const platformDir = path.join(SKILLS_DIR, platform);
  if (!fs.existsSync(platformDir)) {
    return emptyReport(platform);
  }

  for (const subdir of STRATEGY_SUBDIRS) {
    const dir = path.join(platformDir, subdir);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith('.json')) continue;
      const capability = entry.slice(0, -'.json'.length);
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(path.join(dir, entry), 'utf-8'));
      } catch {
        continue;
      }
      const text = collectJsText(raw);
      if (!text) continue;
      for (const ref of extractRefs(text)) {
        const key = `${ref.source}:${ref.name}`;
        let mod = aggregated.get(key);
        if (!mod) {
          mod = { name: ref.name, source: ref.source, used_by: [], strategy_count: 0 };
          aggregated.set(key, mod);
        }
        if (!mod.used_by.includes(capability)) mod.used_by.push(capability);
        mod.strategy_count += 1;
      }
    }
  }

  const modules = [...aggregated.values()].sort(
    (a, b) => b.strategy_count - a.strategy_count || a.name.localeCompare(b.name),
  );
  const report: KnownModulesReport = {
    schema_version: 1,
    platform,
    computed_at: new Date().toISOString(),
    modules,
  };
  writeReport(platform, report);
  return report;
}

function writeReport(platform: string, report: KnownModulesReport): void {
  const p = derivedPath(platform, 'known-modules');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(report, null, 2));
  fs.renameSync(tmp, p);
}

function emptyReport(platform: string): KnownModulesReport {
  return {
    schema_version: 1,
    platform,
    computed_at: new Date().toISOString(),
    modules: [],
  };
}

/** Walk a saved-strategy object and concatenate every string-valued
 * field that plausibly carries JS text — expressions, generator code, prereq
 * expressions. We don't filter by key name up-front because strategies carry JS
 * in varied slots (frameFromPage.expression, generated.frame.code,
 * generated.<name>.code, prerequisites[].expression, etc.); a flat walk catches
 * them all. Cap to avoid pathological
 *  memory use on corrupted files. */
function collectJsText(node: unknown, depth = 0): string {
  if (depth > 10) return '';
  if (typeof node === 'string') return node.length > 50_000 ? node.slice(0, 50_000) : node;
  if (Array.isArray(node)) return node.map((n) => collectJsText(n, depth + 1)).join('\n');
  if (node && typeof node === 'object') {
    return Object.values(node as Record<string, unknown>)
      .map((v) => collectJsText(v, depth + 1))
      .join('\n');
  }
  return '';
}

function extractRefs(text: string): Array<{ name: string; source: 'require' | 'global' }> {
  const out: Array<{ name: string; source: 'require' | 'global' }> = [];
  for (const { re, source } of MODULE_REF_PATTERNS) {
    // Global flag stored in the RegExp; iterate via matchAll.
    for (const m of text.matchAll(re)) {
      const name = m[1];
      if (!name) continue;
      // Filter out noise: single-letter names, JS builtins we never care to
      // surface as "platform modules."
      if (isNoiseName(name, source)) continue;
      out.push({ name, source });
    }
  }
  return out;
}

const BUILTIN_GLOBALS = new Set([
  'document',
  'location',
  'navigator',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'crypto',
  'fetch',
  'console',
  'addEventListener',
  'removeEventListener',
  'getComputedStyle',
  'scrollTo',
  'scrollBy',
  'alert',
  'confirm',
  'prompt',
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'clearInterval',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'JSON',
  'Math',
  'Date',
  'Object',
  'Array',
  'String',
  'Number',
  'Boolean',
  'Buffer',
  'URL',
  'URLSearchParams',
  'Promise',
  'Symbol',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Reflect',
  'Proxy',
  'Error',
  'TypeError',
  'RangeError',
  'innerWidth',
  'innerHeight',
  'outerWidth',
  'outerHeight',
  'scrollX',
  'scrollY',
  'pageXOffset',
  'pageYOffset',
  'devicePixelRatio',
  'screen',
  'history',
  'frames',
  'parent',
  'top',
  'performance',
  'origin',
]);

function isNoiseName(name: string, source: 'require' | 'global'): boolean {
  if (name.length < 3) return true;
  if (source === 'global' && BUILTIN_GLOBALS.has(name)) return true;
  return false;
}

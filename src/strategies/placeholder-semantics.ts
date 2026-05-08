import type { Strategy } from './skills';
import { collectInlinePlaceholderRefs } from '../execution/placeholders';

export interface DeclaredPlaceholders {
  genNames: Set<string>;
  paramNames: Set<string>;
  /** Positional aliases for the same caller args declared in `paramNames`,
   *  in declaration order. `{{0}}` resolves to the first param, `{{1}}` to
   *  the second, etc. Kept separate from `paramNames` so the available-list
   *  hint can present named first, positional second — matching the dominant
   *  model prior. See principles.md §"Forgive surface variance". */
  paramPositions: Set<string>;
  prereqProducedNames: Set<string>;
  interruptProducedNames: Set<string>;
}

export interface PlaceholderResolutionContext {
  allowGeneratedNames: boolean;
  allowInterruptProducedNames: boolean;
}

export interface PlaceholderUse {
  path: string;
  ref: string;
  context: PlaceholderResolutionContext;
}

interface PlaceholderDeclarationSource {
  generated?: unknown;
  interrupts?: unknown;
  notes?: unknown;
  prerequisites?: unknown;
}

const HTTP_REQUEST_PLACEHOLDER_CONTEXT: PlaceholderResolutionContext = Object.freeze({
  allowGeneratedNames: true,
  allowInterruptProducedNames: false,
});

const RUNTIME_ONLY_PLACEHOLDER_CONTEXT: PlaceholderResolutionContext = Object.freeze({
  allowGeneratedNames: false,
  allowInterruptProducedNames: false,
});

const RECORDED_STEP_PLACEHOLDER_CONTEXT: PlaceholderResolutionContext = Object.freeze({
  allowGeneratedNames: false,
  allowInterruptProducedNames: true,
});

type ProducedNameCollector = (raw: Record<string, unknown>) => Iterable<string>;

const PREREQ_PRODUCED_NAME_COLLECTORS: Record<string, ProducedNameCollector> = {
  cached: (raw) => (typeof raw.name === 'string' ? [raw.name] : []),
  'page-extract': (raw) =>
    raw.vars && typeof raw.vars === 'object'
      ? Object.keys(raw.vars as Record<string, unknown>)
      : [],
  'fetch-extract': (raw) =>
    raw.vars && typeof raw.vars === 'object'
      ? Object.keys(raw.vars as Record<string, unknown>)
      : [],
  browser: (raw) => {
    const out: string[] = [];
    if (!Array.isArray(raw.steps)) return out;
    for (const step of raw.steps) {
      if (!step || typeof step !== 'object') continue;
      const as = (step as Record<string, unknown>).as;
      if (typeof as === 'string') out.push(as);
    }
    return out;
  },
  'js-eval': (raw) => (typeof raw.binds === 'string' ? [raw.binds] : []),
  capability: (raw) =>
    raw.vars && typeof raw.vars === 'object'
      ? Object.keys(raw.vars as Record<string, unknown>)
      : [],
};

function collectInterruptProducedNames(raw: unknown): Iterable<string> {
  if (!raw || typeof raw !== 'object') return [];
  const handler = (raw as Record<string, unknown>).handler;
  if (!handler || typeof handler !== 'object') return [];
  const bindAs = (handler as Record<string, unknown>).binds;
  return typeof bindAs === 'string' ? [bindAs] : [];
}

// Semantic source of truth for names a prereq makes available to template
// interpolation. Important subtlety: browser prereq `name` is NOT included here
// — only explicit `step.as` outputs count. The runtime may hydrate
// `tokens[prereq.name]` from cache on a warm hit, but that's an optimization,
// not a portable declaration shape a newly-saved strategy should rely on.
function getPrereqProducedNames(raw: unknown): Set<string> {
  const out = new Set<string>();
  if (!raw || typeof raw !== 'object') return out;
  const kind = (raw as Record<string, unknown>).kind;
  if (typeof kind !== 'string') return out;
  const collect = PREREQ_PRODUCED_NAME_COLLECTORS[kind];
  if (!collect) return out;
  for (const name of collect(raw as Record<string, unknown>)) {
    if (typeof name === 'string' && name.length > 0) out.add(name);
  }
  return out;
}

export function collectDeclaredPlaceholders(
  data: PlaceholderDeclarationSource,
): DeclaredPlaceholders {
  const out: DeclaredPlaceholders = {
    genNames: new Set(),
    paramNames: new Set(),
    paramPositions: new Set(),
    prereqProducedNames: new Set(),
    interruptProducedNames: new Set(),
  };

  const generated = (data as { generated?: Record<string, unknown> }).generated;
  if (generated && typeof generated === 'object') {
    for (const name of Object.keys(generated)) out.genNames.add(name);
  }

  // Param declarations land in either the canonical object form or the
  // JSON-Schema-style array form. validateNotesParamsShape normalizes the
  // array form to the object form before saving, but this function is also
  // called from non-validation paths (placeholder resolution at execute-time
  // on freshly-emitted-but-not-yet-saved strategies, validator chains that
  // run before notes-shape), so we accept both shapes here too.
  const notes = (data as { notes?: Record<string, unknown> }).notes;
  if (notes && typeof notes === 'object') {
    const params = (notes as { params?: unknown }).params;
    const paramNamesInOrder: string[] = [];
    if (Array.isArray(params)) {
      for (const entry of params) {
        if (entry && typeof entry === 'object') {
          const name = (entry as { name?: unknown }).name;
          if (typeof name === 'string' && name.length > 0) paramNamesInOrder.push(name);
        }
      }
    } else if (params && typeof params === 'object') {
      paramNamesInOrder.push(...Object.keys(params as Record<string, unknown>));
    }
    paramNamesInOrder.forEach((name, idx) => {
      out.paramNames.add(name);
      out.paramPositions.add(String(idx));
    });
  }

  const prereqs = (data as { prerequisites?: unknown[] }).prerequisites;
  if (Array.isArray(prereqs)) {
    for (const raw of prereqs) {
      for (const name of getPrereqProducedNames(raw)) out.prereqProducedNames.add(name);
    }
  }

  const interrupts = (data as { interrupts?: unknown[] }).interrupts;
  if (Array.isArray(interrupts)) {
    for (const raw of interrupts) {
      for (const name of collectInterruptProducedNames(raw)) out.interruptProducedNames.add(name);
    }
  }

  return out;
}

function bareNamesForContext(
  declared: DeclaredPlaceholders,
  context: PlaceholderResolutionContext,
): Set<string> {
  const out = new Set<string>([
    ...declared.paramNames,
    ...declared.paramPositions,
    ...declared.prereqProducedNames,
  ]);
  if (context.allowInterruptProducedNames) {
    for (const name of declared.interruptProducedNames) out.add(name);
  }
  return out;
}

export function listAvailablePlaceholders(
  declared: DeclaredPlaceholders,
  context: PlaceholderResolutionContext,
): string[] {
  // Order: named param refs first (dominant model prior — REST template
  // style), then prereq-produced names, then interrupt-produced names if
  // the context allows them, then positional aliases for the same params,
  // then __gen aliases. The visual ordering teaches the agent which form
  // to reach for first.
  const out: string[] = [];
  out.push(
    ...[...declared.paramNames].sort((a, b) => a.localeCompare(b)).map((name) => `{{${name}}}`),
  );
  out.push(
    ...[...declared.prereqProducedNames]
      .sort((a, b) => a.localeCompare(b))
      .map((name) => `{{${name}}}`),
  );
  if (context.allowInterruptProducedNames) {
    out.push(
      ...[...declared.interruptProducedNames]
        .sort((a, b) => a.localeCompare(b))
        .map((name) => `{{${name}}}`),
    );
  }
  // Positional aliases, sorted numerically, with a "(positional alias)"
  // suffix so the agent doesn't think `{{0}}` and `{{recipient_name}}`
  // are different params — they're the same caller arg under two names.
  const positional = [...declared.paramPositions]
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  for (const idx of positional) {
    const named = [...declared.paramNames][idx];
    out.push(named ? `{{${idx}}} (alias for {{${named}}})` : `{{${idx}}}`);
  }
  if (context.allowGeneratedNames) {
    out.push(
      ...[...declared.genNames]
        .sort((a, b) => a.localeCompare(b))
        .map((name) => `{{__gen.${name}}}`),
    );
  }
  return out;
}

export function isPlaceholderDeclared(
  ref: string,
  declared: DeclaredPlaceholders,
  context: PlaceholderResolutionContext,
): boolean {
  if (ref.includes('.')) {
    if (!context.allowGeneratedNames) return false;
    const [head, ...rest] = ref.split('.');
    if (head !== '__gen') return false;
    const genName = rest.join('.');
    return declared.genNames.has(genName);
  }
  return bareNamesForContext(declared, context).has(ref);
}

function collectTemplateUses(
  value: unknown,
  path: string,
  context: PlaceholderResolutionContext,
  out: PlaceholderUse[],
): void {
  if (typeof value === 'string') {
    for (const ref of collectInlinePlaceholderRefs(value)) {
      out.push({ path, ref, context });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectTemplateUses(entry, path, context, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      collectTemplateUses(entry, path, context, out);
    }
  }
}

const GEN_CODE_ARGS_REF_RE = /\bargs\.([A-Z_a-z]\w*)/g;

function collectGeneratorArgUses(generated: unknown, out: PlaceholderUse[]): void {
  if (!generated || typeof generated !== 'object') return;
  for (const [name, entry] of Object.entries(generated as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue;
    const code = (entry as Record<string, unknown>).code;
    if (typeof code !== 'string') continue;
    let match: RegExpExecArray | null;
    GEN_CODE_ARGS_REF_RE.lastIndex = 0;
    while ((match = GEN_CODE_ARGS_REF_RE.exec(code)) !== null) {
      if (!match[1]) continue;
      out.push({
        path: `generated.${name}.code`,
        ref: match[1],
        context: RUNTIME_ONLY_PLACEHOLDER_CONTEXT,
      });
    }
  }
}

function collectPrereqUses(prereqs: unknown, out: PlaceholderUse[]): void {
  if (!Array.isArray(prereqs)) return;
  prereqs.forEach((raw, idx) => {
    if (!raw || typeof raw !== 'object') return;
    const prereq = raw as Record<string, unknown>;
    const pathBase = `prerequisites[${idx}]`;
    switch (prereq.kind) {
      case 'page-extract':
      case 'js-eval':
        collectTemplateUses(prereq.url, `${pathBase}.url`, RUNTIME_ONLY_PLACEHOLDER_CONTEXT, out);
        break;
      case 'fetch-extract':
        collectTemplateUses(prereq.url, `${pathBase}.url`, RUNTIME_ONLY_PLACEHOLDER_CONTEXT, out);
        collectTemplateUses(
          prereq.headers_map,
          `${pathBase}.headers_map`,
          RUNTIME_ONLY_PLACEHOLDER_CONTEXT,
          out,
        );
        collectTemplateUses(
          prereq.fetch_body,
          `${pathBase}.fetch_body`,
          RUNTIME_ONLY_PLACEHOLDER_CONTEXT,
          out,
        );
        break;
      case 'browser':
        if (!Array.isArray(prereq.steps)) break;
        prereq.steps.forEach((step, stepIdx) => {
          if (!step || typeof step !== 'object') return;
          const rawStep = step as Record<string, unknown>;
          for (const field of ['url', 'selector', 'attribute', 'value'] as const) {
            collectTemplateUses(
              rawStep[field],
              `${pathBase}.steps[${stepIdx}].${field}`,
              RUNTIME_ONLY_PLACEHOLDER_CONTEXT,
              out,
            );
          }
        });
        break;
      case 'capability':
        collectTemplateUses(prereq.args, `${pathBase}.args`, RUNTIME_ONLY_PLACEHOLDER_CONTEXT, out);
        break;
    }
  });
}

function collectInterruptUses(interrupts: unknown, out: PlaceholderUse[]): void {
  if (!Array.isArray(interrupts)) return;
  interrupts.forEach((raw, idx) => {
    if (!raw || typeof raw !== 'object') return;
    const handler = (raw as Record<string, unknown>).handler;
    if (!handler || typeof handler !== 'object') return;
    if ((handler as Record<string, unknown>).kind !== 'user-assist') return;
    collectTemplateUses(
      (handler as Record<string, unknown>).url,
      `interrupts[${idx}].handler.url`,
      RUNTIME_ONLY_PLACEHOLDER_CONTEXT,
      out,
    );
  });
}

export function collectPlaceholderUses(data: Strategy): PlaceholderUse[] {
  const out: PlaceholderUse[] = [];
  const obj = data as Record<string, unknown>;
  const protocol = obj.protocol === 'websocket' ? 'websocket' : 'http';

  if (protocol === 'websocket') {
    collectTemplateUses(obj.wsUrl, 'wsUrl', RUNTIME_ONLY_PLACEHOLDER_CONTEXT, out);
    collectTemplateUses(obj.wsHeaders, 'wsHeaders', RUNTIME_ONLY_PLACEHOLDER_CONTEXT, out);
    collectTemplateUses(obj.frame, 'frame', RUNTIME_ONLY_PLACEHOLDER_CONTEXT, out);

    const frameFromPage = obj.frameFromPage;
    if (frameFromPage && typeof frameFromPage === 'object') {
      collectTemplateUses(
        (frameFromPage as Record<string, unknown>).expression,
        'frameFromPage.expression',
        RUNTIME_ONLY_PLACEHOLDER_CONTEXT,
        out,
      );
    }

    const wsOpen = obj.wsOpen;
    if (wsOpen && typeof wsOpen === 'object') {
      collectTemplateUses(
        (wsOpen as Record<string, unknown>).steps,
        'wsOpen.steps',
        RUNTIME_ONLY_PLACEHOLDER_CONTEXT,
        out,
      );
    }
  } else {
    collectTemplateUses(obj.endpoint, 'endpoint', HTTP_REQUEST_PLACEHOLDER_CONTEXT, out);
    collectTemplateUses(obj.baseUrl, 'baseUrl', HTTP_REQUEST_PLACEHOLDER_CONTEXT, out);
    collectTemplateUses(obj.headers, 'headers', HTTP_REQUEST_PLACEHOLDER_CONTEXT, out);
    collectTemplateUses(obj.body, 'body', HTTP_REQUEST_PLACEHOLDER_CONTEXT, out);
    collectTemplateUses(obj.params, 'params', HTTP_REQUEST_PLACEHOLDER_CONTEXT, out);
    if (obj.strategy === 'page-script') {
      collectTemplateUses(obj.origin, 'origin', HTTP_REQUEST_PLACEHOLDER_CONTEXT, out);
    }
  }

  if (obj.strategy === 'recorded-path') {
    collectTemplateUses(obj.steps, 'steps', RECORDED_STEP_PLACEHOLDER_CONTEXT, out);
  }

  collectGeneratorArgUses(obj.generated, out);
  collectPrereqUses(obj.prerequisites, out);
  collectInterruptUses(obj.interrupts, out);
  return out;
}

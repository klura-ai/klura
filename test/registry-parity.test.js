// Tool registry parity tests. Asserts the registry is internally consistent
// and stays in sync with the vocab module. Also covers the schema-registry
// side of the vocab: the tier and prereq-kind Zod registries must carry
// exactly one entry per vocabulary value, keyed and literal-tagged by it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  TOOL_REGISTRY,
  TOOL_NAMES,
  UNIVERSAL_TOOLS,
  SESSION_PHASES,
  TOOL_PHASE_CATEGORIES,
  CATEGORY_PHASES,
  phaseAllowedTools,
  phaseExhaustedTools,
  toolPhasePolicies,
} = await import('../dist/index.js');
const { STRATEGY_TIERS, PREREQ_KIND_VALUES, SESSION_OUTCOMES, SAVED_OUTCOME_BY_TIER } =
  await import('../dist/vocab/index.js');
const { strategySchemas } = await import('../dist/strategies/schemas/strategy.js');
const { prereqSchemas } = await import('../dist/strategies/schemas/prereqs.js');
const { getSaveStrategySchema } = await import('../dist/strategies/schema-catalog.js');

test('TOOL_REGISTRY: every entry has a unique name', () => {
  const names = TOOL_REGISTRY.map((d) => d.name);
  const unique = new Set(names);
  assert.equal(names.length, unique.size, 'duplicate name(s) in TOOL_REGISTRY');
});

test('TOOL_REGISTRY: every entry.name is in TOOL_NAMES', () => {
  const validNames = new Set(Object.values(TOOL_NAMES));
  for (const def of TOOL_REGISTRY) {
    assert.ok(
      validNames.has(def.name),
      `TOOL_REGISTRY entry "${def.name}" not in TOOL_NAMES const map — add to vocab.ts first`,
    );
  }
});

test('TOOL_REGISTRY: every entry has a callable handler', () => {
  for (const def of TOOL_REGISTRY) {
    assert.equal(
      typeof def.handler,
      'function',
      `TOOL_REGISTRY entry "${def.name}" missing/invalid handler`,
    );
  }
});

test('TOOL_REGISTRY: every entry has a non-empty description', () => {
  for (const def of TOOL_REGISTRY) {
    assert.ok(
      typeof def.description === 'string' && def.description.length > 0,
      `TOOL_REGISTRY entry "${def.name}" missing description`,
    );
  }
});

test('TOOL_REGISTRY: every entry has an inputSchema object', () => {
  for (const def of TOOL_REGISTRY) {
    assert.equal(
      typeof def.inputSchema,
      'object',
      `TOOL_REGISTRY entry "${def.name}" missing inputSchema`,
    );
    assert.notEqual(def.inputSchema, null);
  }
});

test('TOOL_REGISTRY: every TOOL_NAMES value appears in the registry', () => {
  const registryNames = new Set(TOOL_REGISTRY.map((d) => d.name));
  const missing = Object.values(TOOL_NAMES).filter((n) => !registryNames.has(n));
  assert.deepEqual(
    missing,
    [],
    `TOOL_NAMES values missing from TOOL_REGISTRY: ${missing.join(', ')} — every named tool must have a TOOL_DEF`,
  );
});

test('vocab: strategySchemas registry keys equal STRATEGY_TIERS', () => {
  assert.deepEqual(Object.keys(strategySchemas), [...STRATEGY_TIERS]);
});

test('vocab: prereqSchemas registry keys equal PREREQ_KIND_VALUES', () => {
  assert.deepEqual(Object.keys(prereqSchemas), [...PREREQ_KIND_VALUES]);
});

test('vocab: each tier schema literal-tags its own key', () => {
  const catalog = getSaveStrategySchema();
  for (const tier of STRATEGY_TIERS) {
    assert.match(
      catalog.tiers[tier].shape_skeleton,
      new RegExp(`"strategy": "${tier}"`),
      `tier registry entry "${tier}" must carry strategy: z.literal("${tier}")`,
    );
  }
});

test('vocab: each prereq schema literal-tags its own kind', () => {
  const catalog = getSaveStrategySchema();
  for (const kind of PREREQ_KIND_VALUES) {
    assert.match(
      catalog.prereqs[kind].shape_skeleton,
      new RegExp(`"kind": "${kind}"`),
      `prereq registry entry "${kind}" must carry kind: z.literal("${kind}")`,
    );
  }
});

test('vocab: SAVED_OUTCOME_BY_TIER covers every tier with a valid outcome', () => {
  assert.deepEqual(Object.keys(SAVED_OUTCOME_BY_TIER), [...STRATEGY_TIERS]);
  const outcomes = new Set(SESSION_OUTCOMES);
  for (const [tier, outcome] of Object.entries(SAVED_OUTCOME_BY_TIER)) {
    assert.ok(outcomes.has(outcome), `SAVED_OUTCOME_BY_TIER["${tier}"] = "${outcome}" not in SESSION_OUTCOMES`);
  }
});

// ---------- Phase catalog parity ----------
//
// The phase tool catalog is a derived projection over TOOL_REGISTRY: every
// ToolDef declares a phasePolicy, and the per-phase allowed / exhausted sets
// plus UNIVERSAL_TOOLS are computed from those declarations. These tests
// lock the projection down in both directions — no catalog entry without a
// registered tool (the phantom-entry regression), and no registered tool
// without a coherent policy.

test('phase catalog: every TOOL_DEF declares a phasePolicy with a known category', () => {
  const categories = new Set(TOOL_PHASE_CATEGORIES);
  for (const def of TOOL_REGISTRY) {
    assert.ok(
      def.phasePolicy && typeof def.phasePolicy === 'object',
      `TOOL_REGISTRY entry "${def.name}" missing phasePolicy — every ToolDef must declare one`,
    );
    assert.ok(
      categories.has(def.phasePolicy.category),
      `TOOL_REGISTRY entry "${def.name}" has unknown phasePolicy.category "${def.phasePolicy.category}"`,
    );
  }
});

test('phase catalog: no catalog entry without a registered tool (phantom-entry regression)', () => {
  const registryNames = new Set(TOOL_REGISTRY.map((d) => d.name));
  const catalogNames = new Set(UNIVERSAL_TOOLS);
  for (const phase of SESSION_PHASES) {
    for (const name of phaseAllowedTools(phase)) catalogNames.add(name);
    for (const name of phaseExhaustedTools(phase)) catalogNames.add(name);
  }
  const phantoms = [...catalogNames].filter((name) => !registryNames.has(name));
  assert.deepEqual(
    phantoms,
    [],
    `phase catalog names with no registered tool: ${phantoms.join(', ')} — the catalog is derived ` +
      `from TOOL_REGISTRY, so a phantom means the derivation or a policy is broken`,
  );
});

test('phase catalog: derived per-phase sets match each ToolDef phasePolicy exactly', () => {
  const policies = toolPhasePolicies();
  for (const def of TOOL_REGISTRY) {
    const policy = policies.get(def.name);
    assert.ok(policy, `toolPhasePolicies() missing "${def.name}"`);
    const declaredPhases = new Set([
      ...(CATEGORY_PHASES[policy.category] ?? []),
      ...(policy.extraPhases ?? []),
    ]);
    for (const phase of SESSION_PHASES) {
      assert.equal(
        phaseAllowedTools(phase).has(def.name),
        declaredPhases.has(phase),
        `"${def.name}" (category ${policy.category}) phase-set membership for '${phase}' ` +
          `contradicts its phasePolicy`,
      );
      const exhaustedDeclared = (policy.allowedWhenExhaustedIn ?? []).includes(phase);
      assert.equal(
        phaseExhaustedTools(phase).has(def.name),
        exhaustedDeclared,
        `"${def.name}" exhausted-set membership for '${phase}' contradicts its phasePolicy`,
      );
    }
    const isUniversal = policy.category === 'universal';
    assert.equal(
      UNIVERSAL_TOOLS.has(def.name),
      isUniversal,
      `"${def.name}" UNIVERSAL_TOOLS membership contradicts its phasePolicy category`,
    );
  }
});

test('phase catalog: exhausted sets are subsets of allowed sets', () => {
  for (const phase of SESSION_PHASES) {
    const allowed = phaseAllowedTools(phase);
    for (const name of phaseExhaustedTools(phase)) {
      assert.ok(
        allowed.has(name),
        `'${name}' is in phase '${phase}' exhausted set but not in its allowed set`,
      );
    }
  }
});

test('phase catalog: session_id-taking tools are never category "none"', () => {
  // The MCP server gates phase admissibility only when the call carries a
  // session_id, so a session-bound tool declared 'none' would silently
  // bypass phase gating the moment it ships.
  const policies = toolPhasePolicies();
  for (const def of TOOL_REGISTRY) {
    const props = def.inputSchema?.properties ?? {};
    if (!('session_id' in props)) continue;
    const policy = policies.get(def.name);
    assert.notEqual(
      policy.category,
      'none',
      `"${def.name}" declares a session_id arg but phasePolicy.category 'none' — ` +
        `session-bound tools must be 'universal' or phase-scoped`,
    );
  }
});

test('phase catalog: snapshot of derived per-phase composition', () => {
  // Independent snapshot of the projection — guards the derivation itself
  // against accidental membership drift. Update deliberately when a
  // phasePolicy changes on purpose.
  const readOnlyDiagnostic = [
    'get_network_log',
    'get_action_history',
    'get_a11y_tree',
    'find_in_page',
    'get_attribute',
    'get_screenshot',
    'get_js_source',
    'search_js_source',
    'read_js_function',
    'list_loaded_scripts',
    'inspect_ws_frame',
    'find_in_ws_frame',
    'pin_ws_frame',
    'explain_ws_frame_structure',
    'js_eval',
    'evaluate_in_iframe',
    'evaluate_in_iframe_chain',
    'evaluate_in_worker',
  ];
  const discoveryArtifact = ['save_verified_expression', 'add_discovery_note', 'add_resume_pointer'];
  const liftReActive = [
    'try_generator',
    'try_generator_in_page',
    'get_send_encoder',
    'set_breakpoint',
    'remove_breakpoint',
    'list_breakpoints',
    'wait_for_pause',
    'get_frame_scope',
    'evaluate_on_frame',
    'step',
    'resume',
    'install_page_init_script',
    'remove_page_init_script',
    'trigger_reference_send',
    'patch_step',
    'start_listener',
    'stop_listener',
    'get_events',
  ];
  const expected = {
    universal: [
      'ack_checkpoint',
      'resolve_interruption',
      'list_interruption_resolvers',
      'list_platform_skills',
      'get_platform_logbook',
      'get_strategy',
      'get_strategy_events',
      'get_discovery_artifact_field',
      'start_remote_session',
      'stop_remote_session',
      'wait_for_remote',
      'describe_config',
      'get_config',
      'get_secret',
      'configure',
      'restart_runtime',
    ],
    allowed: {
      drive: [
        ...readOnlyDiagnostic,
        ...discoveryArtifact,
        'start_session',
        'perform_action',
        'end_drive',
        'resume_execution',
        'declare_capability',
        'record_observed_capability',
        'lift_observed_capability',
        'update_strategy',
        'abort_session',
      ],
      triage: [
        ...readOnlyDiagnostic,
        ...discoveryArtifact,
        'save_strategy',
        'submit_triage_plan',
        'declare_capability',
        'record_observed_capability',
        'abort_session',
      ],
      lift: [
        ...readOnlyDiagnostic,
        ...discoveryArtifact,
        ...liftReActive,
        'save_strategy',
        'submit_triage_plan',
        'update_strategy',
        'declare_capability',
        'record_observed_capability',
        'lift_observed_capability',
        'abort_session',
        'perform_action',
        'end_drive',
      ],
      execute: ['end_drive', 'get_screenshot', 'patch_step', 'resume_execution', 'update_strategy'],
    },
    exhausted: {
      drive: ['end_drive', 'abort_session'],
      triage: ['submit_triage_plan', 'abort_session'],
      lift: ['save_strategy', 'submit_triage_plan', 'end_drive', 'abort_session'],
      execute: ['end_drive'],
    },
  };
  assert.deepEqual([...UNIVERSAL_TOOLS].sort(), [...expected.universal].sort());
  for (const phase of SESSION_PHASES) {
    assert.deepEqual(
      [...phaseAllowedTools(phase)].sort(),
      [...expected.allowed[phase]].sort(),
      `phase '${phase}' allowed set drifted from the snapshot`,
    );
    assert.deepEqual(
      [...phaseExhaustedTools(phase)].sort(),
      [...expected.exhausted[phase]].sort(),
      `phase '${phase}' exhausted set drifted from the snapshot`,
    );
  }
});

test('phase catalog: programmatic-operation names never appear in any derived set', () => {
  // These names are daemon/CLI programmatic operations (or the programmatic
  // executor), not MCP tools. The phase layer must never admit them: an
  // unregistered universal name would bypass phase gates, budget ticks, and
  // the closed-session check the moment a tool of that name ships.
  const retired = [
    'archive_strategy',
    'unarchive_strategy',
    'mark_healed',
    'demote_fetch_to_page_script',
    'execute',
  ];
  for (const name of retired) {
    assert.equal(UNIVERSAL_TOOLS.has(name), false, `'${name}' must not be universal`);
    for (const phase of SESSION_PHASES) {
      assert.equal(
        phaseAllowedTools(phase).has(name),
        false,
        `'${name}' must not be admissible in phase '${phase}'`,
      );
    }
  }
});

test('TOOL_REGISTRY: gate-owning tools set their bypass flags', () => {
  const byName = new Map(TOOL_REGISTRY.map((d) => [d.name, d]));
  const ack = byName.get(TOOL_NAMES.ackCheckpoint);
  assert.ok(ack, 'ack_checkpoint missing from TOOL_REGISTRY');
  assert.equal(
    ack.skipCheckpointGate,
    true,
    'ack_checkpoint must set skipCheckpointGate:true — it resolves the pending checkpoint',
  );
  for (const name of [TOOL_NAMES.resolveInterruption, TOOL_NAMES.listInterruptionResolvers]) {
    const def = byName.get(name);
    assert.ok(def, `${name} missing from TOOL_REGISTRY`);
    assert.equal(
      def.skipInterruptionGate,
      true,
      `${name} must set skipInterruptionGate:true — interruption-resolver tools own the pending-interruption gate`,
    );
  }
});

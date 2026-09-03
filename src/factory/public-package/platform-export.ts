import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseExactRecord,
  PublicContractError,
  sha256Digest,
  type CapabilityIdV1,
  type PackageIdV1,
  type PackageVersionV1,
  type Sha256DigestV1,
  type StableContractIdV1,
} from '../../public/contracts/common';
import type { JsonValueV1 } from '../../public/contracts/json';
import {
  assessPackageFixtureCoverage,
  PACKAGE_FIXTURE_KINDS,
  PACKAGE_FIXTURE_SCHEMA_VERSION,
  packageFixtureFileName,
  parsePublicPackageFixtureBytes,
  planPackageFixtureCoverage,
} from '../../public/contracts/fixture';
import { TOOLS_PACKAGE_LAYOUT_V1 } from './tools-layout';
import {
  parseExportReview,
  parsePlatform,
  parseToolsRepositoryPath,
  type ParsedExportReviewV1,
} from './export-review';
import { buildCapabilitySource, type ParsedFixtureReviewV1 } from './capability-review';
import type { PublicHttpResponseV1 } from '../../consumer/execution/node-http';
import {
  PublicHttpExecutionError,
  executeNodeHttpStrategy,
  type PublicExecutionDiagnosticV1,
} from '../../consumer/execution/node-http';
import { executeBrowserNavigationStrategy } from '../../consumer/execution/public-browser/executor';
import { executeBrowserHttpStrategy } from '../../consumer/execution/public-browser/http-executor';
import { collectStrategyOutcomeSelectors } from '../../consumer/execution/public-browser/outcome-selectors';
import { executeBrowserPageScriptStrategy } from '../../consumer/execution/public-browser/page-script-executor';
import { PublicCallerV1, type PublicCallResultV1 } from '../../consumer/call';
import type {
  PublicHttpStrategyV1,
  PublicBrowserPageScriptStrategyV1,
  PublicReadCapabilityV1,
  PublicToolPackageV1,
} from '../../public/contracts/package';
import { RunStoreV1, type RunArtifactRefV1 } from '../../consumer/scrape/run-store';
import { ScrapeRunServiceV1, type LocalScrapeRunResultV1 } from '../../consumer/scrape/run-service';
import { readCommittedRunItems } from '../../consumer/scrape/result-reader';
import { validateJsonSchema } from '../../public/contracts/json-schema';
import { listPlatformSkills, loadStrategies, type Strategy } from '../../strategies/skills';
import {
  assessPostSaveVerificationProof,
  POST_SAVE_PROOF_ASSESSMENT_KINDS,
} from '../../strategies/post-save-verification-proof';
import {
  compilePublicPackageSource,
  type CompiledPublicPackageV1,
  type PublicPackageSourceV1,
  type PublicReadCapabilitySourceV1,
} from './compiler';
import { createExportTreeManifest, type ExportTreeManifestV1 } from './export-tree';

export const PACKAGE_EXPORT_AUDIT_CODES = {
  invalidExport: 'invalid_export',
  platformNotFound: 'platform_not_found',
  capabilityNotSaved: 'capability_not_saved',
  fixtureCoverageIncomplete: 'fixture_coverage_incomplete',
  strategyNotExportable: 'strategy_not_exportable',
  strategyNotVerified: 'strategy_not_verified',
  strategyVerificationStale: 'strategy_verification_stale',
  smokeFailed: 'smoke_failed',
  targetExists: 'target_exists',
} as const;

export type PackageExportAuditCodeV1 =
  (typeof PACKAGE_EXPORT_AUDIT_CODES)[keyof typeof PACKAGE_EXPORT_AUDIT_CODES];

export interface PackageExportAuditIssueV1 {
  code: PackageExportAuditCodeV1;
  path: string;
  message: string;
  remedy: string;
  diagnostic?: PublicExecutionDiagnosticV1;
}

export type PlatformPackageExportResultV1 =
  | {
      kind: 'package_exported';
      platform: string;
      package_id: PackageIdV1;
      version: PackageVersionV1;
      package_digest: Sha256DigestV1;
      manifest_digest: Sha256DigestV1;
      target_directory: string;
      package_source_path: string;
      registry_path: string;
      fixture_paths: string[];
      export_tree: ExportTreeManifestV1;
      capabilities: CapabilityIdV1[];
      git_changed: false;
      published: false;
    }
  | {
      kind: 'export_audit_failed';
      platform: string;
      package_id: string | null;
      issues: PackageExportAuditIssueV1[];
      files_written: false;
      git_changed: false;
      published: false;
    };

interface SmokeExecutionV1 {
  result: PublicCallResultV1;
  responses: Array<{ strategy_id: StableContractIdV1; response: PublicHttpResponseV1 }>;
  diagnostics: PublicExecutionDiagnosticV1[];
}

interface SmokeRunExecutionV1 {
  result: LocalScrapeRunResultV1;
  items: JsonValueV1[];
  responses: Array<{ strategy_id: StableContractIdV1; response: PublicHttpResponseV1 }>;
  diagnostics: PublicExecutionDiagnosticV1[];
}

interface SmokeRunFixtureV1 {
  input: JsonValueV1;
  caller_bounds: JsonValueV1;
  input_mode_id: StableContractIdV1 | null;
}

interface SmokeRunContextV1 {
  capabilities: PublicToolPackageV1['capabilities'];
  artifact: Omit<RunArtifactRefV1, 'collection_contract_digest'>;
}

export interface PlatformPackageExportDependenciesV1 {
  load_platform_capabilities?: (platform: string) => string[];
  load_strategies?: (platform: string, capability: string) => Strategy[];
  smoke_call?: (
    capability: PublicReadCapabilityV1,
    input: JsonValueV1,
  ) => Promise<SmokeExecutionV1>;
  smoke_run?: (
    capability: PublicReadCapabilityV1,
    fixture: SmokeRunFixtureV1,
    context: SmokeRunContextV1,
  ) => Promise<SmokeRunExecutionV1>;
}

/**
 * Builds one PR-ready tools-repository directory from reviewed local skills.
 * The export stops before git, signing, registry deployment, or activation.
 */
export async function exportPlatformPackageToTools(
  value: unknown,
  dependencies: PlatformPackageExportDependenciesV1 = {},
): Promise<PlatformPackageExportResultV1> {
  let platform = '';
  let packageId: string | null = null;
  try {
    const input = parseExactRecord(value, 'platform_export', [
      'platform',
      'tools_repository_path',
      'review',
    ]);
    platform = parsePlatform(input.platform);
    const repositoryPath = parseToolsRepositoryPath(input.tools_repository_path);
    const review = parseExportReview(input.review);
    packageId = review.package_id;
    const issues = auditPlatformExport(
      platform,
      review,
      repositoryPath,
      dependencies.load_platform_capabilities ?? defaultPlatformCapabilities,
      dependencies.load_strategies ?? loadStrategies,
    );
    if (issues.length > 0) return auditFailure(platform, packageId, issues);

    const built = buildPackageSource(
      platform,
      review,
      dependencies.load_strategies ?? loadStrategies,
    );
    const fixtures = await runSmokeFixtures(
      review,
      built.compiled,
      dependencies.smoke_call ?? smokeCall,
      dependencies.smoke_run ?? smokeRun,
    );
    if (fixtures.issues.length > 0) {
      return auditFailure(platform, packageId, fixtures.issues);
    }
    const written = writeToolsPackage(repositoryPath, review, built, fixtures.files);
    return {
      kind: 'package_exported',
      platform,
      package_id: review.package_id,
      version: review.version,
      package_digest: sha256Digest(built.compiled.bytes),
      manifest_digest: built.compiled.manifest_digest,
      target_directory: written.targetDirectory,
      package_source_path: written.packageSourcePath,
      registry_path: written.registryPath,
      fixture_paths: written.fixturePaths,
      export_tree: written.exportTree,
      capabilities: Object.keys(built.compiled.package.capabilities).sort(
        compareText,
      ) as CapabilityIdV1[],
      git_changed: false,
      published: false,
    };
  } catch (error) {
    const issue =
      error instanceof PublicContractError
        ? {
            code: PACKAGE_EXPORT_AUDIT_CODES.invalidExport,
            path: error.field,
            message: error.message,
            remedy: 'Correct the reviewed contract at this exact path and retry the same export.',
          }
        : {
            code: PACKAGE_EXPORT_AUDIT_CODES.invalidExport,
            path: 'platform_export',
            message: error instanceof Error ? error.message : String(error),
            remedy: 'Correct the export input and retry; no tools-repository files were written.',
          };
    return auditFailure(platform, packageId, [issue]);
  }
}

function auditPlatformExport(
  platform: string,
  review: ParsedExportReviewV1,
  repositoryPath: string,
  loadCapabilities: (platform: string) => string[],
  loadLocalStrategies: (platform: string, capability: string) => Strategy[],
): PackageExportAuditIssueV1[] {
  const issues: PackageExportAuditIssueV1[] = [];
  const saved = loadCapabilities(platform).sort(compareText);
  const reviewed = Object.keys(review.capabilities).sort(compareText);
  if (saved.length === 0) {
    issues.push({
      code: PACKAGE_EXPORT_AUDIT_CODES.platformNotFound,
      path: `skills.${platform}`,
      message: `No active saved capabilities exist for ${platform}.`,
      remedy: 'Finish discovery and post-save verification before exporting the platform.',
    });
    return issues;
  }
  const missingReviewed = reviewed.filter((capability) => !saved.includes(capability));
  if (missingReviewed.length > 0) {
    issues.push({
      code: PACKAGE_EXPORT_AUDIT_CODES.capabilityNotSaved,
      path: 'platform_export.review.capabilities',
      message:
        `Reviewed capabilities ${JSON.stringify(missingReviewed)} are not active saved ` +
        `capabilities. Active capabilities are ${JSON.stringify(saved)}.`,
      remedy: 'Finish and verify every reviewed capability, or remove it from this package review.',
    });
  }
  issues.push(...auditFixtureCoverage(review));
  for (const capability of reviewed) {
    const strategies = loadLocalStrategies(platform, capability);
    // The reviewed block names the tier, so the audit looks for the strategy
    // the maintainer actually reviewed rather than assuming one tier.
    const reviewedTier = review.capabilities[capability]?.http ? 'fetch' : 'page-script';
    const selected = strategies.find((strategy) => strategy.strategy === reviewedTier);
    if (!selected) {
      issues.push({
        code: PACKAGE_EXPORT_AUDIT_CODES.strategyNotExportable,
        path: `skills.${platform}.${capability}`,
        message: `This capability is reviewed as ${reviewedTier}, but no active ${reviewedTier} strategy is saved for it.`,
        remedy: `Save and verify a ${reviewedTier} strategy for this read capability, or review it at the tier that is saved; unsupported tiers remain local.`,
      });
      continue;
    }
    if (selected.runtime_meta?.post_save_validation !== 'passed') {
      issues.push({
        code: PACKAGE_EXPORT_AUDIT_CODES.strategyNotVerified,
        path: `skills.${platform}.${capability}.runtime_meta.post_save_validation`,
        message: `The selected ${reviewedTier} has not passed post-save semantic verification.`,
        remedy:
          'Run the saved capability with grounded sample input and complete its validation checkpoint.',
      });
    } else {
      const proofAssessment = assessPostSaveVerificationProof(
        selected,
        selected.runtime_meta.post_save_verification,
        { platform, capability },
      );
      if (proofAssessment.kind === POST_SAVE_PROOF_ASSESSMENT_KINDS.current) continue;
      issues.push({
        code: PACKAGE_EXPORT_AUDIT_CODES.strategyVerificationStale,
        path: `skills.${platform}.${capability}.runtime_meta.post_save_verification`,
        message: `The selected ${reviewedTier} post-save proof is ${proofAssessment.kind}.`,
        remedy: `Run exact post-save verification for the current ${reviewedTier}; local saving and execution remain available.`,
      });
    }
  }
  const target = path.join(
    repositoryPath,
    TOOLS_PACKAGE_LAYOUT_V1.packagesDirectoryName,
    review.package_id,
  );
  if (fs.existsSync(target)) {
    issues.push({
      code: PACKAGE_EXPORT_AUDIT_CODES.targetExists,
      path: target,
      message: 'The target package directory already exists.',
      remedy:
        'Export a new package ID or use the version-update workflow; create-only export never overwrites reviewed source.',
    });
  }
  return issues;
}

function auditFixtureCoverage(review: ParsedExportReviewV1): PackageExportAuditIssueV1[] {
  const plan = planPackageFixtureCoverage(
    Object.fromEntries(
      Object.entries(review.capabilities).map(([capabilityId, capabilityReview]) => [
        capabilityId,
        { collection: capabilityReview.contract.collection },
      ]),
    ),
  );
  const covered = Object.entries(review.capabilities).flatMap(([capabilityId, capabilityReview]) =>
    capabilityReview.fixtures.map((fixture) => ({
      capability: capabilityId,
      kind: fixture.kind,
    })),
  );
  return assessPackageFixtureCoverage(plan, covered).map((issue) => ({
    code: PACKAGE_EXPORT_AUDIT_CODES.fixtureCoverageIncomplete,
    path: `platform_export.review.capabilities.${issue.capability}.fixtures`,
    message: `Reviewed fixture coverage: ${issue.capability} ${issue.message}.`,
    remedy:
      'Review one grounded call fixture per capability and one run fixture per collection capability; run fixtures are only valid on collection capabilities.',
  }));
}

function buildPackageSource(
  platform: string,
  review: ParsedExportReviewV1,
  loadLocalStrategies: (platform: string, capability: string) => Strategy[],
): { source: PublicPackageSourceV1; compiled: CompiledPublicPackageV1 } {
  const capabilities: Record<string, PublicReadCapabilitySourceV1> = {};
  for (const [capabilityId, capabilityReview] of Object.entries(review.capabilities)) {
    const tier = capabilityReview.http ? 'fetch' : 'page-script';
    const local = loadLocalStrategies(platform, capabilityId).find(
      (strategy) => strategy.strategy === tier,
    );
    if (!local) {
      throw new PublicContractError(
        `skills.${platform}.${capabilityId}`,
        `${tier} disappeared after export audit`,
      );
    }
    capabilities[capabilityId] = buildCapabilitySource(local, capabilityReview);
  }
  const source: PublicPackageSourceV1 = {
    package_source_schema_version: 1,
    package: {
      package_schema_version: 1,
      package_id: review.package_id,
      version: review.version,
      authentication_contracts:
        review.authentication_contracts as PublicPackageSourceV1['package']['authentication_contracts'],
      capabilities: capabilities as PublicPackageSourceV1['package']['capabilities'],
    },
  };
  return { source, compiled: compilePublicPackageSource(source) };
}

async function runSmokeFixtures(
  review: ParsedExportReviewV1,
  compiled: CompiledPublicPackageV1,
  call: NonNullable<PlatformPackageExportDependenciesV1['smoke_call']>,
  run: NonNullable<PlatformPackageExportDependenciesV1['smoke_run']>,
): Promise<{
  issues: PackageExportAuditIssueV1[];
  files: Array<{ name: string; value: unknown }>;
}> {
  const issues: PackageExportAuditIssueV1[] = [];
  const files: Array<{ name: string; value: unknown }> = [];
  for (const [capabilityId, capabilityReview] of Object.entries(review.capabilities)) {
    const capability = compiled.package.capabilities[capabilityId as CapabilityIdV1];
    if (!capability) {
      issues.push({
        code: PACKAGE_EXPORT_AUDIT_CODES.invalidExport,
        path: `platform_export.review.capabilities.${capabilityId}`,
        message: 'Reviewed capability is absent from the compiled package.',
        remedy: 'Correct the reviewed capability contract so it compiles into the package.',
      });
      continue;
    }
    for (const fixture of capabilityReview.fixtures) {
      const fixturePath = `platform_export.review.capabilities.${capabilityId}.fixtures.${fixture.fixture_id}`;
      validateJsonSchema(fixture.input, capability.input_schema, `${fixturePath}.input`);
      const captured =
        fixture.kind === PACKAGE_FIXTURE_KINDS.call
          ? await captureCallFixtureEvidence(
              capability,
              capabilityId,
              fixture,
              review,
              call,
              fixturePath,
            )
          : await captureRunFixtureEvidence(
              capability,
              capabilityId,
              fixture,
              review,
              compiled,
              run,
              fixturePath,
            );
      if ('issue' in captured) {
        issues.push(captured.issue);
        continue;
      }
      const name = packageFixtureFileName(fixture.fixture_id, fixture.kind);
      try {
        parsePublicPackageFixtureBytes(renderJsonFileBytes(captured.value), `fixture ${name}`);
      } catch (error) {
        issues.push({
          code: PACKAGE_EXPORT_AUDIT_CODES.smokeFailed,
          path: fixturePath,
          message: `Captured smoke evidence does not replay as a public fixture: ${
            error instanceof Error ? error.message : String(error)
          }`,
          remedy:
            'Correct the reviewed contract or saved strategy so captured responses fit the public fixture contract, then retry.',
        });
        continue;
      }
      files.push({ name, value: captured.value });
    }
    const ceiling = await proveCollectionCeilings(
      capability,
      capabilityId,
      capabilityReview,
      review,
      compiled,
      run,
    );
    if (ceiling !== null) issues.push(ceiling);
  }
  return { issues, files };
}

/** Runs a collection once to its own declared ceilings. A fixture proves the
 *  recorded page replays; this proves the package can actually reach the item
 *  and page limits it signs, against the live site, without tripping a budget
 *  it declared for itself or emitting an item its own schema rejects. */
async function proveCollectionCeilings(
  capability: PublicReadCapabilityV1,
  capabilityId: string,
  capabilityReview: ParsedExportReviewV1['capabilities'][string],
  review: ParsedExportReviewV1,
  compiled: CompiledPublicPackageV1,
  run: NonNullable<PlatformPackageExportDependenciesV1['smoke_run']>,
): Promise<PackageExportAuditIssueV1 | null> {
  if (capability.collection === null) return null;
  const seed = capabilityReview.fixtures.find(
    (fixture): fixture is Extract<ParsedFixtureReviewV1, { kind: 'run' }> =>
      fixture.kind === PACKAGE_FIXTURE_KINDS.run,
  );
  if (seed === undefined) return null;
  const proofPath = `platform_export.review.capabilities.${capabilityId}.collection.run_policy`;
  const execution = await run(
    capability,
    { input: seed.input, caller_bounds: {}, input_mode_id: seed.input_mode_id },
    {
      capabilities: compiled.package.capabilities,
      artifact: {
        package_id: review.package_id,
        version: review.version,
        package_digest: sha256Digest(compiled.bytes),
        capability: capabilityId as CapabilityIdV1,
        runtime_range: review.registry_manifest.releases[0].runtime_range,
      },
    },
  );
  const result = execution.result;
  const reachedOwnCeiling =
    result.kind === 'scrape_outcome' ||
    (result.kind === 'scrape_partial' && result.stop === 'run_budget_exhausted');
  if (reachedOwnCeiling) return null;
  return {
    code: PACKAGE_EXPORT_AUDIT_CODES.smokeFailed,
    path: proofPath,
    message:
      `Running the collection to its declared ceilings stopped with ${JSON.stringify(result)}; ` +
      'a signed package must reach its own max_items and max_pages on the live site.',
    remedy:
      'Correct the item schema, pagination, or durable budgets this capability declares, then retry the export.',
    ...(execution.diagnostics[0] === undefined ? {} : { diagnostic: execution.diagnostics[0] }),
  };
}

async function captureCallFixtureEvidence(
  capability: PublicReadCapabilityV1,
  capabilityId: string,
  fixture: Extract<ParsedFixtureReviewV1, { kind: typeof PACKAGE_FIXTURE_KINDS.call }>,
  review: ParsedExportReviewV1,
  call: NonNullable<PlatformPackageExportDependenciesV1['smoke_call']>,
  fixturePath: string,
): Promise<{ value: unknown } | { issue: PackageExportAuditIssueV1 }> {
  const execution = await call(capability, fixture.input);
  if (execution.result.kind !== 'outcome' || execution.result.outcome_class !== 'success') {
    return { issue: smokeFailedIssue(fixturePath, execution.result, execution.diagnostics[0]) };
  }
  return {
    value: {
      fixture_schema_version: PACKAGE_FIXTURE_SCHEMA_VERSION,
      kind: PACKAGE_FIXTURE_KINDS.call,
      version: review.version,
      capability: capabilityId,
      input: fixture.input,
      responses: canonicalSmokeResponses(execution.responses, [capability]),
      expected: { result: execution.result },
      caller_bounds: null,
      input_mode_id: null,
    },
  };
}

async function captureRunFixtureEvidence(
  capability: PublicReadCapabilityV1,
  capabilityId: string,
  fixture: Extract<ParsedFixtureReviewV1, { kind: typeof PACKAGE_FIXTURE_KINDS.run }>,
  review: ParsedExportReviewV1,
  compiled: CompiledPublicPackageV1,
  run: NonNullable<PlatformPackageExportDependenciesV1['smoke_run']>,
  fixturePath: string,
): Promise<{ value: unknown } | { issue: PackageExportAuditIssueV1 }> {
  const execution = await run(
    capability,
    {
      input: fixture.input,
      caller_bounds: fixture.caller_bounds,
      input_mode_id: fixture.input_mode_id,
    },
    {
      capabilities: compiled.package.capabilities,
      artifact: {
        package_id: review.package_id,
        version: review.version,
        package_digest: sha256Digest(compiled.bytes),
        capability: capabilityId as CapabilityIdV1,
        runtime_range: review.registry_manifest.releases[0].runtime_range,
      },
    },
  );
  if (execution.result.kind !== 'scrape_outcome') {
    return { issue: smokeFailedIssue(fixturePath, execution.result, execution.diagnostics[0]) };
  }
  const expectedResult: Record<string, unknown> = { ...execution.result };
  delete expectedResult.run_id;
  return {
    value: {
      fixture_schema_version: PACKAGE_FIXTURE_SCHEMA_VERSION,
      kind: PACKAGE_FIXTURE_KINDS.run,
      version: review.version,
      capability: capabilityId,
      input: fixture.input,
      responses: canonicalSmokeResponses(
        execution.responses,
        Object.values(compiled.package.capabilities),
      ),
      expected: { result: expectedResult, items: execution.items },
      caller_bounds: fixture.caller_bounds,
      input_mode_id: fixture.input_mode_id,
    },
  };
}

function smokeFailedIssue(
  fixturePath: string,
  result: unknown,
  diagnostic: PublicExecutionDiagnosticV1 | undefined,
): PackageExportAuditIssueV1 {
  return {
    code: PACKAGE_EXPORT_AUDIT_CODES.smokeFailed,
    path: fixturePath,
    message: `Consumer smoke returned ${JSON.stringify(result)}.`,
    remedy: diagnostic
      ? 'Add or correct the exact reviewed egress rule described by diagnostic, then retry.'
      : 'Correct the typed outcome, request budget, or saved strategy and retry.',
    ...(diagnostic === undefined ? {} : { diagnostic }),
  };
}

function canonicalSmokeResponses(
  responses: Array<{ strategy_id: StableContractIdV1; response: PublicHttpResponseV1 }>,
  capabilities: readonly PublicReadCapabilityV1[],
): Array<{
  strategy_id: StableContractIdV1;
  response: Omit<PublicHttpResponseV1, 'html_selector_exists'> & {
    selector_matches?: Record<string, boolean>;
  };
}> {
  return responses.map((entry) => {
    const selectorMatches = recordedSelectorMatches(entry, capabilities);
    return {
      strategy_id: entry.strategy_id,
      response: {
        status: entry.response.status,
        headers: entry.response.headers,
        media_type: entry.response.media_type,
        body_kind: entry.response.body_kind,
        body: entry.response.body,
        target_requests: entry.response.target_requests,
        ...(selectorMatches === undefined ? {} : { selector_matches: selectorMatches }),
      },
    };
  });
}

/**
 * Serializes the page evaluations behind a live response's
 * `html_selector_exists` callback into fixture evidence. The selector set is
 * derived structurally from the outcome cases bound to the responding
 * strategy — the same set the live executor evaluated — so fixture replay
 * resolves every selector matcher the outcome evaluation can query.
 */
function recordedSelectorMatches(
  entry: { strategy_id: StableContractIdV1; response: PublicHttpResponseV1 },
  capabilities: readonly PublicReadCapabilityV1[],
): Record<string, boolean> | undefined {
  const evaluate = entry.response.html_selector_exists;
  if (evaluate === undefined) return undefined;
  const selectors = new Set<string>();
  for (const capability of capabilities) {
    for (const selector of collectStrategyOutcomeSelectors(capability, entry.strategy_id)) {
      selectors.add(selector);
    }
  }
  if (selectors.size === 0) return undefined;
  const matches: Record<string, boolean> = {};
  for (const selector of [...selectors].sort(compareText)) {
    matches[selector] = evaluate(selector);
  }
  return matches;
}

async function smokeCall(
  capability: PublicReadCapabilityV1,
  input: JsonValueV1,
): Promise<SmokeExecutionV1> {
  const responses: SmokeExecutionV1['responses'] = [];
  const diagnostics: PublicExecutionDiagnosticV1[] = [];
  const pageScriptExecutor = async (
    target: PublicReadCapabilityV1,
    strategy: PublicBrowserPageScriptStrategyV1,
    options: Parameters<typeof executeBrowserPageScriptStrategy>[2],
  ): Promise<PublicHttpResponseV1> => {
    try {
      const response = await executeBrowserPageScriptStrategy(target, strategy, options);
      responses.push({ strategy_id: strategy.strategy_id, response });
      return response;
    } catch (error) {
      if (error instanceof PublicHttpExecutionError && error.diagnostic !== null) {
        diagnostics.push(error.diagnostic);
      }
      throw error;
    }
  };
  const caller = new PublicCallerV1(
    recordingHttpExecutor(executeNodeHttpStrategy, responses, diagnostics),
    Math.random,
    executeBrowserNavigationStrategy,
    recordingHttpExecutor(executeBrowserHttpStrategy, responses, diagnostics),
    pageScriptExecutor,
  );
  return { result: await caller.call(capability, input), responses, diagnostics };
}

/** Wraps an http executor so every response it produces — projected exactly as
 *  the outcome contracts will see it — is captured as fixture evidence. */
function recordingHttpExecutor<Options>(
  execute: (
    target: PublicReadCapabilityV1,
    strategy: PublicHttpStrategyV1,
    options: Options,
  ) => Promise<PublicHttpResponseV1>,
  responses: Array<{ strategy_id: StableContractIdV1; response: PublicHttpResponseV1 }>,
  diagnostics: PublicExecutionDiagnosticV1[],
): (
  target: PublicReadCapabilityV1,
  strategy: PublicHttpStrategyV1,
  options: Options,
) => Promise<PublicHttpResponseV1> {
  return async (target, strategy, options) => {
    try {
      const response = await execute(target, strategy, options);
      responses.push({ strategy_id: strategy.request.strategy_id, response });
      return response;
    } catch (error) {
      if (error instanceof PublicHttpExecutionError && error.diagnostic !== null) {
        diagnostics.push(error.diagnostic);
      }
      throw error;
    }
  };
}

async function smokeRun(
  capability: PublicReadCapabilityV1,
  fixture: SmokeRunFixtureV1,
  context: SmokeRunContextV1,
): Promise<SmokeRunExecutionV1> {
  const responses: SmokeRunExecutionV1['responses'] = [];
  const diagnostics: PublicExecutionDiagnosticV1[] = [];
  // Target executions are serialized so the recorded response order replays
  // deterministically through the tools repository's order-sensitive queue.
  let chain: Promise<unknown> = Promise.resolve();
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const next = chain.then(task, task);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  const pageScriptExecutor = (
    target: PublicReadCapabilityV1,
    strategy: PublicBrowserPageScriptStrategyV1,
    options: Parameters<typeof executeBrowserPageScriptStrategy>[2],
  ): Promise<PublicHttpResponseV1> =>
    serialize(async () => {
      try {
        const response = await executeBrowserPageScriptStrategy(target, strategy, options);
        responses.push({ strategy_id: strategy.strategy_id, response });
        return response;
      } catch (error) {
        if (error instanceof PublicHttpExecutionError && error.diagnostic !== null) {
          diagnostics.push(error.diagnostic);
        }
        throw error;
      }
    });
  const serializedHttp = <Options>(
    execute: (
      target: PublicReadCapabilityV1,
      strategy: PublicHttpStrategyV1,
      options: Options,
    ) => Promise<PublicHttpResponseV1>,
  ) => {
    const recording = recordingHttpExecutor(execute, responses, diagnostics);
    return (target: PublicReadCapabilityV1, strategy: PublicHttpStrategyV1, options: Options) =>
      serialize(() => recording(target, strategy, options));
  };
  const caller = new PublicCallerV1(
    serializedHttp(executeNodeHttpStrategy),
    Math.random,
    executeBrowserNavigationStrategy,
    serializedHttp(executeBrowserHttpStrategy),
    pageScriptExecutor,
  );
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-export-run-smoke-'));
  try {
    const store = new RunStoreV1(home);
    const service = new ScrapeRunServiceV1(store, caller);
    const result = await service.start({
      artifact: context.artifact,
      owner: capability,
      capabilities: context.capabilities,
      input: fixture.input,
      caller_bounds: fixture.caller_bounds,
      ...(fixture.input_mode_id === null ? {} : { input_mode_id: fixture.input_mode_id }),
      output: {
        kind: 'file',
        requested_path: path.join(home, 'smoke-output.ndjson'),
        format: 'ndjson',
      },
    });
    const items =
      result.kind === 'scrape_outcome' ? readCommittedRunItems(store, result.run_id) : [];
    return { result, items, responses, diagnostics };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function writeToolsPackage(
  repositoryPath: string,
  review: ParsedExportReviewV1,
  built: { source: PublicPackageSourceV1; compiled: CompiledPublicPackageV1 },
  fixtures: Array<{ name: string; value: unknown }>,
): {
  targetDirectory: string;
  packageSourcePath: string;
  registryPath: string;
  fixturePaths: string[];
  exportTree: ExportTreeManifestV1;
} {
  const packagesRoot = path.join(repositoryPath, TOOLS_PACKAGE_LAYOUT_V1.packagesDirectoryName);
  const targetDirectory = path.join(packagesRoot, review.package_id);
  const staging = fs.mkdtempSync(path.join(packagesRoot, `.klura-export-${review.package_id}-`));
  const sortedFixtures = [...fixtures].sort((left, right) => compareText(left.name, right.name));
  let exportTree!: ExportTreeManifestV1;
  try {
    const fixturesDirectory = path.join(staging, TOOLS_PACKAGE_LAYOUT_V1.fixturesDirectoryName);
    fs.mkdirSync(fixturesDirectory, { mode: 0o755 });
    writeJson(path.join(staging, TOOLS_PACKAGE_LAYOUT_V1.packageSourceFileName), built.source);
    writeJson(
      path.join(staging, TOOLS_PACKAGE_LAYOUT_V1.registryManifestFileName),
      review.registry_manifest,
    );
    for (const fixture of sortedFixtures) {
      writeJson(path.join(fixturesDirectory, fixture.name), fixture.value);
    }
    exportTree = createExportTreeManifest(staging);
    fs.renameSync(staging, targetDirectory);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return {
    targetDirectory,
    packageSourcePath: path.join(targetDirectory, TOOLS_PACKAGE_LAYOUT_V1.packageSourceFileName),
    registryPath: path.join(targetDirectory, TOOLS_PACKAGE_LAYOUT_V1.registryManifestFileName),
    fixturePaths: sortedFixtures.map((fixture) =>
      path.join(targetDirectory, TOOLS_PACKAGE_LAYOUT_V1.fixturesDirectoryName, fixture.name),
    ),
    exportTree,
  };
}

function renderJsonFileBytes(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, renderJsonFileBytes(value), {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o644,
  });
}

function defaultPlatformCapabilities(platform: string): string[] {
  return (
    listPlatformSkills()
      .find((entry) => entry.platform === platform)
      ?.capabilities.map((capability) => capability.name) ?? []
  );
}

function auditFailure(
  platform: string,
  packageId: string | null,
  issues: PackageExportAuditIssueV1[],
): PlatformPackageExportResultV1 {
  return {
    kind: 'export_audit_failed',
    platform,
    package_id: packageId,
    issues,
    files_written: false,
    git_changed: false,
    published: false,
  };
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

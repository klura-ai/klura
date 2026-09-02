// Installs a locally authored platform skill as an unsigned, locally
// provenanced package in the consumer package store. Structurally parallel to
// `exportPlatformPackageToTools`: parse the reviewed input, audit it against
// the saved skills, project it onto a package source, compile it through the
// same `compilePublicPackageSource` gate the export path uses, persist the
// canonical source, then activate the artifact.
//
// Execution safety is byte-identical to the export path, because it is the
// same compiler and the same `parsePublicToolPackage` contract. What this path
// skips is distribution trust — signature, index validity, download digest,
// signed projection, release state — all of which describe a publisher this
// path does not have.
import path from 'node:path';
import {
  localPackageIdForPlatform,
  parseBoundedRecord,
  parseExactRecord,
  parsePackageVersion,
  parseStableContractId,
  PublicContractError,
  sha256Digest,
  type CapabilityIdV1,
  type PackageIdV1,
  type PackageVersionV1,
  type Sha256DigestV1,
} from '../../public/contracts/common';
import { canonicalJson, type JsonValueV1 } from '../../public/contracts/json';
import { readConsumerRuntimeVersion } from '../../consumer/runtime-version';
import {
  LocalPackageInstallError,
  LocalPackageInstallerV1,
  type InstallLocalPackageResultV1,
  type LocalPackageInstallInputV1,
} from '../../consumer/local-package';
import { PackageStoreV1 } from '../../consumer/store/package-store';
import { SKILLS_DIR } from '../../paths';
import {
  withCapabilityMutationLock,
  writeJsonAtomically,
} from '../../strategies/capability-mutation';
import { listPlatformSkills, loadStrategies, type Strategy } from '../../strategies/skills';
import {
  assessPostSaveVerificationProof,
  POST_SAVE_PROOF_ASSESSMENT_KINDS,
} from '../../strategies/post-save-verification-proof';
import { asPlatformSlug, ValidationError } from '../../validators';
import { TOOL_NAMES } from '../../vocab';
import {
  buildCapabilitySource,
  CAPABILITY_CONTRACT_KEYS,
  PAGE_SCRIPT_REVIEW_KEYS,
  type ParsedCapabilityReviewV1,
} from './capability-review';
import {
  compilePublicPackageSource,
  type CompiledPublicPackageV1,
  type PublicPackageSourceV1,
  type PublicReadCapabilitySourceV1,
} from './compiler';

/** Input field prefix every rejection from this path is rooted at. */
export const LOCAL_INSTALL_FIELD_V1 = 'install_local_package';

const LOCAL_INSTALL_CAPABILITIES_FIELD = `${LOCAL_INSTALL_FIELD_V1}.capabilities`;

/** File name of the canonical reviewed source under the platform's skill
 *  directory. Its canonical-JSON digest is the artifact's local provenance. */
export const LOCAL_PACKAGE_SOURCE_FILE_NAME_V1 = 'local-package.json';

/**
 * Lock key for the platform-level source file. Capability names are
 * snake_case, so this dashed name addresses the platform's package source
 * without colliding with any capability's own mutation lock.
 */
const LOCAL_PACKAGE_LOCK_KEY_V1 = 'local-package';

export const LOCAL_PACKAGE_AUDIT_CODES = {
  invalidInstall: 'invalid_install',
  platformNotFound: 'platform_not_found',
  capabilityNotSaved: 'capability_not_saved',
  strategyNotInstallable: 'strategy_not_installable',
  packageNotCompilable: 'package_not_compilable',
  installRejected: 'install_rejected',
} as const;

export type LocalPackageAuditCodeV1 =
  (typeof LOCAL_PACKAGE_AUDIT_CODES)[keyof typeof LOCAL_PACKAGE_AUDIT_CODES];

export interface LocalPackageAuditIssueV1 {
  code: LocalPackageAuditCodeV1;
  path: string;
  message: string;
  remedy: string;
}

export type LocalPackageInstallResultV1 =
  | {
      kind: 'local_package_installed';
      platform: string;
      package_id: PackageIdV1;
      version: PackageVersionV1;
      action: InstallLocalPackageResultV1['action'];
      package_digest: Sha256DigestV1;
      manifest_digest: Sha256DigestV1;
      source_digest: Sha256DigestV1;
      source_path: string;
      capabilities: CapabilityIdV1[];
      signed: false;
      published: false;
      _hint?: string;
    }
  | {
      kind: 'local_package_audit_failed';
      platform: string;
      package_id: string | null;
      issues: LocalPackageAuditIssueV1[];
      installed: false;
      signed: false;
      published: false;
    };

export interface LocalPackageInstallDependenciesV1 {
  load_platform_capabilities?: (platform: string) => string[];
  load_strategies?: (platform: string, capability: string) => Strategy[];
  install?: (input: LocalPackageInstallInputV1) => InstallLocalPackageResultV1;
  /** Persists the canonical reviewed source and returns its absolute path. */
  write_source?: (platform: string, source: PublicPackageSourceV1) => string;
}

interface ParsedLocalInstallV1 {
  platform: string;
  package_id: PackageIdV1;
  version: PackageVersionV1;
  authentication_contracts: Record<string, unknown>;
  capabilities: Record<string, Pick<ParsedCapabilityReviewV1, 'contract' | 'page_script'>>;
}

/**
 * Turns the reviewed subset of a platform's active saved capabilities into an
 * installed local package. The reviewed contract is the same one the export
 * path reviews minus its distribution fields: no tools repository, no catalog,
 * no fixtures. The package id is derived as `local-<platform>`, never authored.
 */
export function installLocalPlatformPackage(
  value: unknown,
  dependencies: LocalPackageInstallDependenciesV1 = {},
): LocalPackageInstallResultV1 {
  let platform = '';
  let packageId: string | null = null;
  try {
    const input = parseLocalInstall(value);
    platform = input.platform;
    packageId = input.package_id;
    const audit = auditLocalInstall(
      input,
      dependencies.load_platform_capabilities ?? defaultPlatformCapabilities,
      dependencies.load_strategies ?? loadStrategies,
    );
    if (audit.issues.length > 0) return auditFailure(platform, packageId, audit.issues);

    const source = buildPackageSource(input, dependencies.load_strategies ?? loadStrategies);
    let compiled: CompiledPublicPackageV1;
    try {
      compiled = compilePublicPackageSource(source);
    } catch (error) {
      return auditFailure(platform, packageId, [
        {
          code: LOCAL_PACKAGE_AUDIT_CODES.packageNotCompilable,
          path: error instanceof PublicContractError ? error.field : LOCAL_INSTALL_FIELD_V1,
          message: errorMessage(error),
          remedy:
            'Correct the reviewed contract at this exact path. This is the same structural gate a signed package passes; nothing is relaxed for a local package.',
        },
      ]);
    }

    const sourcePath = (dependencies.write_source ?? writeLocalPackageSource)(platform, source);
    const sourceDigest = sha256Digest(canonicalJson(source as unknown as JsonValueV1));
    let installed: InstallLocalPackageResultV1;
    try {
      installed = (dependencies.install ?? defaultInstall)({
        package_id: input.package_id,
        bytes: compiled.bytes,
        source_digest: sourceDigest,
      });
    } catch (error) {
      return auditFailure(platform, packageId, [
        {
          code: LOCAL_PACKAGE_AUDIT_CODES.installRejected,
          path:
            error instanceof LocalPackageInstallError
              ? `${LOCAL_INSTALL_FIELD_V1}.${error.code}`
              : LOCAL_INSTALL_FIELD_V1,
          message: errorMessage(error),
          remedy: `Correct the reported local state and retry; the reviewed source remains at ${sourcePath}.`,
        },
      ]);
    }
    const hint = verificationHint(audit.verification_notices);
    return {
      kind: 'local_package_installed',
      platform,
      package_id: installed.artifact.package_id,
      version: installed.artifact.version,
      action: installed.action,
      package_digest: installed.artifact.package_digest,
      manifest_digest: installed.artifact.manifest_digest,
      source_digest: sourceDigest,
      source_path: sourcePath,
      capabilities: Object.keys(compiled.package.capabilities).sort(
        compareText,
      ) as CapabilityIdV1[],
      signed: false,
      published: false,
      ...(hint === null ? {} : { _hint: hint }),
    };
  } catch (error) {
    return auditFailure(platform, packageId, [
      {
        code: LOCAL_PACKAGE_AUDIT_CODES.invalidInstall,
        path: error instanceof PublicContractError ? error.field : LOCAL_INSTALL_FIELD_V1,
        message: errorMessage(error),
        remedy: 'Correct the reviewed input at this exact path and retry; nothing was installed.',
      },
    ]);
  }
}

function parseLocalInstall(value: unknown): ParsedLocalInstallV1 {
  const input = parseExactRecord(value, LOCAL_INSTALL_FIELD_V1, [
    'platform',
    'version',
    'authentication_contracts',
    'capabilities',
  ]);
  const platform = parsePlatformSlug(input.platform);
  // Derived, never authored: an authored id could name a package this runtime
  // cannot resolve, which would strand an interrupted run.
  const packageId = localPackageIdForPlatform(platform, `${LOCAL_INSTALL_FIELD_V1}.platform`);
  const rawCapabilities = parseBoundedRecord(
    input.capabilities,
    LOCAL_INSTALL_CAPABILITIES_FIELD,
    32,
  );
  if (Object.keys(rawCapabilities).length === 0) {
    throw new PublicContractError(
      LOCAL_INSTALL_CAPABILITIES_FIELD,
      'must contain at least one reviewed capability',
    );
  }
  const capabilities: ParsedLocalInstallV1['capabilities'] = {};
  for (const [capabilityId, capabilityValue] of Object.entries(rawCapabilities)) {
    capabilities[capabilityId] = parseReviewedCapability(capabilityValue, capabilityId);
  }
  return {
    platform,
    package_id: packageId,
    version: parsePackageVersion(input.version, `${LOCAL_INSTALL_FIELD_V1}.version`),
    authentication_contracts: parseBoundedRecord(
      input.authentication_contracts,
      `${LOCAL_INSTALL_FIELD_V1}.authentication_contracts`,
      32,
    ),
    capabilities,
  };
}

/**
 * Validates one reviewed capability's two leaves against the shared key sets.
 * The local path carries no fixtures — a fixture is captured smoke evidence
 * for a package a maintainer will publish — so it parses the same `contract`
 * and `page_script` key sets the export review parses and hands the result to
 * the shared `buildCapabilitySource`.
 */
function parseReviewedCapability(
  value: unknown,
  capabilityId: string,
): Pick<ParsedCapabilityReviewV1, 'contract' | 'page_script'> {
  const field = `${LOCAL_INSTALL_CAPABILITIES_FIELD}.${capabilityId}`;
  const review = parseExactRecord(value, field, ['contract', 'page_script']);
  const contract = parseExactRecord(review.contract, `${field}.contract`, CAPABILITY_CONTRACT_KEYS);
  const pageScript = parseExactRecord(
    review.page_script,
    `${field}.page_script`,
    PAGE_SCRIPT_REVIEW_KEYS,
  );
  if (pageScript.tier !== 'page-script') {
    throw new PublicContractError(`${field}.page_script.tier`, 'must be page-script');
  }
  return {
    contract: contract as unknown as Omit<PublicReadCapabilitySourceV1, 'strategies'>,
    page_script: {
      tier: 'page-script',
      strategy_id: parseStableContractId(
        pageScript.strategy_id,
        `${field}.page_script.strategy_id`,
      ),
      wait: pageScript.wait,
      interaction: pageScript.interaction,
      expect: pageScript.expect,
      request_body_limits: pageScript.request_body_limits,
      replay: pageScript.replay,
    },
  };
}

function parsePlatformSlug(value: unknown): string {
  try {
    return asPlatformSlug(value, 'platform');
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new PublicContractError(`${LOCAL_INSTALL_FIELD_V1}.platform`, error.message);
    }
    throw error;
  }
}

interface LocalInstallAuditV1 {
  issues: LocalPackageAuditIssueV1[];
  /** Advisory post-save verification observations, surfaced as one `_hint`. */
  verification_notices: string[];
}

/**
 * Blocking structure only: every reviewed capability must be an active saved
 * capability with a page-script strategy. Post-save semantic verification is
 * observed but advisory — the run this package exists to perform is itself the
 * verification, bounded by the collection's run policy, the caller's bounds,
 * and the origin scheduler.
 */
function auditLocalInstall(
  input: ParsedLocalInstallV1,
  loadCapabilities: (platform: string) => string[],
  loadLocalStrategies: (platform: string, capability: string) => Strategy[],
): LocalInstallAuditV1 {
  const issues: LocalPackageAuditIssueV1[] = [];
  const verificationNotices: string[] = [];
  const saved = loadCapabilities(input.platform).sort(compareText);
  const reviewed = Object.keys(input.capabilities).sort(compareText);
  if (saved.length === 0) {
    issues.push({
      code: LOCAL_PACKAGE_AUDIT_CODES.platformNotFound,
      path: `skills.${input.platform}`,
      message: `No active saved capabilities exist for ${input.platform}.`,
      remedy: `Finish discovery and save a strategy before installing the platform; ${TOOL_NAMES.listPlatformSkills} lists what is active.`,
    });
    return { issues, verification_notices: verificationNotices };
  }
  const missingReviewed = reviewed.filter((capability) => !saved.includes(capability));
  if (missingReviewed.length > 0) {
    issues.push({
      code: LOCAL_PACKAGE_AUDIT_CODES.capabilityNotSaved,
      path: LOCAL_INSTALL_CAPABILITIES_FIELD,
      message:
        `Reviewed capabilities ${JSON.stringify(missingReviewed)} are not active saved ` +
        `capabilities. Active capabilities are ${JSON.stringify(saved)}.`,
      remedy: 'Save every reviewed capability, or remove it from this local package.',
    });
  }
  for (const capability of reviewed) {
    const pageScript = loadLocalStrategies(input.platform, capability).find(
      (strategy) => strategy.strategy === 'page-script',
    );
    if (!pageScript) {
      issues.push({
        code: LOCAL_PACKAGE_AUDIT_CODES.strategyNotInstallable,
        path: `skills.${input.platform}.${capability}`,
        message: 'A local package capability requires an active page-script strategy.',
        remedy:
          'Save a page-script strategy for this read capability; other tiers remain local-only.',
      });
      continue;
    }
    verificationNotices.push(...verificationNotice(input.platform, capability, pageScript));
  }
  return { issues, verification_notices: verificationNotices };
}

function verificationNotice(platform: string, capability: string, strategy: Strategy): string[] {
  if (strategy.runtime_meta?.post_save_validation !== 'passed') {
    return [`${capability} has not passed post-save semantic verification`];
  }
  const assessment = assessPostSaveVerificationProof(
    strategy,
    strategy.runtime_meta.post_save_verification,
    { platform, capability },
  );
  if (assessment.kind === POST_SAVE_PROOF_ASSESSMENT_KINDS.current) return [];
  return [`${capability} post-save proof is ${assessment.kind}`];
}

function verificationHint(notices: string[]): string | null {
  if (notices.length === 0) return null;
  return (
    `Installed without a current post-save proof for: ${notices.join('; ')}. ` +
    `A local package is not published, so this is advisory — the run itself verifies it. ` +
    `Read the first committed items with ${TOOL_NAMES.listScrapeRunItems} before trusting the output.`
  );
}

function buildPackageSource(
  input: ParsedLocalInstallV1,
  loadLocalStrategies: (platform: string, capability: string) => Strategy[],
): PublicPackageSourceV1 {
  const capabilities: Record<string, PublicReadCapabilitySourceV1> = {};
  for (const [capabilityId, capabilityReview] of Object.entries(input.capabilities)) {
    const local = loadLocalStrategies(input.platform, capabilityId).find(
      (strategy) => strategy.strategy === 'page-script',
    );
    if (!local) {
      throw new PublicContractError(
        `skills.${input.platform}.${capabilityId}`,
        'page-script disappeared after the install audit',
      );
    }
    capabilities[capabilityId] = buildCapabilitySource(local, capabilityReview);
  }
  return {
    package_source_schema_version: 1,
    package: {
      package_schema_version: 1,
      package_id: input.package_id,
      version: input.version,
      authentication_contracts:
        input.authentication_contracts as PublicPackageSourceV1['package']['authentication_contracts'],
      capabilities: capabilities as PublicPackageSourceV1['package']['capabilities'],
    },
  };
}

/** Absolute path of one platform's canonical reviewed package source. */
export function localPackageSourcePath(platform: string): string {
  return path.join(SKILLS_DIR, platform, LOCAL_PACKAGE_SOURCE_FILE_NAME_V1);
}

function writeLocalPackageSource(platform: string, source: PublicPackageSourceV1): string {
  const filePath = localPackageSourcePath(platform);
  withCapabilityMutationLock(platform, LOCAL_PACKAGE_LOCK_KEY_V1, () => {
    writeJsonAtomically(filePath, source);
  });
  return filePath;
}

function defaultInstall(input: LocalPackageInstallInputV1): InstallLocalPackageResultV1 {
  return new LocalPackageInstallerV1(new PackageStoreV1(), readConsumerRuntimeVersion()).install(
    input,
  );
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
  issues: LocalPackageAuditIssueV1[],
): LocalPackageInstallResultV1 {
  return {
    kind: 'local_package_audit_failed',
    platform,
    package_id: packageId,
    issues,
    installed: false,
    signed: false,
    published: false,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

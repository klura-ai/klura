import { parsePackageId } from '../../public/contracts/common';
import { parsePackageFixtureFileName } from '../../public/contracts/fixture';
import {
  PACKAGE_SOURCE_FILE_NAME,
  parseRegistryReleaseSourcePath,
  RELEASES_DIRECTORY_NAME,
} from '../../public/contracts/registry-catalog';

/**
 * Tools-repository package layout contract.
 *
 * One `tools/<package_id>/` directory holds exactly the reviewable package
 * files: the stable package source, the registry catalog manifest, replayable
 * fixtures, and immutable per-version release sources. The platform exporter
 * writes this layout; the PR path gate, the static registry builder, the
 * fixture verifier, and the bench export reviewer all read it through these
 * constants and predicates so the tree grammar has a single owner.
 */
export const TOOLS_PACKAGE_LAYOUT_V1 = {
  packagesDirectoryName: 'tools',
  packageSourceFileName: PACKAGE_SOURCE_FILE_NAME,
  registryManifestFileName: 'registry.json',
  fixturesDirectoryName: 'fixtures',
  releasesDirectoryName: RELEASES_DIRECTORY_NAME,
} as const;

export type ToolsPackageLayoutV1 = typeof TOOLS_PACKAGE_LAYOUT_V1;

/**
 * True when one package-relative POSIX path names a reviewable tools-package
 * file: the registry manifest, a stable or immutable release source, or a
 * canonically named fixture.
 */
export function isAllowedToolsPackageFile(relativePath: string): boolean {
  if (typeof relativePath !== 'string') return false;
  if (relativePath === TOOLS_PACKAGE_LAYOUT_V1.registryManifestFileName) return true;
  if (
    parsesWithoutError(() => parseRegistryReleaseSourcePath(relativePath, 'tools_package_file'))
  ) {
    return true;
  }
  const segments = relativePath.split('/');
  return (
    segments.length === 2 &&
    segments[0] === TOOLS_PACKAGE_LAYOUT_V1.fixturesDirectoryName &&
    parsesWithoutError(() =>
      parsePackageFixtureFileName(segments[1], 'tools_package_file.fixture_name'),
    )
  );
}

/**
 * True when one repository-relative POSIX path may change in a tools pull
 * request: `tools/<package_id>/` followed by an allowed package file.
 */
export function isAllowedToolsRepositoryPath(file: string): boolean {
  if (typeof file !== 'string') return false;
  const segments = file.split('/');
  if (segments.length < 3 || segments[0] !== TOOLS_PACKAGE_LAYOUT_V1.packagesDirectoryName) {
    return false;
  }
  if (!parsesWithoutError(() => parsePackageId(segments[1], 'tools_package_path.package_id'))) {
    return false;
  }
  return isAllowedToolsPackageFile(segments.slice(2).join('/'));
}

function parsesWithoutError(parse: () => unknown): boolean {
  try {
    parse();
    return true;
  } catch {
    return false;
  }
}

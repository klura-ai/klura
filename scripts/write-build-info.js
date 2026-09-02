'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BUILD_INFO_SCHEMA_VERSION = 1;
const BUILD_INFO_RELATIVE_PATH = path.join('dist', 'build-info.json');
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

class RuntimeBuildIntegrityError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RuntimeBuildIntegrityError';
    this.code = code;
    Object.assign(this, details);
  }
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function portableRelative(root, absolute) {
  return path.relative(root, absolute).split(path.sep).join('/');
}

function collectFiles(root, relativeDir, accepts) {
  const absoluteDir = path.join(root, relativeDir);
  if (!fs.existsSync(absoluteDir)) return [];
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile() && accepts(absolute)) {
        files.push(absolute);
      }
    }
  };
  visit(absoluteDir);
  return files;
}

function existingFiles(root, relatives) {
  return relatives
    .map((relative) => path.join(root, relative))
    .filter((absolute) => fs.existsSync(absolute) && fs.statSync(absolute).isFile());
}

function uniqueSortedEntries(entries) {
  const byRelative = new Map();
  for (const entry of entries) {
    byRelative.set(entry.relative, entry.absolute);
  }
  return [...byRelative.entries()]
    .sort(([left], [right]) => comparePaths(left, right))
    .map(([relative, absolute]) => ({ relative, absolute }));
}

function digestEntries(entries, domain) {
  const hash = crypto.createHash('sha256');
  hash.update(`${domain}\0`);
  for (const { relative, absolute } of uniqueSortedEntries(entries)) {
    const content = fs.readFileSync(absolute);
    hash.update(relative);
    hash.update('\0');
    hash.update(String(content.byteLength));
    hash.update('\0');
    hash.update(content);
  }
  return hash.digest('hex');
}

function digestFiles(root, files, domain) {
  return digestEntries(
    files.map((absolute) => ({ relative: portableRelative(root, absolute), absolute })),
    domain,
  );
}

function collectDirectRuntimeFiles(runtimeRoot) {
  return [
    ...existingFiles(runtimeRoot, [
      'package.json',
      'mcp-server.js',
      'consumer.js',
      'consumer.d.ts',
      'factory-compiler.js',
      'factory-compiler.d.ts',
      'SKILL.md',
      'REFERENCE.md',
      'scripts/build-staged.js',
      'scripts/write-build-info.js',
    ]),
    ...collectFiles(runtimeRoot, 'bin', (file) => file.endsWith('.js')),
    ...collectFiles(runtimeRoot, 'agent', (file) => file.endsWith('.js')),
  ];
}

function collectSourceFiles(runtimeRoot) {
  const sourceRoot = path.join(runtimeRoot, 'src');
  if (!fs.existsSync(sourceRoot)) return null;
  return [
    ...collectFiles(runtimeRoot, 'src', (file) => file.endsWith('.ts')),
    ...existingFiles(runtimeRoot, ['tsconfig.json']),
    ...collectDirectRuntimeFiles(runtimeRoot),
  ];
}

function collectCompiledArtifactFiles(artifactDirectory) {
  return collectFiles(
    artifactDirectory,
    '.',
    (file) => file.endsWith('.js') || file.endsWith('.d.ts'),
  );
}

function readPackageVersion(runtimeRoot) {
  const packagePath = path.join(runtimeRoot, 'package.json');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  } catch (error) {
    throw new RuntimeBuildIntegrityError(
      'runtime_build_invalid',
      `runtime_build_invalid: cannot read ${packagePath}.`,
      { cause: error },
    );
  }
  if (!parsed || typeof parsed.version !== 'string' || parsed.version.length === 0) {
    throw new RuntimeBuildIntegrityError(
      'runtime_build_invalid',
      'runtime_build_invalid: package.json does not contain a runtime version.',
    );
  }
  return parsed.version;
}

function computeSourceDigest(runtimeRoot) {
  const sourceFiles = collectSourceFiles(runtimeRoot);
  if (sourceFiles === null) return null;
  return digestFiles(runtimeRoot, sourceFiles, 'klura-runtime-source-v1');
}

function computeArtifactDigest(runtimeRoot, artifactDirectory = path.join(runtimeRoot, 'dist')) {
  const compiledArtifactFiles = collectCompiledArtifactFiles(artifactDirectory);
  if (compiledArtifactFiles.length === 0) {
    throw new RuntimeBuildIntegrityError(
      'runtime_build_invalid',
      'runtime_build_invalid: compiled runtime artifacts are missing. Run `npm run build`.',
    );
  }
  const entries = [
    ...compiledArtifactFiles.map((absolute) => ({
      relative: path.posix.join('dist', portableRelative(artifactDirectory, absolute)),
      absolute,
    })),
    ...collectDirectRuntimeFiles(runtimeRoot).map((absolute) => ({
      relative: portableRelative(runtimeRoot, absolute),
      absolute,
    })),
  ];
  return digestEntries(entries, 'klura-runtime-artifact-v1');
}

function validateBuildInfo(value, runtimeRoot) {
  const valid =
    value &&
    value.schema_version === BUILD_INFO_SCHEMA_VERSION &&
    typeof value.runtime_version === 'string' &&
    DIGEST_PATTERN.test(value.source_digest) &&
    DIGEST_PATTERN.test(value.artifact_digest) &&
    DIGEST_PATTERN.test(value.build_id) &&
    value.build_id === value.artifact_digest;
  if (!valid) {
    throw new RuntimeBuildIntegrityError(
      'runtime_build_invalid',
      'runtime_build_invalid: dist/build-info.json has an invalid shape. Run `npm run build`.',
    );
  }
  const packageVersion = readPackageVersion(runtimeRoot);
  if (value.runtime_version !== packageVersion) {
    throw new RuntimeBuildIntegrityError(
      'runtime_build_invalid',
      `runtime_build_invalid: build metadata is for runtime ${value.runtime_version}, but package.json is ${packageVersion}. Run \`npm run build\`.`,
      { current_build_id: value.build_id },
    );
  }
  return value;
}

function readRuntimeBuildInfo(runtimeRoot = path.resolve(__dirname, '..')) {
  const buildInfoPath = path.join(runtimeRoot, BUILD_INFO_RELATIVE_PATH);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'));
  } catch (error) {
    throw new RuntimeBuildIntegrityError(
      'runtime_build_invalid',
      'runtime_build_invalid: dist/build-info.json is missing or unreadable. Run `npm run build` before starting klura.',
      { cause: error },
    );
  }
  return validateBuildInfo(parsed, runtimeRoot);
}

function buildInfoFor(runtimeRoot, artifactDirectory) {
  const sourceDigest = computeSourceDigest(runtimeRoot);
  if (sourceDigest === null) {
    throw new RuntimeBuildIntegrityError(
      'runtime_build_invalid',
      'runtime_build_invalid: runtime/src is missing, so build metadata cannot be generated.',
    );
  }
  const artifactDigest = computeArtifactDigest(runtimeRoot, artifactDirectory);
  return {
    schema_version: BUILD_INFO_SCHEMA_VERSION,
    runtime_version: readPackageVersion(runtimeRoot),
    source_digest: sourceDigest,
    artifact_digest: artifactDigest,
    build_id: artifactDigest,
  };
}

function writeRuntimeBuildInfo(
  runtimeRoot = path.resolve(__dirname, '..'),
  artifactDirectory = path.join(runtimeRoot, 'dist'),
) {
  const info = buildInfoFor(runtimeRoot, artifactDirectory);
  const destination = path.join(artifactDirectory, 'build-info.json');
  const serialized = `${JSON.stringify(info, null, 2)}\n`;
  if (fs.existsSync(destination) && fs.readFileSync(destination, 'utf8') === serialized) {
    return info;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, serialized, { flag: 'wx' });
    fs.renameSync(temporary, destination);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      /* Atomic rename consumes the temporary file. */
    }
  }
  return info;
}

function assertSourceMatchesBuild(runtimeRoot, info) {
  const sourceDigest = computeSourceDigest(runtimeRoot);
  if (sourceDigest !== null && sourceDigest !== info.source_digest) {
    throw new RuntimeBuildIntegrityError(
      'runtime_build_stale',
      'runtime_build_stale: runtime source does not match the compiled build. Run `npm run build` and restart the MCP process.',
      {
        current_build_id: info.build_id,
        expected_source_digest: info.source_digest,
        actual_source_digest: sourceDigest,
      },
    );
  }
}

function assertArtifactsMatchBuild(runtimeRoot, info) {
  const artifactDigest = computeArtifactDigest(runtimeRoot);
  if (artifactDigest !== info.artifact_digest) {
    throw new RuntimeBuildIntegrityError(
      'runtime_build_invalid',
      'runtime_build_invalid: compiled runtime artifacts do not match dist/build-info.json. Run `npm run build` and restart the MCP process.',
      {
        current_build_id: info.build_id,
        expected_artifact_digest: info.artifact_digest,
        actual_artifact_digest: artifactDigest,
      },
    );
  }
}

function assertRuntimeBuildFresh(runtimeRoot = path.resolve(__dirname, '..')) {
  const info = readRuntimeBuildInfo(runtimeRoot);
  assertSourceMatchesBuild(runtimeRoot, info);
  assertArtifactsMatchBuild(runtimeRoot, info);
  return info;
}

function assertLoadedRuntimeBuildCurrent(
  loadedBuildInfo,
  runtimeRoot = path.resolve(__dirname, '..'),
) {
  const current = readRuntimeBuildInfo(runtimeRoot);
  if (current.build_id !== loadedBuildInfo.build_id) {
    throw new RuntimeBuildIntegrityError(
      'runtime_process_stale',
      `runtime_process_stale: this MCP process loaded build ${loadedBuildInfo.build_id.slice(0, 12)}, but the package now contains ${current.build_id.slice(0, 12)}. Restart the MCP process.`,
      {
        loaded_build_id: loadedBuildInfo.build_id,
        current_build_id: current.build_id,
      },
    );
  }
  assertSourceMatchesBuild(runtimeRoot, current);
  assertArtifactsMatchBuild(runtimeRoot, current);
  return current;
}

module.exports = {
  RuntimeBuildIntegrityError,
  assertLoadedRuntimeBuildCurrent,
  assertRuntimeBuildFresh,
  computeArtifactDigest,
  computeSourceDigest,
  readRuntimeBuildInfo,
  writeRuntimeBuildInfo,
};

if (require.main === module) {
  try {
    const info = writeRuntimeBuildInfo();
    process.stdout.write(`${info.build_id}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

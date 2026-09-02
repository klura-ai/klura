import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { sha256Digest, type Sha256DigestV1 } from '../../public/contracts/common';
import { canonicalJson } from '../../public/contracts/json';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_EXPORT_TREE_FILES = 4_096;
const MAX_EXPORT_TREE_DIRECTORIES = 1_024;

export const EXPORT_TREE_SCHEMA_VERSION = 1 as const;

const ExportTreeFileSchema = z
  .object({
    path: z.string().refine(isCanonicalRelativePath, 'must be a canonical relative POSIX path'),
    bytes: z.number().int().nonnegative(),
    sha256_digest: z.string().regex(SHA256_PATTERN),
  })
  .strict();

export const ExportTreeManifestSchema = z
  .object({
    schema_version: z.literal(EXPORT_TREE_SCHEMA_VERSION),
    directories: z
      .array(z.string().refine(isCanonicalRelativePath, 'must be a canonical relative POSIX path'))
      .max(MAX_EXPORT_TREE_DIRECTORIES),
    files: z.array(ExportTreeFileSchema).min(1).max(MAX_EXPORT_TREE_FILES),
    tree_digest: z.string().regex(SHA256_PATTERN),
  })
  .strict()
  .superRefine((manifest, context) => {
    const canonicalDirectories = [...manifest.directories].sort(compareText);
    if (
      JSON.stringify(manifest.directories) !== JSON.stringify(canonicalDirectories) ||
      new Set(canonicalDirectories).size !== canonicalDirectories.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['directories'],
        message: 'must be sorted with no duplicate paths',
      });
    }
    const canonicalFiles = [...manifest.files].sort(compareTreeFiles);
    if (JSON.stringify(manifest.files) !== JSON.stringify(canonicalFiles)) {
      context.addIssue({
        code: 'custom',
        path: ['files'],
        message: 'must be sorted by path with no duplicate paths',
      });
    }
    for (let index = 1; index < canonicalFiles.length; index += 1) {
      if (canonicalFiles[index - 1]?.path === canonicalFiles[index]?.path) {
        context.addIssue({
          code: 'custom',
          path: ['files', index, 'path'],
          message: 'must not duplicate another file path',
        });
      }
    }
    const expectedDigest = digestExportTree(canonicalDirectories, canonicalFiles);
    if (manifest.tree_digest !== expectedDigest) {
      context.addIssue({
        code: 'custom',
        path: ['tree_digest'],
        message: 'does not match the canonical file manifest',
      });
    }
  });

export type ExportTreeFileV1 = z.infer<typeof ExportTreeFileSchema>;
export type ExportTreeManifestV1 = z.infer<typeof ExportTreeManifestSchema>;

export const EXPORT_TREE_ASSESSMENT_KINDS = {
  current: 'current',
  malformedManifest: 'malformed_manifest',
  invalidRoot: 'invalid_root',
  unsafeNode: 'unsafe_node',
  ioFailure: 'io_failure',
  fileSetChanged: 'file_set_changed',
  fileChanged: 'file_changed',
} as const;

type ExportTreeScanFailure =
  | {
      kind: typeof EXPORT_TREE_ASSESSMENT_KINDS.invalidRoot;
      reason: 'missing' | 'symlink' | 'not_directory' | 'path_escape';
    }
  | {
      kind: typeof EXPORT_TREE_ASSESSMENT_KINDS.unsafeNode;
      path: string;
      node_kind: 'symlink' | 'non_regular';
    }
  | {
      kind: typeof EXPORT_TREE_ASSESSMENT_KINDS.ioFailure;
      path: string;
      operation: 'lstat' | 'realpath' | 'readdir' | 'read';
      message: string;
    };

export type ExportTreeAssessment =
  | {
      kind: typeof EXPORT_TREE_ASSESSMENT_KINDS.current;
      manifest: ExportTreeManifestV1;
    }
  | {
      kind: typeof EXPORT_TREE_ASSESSMENT_KINDS.malformedManifest;
      issues: Array<{ path: string; message: string }>;
    }
  | ExportTreeScanFailure
  | {
      kind: typeof EXPORT_TREE_ASSESSMENT_KINDS.fileSetChanged;
      missing_directories: string[];
      extra_directories: string[];
      missing_paths: string[];
      extra_paths: string[];
    }
  | {
      kind: typeof EXPORT_TREE_ASSESSMENT_KINDS.fileChanged;
      paths: string[];
    };

export class ExportTreeCaptureError extends Error {
  readonly assessment: ExportTreeScanFailure;

  constructor(assessment: ExportTreeScanFailure) {
    super(`export_tree_capture_failed: ${JSON.stringify(assessment)}`);
    this.name = 'ExportTreeCaptureError';
    this.assessment = assessment;
  }
}

export function createExportTreeManifest(rootDirectory: string): ExportTreeManifestV1 {
  const scanned = scanExportTree(rootDirectory);
  if (scanned.kind !== EXPORT_TREE_ASSESSMENT_KINDS.current) {
    throw new ExportTreeCaptureError(scanned);
  }
  return scanned.manifest;
}

export function assessExportTreeManifest(
  rootDirectory: string,
  manifestInput: unknown,
): ExportTreeAssessment {
  const parsed = ExportTreeManifestSchema.safeParse(manifestInput);
  if (!parsed.success) {
    return {
      kind: EXPORT_TREE_ASSESSMENT_KINDS.malformedManifest,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    };
  }
  const scanned = scanExportTree(rootDirectory);
  if (scanned.kind !== EXPORT_TREE_ASSESSMENT_KINDS.current) return scanned;

  const expectedByPath = new Map(parsed.data.files.map((file) => [file.path, file]));
  const actualByPath = new Map(scanned.manifest.files.map((file) => [file.path, file]));
  const expectedDirectories = new Set(parsed.data.directories);
  const actualDirectories = new Set(scanned.manifest.directories);
  const missingDirectories = [...expectedDirectories]
    .filter((directory) => !actualDirectories.has(directory))
    .sort(compareText);
  const extraDirectories = [...actualDirectories]
    .filter((directory) => !expectedDirectories.has(directory))
    .sort(compareText);
  const missingPaths = [...expectedByPath.keys()]
    .filter((filePath) => !actualByPath.has(filePath))
    .sort(compareText);
  const extraPaths = [...actualByPath.keys()]
    .filter((filePath) => !expectedByPath.has(filePath))
    .sort(compareText);
  if (
    missingDirectories.length > 0 ||
    extraDirectories.length > 0 ||
    missingPaths.length > 0 ||
    extraPaths.length > 0
  ) {
    return {
      kind: EXPORT_TREE_ASSESSMENT_KINDS.fileSetChanged,
      missing_directories: missingDirectories,
      extra_directories: extraDirectories,
      missing_paths: missingPaths,
      extra_paths: extraPaths,
    };
  }

  const changedPaths = parsed.data.files
    .filter(
      (expected) =>
        actualByPath.get(expected.path)?.bytes !== expected.bytes ||
        actualByPath.get(expected.path)?.sha256_digest !== expected.sha256_digest,
    )
    .map((file) => file.path);
  if (changedPaths.length > 0) {
    return {
      kind: EXPORT_TREE_ASSESSMENT_KINDS.fileChanged,
      paths: changedPaths,
    };
  }
  return { kind: EXPORT_TREE_ASSESSMENT_KINDS.current, manifest: scanned.manifest };
}

function scanExportTree(rootDirectory: string):
  | {
      kind: typeof EXPORT_TREE_ASSESSMENT_KINDS.current;
      manifest: ExportTreeManifestV1;
    }
  | ExportTreeScanFailure {
  const root = path.resolve(rootDirectory);
  const rootStat = safeLstat(root);
  if (!rootStat.ok) {
    return rootStat.missing
      ? { kind: EXPORT_TREE_ASSESSMENT_KINDS.invalidRoot, reason: 'missing' }
      : ioFailure('', 'lstat', rootStat.error);
  }
  if (rootStat.stat.isSymbolicLink()) {
    return { kind: EXPORT_TREE_ASSESSMENT_KINDS.invalidRoot, reason: 'symlink' };
  }
  if (!rootStat.stat.isDirectory()) {
    return { kind: EXPORT_TREE_ASSESSMENT_KINDS.invalidRoot, reason: 'not_directory' };
  }

  let rootReal: string;
  try {
    rootReal = fs.realpathSync(root);
  } catch (error) {
    return ioFailure('', 'realpath', error);
  }
  const directories: string[] = [];
  const files: ExportTreeFileV1[] = [];
  const pending: Array<{ absolute: string; relative: string }> = [{ absolute: root, relative: '' }];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) break;
    let names: string[];
    try {
      names = fs.readdirSync(directory.absolute).sort(compareText);
    } catch (error) {
      return ioFailure(directory.relative, 'readdir', error);
    }
    for (const name of names) {
      const absolute = path.join(directory.absolute, name);
      const relative = directory.relative ? `${directory.relative}/${name}` : name;
      const statResult = safeLstat(absolute);
      if (!statResult.ok) {
        return ioFailure(relative, 'lstat', statResult.error);
      }
      if (statResult.stat.isSymbolicLink()) {
        return {
          kind: EXPORT_TREE_ASSESSMENT_KINDS.unsafeNode,
          path: relative,
          node_kind: 'symlink',
        };
      }

      let real: string;
      try {
        real = fs.realpathSync(absolute);
      } catch (error) {
        return ioFailure(relative, 'realpath', error);
      }
      if (!isWithinRoot(rootReal, real)) {
        return {
          kind: EXPORT_TREE_ASSESSMENT_KINDS.unsafeNode,
          path: relative,
          node_kind: 'symlink',
        };
      }
      if (statResult.stat.isDirectory()) {
        directories.push(relative);
        if (directories.length > MAX_EXPORT_TREE_DIRECTORIES) {
          return {
            kind: EXPORT_TREE_ASSESSMENT_KINDS.ioFailure,
            path: '',
            operation: 'readdir',
            message: `export tree exceeds ${MAX_EXPORT_TREE_DIRECTORIES} directories`,
          };
        }
        pending.push({ absolute, relative });
        continue;
      }
      if (!statResult.stat.isFile()) {
        return {
          kind: EXPORT_TREE_ASSESSMENT_KINDS.unsafeNode,
          path: relative,
          node_kind: 'non_regular',
        };
      }
      const hashed = hashRegularFile(absolute, relative, statResult.stat);
      if (!hashed.ok) return hashed.failure;
      files.push({
        path: relative,
        bytes: hashed.bytes,
        sha256_digest: hashed.sha256_digest,
      });
      if (files.length > MAX_EXPORT_TREE_FILES) {
        return {
          kind: EXPORT_TREE_ASSESSMENT_KINDS.ioFailure,
          path: '',
          operation: 'readdir',
          message: `export tree exceeds ${MAX_EXPORT_TREE_FILES} files`,
        };
      }
    }
  }
  directories.sort(compareText);
  files.sort(compareTreeFiles);
  if (files.length === 0) {
    return {
      kind: EXPORT_TREE_ASSESSMENT_KINDS.ioFailure,
      path: '',
      operation: 'readdir',
      message: 'export tree contains no files',
    };
  }
  return {
    kind: EXPORT_TREE_ASSESSMENT_KINDS.current,
    manifest: {
      schema_version: EXPORT_TREE_SCHEMA_VERSION,
      directories,
      files,
      tree_digest: digestExportTree(directories, files),
    },
  };
}

function digestExportTree(directories: string[], files: ExportTreeFileV1[]): Sha256DigestV1 {
  return sha256Digest(
    canonicalJson({
      schema_version: EXPORT_TREE_SCHEMA_VERSION,
      directories,
      files,
    }),
  );
}

function isCanonicalRelativePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.includes('\0') ||
    value.includes('\\') ||
    path.posix.isAbsolute(value)
  ) {
    return false;
  }
  const segments = value.split('/');
  return (
    segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..') &&
    path.posix.normalize(value) === value
  );
}

function isWithinRoot(rootReal: string, candidateReal: string): boolean {
  const relative = path.relative(rootReal, candidateReal);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..');
}

function hashRegularFile(
  absolutePath: string,
  relativePath: string,
  observedStat: fs.Stats,
):
  | { ok: true; bytes: number; sha256_digest: Sha256DigestV1 }
  | { ok: false; failure: ExportTreeScanFailure } {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(absolutePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = fs.fstatSync(descriptor);
    if (!before.isFile()) {
      return {
        ok: false,
        failure: {
          kind: EXPORT_TREE_ASSESSMENT_KINDS.unsafeNode,
          path: relativePath,
          node_kind: 'non_regular',
        },
      };
    }
    if (before.dev !== observedStat.dev || before.ino !== observedStat.ino) {
      return {
        ok: false,
        failure: {
          kind: EXPORT_TREE_ASSESSMENT_KINDS.ioFailure,
          path: relativePath,
          operation: 'read',
          message: 'file changed before hashing',
        },
      };
    }

    const digest = crypto.createHash('sha256');
    const chunk = Buffer.allocUnsafe(64 * 1_024);
    let bytes = 0;
    for (;;) {
      const count = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (count === 0) break;
      digest.update(chunk.subarray(0, count));
      bytes += count;
    }
    const after = fs.fstatSync(descriptor);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      bytes !== after.size
    ) {
      return {
        ok: false,
        failure: {
          kind: EXPORT_TREE_ASSESSMENT_KINDS.ioFailure,
          path: relativePath,
          operation: 'read',
          message: 'file changed while it was being hashed',
        },
      };
    }
    return {
      ok: true,
      bytes,
      sha256_digest: digest.digest('hex') as Sha256DigestV1,
    };
  } catch (error) {
    const code =
      error instanceof Error && 'code' in error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === 'ELOOP') {
      return {
        ok: false,
        failure: {
          kind: EXPORT_TREE_ASSESSMENT_KINDS.unsafeNode,
          path: relativePath,
          node_kind: 'symlink',
        },
      };
    }
    return { ok: false, failure: ioFailure(relativePath, 'read', error) };
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function safeLstat(
  target: string,
): { ok: true; stat: fs.Stats } | { ok: false; missing: boolean; error: unknown } {
  try {
    return { ok: true, stat: fs.lstatSync(target) };
  } catch (error) {
    return {
      ok: false,
      missing:
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ENOENT',
      error,
    };
  }
}

function ioFailure(
  relativePath: string,
  operation: 'lstat' | 'realpath' | 'readdir' | 'read',
  error: unknown,
): Extract<ExportTreeScanFailure, { kind: typeof EXPORT_TREE_ASSESSMENT_KINDS.ioFailure }> {
  return {
    kind: EXPORT_TREE_ASSESSMENT_KINDS.ioFailure,
    path: relativePath,
    operation,
    message: error instanceof Error ? error.message : String(error),
  };
}

function compareTreeFiles(left: ExportTreeFileV1, right: ExportTreeFileV1): number {
  return compareText(left.path, right.path);
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

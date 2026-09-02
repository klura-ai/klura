import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  assessExportTreeManifest,
  createExportTreeManifest,
  EXPORT_TREE_ASSESSMENT_KINDS,
} = require('../dist/factory/public-package/export-tree.js');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-export-tree-'));
  fs.mkdirSync(path.join(root, 'fixtures'));
  fs.writeFileSync(path.join(root, 'package.source.json'), '{"package":true}\n');
  fs.writeFileSync(path.join(root, 'registry.json'), '{"registry":true}\n');
  fs.writeFileSync(path.join(root, 'fixtures', 'read.call.json'), '{"fixture":true}\n');
  return root;
}

test('one canonical export-tree manifest covers files and directories', () => {
  const root = setup();
  const manifest = createExportTreeManifest(root);
  assert.deepEqual(manifest.directories, ['fixtures']);
  assert.deepEqual(
    manifest.files.map((file) => file.path),
    ['fixtures/read.call.json', 'package.source.json', 'registry.json'],
  );
  assert.equal(assessExportTreeManifest(root, manifest).kind, EXPORT_TREE_ASSESSMENT_KINDS.current);
});

test('changed, missing, and extra files have distinct structural assessments', () => {
  const changedRoot = setup();
  const changedManifest = createExportTreeManifest(changedRoot);
  fs.writeFileSync(path.join(changedRoot, 'registry.json'), '{"registry":"changed"}\n');
  assert.deepEqual(assessExportTreeManifest(changedRoot, changedManifest), {
    kind: EXPORT_TREE_ASSESSMENT_KINDS.fileChanged,
    paths: ['registry.json'],
  });

  const missingRoot = setup();
  const missingManifest = createExportTreeManifest(missingRoot);
  fs.unlinkSync(path.join(missingRoot, 'fixtures', 'read.call.json'));
  assert.deepEqual(assessExportTreeManifest(missingRoot, missingManifest), {
    kind: EXPORT_TREE_ASSESSMENT_KINDS.fileSetChanged,
    missing_directories: [],
    extra_directories: [],
    missing_paths: ['fixtures/read.call.json'],
    extra_paths: [],
  });

  const extraRoot = setup();
  const extraManifest = createExportTreeManifest(extraRoot);
  fs.writeFileSync(path.join(extraRoot, 'unexpected.json'), '{}\n');
  assert.deepEqual(assessExportTreeManifest(extraRoot, extraManifest), {
    kind: EXPORT_TREE_ASSESSMENT_KINDS.fileSetChanged,
    missing_directories: [],
    extra_directories: [],
    missing_paths: [],
    extra_paths: ['unexpected.json'],
  });
});

test('an unexpected empty directory invalidates the complete tree', () => {
  const root = setup();
  const manifest = createExportTreeManifest(root);
  fs.mkdirSync(path.join(root, 'unexpected'));
  assert.deepEqual(assessExportTreeManifest(root, manifest), {
    kind: EXPORT_TREE_ASSESSMENT_KINDS.fileSetChanged,
    missing_directories: [],
    extra_directories: ['unexpected'],
    missing_paths: [],
    extra_paths: [],
  });
});

test('root and descendant symlinks are rejected before hashing', () => {
  const root = setup();
  const manifest = createExportTreeManifest(root);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-export-tree-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.json'), '{"secret":true}\n');
  fs.symlinkSync(path.join(outside, 'secret.json'), path.join(root, 'linked.json'));
  assert.deepEqual(assessExportTreeManifest(root, manifest), {
    kind: EXPORT_TREE_ASSESSMENT_KINDS.unsafeNode,
    path: 'linked.json',
    node_kind: 'symlink',
  });

  const rootLink = `${root}-link`;
  fs.symlinkSync(root, rootLink);
  assert.deepEqual(assessExportTreeManifest(rootLink, manifest), {
    kind: EXPORT_TREE_ASSESSMENT_KINDS.invalidRoot,
    reason: 'symlink',
  });
});

test('noncanonical manifest paths are rejected without reading outside the root', () => {
  const root = setup();
  const manifest = createExportTreeManifest(root);
  const unsafe = {
    ...manifest,
    files: [
      ...manifest.files,
      {
        path: '../outside.json',
        bytes: 2,
        sha256_digest: 'a'.repeat(64),
      },
    ],
  };
  const assessment = assessExportTreeManifest(root, unsafe);
  assert.equal(assessment.kind, EXPORT_TREE_ASSESSMENT_KINDS.malformedManifest);
  assert.ok(assessment.issues.some((issue) => issue.path.includes('files')));
});

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { buildRuntime } = require('../scripts/build-staged.js');
const {
  assertRuntimeBuildFresh,
  computeArtifactDigest,
  computeSourceDigest,
} = require('../scripts/write-build-info.js');

function writeFixtureFile(root, relative, content) {
  const destination = path.join(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-staged-build-'));
  writeFixtureFile(root, 'package.json', '{"name":"fixture-runtime","version":"1.0.0"}\n');
  writeFixtureFile(root, 'tsconfig.json', '{}\n');
  writeFixtureFile(root, 'src/index.ts', 'export const current = true;\n');
  writeFixtureFile(root, 'SKILL.md', '# Fixture skill\n');
  writeFixtureFile(root, 'dist/orphan.js', '"use strict"; exports.orphan = true;\n');
  writeFixtureFile(root, 'dist/nested/previous.d.ts', 'export declare const previous: true;\n');
  writeFixtureFile(root, 'dist/build-info.json', '{"previous":true}\n');
  return root;
}

function snapshotDirectory(directory) {
  const entries = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(directory, absolute).split(path.sep).join('/');
      if (entry.isDirectory()) {
        entries.push([relative, 'directory']);
        visit(absolute);
      } else {
        entries.push([relative, 'file', fs.readFileSync(absolute, 'base64')]);
      }
    }
  };
  visit(directory);
  return entries;
}

function stagingEntries(runtimeRoot) {
  return fs.readdirSync(runtimeRoot).filter((entry) => entry.startsWith('.dist-stage-'));
}

test('staged build replaces dist without legitimizing orphaned artifacts', () => {
  const root = fixture();
  try {
    const info = buildRuntime({
      runtimeRoot: root,
      compile: ({ runtimeRoot, stagingDirectory }) => {
        assert.equal(fs.existsSync(path.join(runtimeRoot, 'dist', 'orphan.js')), true);
        writeFixtureFile(stagingDirectory, 'index.js', '"use strict"; exports.current = true;\n');
        writeFixtureFile(stagingDirectory, 'index.d.ts', 'export declare const current: true;\n');
        writeFixtureFile(stagingDirectory, 'index.js.map', '{"version":3}\n');
      },
    });

    assert.equal(fs.existsSync(path.join(root, 'dist', 'orphan.js')), false);
    assert.equal(fs.existsSync(path.join(root, 'dist', 'nested', 'previous.d.ts')), false);
    assert.equal(fs.existsSync(path.join(root, 'dist', 'index.js')), true);
    assert.equal(fs.existsSync(path.join(root, 'dist', 'index.js.map')), true);
    assert.equal(info.source_digest, computeSourceDigest(root));
    assert.equal(info.artifact_digest, computeArtifactDigest(root));
    assert.deepEqual(assertRuntimeBuildFresh(root), info);
    assert.deepEqual(stagingEntries(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('compile failure preserves the previous dist byte for byte', () => {
  const root = fixture();
  try {
    const before = snapshotDirectory(path.join(root, 'dist'));
    assert.throws(
      () =>
        buildRuntime({
          runtimeRoot: root,
          compile: ({ stagingDirectory }) => {
            writeFixtureFile(stagingDirectory, 'partial.js', '"use strict";\n');
            throw new Error('synthetic compile failure');
          },
        }),
      /synthetic compile failure/,
    );

    assert.deepEqual(snapshotDirectory(path.join(root, 'dist')), before);
    assert.deepEqual(stagingEntries(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('metadata failure preserves the previous dist byte for byte', () => {
  const root = fixture();
  try {
    const before = snapshotDirectory(path.join(root, 'dist'));
    assert.throws(
      () =>
        buildRuntime({
          runtimeRoot: root,
          compile: ({ stagingDirectory }) => {
            writeFixtureFile(stagingDirectory, 'next.js', '"use strict"; exports.next = true;\n');
          },
          generateBuildInfo: () => {
            throw new Error('synthetic metadata failure');
          },
        }),
      /synthetic metadata failure/,
    );

    assert.deepEqual(snapshotDirectory(path.join(root, 'dist')), before);
    assert.deepEqual(stagingEntries(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

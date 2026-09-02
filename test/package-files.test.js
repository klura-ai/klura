import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('published runtime contains the on-demand MCP reference document', () => {
  assert.ok(
    packageJson.files.includes('REFERENCE.md'),
    'package.json files must include REFERENCE.md for klura://reference',
  );
});

test('published runtime contains deterministic build metadata and its verifier', () => {
  assert.ok(packageJson.files.includes('dist/build-info.json'));
  assert.ok(packageJson.files.includes('scripts/build-staged.js'));
  assert.ok(packageJson.files.includes('scripts/write-build-info.js'));
});

test('packed runtime resolves consumer, compiler, MCP, and agent entrypoints', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'klura-runtime-pack-'));
  try {
    const packed = JSON.parse(
      execFileSync(
        'npm',
        [
          '--cache',
          path.join(temporary, 'npm-cache'),
          'pack',
          '--ignore-scripts',
          '--json',
          '--pack-destination',
          temporary,
        ],
        { cwd: root, encoding: 'utf8' },
      ),
    );
    assert.equal(packed.length, 1);
    const archive = path.join(temporary, packed[0].filename);
    execFileSync('tar', ['-xzf', archive, '-C', temporary]);
    const artifact = path.join(temporary, 'package');
    const packagedBuildInfo = JSON.parse(
      fs.readFileSync(path.join(artifact, 'dist', 'build-info.json'), 'utf8'),
    );
    const buildVerifier = createRequire(import.meta.url)(
      path.join(artifact, 'scripts', 'write-build-info.js'),
    );
    assert.deepEqual(buildVerifier.assertRuntimeBuildFresh(artifact), packagedBuildInfo);
    const environment = {
      ...process.env,
      NODE_PATH: [path.join(root, 'node_modules'), process.env.NODE_PATH]
        .filter(Boolean)
        .join(path.delimiter),
    };
    const entrypointCheck = [
      'const consumer = require(process.argv[1]);',
      'const compiler = require(process.argv[2]);',
      'const mcp = require(process.argv[3]);',
      'const agent = require(process.argv[4]);',
      "if (typeof consumer.KluraConsumerClientV1 !== 'function') process.exit(1);",
      "if (typeof compiler.compileStaticRegistryIndex !== 'function') process.exit(1);",
      "if (typeof mcp.createKluraMcpServer !== 'function') process.exit(1);",
      "if (typeof agent.runAgentTask !== 'function') process.exit(1);",
    ].join('');
    execFileSync(
      process.execPath,
      [
        '-e',
        entrypointCheck,
        path.join(artifact, 'consumer.js'),
        path.join(artifact, 'factory-compiler.js'),
        path.join(artifact, 'mcp-server.js'),
        path.join(artifact, 'agent', 'index.js'),
      ],
      { env: environment },
    );
    assert.equal(
      execFileSync(process.execPath, [path.join(artifact, 'bin', 'klura.js'), '--version'], {
        encoding: 'utf8',
        env: environment,
      }),
      `${packageJson.version}\n`,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

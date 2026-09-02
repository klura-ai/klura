'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const { writeRuntimeBuildInfo } = require('./write-build-info.js');

function compileTypeScript({ runtimeRoot, stagingDirectory }) {
  const typescriptCli = require.resolve('typescript/bin/tsc', { paths: [runtimeRoot] });
  const result = childProcess.spawnSync(
    process.execPath,
    [
      typescriptCli,
      '--project',
      path.join(runtimeRoot, 'tsconfig.json'),
      '--outDir',
      stagingDirectory,
    ],
    {
      cwd: runtimeRoot,
      stdio: 'inherit',
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const error = new Error(
      `TypeScript compilation failed${result.signal ? ` with signal ${result.signal}` : ` with exit code ${result.status}`}.`,
    );
    error.code = 'typescript_compile_failed';
    error.exitCode = result.status;
    error.signal = result.signal;
    throw error;
  }
}

function generateRuntimeBuildInfo({ runtimeRoot, stagingDirectory }) {
  return writeRuntimeBuildInfo(runtimeRoot, stagingDirectory);
}

function installStagedDistribution({ runtimeRoot, stagingDirectory }) {
  const distributionDirectory = path.join(runtimeRoot, 'dist');
  const previousDistributionDirectory = `${stagingDirectory}-previous`;
  let previousDistributionMoved = false;

  try {
    if (fs.existsSync(distributionDirectory)) {
      fs.renameSync(distributionDirectory, previousDistributionDirectory);
      previousDistributionMoved = true;
    }
    fs.renameSync(stagingDirectory, distributionDirectory);
  } catch (error) {
    if (
      previousDistributionMoved &&
      !fs.existsSync(distributionDirectory) &&
      fs.existsSync(previousDistributionDirectory)
    ) {
      try {
        fs.renameSync(previousDistributionDirectory, distributionDirectory);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Staged build installation failed and the previous dist could not be restored.',
        );
      }
    }
    throw error;
  }

  if (previousDistributionMoved) {
    fs.rmSync(previousDistributionDirectory, { recursive: true, force: true });
  }
}

function buildRuntime(options = {}) {
  const runtimeRoot = path.resolve(options.runtimeRoot ?? path.resolve(__dirname, '..'));
  const compile = options.compile ?? compileTypeScript;
  const generateBuildInfo = options.generateBuildInfo ?? generateRuntimeBuildInfo;
  const stagingDirectory = fs.mkdtempSync(path.join(runtimeRoot, '.dist-stage-'));

  try {
    compile({ runtimeRoot, stagingDirectory });
    const info = generateBuildInfo({ runtimeRoot, stagingDirectory });
    installStagedDistribution({ runtimeRoot, stagingDirectory });
    return info;
  } finally {
    if (fs.existsSync(stagingDirectory)) {
      fs.rmSync(stagingDirectory, { recursive: true, force: true });
    }
  }
}

module.exports = {
  buildRuntime,
  compileTypeScript,
  generateRuntimeBuildInfo,
  installStagedDistribution,
};

if (require.main === module) {
  try {
    const info = buildRuntime();
    process.stdout.write(`${info.build_id}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

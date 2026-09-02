import fs from 'node:fs';
import path from 'node:path';
import { parsePackageVersion, PublicContractError } from '../public/contracts/common';

/** Reads the packaged consumer runtime version for immutable artifact checks. */
export function readConsumerRuntimeVersion(): string {
  const packagePath = path.join(__dirname, '..', '..', 'package.json');
  try {
    const candidate = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { version?: unknown };
    return parsePackageVersion(candidate.version, 'runtime.version');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PublicContractError('runtime.version', message);
  }
}

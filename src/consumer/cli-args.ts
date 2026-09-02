// Flag, selector, and input parsing shared by the consumer CLI command
// handlers. Every parse failure is a CliInputError; the CLI entry point
// renders it as an invalid-input failure with exit code 2.
import fs from 'node:fs';
import {
  parseCapabilityId,
  parseInteger,
  parsePackageId,
  parsePackageVersion,
  parseSessionName,
  parseStableContractId,
  PUBLIC_CONTRACT_LIMITS,
  type CapabilityIdV1,
  type PackageIdV1,
  type PackageVersionV1,
} from '../public/contracts/common';
import {
  CONSUMER_BOUNDS,
  CONSUMER_LIMITS_MAX_ENTRIES_V1,
  type CallerBoundKeyV1,
} from '../public/contracts/consumer-bounds';
import { parseStrictJson, type JsonValueV1 } from '../public/contracts/json';
import type { RunOutputFormatV1 } from './scrape/output';

export class CliInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliInputError';
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parsePackageCapabilitySelector(value: string): {
  package_id: PackageIdV1;
  capability: CapabilityIdV1;
} {
  const separator = value.indexOf('.');
  if (separator <= 0 || separator !== value.lastIndexOf('.')) {
    throw new CliInputError('call selector must be <package.capability>');
  }
  return {
    package_id: parseCliPackageId(value.slice(0, separator)),
    capability: parseCliCapabilityId(value.slice(separator + 1)),
  };
}

export function parsePackageOptionalCapabilitySelector(
  value: string,
  field: string,
): { package_id: PackageIdV1; capability?: CapabilityIdV1 } {
  const separator = value.indexOf('.');
  if (separator === -1) return { package_id: parseCliPackageId(value) };
  if (separator <= 0 || separator !== value.lastIndexOf('.')) {
    throw new CliInputError(`${field} must be <package[.capability]>`);
  }
  return {
    package_id: parseCliPackageId(value.slice(0, separator)),
    capability: parseCliCapabilityId(value.slice(separator + 1)),
  };
}

export function parsePackageVersionSelector(value: string): {
  package_id: PackageIdV1;
  version?: PackageVersionV1;
} {
  const separator = value.indexOf('@');
  if (separator === -1) return { package_id: parseCliPackageId(value) };
  if (separator <= 0 || separator !== value.lastIndexOf('@')) {
    throw new CliInputError('install selector must be <package[@version]>');
  }
  return {
    package_id: parseCliPackageId(value.slice(0, separator)),
    version: parseCliPackageVersion(value.slice(separator + 1)),
  };
}

export function parseCliPackageId(value: string): PackageIdV1 {
  try {
    return parsePackageId(value, 'package');
  } catch (error) {
    throw new CliInputError(errorMessage(error));
  }
}

function parseCliCapabilityId(value: string): CapabilityIdV1 {
  try {
    return parseCapabilityId(value, 'capability');
  } catch (error) {
    throw new CliInputError(errorMessage(error));
  }
}

export function optionalSessionName(args: readonly string[], flag: string): string | undefined {
  const value = optionalFlag(args, flag);
  if (value === undefined) return undefined;
  try {
    return parseSessionName(value, flag);
  } catch (error) {
    throw new CliInputError(errorMessage(error));
  }
}

export function parseCliPackageVersion(value: string): PackageVersionV1 {
  try {
    return parsePackageVersion(value, 'version');
  } catch (error) {
    throw new CliInputError(errorMessage(error));
  }
}

export function parseCliInput(value: string): JsonValueV1 {
  let bytes: Buffer;
  if (value.startsWith('@')) {
    const inputPath = value.slice(1);
    if (!inputPath) throw new CliInputError('--input @path requires a path');
    try {
      const stats = fs.statSync(inputPath);
      if (!stats.isFile() || stats.size > PUBLIC_CONTRACT_LIMITS.packageBytes) {
        throw new CliInputError('--input file must be a bounded regular file');
      }
      bytes = fs.readFileSync(inputPath);
    } catch (error) {
      if (error instanceof CliInputError) throw error;
      throw new CliInputError('--input file could not be read');
    }
  } else {
    bytes = Buffer.from(value, 'utf8');
  }
  try {
    return parseStrictJson(
      bytes,
      'call.input',
      PUBLIC_CONTRACT_LIMITS.packageBytes,
      PUBLIC_CONTRACT_LIMITS.maxDepth,
    );
  } catch (error) {
    throw new CliInputError(errorMessage(error));
  }
}

export function callerBoundFlag(key: CallerBoundKeyV1): string {
  return `--${key.replaceAll('_', '-')}`;
}

export function optionalPageLimit(args: readonly string[]): number | undefined {
  return optionalBoundedInteger(
    args,
    '--limit',
    CONSUMER_BOUNDS.page_limit.minimum,
    CONSUMER_BOUNDS.page_limit.maximum,
  );
}

export function optionalNonNegativeInteger(
  args: readonly string[],
  flag: string,
): number | undefined {
  return optionalBoundedInteger(
    args,
    flag,
    CONSUMER_BOUNDS.after_sequence.minimum,
    CONSUMER_BOUNDS.after_sequence.maximum,
  );
}

export function optionalBoundedInteger(
  args: readonly string[],
  flag: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = optionalFlag(args, flag);
  if (value === undefined) return undefined;
  try {
    return parseInteger(Number(value), flag, minimum, maximum);
  } catch (error) {
    throw new CliInputError(errorMessage(error));
  }
}

export function parseNamedLimits(args: readonly string[]): Record<string, number> | undefined {
  const values = flagValues(args, '--limit');
  if (values.length === 0) return undefined;
  if (values.length > CONSUMER_LIMITS_MAX_ENTRIES_V1) {
    throw new CliInputError(`--limit accepts at most ${CONSUMER_LIMITS_MAX_ENTRIES_V1} entries`);
  }
  const limits: Record<string, number> = {};
  for (const value of values) {
    const separator = value.indexOf('=');
    if (separator < 1 || separator !== value.lastIndexOf('=')) {
      throw new CliInputError('--limit requires <id>=<positive-integer>');
    }
    const id = value.slice(0, separator);
    let amount: number;
    try {
      parseStableContractId(id, '--limit id');
      amount = parseInteger(
        Number(value.slice(separator + 1)),
        '--limit value',
        CONSUMER_BOUNDS.caller_limit.minimum,
        CONSUMER_BOUNDS.caller_limit.maximum,
      );
    } catch (error) {
      throw new CliInputError(errorMessage(error));
    }
    if (Object.hasOwn(limits, id)) throw new CliInputError(`duplicate --limit ${id}`);
    limits[id] = amount;
  }
  return limits;
}

export function parseOutputFormat(args: readonly string[]): RunOutputFormatV1 | undefined {
  const value = optionalFlag(args, '--format');
  if (value === undefined) return undefined;
  if (value === 'json' || value === 'ndjson' || value === 'csv') return value;
  throw new CliInputError('--format must be json, ndjson, or csv');
}

export function requireFlag(args: readonly string[], flag: string): string {
  const value = optionalFlag(args, flag);
  if (value === undefined) throw new CliInputError(`${flag} is required`);
  return value;
}

export function optionalFlag(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new CliInputError(`${flag} requires a value`);
  return value;
}

function flagValues(args: readonly string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== flag) continue;
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new CliInputError(`${flag} requires a value`);
    values.push(value);
    index += 1;
  }
  return values;
}

export function assertFlags(
  args: readonly string[],
  start: number,
  valueFlags: ReadonlySet<string>,
  repeatedFlags = new Set<string>(),
  bareFlags = new Set<string>(['--json']),
): void {
  const seen = new Set<string>();
  for (let index = start; index < args.length; index += 1) {
    const flag = args[index];
    if (!flag || !flag.startsWith('--'))
      throw new CliInputError(`unexpected argument ${flag ?? ''}`);
    if (seen.has(flag) && !repeatedFlags.has(flag))
      throw new CliInputError(`duplicate flag ${flag}`);
    seen.add(flag);
    if (bareFlags.has(flag)) continue;
    if (!valueFlags.has(flag)) throw new CliInputError(`unknown flag ${flag}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new CliInputError(`${flag} requires a value`);
    index += 1;
  }
}

export function requirePositional(args: readonly string[], index: number, usage: string): string {
  const value = args[index];
  if (!value || value.startsWith('--')) throw new CliInputError(`usage: klura ${usage}`);
  return value;
}

export function optionalPositional(args: readonly string[], index: number): string | undefined {
  const value = args[index];
  if (value === undefined || value.startsWith('--')) return undefined;
  return value;
}

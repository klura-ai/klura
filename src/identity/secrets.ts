import { execSync } from 'child_process';
import { asNonEmptyBoundedString, ValidationError } from '../validators';
import { loadConfig, updateSecrets } from '../config/handler';

// Scheme names are used as map keys and as substrings of the interpolated
// {{secret:<scheme>:<ref>}} placeholder. Tight regex so we can't accidentally
// end up with `{{secret:foo bar:x}}` that parses weird downstream.
const SCHEME_RE = /^[a-zA-Z0-9_-]+$/;

// Shell metacharacters forbidden in resolver command templates. We build the
// command via string replace, so anything that gives the shell an opportunity
// to do more than run the named binary is off-limits. Block: pipes, redirects,
// backticks, $( substitution, &&/||, semicolons, &, <, newlines. Allow spaces,
// slashes, dashes, and {{ref}} placeholders for real-world password-manager
// commands like `op read "op://vault/{{ref}}/password"`.
const SHELL_METACHAR_RE = /[|;&`$()<>\n\r]|\$\(|&&|\|\|/;

/** Get all configured secret resolvers. */
export function listSecretResolvers(): Record<string, string> {
  return loadConfig().secrets ?? {};
}

/** Add or update a secret resolver scheme. Rejects shell-metachar injection. */
export function addSecretResolver(scheme: string, command: string): void {
  try {
    asNonEmptyBoundedString(scheme, 'scheme', 64);
    if (!SCHEME_RE.test(scheme)) {
      throw new ValidationError(
        'scheme',
        `= ${JSON.stringify(scheme)} must match /^[a-zA-Z0-9_-]+$/ (letters, digits, dash, underscore)`,
      );
    }
    asNonEmptyBoundedString(command, 'command', 2000);
    if (SHELL_METACHAR_RE.test(command)) {
      throw new ValidationError(
        'command',
        `contains forbidden shell metacharacters ( | ; & \` $ ( ) < > newline && || $() ) — ` +
          `resolver commands must be a single invocation with {{ref}} placeholders, not a shell pipeline. ` +
          `Example: \`security find-generic-password -s {{ref}} -w\` ` +
          `or \`op read "op://vault/{{ref}}/password"\``,
      );
    }
  } catch (e) {
    if (e instanceof ValidationError) {
      throw new Error(`invalid_secret_resolver: ${e.message}`, { cause: e });
    }
    throw e;
  }
  updateSecrets((secrets) => ({ ...secrets, [scheme]: command }));
}

/** Remove a secret resolver scheme. */
export function removeSecretResolver(scheme: string): void {
  try {
    asNonEmptyBoundedString(scheme, 'scheme', 64);
  } catch (e) {
    if (e instanceof ValidationError) {
      throw new Error(`invalid_secret_resolver: ${e.message}`, { cause: e });
    }
    throw e;
  }
  updateSecrets((secrets) => {
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(secrets)) {
      if (k !== scheme) next[k] = v;
    }
    return next;
  });
}

/**
 * Resolve a single secret via its configured shell command. Throws on failure
 * with redacted error (no ref or output leaked).
 */
export function resolveSecret(scheme: string, ref: string): string {
  const resolvers = listSecretResolvers();
  const template = resolvers[scheme];
  if (!template) {
    throw new Error(
      `secret resolution failed: unknown scheme "${scheme}" (configure with: klura secret add ${scheme} "<command>")`,
    );
  }

  const command = template.replace(/\{\{ref\}\}/g, ref);

  try {
    // Secret resolvers are explicit user configuration and intentionally support
    // shell commands like `op read ...` or `security find-generic-password ...`.
    // eslint-disable-next-line sonarjs/os-command -- user-configured secret resolver command
    const result = execSync(command, {
      timeout: 10_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'], // capture stderr too, but don't use it
    });
    return result.replace(/\n$/, ''); // strip trailing newline
  } catch {
    throw new Error(`secret resolution failed for scheme "${scheme}" [REDACTED]`);
  }
}

/**
 * Find and resolve all {{secret:scheme:ref}} placeholders in a string. Returns
 * the string with secrets substituted.
 */
export function resolveSecrets(template: string): string {
  return template.replace(
    /\{\{secret:(\w+):([^}]+)\}\}/g,
    (_match, scheme: string, ref: string) => {
      return resolveSecret(scheme, ref);
    },
  );
}

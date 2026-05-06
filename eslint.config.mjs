import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';
import sonarjs from 'eslint-plugin-sonarjs';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  sonarjs.configs.recommended,
  prettierConfig,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-function-return-type': ['error', {
        allowExpressions: true,
        allowTypedFunctionExpressions: true,
      }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/strict-boolean-expressions': 'off', // too noisy for now
      '@typescript-eslint/restrict-template-expressions': ['error', {
        allowNumber: true,
        allowBoolean: true,
      }],

      // General
      'no-console': 'off', // daemon needs console
      'eqeqeq': ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-throw-literal': 'error',

      // Cap comment width at the same width as code (prettier's
      // `printWidth: 100`). Code width is prettier's job; this rule only
      // targets comments. `code: 1000` is a sentinel to disable the code
      // check without disabling the whole rule.
      'max-len': ['error', {
        code: 1000,
        comments: 100,
        ignoreUrls: true,
        ignoreRegExpLiterals: true,
        ignoreTemplateLiterals: true,
        ignoreStrings: true,
      }],
      'spaced-comment': ['error', 'always', { markers: ['/'] }],

      'sonarjs/cognitive-complexity': ['error', 80],

      // Cap source files at 1000 lines. Long files mix concerns; splitting
      // by responsibility makes the codebase easier to read. Per-file
      // exemptions go in the override block below.
      'max-lines': ['error', { max: 1000, skipBlankLines: false, skipComments: false }],

      // Architectural discipline: only src/drivers/ may import playwright.
      // Every other file in the runtime must go through the BrowserDriver
      // abstract interface — that's what keeps the driver layer pluggable
      // (BYO drivers via pool.driver). Uses `paths` (exact match on the
      // package name) rather than `patterns` (glob) so local paths like
      // `./drivers/playwright` don't get caught by the glob.
      'no-restricted-imports': ['error', {
        paths: [{
          name: 'playwright',
          message: 'Only files under src/drivers/ may import from playwright. Everything else must go through the BrowserDriver interface (see src/drivers/interface.ts).',
        }],
      }],
    },
  },
  {
    // The one directory allowed to import from playwright.
    files: ['src/drivers/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',

      // Init-script discipline: every script that should fire on every fresh
      // document goes through `BrowserDriver.registerInitScript()` (called
      // from the constructor). The base loop in `_installRegisteredInitScripts`
      // applies them at session creation and warm reset. Direct
      // `context.addInitScript` calls bypass that loop, so BYO drivers don't
      // inherit the script and warm-reset doesn't reinstall it. The sanctioned
      // callsites — `_installRegisteredInitScripts` (the registry installer
      // itself) and `installInitScript` (the agent-supplied API) — opt out
      // with an inline `eslint-disable-next-line` comment.
      'no-restricted-syntax': ['error', {
        selector: "CallExpression[callee.property.name='addInitScript']",
        message: 'Use BrowserDriver.registerInitScript() in the constructor instead of direct addInitScript calls. The base _installRegisteredInitScripts loop installs registered scripts on session create and warm reset.',
      }],
    },
  },
  {
    // Driver implementation: the entire CDP / Playwright surface lives in
    // one file (capture, locators, lifecycle, stealth, debugger). Ignore for now.
    files: ['src/drivers/playwright.ts'],
    rules: {
      'max-lines': 'off',
    },
  },
  {
    // Top-level execute() orchestrator + cascade-failure helpers live as
    // one cohesive module. Splitting bounces the reader between files for
    // very tightly-coupled error-classification logic. Ignore for now.
    files: ['src/execution.ts'],
    rules: {
      'max-lines': 'off',
    },
  },
  {
    // Remote viewer: HTTP server + tab-strip wiring + screencast fan-out
    // sit in one file because they share session state. Splitting would
    // mostly thread the same Session refs through new module boundaries.
    files: ['src/remote/viewer.ts'],
    rules: {
      'max-lines': 'off',
    },
  },
  {
    // Tool files where the impl + colocated TOOL_DEF / TOOL_DEFS together
    // exceed the 1000-line cap. Splitting the TOOL_DEF off into a sibling
    // would defeat the colocation goal (a reviewer reading the impl sees
    // the description and schema right there).
    //
    // start-session.ts: bundles identity normalization, drive-start nudges,
    //   warm-path advisories, capability resolution.
    // perform-action.ts: bundles every action handler (click/type/navigate/
    //   scroll/etc.) plus get_a11y_tree/get_action_history/get_network_log.
    // save-strategy.ts: bundles save_strategy + patch_step entry points
    //   plus the cross-tier audit handoff.
    files: [
      'src/tools/start-session.ts',
      'src/tools/perform-action.ts',
      'src/tools/save-strategy.ts',
    ],
    rules: {
      'max-lines': 'off',
    },
  },
  {
    // Tool files house both typed implementations and the colocated
    // TOOL_DEF / TOOL_DEFS exports whose handlers forward un-validated
    // agent JSON (`args: any`) into the typed impls — the impls validate.
    // The strict-type `no-unsafe-*` family flags every `args.foo` access
    // in those handlers, but the handler boundary is exactly where typed
    // and untyped meet, so the rules add noise without catching a real
    // bug. Disable for tool files; the impl functions in the same files
    // remain typed and tsc-checked.
    files: ['src/tools/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  {
    ignores: ['dist/', 'node_modules/', 'benchmarks-internal/', '**/*.js', 'eslint.config.mjs'],
  },
);

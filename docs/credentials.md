# Credentials, identities, and authentication

This file consolidates klura's login capability shape, credentials policy, identity storage, secret resolvers, authentication flow, and reauth semantics.

## Credentials policy

Klura does not store credentials. Avoid handling them in context when possible.

Priority for reauth:

1. **Remote session** — password never enters context. User logs in directly.
2. **Secret resolver** — if configured, `execute(platform, 'login')` resolves the password via shell command. Password never enters LLM context.
3. **Chat** — last resort, only if user explicitly offers and platform has no CAPTCHA.

Never write credentials to strategy files, notes, or memory. They live only in the transient `args` to `execute`.

## PII and secrets — full list

Strategy files should be shareable. Never write into `endpoint`, `baseUrl`, `params`, `headers`, `body`, `generated.*.examples`, or `notes`:

- **Account identifiers**: user IDs, customer IDs, account numbers, device IDs, order IDs, profile slugs.
- **Contact info**: email, phone, address, postal code, lat/lon.
- **Personal content**: real names, messages, search queries, payment info.
- **Secrets**: cookies, bearer tokens, user-scoped API keys, CSRF tokens, session JWTs.

Public per-platform keys (e.g. `x-fp-api-key: volo`) and hostnames are fine. Replace real values with `{{placeholder}}`, describe in `notes.params`. In notes, describe shapes and field names, not example values. Use fake values for `generated.*.examples`.

## Login capability format

Save login as a recorded-path named `login`, parameterized by `{{email}}`, `{{password}}`:

```json
{
  "strategy": "recorded-path",
  "steps": [
    { "id": "navigate_login", "action": "navigate", "url": "https://example.com/login" },
    {
      "id": "type_email",
      "action": "type",
      "locators": { "a11y": { "role": "textbox", "name": "Email" }, "css": "input[name='email']" },
      "value": "{{email}}"
    },
    {
      "id": "type_password",
      "action": "type",
      "locators": {
        "a11y": { "role": "textbox", "name": "Password" },
        "css": "input[name='password']"
      },
      "value": "{{password}}"
    },
    {
      "id": "click_remember_me",
      "action": "click",
      "locators": {
        "a11y": { "role": "checkbox", "name": "Keep me logged in" },
        "css": "input[name='remember']"
      }
    },
    {
      "id": "click_login",
      "action": "click",
      "locators": { "a11y": { "role": "button", "name": "Log in" }, "css": "button[type='submit']" }
    },
    { "id": "wait_navigation", "action": "wait", "condition": "navigation", "timeout": 10000 }
  ],
  "notes": {
    "params": { "email": "login email", "password": "account password" },
    "discovery": "Captured during initial discovery. Remember-me ticked by default for longer sessions."
  }
}
```

Guidelines:

- **Name it `login`** — convention so reauth logic always finds it.
- **Include remember-me** — fewer reauths, less CAPTCHA friction.
- **Never save credentials** in the strategy file — `{{email}}` and `{{password}}` are filled from `execute` args.
- **Capture both locator types** — login forms change often.
- **Include the post-submit wait** — cookies need the navigation to complete before `saveStorageState` runs.

## Authentication flow

On first login for a platform (no cookies yet):

1. `start_session(url, platform)` — opens the browser.
2. `start_remote_session(session_id, "Log in to your <platform> account")` — surfaces the viewer URL for the user.
3. `wait_for_remote(session_id)` — blocks until the user clicks Done (or types "done" in chat).
4. `stop_remote_session(session_id)` + `close_session(session_id, platform)` — saves the fresh cookies to `~/.klura/storage-state/<platform>.json`.
5. **Capture the login steps as the `login` capability** (see above) so future reauths can run headlessly.

On first identity capture, also call `set_identity(platform, {email: "..."})` with user confirmation so future `{{email}}` / `{{username}}` placeholders auto-fill. Non-secret only.

On `needs_reauth: true` during execute (cookies stale, strategy still fine — do NOT re-discover):

1. **Preferred — remote session**: `start_session(url, platform)` → `start_remote_session` → user logs in → `close_session(..., platform)` → retry the original `execute`. Password never enters context.
2. **If a secret resolver is configured**: `execute(platform, 'login')`. Identity fills the email, secret resolver fills the password. No credentials in LLM context.
3. **Chat (last resort)**: only if the user explicitly offers credentials AND the platform has no CAPTCHA.

If reauth fails, report the failure — only re-discover if the retried call fails with a _non_-auth error.

## Reauth details

When `execute` returns `{needs_reauth: true}`, the runtime detected one of:

- HTTP 401/403.
- Redirect to login-like URLs (`/login`, `/signin`, `/auth`, `/sessions/new`, `/account/login`).
- JSON body top-level `error`/`message`/`code` containing "unauthorized", "forbidden", "not auth", "authenticate", "session expired", "token invalid", "login required".
- **GraphQL-shaped** `body.errors[]` where any entry has `type === 'AUTHENTICATION'`, `extensions.code` matching `/auth/i`, or a message containing "authenticate" — regardless of HTTP status. Many GraphQL servers return 200 or 404 for auth failures, not 401.
- Top-level `body.code === 'UNAUTHORIZED'` (common REST convention).

The detection runs AFTER the cascade — if a lower tier succeeds, no reauth signal is emitted. The classifier never mistakes a plain 404 for auth failure; the body must contain an auth-shaped signal to trip the GraphQL path. The response includes `original_status`, `original_body`, `final_url`, and `discovered_on_page`.

**If `login` hits a CAPTCHA mid-execution**, the recorded-path executor pauses and returns a response carrying `_checkpoint: {kind: "recorded_step_failed", prompt, viewer_url, checkpoint_token}` with `session_id`. Open the returned `viewer_url` for the user, ack via `ack_checkpoint({checkpoint_token, viewer_result: {...}})`, then `resume_execution(session_id)` to finish. Cookies still get saved on completion.

**Manual login fallback** (when no auth-providing capability is on disk): `start_session(url, platform)` → log in via remote session → **save the login steps as a capability with `provides: ["auth"]` declared at the top level** → `close_session(session_id, platform)` → retry `execute`. The `auto_injected` advisory on dependent saves wires up `{kind: "tag", tag: "auth"}` automatically once an auth-providing capability exists.

**Forcing reauth when heuristics miss**: if a strategy fails with a non-auth error but you suspect stale auth, run the reauth steps manually and retry. The detection is intentionally conservative.

## Identities

Per-platform identity fields stored in `~/.klura/identities.json`. Non-secret PII only (emails, usernames). Auto-fills `{{placeholder}}` values during execution so users don't get re-asked every conversation.

```json
{
  "site-one": { "email": "alice@example.com" },
  "site-two": { "username": "alice.example" },
  "site-three": { "username": "alice", "email": "alice@example.com" }
}
```

**Resolution order** at execute time (first match wins):

1. Explicit `args` passed to `execute()` — always takes priority.
2. Identity fields from `identities.json[platform]`.
3. `{{secret:scheme:ref}}` placeholder — resolved via shell command.
4. Unresolved — left as `{{placeholder}}` in output.

**Setting identities**:

- `set_identity(platform, {email: "user@example.com"})` — via tool.
- `klura identity set <platform> email=user@example.com` — via CLI.
- Or edit `~/.klura/identities.json` directly.

**When to save**: on first login for a platform, after the user provides their email/username in chat. Ask for confirmation before saving. Non-secret PII — fine in a plain file and in LLM context.

## Secret resolvers

Shell-command resolvers that fetch passwords from external vaults at execution time. The password never enters LLM context.

**Configuration** in `~/.klura/config.json`:

```json
{
  "secrets": {
    "op": "op read {{ref}}",
    "bw": "bw get password {{ref}}",
    "pass": "pass show {{ref}}",
    "kc": "security find-generic-password -s {{ref}} -w",
    "env": "printenv {{ref}}"
  }
}
```

**Strategy placeholder**: `{{secret:scheme:ref}}`.

```json
{
  "action": "type",
  "locators": {
    "a11y": { "role": "textbox", "name": "Password" },
    "css": "input[type='password']"
  },
  "value": "{{secret:op:op://Personal/<platform>/password}}"
}
```

At execute time, the runtime parses `{{secret:op:op://Personal/<platform>/password}}`, looks up the `op` scheme, runs `op read op://Personal/<platform>/password`, captures stdout, strips trailing newline, and substitutes the value. 10-second timeout. On failure, error message says `[REDACTED]` — never leaks the ref or output.

**Setting up resolvers**:

- `klura secret add op "op read {{ref}}"` — via CLI.
- `klura secret list` — show configured resolvers.
- `klura secret remove op` — remove a resolver.
- Or edit `~/.klura/config.json` directly.

**Common recipes**:

| Manager              | Command                                        |
| -------------------- | ---------------------------------------------- |
| 1Password            | `op read {{ref}}`                              |
| Bitwarden            | `bw get password {{ref}}`                      |
| pass/gopass          | `pass show {{ref}}`                            |
| macOS Keychain       | `security find-generic-password -s {{ref}} -w` |
| Environment variable | `printenv {{ref}}`                             |
| File (CI)            | `cat {{ref}}`                                  |

**Security notes**:

- The LLM never sees resolved secret values — they're substituted at runtime.
- Secret values can appear in network request bodies (inherent — the server needs them).
- Error messages from failed resolution use `[REDACTED]` — no ref or output leaked.
- No MCP tools for secret management — resolvers are configured out-of-band via CLI.

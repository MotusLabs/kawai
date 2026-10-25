# Proposal

## Why

Configuring a private relay gateway (for example a Bifrost relay in front of
several providers) today means editing several JSON files by hand, copying the
shipped catalog to make one small override, and diagnosing failures by
inspecting process environments. A relay set up at the provider level was
silently overridden by a profile's own built-in env; `ANTHROPIC_CUSTOM_HEADERS`
was refused with no supported alternative, so a virtual-key header could not be
configured at all; chat creation succeeded while every model request then
failed, and the error text ("Failed to authenticate") misattributed a
virtual-key restriction as an authentication failure. The operator had no way
to see the effective configuration, test the relay through the real launch
path, or check that a selected model exists before creating a session.

## What Changes

- **A credential store outside the catalogs.** Operators import credential
  values per environment variable through Settings. Values live in one
  server-owned, user-level file (`~/.kawai/credentials.json`, mode 0600) —
  never in SQLite (backups copy the database), never in the repository, never
  in project files (agent-writable). The UI is write-only: presence and source
  are shown, values are never returned. A store value overrides the server
  environment's variable, and the precedence is shown per variable. A change
  takes effect at the next launch without a restart.
- **Relay setup as one flow.** A setup surface configures, per provider, the
  base URL, the access-token variable, custom header names (each bound to a
  credential variable — `x-bf-vk` is a secret), and the model IDs together,
  writing one user-level catalog entry plus credential variables.
- **Custom headers are supported.** A trusted catalog provider may bind
  header names to credential variables; the launch composes
  `ANTHROPIC_CUSTOM_HEADERS` from their values, with no more agent exposure
  than today's token path. Values are still refused in catalog files.
- **Small overrides preserve defaults.** **BREAKING**: the user-level catalog
  merges over the shipped defaults per entry and field instead of replacing
  them when either file exists; an entry may disable a shipped one. An
  instance whose user-level files are already complete keeps the same
  effective catalog (regression oracle).
- **The shipped catalog is trimmed.** **BREAKING**: shipped providers reduce
  to Anthropic (Claude login) and OpenAI (Codex). The removed zai, minimax,
  mimo, kimi, and openrouter entries ship as setup templates with the same
  ids, so adopting one restores resolution for stored sessions, group files,
  and routing that name them.
- **Precedence is explicit.** One precedence table covers every field
  (shipped/user/project; provider vs profile; env vs catalog fields).
  Conflicting overrides warn, and the New Session dialog previews the
  effective configuration before creation: the layer of origin per field, the
  exact model ID sent, credential variable names with presence, and header
  names — credential values redacted.
- **Validation failures are prominent.** The operator sees every configuration
  source listed with its status (loaded, missing, rejected, and the reason),
  and each rejection names the supported setting.
- **A connection test through the real launch path.** The test resolves the
  profile exactly as session creation would and makes a minimal model request
  with the same executable and environment, under a bounded time.
- **Failure classes are distinguished.** Missing server credentials, gateway
  authentication failures, virtual-key restrictions, and provider
  model-catalog failures are reported with the evidence that tells them apart,
  as diagnostics — never as limit events, so no profile cools because a relay
  refused a virtual key.
- **Model availability is checked.** The server queries the relay's model list
  with the provider's own credentials, compares the exact model ID a profile
  sends against it, and marks unavailable profiles in the picker.

## Capabilities

### New Capabilities

- `provider-credentials`: the server-owned credential store — import, storage,
  precedence over the server environment, write-only UI, no-restart effect,
  and the secrecy invariants (values never reach SQLite, backups, logs,
  client payloads, or agent environments beyond the composed token/header
  path).
- `provider-setup`: the setup and diagnostics surface — relay configuration as
  one flow, the configuration-source listing, prominent validation failures,
  the effective-configuration preview, the real-launch-path connection test,
  failure-class diagnosis, model-availability checks, and setup templates for
  the removed shipped providers.

### Modified Capabilities

- `claude-session-profiles`: the user-level catalog merges over the shipped
  defaults with disable semantics (regression oracle: complete user files keep
  the same effective catalog); providers may bind custom header names to
  credential variables; the shipped catalog holds Anthropic and OpenAI (Codex)
  only, with removed ids degrading gracefully until a template is adopted; the
  picker marks profiles whose model the provider's catalog does not list.
- `profile-limit-handling`: an added boundary — authentication, virtual-key,
  and model-catalog failures are diagnostics, never limit events; limit
  recording and cooldowns are unchanged.

## Impact

- **Depends on `openrouter-provider` (active, 19/20)** for the credential
  fields this change builds on (`authTokenEnv`, `balanceKeyEnv`, withholding,
  base-URL pinning). Its delta ADDs "The shipped catalog includes OpenRouter";
  this change REMOVEs that requirement when it trims the shipped catalog, so
  **archive order: `openrouter-provider`, then this change**. The trim's delta
  is authored against the text that change produces; if it stalls, this
  change's REMOVED block is rebased before its own archive. Its credit-limit
  and usage-pull deltas are untouched by this change.
- **Code:** `src/server/chat/catalogParse.ts`, `catalogMerge.ts`,
  `profileCatalog.ts` (layering, disable, header fields, trim);
  `chatProviderEnv.ts` (the store layer in the effective environment);
  `ClaudeProfiles.ts` (header composition, the effective-configuration view);
  `chatAuth.ts` (source-aware credential presence); a new credential store
  module; a new connection-test module; a new model-catalog pull module
  (beside `openRouterUsage.ts`, which this change does not touch);
  `src/server/routes/claudeProfiles.ts` and `settings.ts` (listing, preview,
  availability, import); `src/client/components/settings/ChatSettings.tsx`,
  `NewSessionModal.tsx` (preview, marks, source listing);
  `config/providers.default.json` and `config/profiles.default.json` (trim,
  OpenAI Codex entry); a new `config/provider-templates.json`;
  `docs/claude-session-profiles.md` and the AGENTS.md profile/credentials
  bullets.
- **No database migration:** stored profile ids are unchanged; unknown stored
  profiles already stay visible and block sending until their entry is
  restored — the trim's migration test pins that degrade-and-restore path,
  including group files and routing that name removed ids.
- **Security:** the store is the only new place a credential value exists; it
  is user-level, mode 0600, outside every backup path, and write-only from
  every client surface. Header values compose into `ANTHROPIC_CUSTOM_HEADERS`
  exactly where `ANTHROPIC_AUTH_TOKEN` rides today, and never enter the flag
  settings layer. Every diagnostic path redacts values before output.
- **Compatibility:** instances with user-level catalogs keep their effective
  catalog byte-for-byte (oracle); instances relying on the old
  replace-the-defaults rule disable the shipped entries they do not want;
  sessions on removed shipped ids stay visible and blocked until the operator
  adopts the matching template or re-adds the entry.

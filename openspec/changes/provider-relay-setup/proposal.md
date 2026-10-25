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
- **SQLite retires as a credential source.** **BREAKING**: at upgrade, the
  Settings provider-env map's values move once into the credential store and
  are cleared from `app_settings`; from then on the Settings env editor
  writes the store, no read surface serves stored values, and no credential
  value is written to SQLite again. Backups taken before the upgrade still
  hold the old values — the docs state this and advise rotation; there is no
  retroactive guarantee.
- **Relay setup as one flow.** A setup surface configures, per provider, the
  base URL, the access-token variable, custom header names (each bound to a
  credential variable — `x-bf-vk` is a secret), and the model IDs together,
  writing one user-level catalog entry plus credential variables.
- **Custom headers are supported.** A trusted catalog provider may bind
  header names to credential variables; the launch composes
  `ANTHROPIC_CUSTOM_HEADERS` from their values in the process environment —
  the same delivery mechanism as today's token. Every registered secret name
  is withheld from every agent launch, including disabled, removed, and
  template entries; what a CLI subprocess can read is established by a
  sentinel fixture, and the design claims parity of mechanism, not measured
  exposure. Values are still refused in catalog files.
- **Small overrides preserve defaults.** **BREAKING**: the user-level catalog
  merges over the shipped defaults per entry and field instead of replacing
  them when either file exists; a user-level entry may disable an id with a
  tombstone nearer tiers cannot resurrect. An instance whose user-level
  files are already complete keeps the same effective catalog for every
  non-runtime field (regression oracle; runtime-origin placements follow the
  runtime-origin rules).
- **The shipped catalog is trimmed, with upgrade adoption.** **BREAKING**:
  shipped providers reduce to Anthropic (Claude login) and OpenAI (Codex) on
  fresh installs. The removed zai, minimax, mimo, kimi, and openrouter
  entries ship as setup templates with the same ids; at upgrade, a removed
  id still referenced by stored sessions, groups, routing, or queued mail
  and defined by no layer is adopted once from its template into the
  user-level catalog, so existing installs keep working with no operator
  action. A worker list that resolves to nothing never falls back to the
  default profile — such mail waits with a named reason.
- **Precedence is explicit.** One precedence table covers every field
  (shipped/user/project; provider vs profile; env vs catalog fields).
  Conflicting overrides warn, and the New Session dialog previews the
  effective configuration before creation: the layer of origin per field, the
  exact model ID sent, credential variable names with presence, and header
  names — credential values redacted.
- **Validation failures are prominent.** The operator sees every configuration
  source listed with its status (loaded, missing, rejected, and the reason),
  and each rejection names the supported setting.
- **A connection test through the real launch path (Claude runtime in v1).**
  The test resolves the profile and composes the same launch settings session
  creation would (cwd, settings sources, executable) and makes one minimal
  model request under a bounded time, creating nothing. Codex profiles keep
  their existing login check and show the test as not supported (non-goal
  for v1).
- **Failure classes are distinguished, with limits first.** The existing
  limit predicate runs unchanged — 429, 402, and the limit error classes
  keep cooling on any status. Failures it does not treat as limits are
  classified by one ordered, disjoint rule list — missing credential,
  gateway authentication failure, virtual-key restriction, model-catalog
  failure, network failure, timeout, relay error, evidence-qualified
  unknown — with the evidence that tells them apart, as diagnostics that
  never record a limit. The same classification runs on a live session's
  failed turns, not only the test; a model-list result never proves
  authentication, and ambiguous evidence reads as an evidence-qualified
  unknown.
- **Model availability is checked.** The server queries the relay's
  Anthropic-compatible model list at the configured base URL (path
  preserved) with the provider's own credentials, compares the exact
  wire model ID a launch sends (after CLI alias resolution), and marks
  profiles whose model is absent — but only on a complete, valid list;
  anything else reads as unknown and never blocks creation.

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
- **No schema migration:** stored profile ids are unchanged; the one-time
  Settings-map-to-store move is a data move recorded by a stamp, not a
  schema change. Upgrade adoption (above) keeps existing installs working
  without operator action; the degrade path (unknown stored profiles stay
  visible and blocked, naming the template) remains for ids with no
  template.
- **Security:** the store is the only new place a credential value exists; it
  is user-level, mode 0600, outside every backup path, and write-only from
  every client surface. Header values compose into `ANTHROPIC_CUSTOM_HEADERS`
  exactly where `ANTHROPIC_AUTH_TOKEN` rides today, and never enter the flag
  settings layer. Every diagnostic path redacts exact credential values
  (not only shape patterns) before output. Pre-upgrade database backups
  still contain the old Settings-map values; the docs advise rotation.
- **Compatibility:** instances with user-level catalogs keep their effective
  catalog for every non-runtime field (oracle; runtime-origin placements
  follow the runtime-origin rules); instances relying on the old
  replace-the-defaults rule disable the shipped entries they do not want;
  referenced removed ids are adopted from templates at upgrade, and sessions
  on ids adopted-then-removed degrade visibly, naming the template.

# Proposal

## Why

Configuring a private relay gateway (for example a Bifrost relay in front of
several providers) today means editing several JSON files by hand, copying the
shipped catalog to make one small override, and diagnosing failures by
inspecting process environments. A relay set up at the provider level was
silently overridden by a profile's own built-in env; `ANTHROPIC_CUSTOM_HEADERS`
was refused with no supported alternative, so a virtual-key header could not be
configured at all; chat creation succeeded while every model request then
failed, and the error text ("Failed to authenticate") looked like an
authentication failure whatever it actually was. The operator had no way
to see the effective configuration, test the relay through the real launch
path, or check that a selected model exists before creating a session.
Credentials also already live in SQLite: the Settings provider-env map
persists its values in `app_settings`, and every database backup copies them.

## What Changes

- **A credential store outside the catalogs, with two kinds of entries.**
  Operators import credential values per environment variable through
  Settings into one server-owned, user-level file (`~/.kawai/credentials.json`,
  mode 0600) — never in SQLite, never in the repository, never in project
  files (agent-writable). The store holds **secret sources** (withheld from
  every launch under their own names; they reach an agent only through a
  binding such as `authTokenEnv` or a header binding) and **launch-env
  entries** (delivered to launches unchanged, exactly as the legacy Settings
  map is delivered today). The UI is write-only for both: presence and
  source are shown, values are never returned. A change takes effect at the
  next launch without a restart.
- **SQLite retires as a credential source.** **BREAKING**: at upgrade, the
  Settings provider-env map's entries move once into the store as launch-env
  entries — the store file is written durably before the SQLite delete and
  stamp commit, so a crash at any point recovers per the design's
  crash/collision/restart table — and the map is cleared from `app_settings`;
  from then on the Settings env editor writes the store, no read surface
  serves stored values, and no credential value is written to SQLite again.
  Backups taken before the migration's commit may still hold the old values
  — including the upgrade's own startup snapshot; the docs state this, advise
  rotation, and state when rotation ages them out. No backup taken after the
  commit holds them.
- **An explicit, filtered environment on every launch.** No launch branch
  inherits the server process environment raw: every Claude and Codex launch
  receives an explicitly filtered environment, and the withheld set — every
  catalog binding name in any layer and state (enabled, disabled, retained,
  template), every secret-source store key, every retained name, and the
  controlled/transport-pin variables — never reaches an agent under its own
  name. What a CLI subprocess can read is established by a sentinel fixture;
  the design claims parity of mechanism, not measured exposure.
- **Relay setup as one flow, through an owned write path.** A setup surface
  configures, per provider, the base URL, the access-token variable, custom
  header names (each bound to a credential variable — `x-bf-vk` is a secret),
  and the model IDs together, writing one user-level catalog entry plus
  credential variables through a catalog-edit API that validates through the
  production parsers, saves atomically, and detects concurrent edits (a
  stale stamp is a reported conflict, never a silent overwrite).
- **Custom headers are supported.** A trusted catalog provider may bind
  header names to credential variables; the launch composes
  `ANTHROPIC_CUSTOM_HEADERS` from their values in the process environment —
  the same delivery mechanism as today's token. Values are still refused in
  catalog files.
- **Small overrides preserve defaults — compatibility by construction.**
  **BREAKING**: fresh installs merge user/project files over the trimmed
  shipped catalog per field. Existing installs without a user-level catalog
  keep the removed shipped entries **at the shipped tier as a
  retained-defaults layer**, so sessions, groups, routing rules (dynamic
  picks included), and project overlays resolve exactly as before; the
  source listing labels the layer and offers to retire it after the operator
  previews the effective-catalog difference. Existing installs with
  user-level files keep whole-file replace semantics — absence preserved
  exactly — until the operator opts into merge after the same preview.
  A user-level entry may disable a named id with a tombstone nearer tiers
  cannot resurrect; `default` cannot be disabled. No startup pass adopts,
  discovers references, or writes files.
- **The shipped catalog is trimmed to Anthropic and OpenAI (Codex).**
  **BREAKING** on fresh installs: shipped providers reduce to Anthropic
  (Claude login) and OpenAI (Codex). The removed zai, minimax, mimo, kimi,
  and openrouter entries ship as setup templates with the same ids, and
  upgraded installs keep serving them through the retained-defaults layer
  until retirement. A **declared** worker list whose ids all fail to resolve
  never falls back to the default profile — its mail waits with a named
  reason and the group shows a warning; a group with no worker field keeps
  today's default.
- **Precedence is explicit.** One precedence table covers every field
  (shipped/user/project; provider vs profile; env vs catalog fields), and
  one composition table covers every launch branch. Conflicting overrides
  warn, and the New Session dialog previews the effective configuration
  before creation: the layer of origin per field, the exact model ID sent,
  credential variable names with presence, and header names — credential
  values redacted.
- **Validation failures are prominent.** The operator sees every
  configuration source listed with its status (loaded, missing, rejected,
  and the reason), and each rejection names the supported setting.
- **A connection test through the real launch path (Claude runtime in v1),
  pure by construction.** The test resolves the profile and composes the
  same launch settings session creation would (cwd, settings sources,
  executable) and makes one minimal model request under a bounded time,
  creating nothing and recording nothing — a limit-shaped outcome is
  reported as the test's class, with the reset time when known, and no
  limit event, cooldown, or other row is written. Credential gates go
  through the same resolver session creation uses. Codex profiles keep
  their existing login check and show the test as not supported (non-goal
  for v1).
- **Failure classes are distinguished, with limits first and evidence
  honest.** The existing limit predicate runs unchanged — 429, 402, and the
  limit error classes keep cooling on any status, in live sessions only.
  Failures it does not treat as limits are classified by one ordered,
  disjoint, total rule list — missing credential, gateway authentication
  failure, virtual-key restriction, model-catalog failure, network failure,
  timeout, relay error, header configuration error, evidence-qualified
  unknown — where only the relay's documented structured error types name
  an auth class; prose is never evidence, and anything unmatched reads as
  the evidence-qualified unknown. A model-list result never proves
  authentication. The same classification runs on a live session's failed
  turns, not only the test.
- **Model availability is checked.** The server queries the relay's
  Anthropic-compatible model list at the configured base URL (path
  preserved) with the provider's own credentials, compares the exact
  wire model ID a launch sends (after CLI alias resolution), and marks
  profiles whose model is absent — but only on a complete, valid list;
  anything else reads as unknown and never blocks creation.

## Capabilities

### New Capabilities

- `provider-credentials`: the server-owned credential store — secret sources
  and launch-env entries, import, precedence over the server environment,
  write-only UI, the file-first Settings migration with its crash table,
  no-restart effect, and the secrecy invariants (values never reach SQLite,
  backups after the migration commit, logs, client payloads, or agent
  environments beyond the composed token/header path).
- `provider-setup`: the setup and diagnostics surface — relay configuration
  as one flow through the owned write path, the configuration-source
  listing, prominent validation failures, the effective-configuration
  preview, the pure real-launch-path connection test, failure-class
  diagnosis, model-availability checks, and setup templates for the removed
  shipped providers.

### Modified Capabilities

- `claude-session-profiles`: install-mode catalog assembly (fresh merge;
  retained-defaults layer; legacy replace until an operator opts in) with
  disable semantics for named ids (regression oracles for both modes);
  providers may bind custom header names to credential variables; the
  shipped catalog holds Anthropic and OpenAI (Codex) only, with removed ids
  served by the retained layer until retirement and degrading gracefully
  after; the picker marks profiles whose wire model the provider's catalog
  does not list.
- `profile-limit-handling`: an added boundary — authentication, virtual-key,
  and model-catalog failures are diagnostics, never limit events; limit
  recording and cooldowns are unchanged in live sessions; connection tests
  record nothing.

## Impact

- **Depends on `openrouter-provider` (active, 19/20)** for the credential
  fields this change builds on (`authTokenEnv`, `balanceKeyEnv`, withholding,
  base-URL pinning). Its delta ADDs "The shipped catalog includes OpenRouter";
  this change REMOVEs that requirement when it trims the shipped catalog.
  **Depends on `rename-agentboard-to-kawai` (active, 0/35)**, which renames
  the chat-env seed (`AGENTBOARD_CHAT_ENV` → `KAWAI_CHAT_ENV`) and MODIFIES
  the same main requirement this change modifies. **Archive order:
  `rename-agentboard-to-kawai`, then `openrouter-provider`, then this
  change**; the REMOVED and MODIFIED blocks are authored against those
  changes' final texts and re-checked at rebase before this change archives.
  If either stalls, this change's spec work pauses on that one delta rather
  than emitting a block against text that does not exist yet.
- **Code:** `src/server/chat/catalogParse.ts`, `catalogMerge.ts`,
  `profileCatalog.ts` (install modes, layering, disable, header fields,
  trim, retained layer); a new credential store module and the file-first
  Settings migration; `chatProviderEnv.ts` (the store layers in the
  effective environment); `ClaudeProfiles.ts` (header composition, the
  effective-configuration view); `chatAuth.ts` (source-aware credential
  presence); a new catalog-edit API (the setup write path: validation,
  atomic save, conflict detection); a new connection-test module; a new
  model-catalog pull module (beside `openRouterUsage.ts`, which this change
  does not touch); `src/server/routes/claudeProfiles.ts` and `settings.ts`
  (listing, preview, availability, import);
  `src/client/components/settings/ChatSettings.tsx`,
  `NewSessionModal.tsx` (preview, marks, source listing);
  `config/providers.default.json` and `config/profiles.default.json` (trim,
  OpenAI Codex entry); a new `config/provider-templates.json`;
  `docs/claude-session-profiles.md` and the AGENTS.md profile/credentials
  bullets.
- **No schema migration:** stored profile ids are unchanged; the one-time
  Settings-map-to-store move is a data move recorded by a stamp (plus the
  install-mode stamp), not a schema change. The retained-defaults layer
  keeps existing installs working without operator action; the degrade path
  (unknown stored profiles stay visible and blocked, naming the template)
  applies after a retire or for ids with no template.
- **Security:** the store is the only new place a credential value exists;
  it is user-level, mode 0600, outside every backup path, and write-only
  from every client surface. Header values compose into
  `ANTHROPIC_CUSTOM_HEADERS` exactly where `ANTHROPIC_AUTH_TOKEN` rides
  today, and never enter the flag settings layer. Every diagnostic path
  redacts exact credential values (not only shape patterns) before output.
  Backups taken before the migration's commit may contain the old
  Settings-map values; the docs advise rotation and state when rotation
  ages them out.
- **Compatibility:** existing installs keep resolving exactly as before —
  retained defaults where no user catalog file exists, whole-file replace
  where one does (absence preserved exactly; oracle) — until an operator
  opts into merge after previewing the difference; `default` cannot be
  disabled; a declared worker list whose ids all fail to resolve waits with
  a named reason instead of falling back to `default`; sessions on ids
  missing after a retire degrade visibly, naming the template.

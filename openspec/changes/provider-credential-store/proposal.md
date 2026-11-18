# Proposal

## Why

Credentials configured in Settings live in SQLite today: the Settings
provider-env map is stored in `app_settings` (`chat_provider_env`), copied
into every database backup, and its GET redacts only names that look secret,
so a credential under any other name is served to the client verbatim. The
map also replaces the `AGENTBOARD_CHAT_ENV` seed wholesale, so setting one
variable silently drops every other seed variable.

`provider-relay-setup` §2.1 built the replacement store core
(`src/server/chat/credentialStore.ts`, #354): a 0600 user-level file with
typed outcomes, trust gates, and serialized mutations. Nothing imports it in
production. It is dormant code, not an integration. This slice wires it in:
it composes credentials per variable, migrates the Settings map file-first
at upgrade, makes every read surface write-only, and registers secret-source
keys with the secret-name registry.

It is one of five slices carved from `provider-relay-setup` (task-f588bc17
r2). The umbrella stays byte-unchanged and held. Its full partition is in
`fixture-relay/design.md`.

## What Changes

- Production composition: one credential store per server, built at
  bootstrap with the real SQLite retained-names collaborator. Resolution
  (gate, injection, provider pulls) reads process env < `AGENTBOARD_CHAT_ENV`
  seed < store, per variable. Delivery (launches) is the same composition
  minus every registered name. The seed's wholesale replacement is retired.
- The registry gains its secret-source store-key source.
- **BREAKING (data move):** at the first startup, the Settings provider-env
  map is written into the store as launch-env entries, durably and before
  any SQLite write. Only after a durable acknowledgement does one SQLite
  transaction delete the map row and commit a migration stamp. Re-runs
  absorb equal values, let the store win collisions, and list the skips.
- Settings: a write-only credential section (set/replace masked, blank,
  clear, explicit kind reclassification) and a credential listing (name,
  kind, state, source, override and collision marks). The old provider-env
  GET that served values is retired.
- Docs: store, kinds, migration, and the honest note about backups taken
  before the migration commit (rotation advice).

## Capabilities

### New Capabilities

- `provider-credentials` (requirements added here; the capability itself is
  created by `provider-relay-secret-registry`'s archive): server-owned store,
  write-only UI, per-variable composition, upgrade migration, effect at the
  next launch.

### Modified Capabilities

- `provider-credentials`: "Registered secret names stay withheld" gains
  secret-source store keys and the reclassification scenario.
- `claude-session-profiles`: "Named profiles configure independent provider
  sessions" composes the global overrides per variable from the store's
  launch-env entries, else the seed.

## Impact

- Code: `src/server/chat/credentialStore*.ts` (consumers only; the core API
  stays), `chatProviderEnv.ts`, `routes/chatProviderEnv.ts` (retired or
  replaced), `bootstrap.ts`, `ClaudeProfiles.ts`, `codexProfiles.ts`,
  `chatAuth.ts`, `ChatSessionManager.ts` (provider env and usage pulls),
  `secretNameRegistry.ts` (store-key source),
  `src/client/components/ChatProviderSettings.tsx` and the Settings modal.
- Data: one live-data move (Settings map → `~/.kawai/credentials.json`). This
  planning change performs no migration. Implementation rehearses it only on
  disposable HOME and database copies. Running it on the operator's live
  install is the owner's upgrade decision.
- Recovery: a new startup migration adds a row to `docs/recovery-matrix.md`.
- Docs: `docs/claude-session-profiles.md`, the AGENTS.md profiles bullet,
  the relevant `docs/architecture/` bullet.
- Dependencies: `provider-relay-secret-registry` must archive first (this
  change MODIFIES its requirement). The shared requirement "Named profiles…"
  and `ClaudeProfiles.ts` are serialized with `mimo-million-token-context`
  and `rename-agentboard-to-kawai`; neither is a correctness prerequisite.
- Holds unchanged: the umbrella and its tasks. Task-cd6ffb9f (§2.1 core,
  active since 2026-10-28), task-62609b66 and task-42c653e6 describe the
  landed core. Whether to close them is the Lead's decision, not this
  change's.

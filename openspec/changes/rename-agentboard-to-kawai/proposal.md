# Proposal

## Why

The product is Kawai, and the package is already `@motuslabs/kawai`, but the runtime still uses the name it was forked from. Operators set about 40 `AGENTBOARD_*` variables. Data lives in `~/.agentboard/agentboard.db`, beside `agentboard.log`, `chat-wire/`, `chat-workers/`, `chat-tasks/`, and `backups/agentboard-*.db`. The release ships `bin/agentboard`, the installers create `agentboard.service` and `com.agentboard`, and the tmux session is `agentboard`. Everything built since then uses the Kawai name: `KAWAI_CLAUDE_PATH`, `KAWAI_UPDATE_ENDPOINT`, `KAWAI_BUILD_VERSION`, and the user-level `~/.kawai/` files (`groups/`, `routing/`, `teams.json`, `outbound.json`, `profiles.json`). One install therefore has two names and two home directories. Renaming the rest at once, with a migration path, ends the split before more operators, scripts, and agent teams depend on the old names.

## What Changes

- **BREAKING (deprecated, still accepted):** every `AGENTBOARD_<NAME>` environment variable becomes `KAWAI_<NAME>`, for example `KAWAI_CHAT_ENV`, `KAWAI_DB_PATH`, `KAWAI_REMOTE_HOSTS`, and `KAWAI_CHAT_FIXTURE`. The old name is still read when the new one is unset or empty, with one deprecation warning per variable that never shows the value. If both are set, `KAWAI_*` wins.
- **BREAKING (migrated, backup first):** the default data directory becomes `~/.kawai/`, beside the existing team, routing, outbound, and profile files. Files: `kawai.db`, `kawai.log`, `chat-wire/`, `chat-workers/`, `chat-tasks/`, `backups/`, `tmux-server.pid`, and the dev TLS pem files. On first start with default paths, the server takes a verified backup of the legacy database, then moves the legacy data into `~/.kawai/` and renames the db, log, and backup files to the `kawai` stem. If anything cannot move, or another process still holds the legacy database, nothing is left half-moved and the server runs on `~/.agentboard/`. `~/.agentboard/app` and `~/.agentboard/bin`, the program files and service wrappers, are not touched.
- **BREAKING (migrated):** the default tmux session becomes `kawai`, and per-connection sessions become `kawai-ws-*`. On startup, an existing `agentboard` session is renamed when no `kawai` session exists, and stored window targets are rewritten in the same step. Startup pruning also removes leftover `agentboard-ws-*` sessions. Remote-host discovery treats both `kawai` and `agentboard` as managed.
- **BREAKING (transition):** the release binary becomes `bin/kawai`, and the release tarballs become `kawai-<platform>.tar.gz`. For a transition window, releases also publish `agentboard-<platform>.tar.gz` with the same build as `bin/agentboard`, and the checksum file lists all eight. The updater accepts install roots whose binary is named `kawai` or `agentboard`. In a legacy root it installs the new build under both names, so service definitions and launchers outside this repository keep working. Source runs install to `~/.kawai/app`.
- **BREAKING (installer-migrated):** the service names become `kawai.service`, `com.kawai`, and `com.kawai.logrotate`. Re-running an installer retires the legacy unit or agent. The updater still restarts whatever unit or label launched it. `KAWAI_SYSTEMD_UNIT` and `KAWAI_LAUNCHD_LABEL` replace the `AGENTBOARD_*` overrides.
- Browser storage keys become `kawai-settings`, `kawai-theme`, `kawai-workspace`, and `kawai-session`. Each old key is copied over once when the new key is missing, then removed.
- Generated names change with no fallback: temp and upload prefixes, the pipe-pane directory, paste file names, the bootstrap window `__kawai_root__`, the update staging prefix, the systemd drop-in `50-kawai-update.conf`, log prefixes (`[kawai]`, `[kawai:settings]`), user-visible text, and `scripts/kawai-window.sh`.
- CI/CD, the installers and their READMEs, the README, current docs (including `docs/operations/database-backups.md`), `AGENTS.md`, the e2e suite, and the unit tests use the new names.
- Out of scope: historical records stay as written: `openspec/changes/archive/`, `.pl4n/`, `notes/`, and dated analyses such as `docs/refactor-analysis/`. Unprefixed variables (`TMUX_SESSION`, `LOG_FILE`, `PRUNE_WS_SESSIONS`, `E2E_*`) and the existing `KAWAI_*` variables keep their names.

## Capabilities

### New Capabilities
- `runtime-naming`: the Kawai names of runtime identifiers (environment variables, data directory and its files, database backups, tmux sessions, browser storage keys, service units) and how legacy `agentboard` names stay accepted or get migrated without losing data.

### Modified Capabilities
- `app-updates`: the installed paths are `bin/kawai` and `dist/client`, a legacy `bin/agentboard` root still updates and keeps both names, source runs install under `~/.kawai/app`, and the tarball is `kawai-<platform>.tar.gz`.
- `github-workflows`: build artifacts are named `kawai-<platform>` and contain `bin/kawai`. During the transition window, releases also publish the legacy tarballs, and the checksum file covers both.
- `terminal-streaming`: `KAWAI_WS_DEFLATE` and `KAWAI_LOG_MATCH_YIELD_MS` replace the old variable names.
- `chat-sessions`, `claude-session-profiles`: the global provider environment comes from `KAWAI_CHAT_ENV`. The restated profile requirement also carries reserved example hosts in place of concrete gateway hosts.
- `chat-debug`, `openspec-visibility`, `workspace-navigation`: requirement text says Kawai instead of Agentboard. The behavior does not change.

## Impact

- **Code:** about 110 files under `src/server`, 30 under `src/client`, and 3 under `src/shared` (the inventory in design.md lists every name). The main sites are `config.ts`, `db.ts`, `dbSafety/backupFiles.ts`, `bootstrap.ts`, `tmuxEnv.ts`, `tmuxFormat.ts`, `SessionManager.ts`, `startupPreflight.ts`, `remoteSessions.ts`, `chat/chatProviderEnv.ts`, `chat/developmentFixture.ts`, `terminal/*`, `routes/paste*.ts`, `updates/*`, and the four persisted client stores. New pieces: one env-lookup helper, a data-home resolver with its migration, and a storage-key migration.
- **Tests:** the unit and integration tests that name the legacy identifiers, about 33 `tests/e2e/*` files and their support helpers, `playwright.config.ts`, and `scripts/test-runner.ts`.
- **CI/CD:** `.github/workflows/ci.yml`, `release.yml`, and `local-runner-test.yml`, `scripts/release-checksums.sh`, `scripts/release.ts`, `scripts/ios-sim.sh`, and `scripts/verify-terminal-render-latency.mjs`.
- **Deployment:** existing installs keep running without changes and self-update through the legacy tarball. Their data moves to `~/.kawai/` on the first start of the renamed build, after a backup. Moving service definitions to the new names requires re-running `systemd/install.sh` or `launchd/install.sh`. Shell profiles keep working but log deprecation warnings until their variables are renamed.
- **Other changes:** in-flight changes that name legacy paths or variables (`execution-safety-recovery`, `providers-and-workers`, `codex-chat-sessions`) get a note, not a scope change.
- **Follow-up:** a later change drops the legacy tarballs, the `AGENTBOARD_*` fallback, and the legacy tmux, remote, and storage names once installs have moved.

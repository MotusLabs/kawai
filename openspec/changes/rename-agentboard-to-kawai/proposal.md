# Proposal

## Why

The product is Kawai, but the code still uses the name it was forked from. Operators set `AGENTBOARD_*` variables. Data lives in `~/.agentboard/agentboard.db`. The release ships `bin/agentboard`, the services are `agentboard.service` and `com.agentboard`, and the tmux session is `agentboard`. Newer pieces already use the Kawai name (`KAWAI_CLAUDE_PATH`, `~/.kawai/groups`, `~/.kawai/teams.json`), so one install now has two names and two home directories. Renaming everything at once, with a migration path, ends the split before more operators and scripts come to depend on the old names.

## What Changes

- **BREAKING (deprecated, still accepted):** every `AGENTBOARD_<NAME>` environment variable becomes `KAWAI_<NAME>`, for example `KAWAI_CHAT_ENV`, `KAWAI_DB_PATH`, `KAWAI_REMOTE_HOSTS`, and `KAWAI_CHAT_FIXTURE`. The old name is still read when the new one is unset, and a one-time deprecation warning is logged. If both are set, `KAWAI_*` wins.
- **BREAKING (migrated):** the default data directory becomes `~/.kawai/`, which already holds `groups/`, `routing/`, and `teams.json`. Files: `kawai.db`, `kawai.log`, `chat-wire/`, `chat-workers/`, `tmux-server.pid`, and the dev TLS pem files. On first start with default paths, the server moves the old data out of `~/.agentboard/` and renames the db and log. It leaves `~/.agentboard/app` and `~/.agentboard/bin`, the program files and service wrappers, untouched.
- **BREAKING (migrated):** the default tmux session becomes `kawai`, and per-connection sessions become `kawai-ws-*`. On startup, an existing `agentboard` session is renamed when no `kawai` session exists. Startup pruning also removes leftover `agentboard-ws-*` sessions. Remote-host discovery treats both the `kawai` and `agentboard` sessions as managed.
- **BREAKING (transition):** the release binary becomes `bin/kawai`, and the release tarballs become `kawai-<platform>.tar.gz`. For a transition window, releases also publish `agentboard-<platform>.tar.gz`, which contains the same build as `bin/agentboard`, so already-installed updaters can still update. Both tarballs are listed in the checksum file. The updater accepts install roots whose binary is named either `kawai` or `agentboard`. For a legacy root, it installs the new binary under both names, so existing service definitions keep working. Source runs install to `~/.kawai/app`.
- **BREAKING (installer-migrated):** the service names become `kawai.service` and `com.kawai`, and `com.kawai.logrotate` replaces the old rotate agent. Re-running the installer retires the legacy unit or agent. The updater still restarts whatever unit or label launched it. `KAWAI_SYSTEMD_UNIT` and `KAWAI_LAUNCHD_LABEL` replace the `AGENTBOARD_*` overrides.
- Browser storage keys become `kawai-settings`, `kawai-theme`, `kawai-workspace`, and `kawai-session`. Old keys are copied over once when the new key is missing, then removed.
- Generated names change: temp and upload prefixes, the pipe-pane directory, paste file names, the bootstrap window `__kawai_root__`, the update staging directory, and the systemd drop-in `50-kawai-update.conf`. Log prefixes become `[kawai]`, user-visible text says Kawai, and script names change (`scripts/kawai-window.sh`).
- CI/CD (`ci.yml`, `release.yml`, `scripts/release-checksums.sh`, `scripts/release.ts`), the systemd and launchd installers and READMEs, the README, `docs/`, `CLAUDE.md`, and the tests use the new names.
- Out of scope: historical records stay as written. That covers `openspec/changes/archive/`, `.pl4n/`, `notes/`, and dated docs such as `docs/handovers/` and `docs/refactor-analysis/`. Unprefixed variables (`TMUX_SESSION`, `LOG_FILE`, `PRUNE_WS_SESSIONS`, `REMOTE_ALLOW_ATTACH`) keep their names.

## Capabilities

### New Capabilities
- `runtime-naming`: the Kawai names of runtime identifiers (environment variables, data directory, tmux sessions, browser storage keys, service units) and how legacy `agentboard` names stay accepted or get migrated.

### Modified Capabilities
- `app-updates`: the installed paths are `bin/kawai` and `dist/client`, a legacy `bin/agentboard` root still updates, source runs install under the Kawai application directory, and the tarball name is `kawai-<platform>.tar.gz`.
- `github-workflows`: build artifacts are named `kawai-<platform>` and contain `bin/kawai`. During the transition window, releases also publish the legacy tarballs, and the checksum file covers both.
- `terminal-streaming`: `KAWAI_WS_DEFLATE` and `KAWAI_LOG_MATCH_YIELD_MS` replace the old variable names.
- `chat-sessions`: the provider environment comes from `KAWAI_CHAT_ENV`.
- `claude-session-profiles`: the global provider fallback is `KAWAI_CHAT_ENV`.
- `chat-debug`, `openspec-visibility`, `workspace-navigation`: requirement text says Kawai instead of Agentboard. The behavior does not change.

## Impact

- **Code:** about 130 files under `src/`. The main ones are `src/server/config.ts`, `db.ts`, `tmuxEnv.ts`, `SessionManager.ts`, `tmuxFormat.ts`, `remoteSessions.ts`, `startupPreflight.ts`, `ws/terminalProxy.ts`, `chat/chatProviderEnv.ts`, `chat/developmentFixture.ts`, `terminal/*`, `routes/paste*.ts`, `updates/*`, and the client stores in `src/client/stores/*`. A new env-lookup helper and a startup data-dir migration are added.
- **Tests:** about 50 unit and integration test files, plus `tests/e2e/*` and `playwright.config.ts`.
- **CI/CD:** `.github/workflows/ci.yml` and `release.yml`, `scripts/release-checksums.sh`, `scripts/release.ts`, and `scripts/test-runner.ts`.
- **Deployment:** existing installs keep running without changes. Moving the service definitions to the new names requires re-running `systemd/install.sh` or `launchd/install.sh`. Operator shell profiles keep working, but they log deprecation warnings until the variables are renamed.
- **Follow-up:** a later change drops the legacy tarballs and the `AGENTBOARD_*` fallback once installs have moved to the new names.

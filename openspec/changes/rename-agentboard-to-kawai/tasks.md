# Tasks

## 1. Environment variable helper and rename

- [ ] 1.1 Add `src/server/env.ts` with `readEnv(name)`. It prefers `KAWAI_<name>`, falls back to `AGENTBOARD_<name>`, warns once per legacy name, and never logs the value. Verify with unit tests in `src/server/__tests__/env.test.ts` covering new only, legacy only, both set (new wins), empty new falling back to legacy, a single warning across repeated reads, and a value that never appears in the warning.
- [ ] 1.2 Replace every `process.env.AGENTBOARD_*` read in `src/server/config.ts` with `readEnv`. Rename the log prefixes to `[kawai]`. Update `src/server/__tests__/config.test.ts` to use `KAWAI_*` names, and add one legacy-name case per kind of setting (numeric, boolean, list). Verify `bun run test` passes for config.
- [ ] 1.3 Do the same for the remaining readers: `db.ts` (`DB_PATH`), `bootstrap.ts` (`STATIC_DIR`), `chat/chatProviderEnv.ts` (`CHAT_ENV`), `chat/developmentFixture.ts` (`CHAT_FIXTURE`, `CHAT_FIXTURE_HOLD_MS`), `terminal/PtyTerminalProxy.ts` (`TMUX_SET_CLIPBOARD`), `terminal/TerminalProxyBase.ts` (`TMUX_SYNC`), and any other `git grep 'process.env.AGENTBOARD_'` hit under `src/`. Update their tests. Verify that `git grep -n 'process.env.AGENTBOARD_' -- src ':!**/__tests__/**'` returns nothing.
- [ ] 1.4 Strip both `KAWAI_STATIC_DIR` and `AGENTBOARD_STATIC_DIR` in `tmuxEnv.ts`, and make the `SessionManager.ts` tmux-daemon fingerprint repair recognize either name. Rename the child-process variable in `routes/paste.ts` to `KAWAI_PASTE_IMAGE_MAX_BYTES` on both the setter and the Swift reader. Verify with the `tmuxEnv` and `sessionManager` tests, including a case per legacy name.
- [ ] 1.5 Update the Settings source text in `ChatProviderSettings.tsx` to `KAWAI_CHAT_ENV`, and update its test. Verify the component test asserts the new text.

## 2. Data home and migration

- [ ] 2.1 Add `src/server/dataHome.ts` with a pure `planDataHomeMigration(listing)` that uses the allowlist and renames from design Decision 2. Verify with unit tests: the db and its WAL/SHM/journal files are renamed, rotated logs are renamed, `app/`, `bin/`, `launchd.*.log`, and unknown files stay, and existing `~/.kawai` team files are never targeted.
- [ ] 2.2 Implement the memoized `resolveDataHome()`. It applies the plan with `renameSync` behind the in-use guard (`PRAGMA wal_checkpoint(TRUNCATE)` busy → skip), rolls back in reverse order when any move fails, and returns `{ dir, legacy }`. Verify with tests on temp directories that inject `homeDir`: a fresh install, a successful migration that keeps the db rows readable from `kawai.db`, already migrated (no moves), an explicit DB path (no moves), a failure in the middle that restores everything and returns the legacy dir, and a busy database that is skipped. Use `cleanGitEnv` patterns where git is spawned.
- [ ] 2.3 Point `config.ts` (default log file and tmux PID file) and `db.ts` (`DEFAULT_DATA_DIR`, `kawai.db`, `resolveDataDir`) at `resolveDataHome()`, and log any migration outcome once the logger is ready. Verify with `db.test.ts` and `config.test.ts` updated to `kawai.db` and `kawai.log`, and check that `git grep -n "'.agentboard'" -- src ':!**/__tests__/**'` lists only `dataHome.ts`.
- [ ] 2.4 Update `scripts/dev-server.ts`, `scripts/test-runner.ts`, `scripts/verify-terminal-render-latency.mjs`, and `vite.config.ts` (TLS pem files, with fallback to the legacy location while not yet migrated) to the Kawai paths and names. Verify that `bun run dev` starts and logs to `~/.kawai/kawai.log`, and that `bun run test` uses the temp `kawai.db`.

## 3. tmux session naming

- [ ] 3.1 Change the default `tmuxSession` to `kawai` and the bootstrap window to `__kawai_root__` (`tmuxFormat.ts`). Rename the `agentboard-pipes`, `agentboard-paste-`, and `agentboard-upload-` prefixes and `scripts/agentboard-window.sh` (to `kawai-window.sh`, updating its references). Verify with the updated `sessionManager`, `pipePaneTerminalProxy`, `terminalProxyBase`, and paste-route tests.
- [ ] 3.2 Add the startup rename to `SessionManager.ensureSession`: only when `TMUX_SESSION` is unset, `=agentboard` exists, and `=kawai` does not. Verify with tests covering a rename that happens, a rename skipped because `kawai` exists, and a rename skipped because of an override.
- [ ] 3.3 Audit every database column that stores a tmux target (start with `agent_sessions.current_window`; check pins, hibernation, and chat-worker tables). Add `rewriteWindowSessionPrefix(from, to)`, which rewrites them in one transaction, and call it right after a successful rename and before the first refresh. Verify with a `db.test.ts` case (rows `agentboard:@42` become `kawai:@42`, other sessions' rows untouched) and a `sessionManager` test showing the tracked session stays active.
- [ ] 3.4 Make `startupPreflight.ts` prune both the `<session>-ws-` and the `agentboard-ws-` prefixes. Make `remoteSessions.ts` take lists of managed names and ws prefixes (`[tmuxSession, 'agentboard']`). Verify with the `remoteSessions` and preflight tests: legacy remote sessions are listed as managed and legacy ws sessions are skipped and pruned.
- [ ] 3.5 Update the README sections that describe the tmux session, per-connection sessions, and `PRUNE_WS_SESSIONS` to the new names, including the legacy rename behavior. Verify by reading the README diff.

## 4. Updater and restart

- [ ] 4.1 `installRoot.ts`: accept the binary names `kawai` and `agentboard` and return `binName`. The source-run root becomes `~/.kawai/app` with `bin/kawai`. Verify with `installRoot.test.ts` covering both names, an unknown name refused, and the source target.
- [ ] 4.2 `updateDownload.ts`: fetch and verify `kawai-<platform>.tar.gz`. Verify with the `updateDownload`, `releaseChecksums`, and `updateInstaller` tests updated to the new tarball and its checksum entry.
- [ ] 4.3 `updateSwap.ts` and `updateInstaller.ts`: derive the live paths from `binName`, stage a copy as `bin/agentboard` for legacy roots, handle a live path that does not exist yet (moved in with nothing set aside, removed on restore), and rename the staging prefix to `.kawai-update-`. Verify with `updateSwap.test.ts` (legacy three-path swap, restore after a failure on the third path) and `updateFlow.integration.test.ts` against a legacy layout.
- [ ] 4.4 `updateRestart.ts`: resolve the systemd unit from `readEnv('SYSTEMD_UNIT')`, then `/proc/self/cgroup`, then `kawai.service`, and the launchd label from `readEnv('LAUNCHD_LABEL')`, then `XPC_SERVICE_NAME`, then `com.kawai`. Write `50-kawai-update.conf` and remove a stale `50-agentboard-update.conf`. Verify with `updateRestart.test.ts` covering the legacy override, cgroup parsing (`…/app.slice/agentboard.service`), the default, and drop-in replacement.
- [ ] 4.5 Update the restart-failure hint in `UpdatePanel.tsx` to `~/.kawai/kawai.log`. Verify with its component test.

## 5. Release workflow

- [ ] 5.1 `.github/workflows/release.yml`: build and upload `kawai-<platform>` artifacts with `bin/kawai`, and smoke-test `./kawai`. In the publish job, derive `agentboard-<platform>.tar.gz` (`bin/agentboard` plus `dist/client`) from the same artifact and attach all eight tarballs. Verify with `actionlint`, or `bunx yaml-lint`, and a review of the packaging script against the `github-workflows` delta.
- [ ] 5.2 `scripts/release-checksums.sh`: checksum the tarballs for every base name it is given (`kawai` and `agentboard`), and fail if any is missing. Update `scripts/release.ts` output text. Verify with `releaseChecksums.test.ts` (eight entries; a missing legacy tarball fails).
- [ ] 5.3 `.github/workflows/ci.yml` and `playwright.config.ts`: rename `AGENTBOARD_CHAT_FIXTURE` to `KAWAI_CHAT_FIXTURE` and update the comments. Update `tests/e2e/*` (`KAWAI_CHAT_FIXTURE`, `KAWAI_DB_PATH`, `kawai.db`, `kawai.log`). Verify that the fixture e2e invocation from `ci.yml` passes locally on a spare `E2E_PORT` after `bun run build`.

## 6. Service installers

- [ ] 6.1 `systemd/install.sh`: retire a legacy `agentboard.service` (disable --now, remove the unit and its `.d/`, daemon-reload), install `kawai.service` running `~/.kawai/app/bin/kawai` with `KAWAI_SYSTEMD_UNIT`, download `kawai-<platform>.tar.gz`, and print the optional cleanup of `~/.agentboard/app` and `bin`. Verify with `systemdInstall.test.ts`, extended with a legacy-unit fixture.
- [ ] 6.2 `launchd/install.sh`: the same for `com.agentboard` and `com.agentboard.logrotate`, replacing them with `com.kawai` and `com.kawai.logrotate`, with logs and wrappers under `~/.kawai` (`kawai-run.sh`, `kawai-log-rotate.sh` rotating `kawai.log`). Verify with `launchdInstall.test.ts`, extended with a legacy-agent fixture.
- [ ] 6.3 Rewrite `systemd/README.md` and `launchd/README.md` (including the tmux watchdog snippet: `KAWAI_TMUX_PID_FILE`, the `kawai` session, `com.kawai`), and add an "Upgrading from agentboard" section with the rollback steps from the design. Verify that every command in the READMEs uses the new names (`grep -i agentboard` hits only the upgrade section).

## 7. Client storage keys and visible text

- [ ] 7.1 Add `src/client/utils/legacyStorage.ts` (`migrateStorageKey`) and call it for settings, theme, workspace, and session before the stores hydrate. Rename the persist keys to `kawai-*`, and the `[agentboard:settings]` log prefixes to `[kawai:settings]`. Verify with tests: the legacy value carries over and its key is removed, an existing new key wins, unavailable storage is a no-op, and `settingsStore.test.ts` passes with the new key.
- [ ] 7.2 Replace the remaining user-visible "Agentboard" strings (`prerequisites.ts`, `ChatSessionDriver.ts` deny message, `ws/messageRouter.ts`, others from `git grep -n Agentboard -- src`) and stale comments in touched files. Verify that `git grep -n -i agentboard -- src ':!**/__tests__/**'` lists only the intentional legacy-compat sites (`env.ts`, `dataHome.ts`, `legacyStorage.ts`, the tmux and remote legacy names, `installRoot.ts`, `tmuxEnv.ts`, `SessionManager` fingerprint, `updateRestart.ts`).

## 8. Docs and specs

- [ ] 8.1 Update `README.md` (env var tables, data paths, fixture commands, upgrade notes), `SECURITY.md`, `docs/pwa-install.md`, `docs/claude-session-profiles.md`, `docs/verification/*/README.md`, and `AGENTS.md`/`CLAUDE.md` (`~/.kawai/` data directory line). Leave historical docs alone. Verify that `git grep -n -i agentboard -- README.md SECURITY.md AGENTS.md docs ':!docs/handovers' ':!docs/refactor-analysis'` lists only the deprecation and upgrade notes.
- [ ] 8.2 Edit the Purpose text of `openspec/specs/workspace-navigation/spec.md`, `chat-debug/spec.md`, and `github-workflows/spec.md` directly to say Kawai, since Purpose is not delta-managed. Verify that `openspec validate --specs --strict` passes.
- [ ] 8.3 Add a note to the in-flight changes that mention the legacy names (`chat-session-background-tasks`, `product-strategy` design) where they name env vars or paths, without changing their scope. Verify that `openspec validate --all` passes.

## 9. Integration checks

- [ ] 9.1 Run `bun run lint && bun run typecheck && bun run test`. All pass.
- [ ] 9.2 Upgrade rehearsal on a scratch HOME. Seed `~/.agentboard` (db with a session pointing at `agentboard:@N`, log, chat-wire), set `AGENTBOARD_*` variables, and run tmux session `agentboard` on a private socket. Start the renamed build and confirm: data lives in `~/.kawai`, the session is listed active on `kawai:@N`, a deprecation warning appears per legacy variable, the browser keys migrate (dev-browser), and `~/.agentboard/app` is untouched.
- [ ] 9.3 Updater rehearsal. Build a release locally, run the compiled binary as `<root>/bin/agentboard`, point `KAWAI_UPDATE_ENDPOINT` at a local release serving both tarballs, and confirm that the update lands `bin/kawai` and `bin/agentboard` and restarts.

## Workflow follow-up

- After the transition window (open question in design.md), propose a follow-up change that removes the legacy tarballs, the `AGENTBOARD_*` fallback, and the legacy tmux, remote, and storage names.
- Update the user's memory note that names `AGENTBOARD_CHAT_ENV` once this ships.
- Archive the change after review.

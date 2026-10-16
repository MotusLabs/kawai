# Design

## Context

The legacy name appears in several kinds of places, and each kind has a different compatibility cost. Inventory taken on master `492eada6` (2026-10-16) with `git grep -i agentboard`.

- **Environment variables.** About 40 `AGENTBOARD_*` variables, read directly as `process.env.AGENTBOARD_X`. Most are read once, when `config.ts` loads. Writers pass some to children (the paste helper, e2e servers).
- **Data paths.** `config.ts` (log file, tmux PID file), `db.ts` (`DEFAULT_DATA_DIR`, `agentboard.db`), `scripts/dev-server.ts` (forced `LOG_FILE`), and `vite.config.ts` (dev TLS pem files) each hard-code `~/.agentboard`. The sibling stores derive their directories from the database's directory: `chat-wire/`, `chat-workers/`, `chat-tasks/`, and `backups/`.
- **Database.** SQLite in rollback-journal mode (no WAL) with `busy_timeout = 5000`. `src/server/dbSafety/` owns the startup snapshot, numbered migrations, and `pre-migration-<n>` backups. Backup files are named after the database stem (`backupFiles.ts`: `<stem>-<UTC stamp>-<reason>.db`), and rotation only recognizes files with the current stem; it never touches others. A plain rename of the database to `kawai.db` would therefore strand every existing `agentboard-*.db` backup outside rotation and outside the recovery doc's "newest `pre-migration-<n>`" pointer.
- **User-level Kawai files.** `~/.kawai/` already holds `groups/`, `routing/` (with the published `kawai-routing.d.ts`), `teams.json`, `outbound.json`, and `profiles.json`. None of those names collide with the moved files.
- **tmux.** `config.tmuxSession` defaults to `agentboard`. Per-connection sessions are `${tmuxSession}-ws-${id}`, pruned by prefix in `startupPreflight.ts`. `remoteSessions.ts` treats `sessionName === tmuxSessionPrefix` as managed. Only `agent_sessions.current_window` stores tmux targets (for example `agentboard:@42`), under a unique index.
- **Updater.** `installRoot.ts` refuses any compiled binary not named `agentboard` and puts source runs under `~/.agentboard/app`. `updateSwap.ts` hard-codes `LIVE_PATHS = ['bin/agentboard', 'dist/client']`. `updateDownload.ts` fetches `agentboard-<platform>.tar.gz`. `updateRestart.ts` falls back to `agentboard.service` and `com.agentboard` and writes `50-agentboard-update.conf`. So installed builds can only fetch the legacy tarball and accept only `bin/agentboard` inside it.
- **Install roots outside this repository.** Some hosts run a release from a root created by tooling this repository does not own, still as `<root>/bin/agentboard`. The updater accepts it because the binary name matches. The renamed build must keep starting under that name.
- **Installers.** `systemd/install.sh` and `launchd/install.sh` use `AGENTBOARD_DIR` (default `~/.agentboard`), export `AGENTBOARD_SYSTEMD_UNIT` / `AGENTBOARD_LAUNCHD_LABEL` in the units they write, and install wrapper scripts under `~/.agentboard/bin`.
- **Client.** Four zustand `persist` keys use the `agentboard-` prefix: settings, theme, workspace, and session.

### Inventory

Disposition: **rename** (new name, no fallback), **alias** (new name, legacy still accepted or migrated during the transition), **out of scope** (left as written).

**Environment variables — alias** (every one becomes `KAWAI_<NAME>`, read through the helper in Decision 1):

| Variable(s) | Read in (non-test) |
|---|---|
| `HOST`, `PROJECT_DIR`, `EXCLUDE_PROJECTS`, `INACTIVE_MAX_AGE_HOURS`, `CLAUDE_NO_FLICKER`, `ENTER_REFRESH_MS`, `WORKING_GRACE_MS`, `RG_THREADS`, `SKIP_MATCHING_PATTERNS` | `src/server/config.ts` |
| `LOG_POLL_MS`, `LOG_POLL_MAX`, `LOG_WATCH_MODE`, `LOG_MATCH_WORKER`, `LOG_MATCH_PROFILE`, `LOG_MATCH_YIELD_MS` | `config.ts` |
| `TMUX_TIMEOUT_MS`, `TMUX_MUTATION_TIMEOUT_MS`, `TMUX_PID_FILE` | `config.ts` (PID file also in `launchd/README.md`, `playwright.config.ts`, e2e) |
| `REMOTE_HOSTS`, `REMOTE_POLL_MS`, `REMOTE_TIMEOUT_MS`, `REMOTE_STALE_MS`, `REMOTE_SSH_OPTS`, `REMOTE_ALLOW_CONTROL`, `REMOTE_ALLOW_ATTACH` | `config.ts` |
| `WS_DEFLATE` | `config.ts`, `ws/socketHandlers.ts` |
| `PREFER_WINDOW_NAME` | `config.ts`, `SessionManager.ts`, `displayName.ts`, `routes/settings.ts`; text in `client/components/Terminal.tsx` |
| `PROJECT_DIR` (text) | `routes/serverInfo.ts`; `client/App.tsx`, `SettingsModal.tsx`, `settingsStore.ts` |
| `PASTE_IMAGE_MAX_BYTES` | `config.ts`; set for the Swift helper in `routes/paste.ts` (child env: new name only) |
| `CHAT_ENV` | `config.ts`, `bootstrap.ts`, `chat/chatProviderEnv.ts`, `routes/chatProviderEnv.ts`, `shared/chatProviderSettings.ts`, `client/components/ChatProviderSettings.tsx` |
| `CHAT_FIXTURE`, `CHAT_FIXTURE_HOLD_MS` | `chat/developmentFixture.ts`; set by `ci.yml`, `playwright.config.ts`, about 30 e2e specs |
| `DB_PATH` | `db.ts`; set by `playwright.config.ts`, `scripts/test-runner.ts`, `scripts/ios-sim.sh`, `scripts/verify-terminal-render-latency.mjs`, e2e specs and `tests/e2e/support/*` |
| `STATIC_DIR` | `bootstrap.ts`; stripped in `tmuxEnv.ts`, fingerprinted in `SessionManager.ts` (both names); set by `playwright.config.ts`, `scripts/ios-sim.sh`, e2e |
| `TMUX_SET_CLIPBOARD`, `TMUX_SYNC` | `terminal/PtyTerminalProxy.ts`, `terminal/TerminalProxyBase.ts` |
| `SYSTEMD_UNIT`, `LAUNCHD_LABEL` | `updates/updateRestart.ts`; exported by `systemd/install.sh`, `launchd/install.sh` |
| `DIR`, `STATE_DIR` (installer-only) | `systemd/install.sh`, `launchd/install.sh`; `launchd/README.md` watchdog snippet |
| `TEST_ONLY_VAR` | test only (`chatProviderEnv.test.ts`): rename |
| `TOKEN`, `MODE`, `HISTORY_ENABLED`, `MANAGE_TMUX` | only in `notes/` plans, never read by code: out of scope |

**Data, database, and backups — alias (migrated by Decision 2):**

| Name | Location | New name |
|---|---|---|
| `~/.agentboard/` data dir | `config.ts`, `db.ts`, `scripts/dev-server.ts`, `vite.config.ts` | `~/.kawai/` |
| `agentboard.db` (+`-journal`) | `db.ts`, `scripts/test-runner.ts`, `scripts/verify-terminal-render-latency.mjs`, `playwright.config.ts` | `kawai.db` |
| `agentboard.log` (+ rotated `.N`) | `config.ts`, `scripts/dev-server.ts`, `scripts/test-runner.ts`, `launchd/install.sh`, `UpdatePanel.tsx` hint | `kawai.log` |
| `backups/agentboard-<stamp>-<reason>.db` (+ `.corrupt`, `.partial`) | `dbSafety/backupFiles.ts` (stem from the db name), `docs/operations/database-backups.md` | `backups/kawai-…` |
| `chat-wire/`, `chat-workers/`, `chat-tasks/`, `tmux-server.pid`, `tls-cert.pem`, `tls-key.pem` | beside the db; `config.ts`, `vite.config.ts` | same names under `~/.kawai/` |
| `~/.agentboard/app`, `~/.agentboard/bin`, `launchd.*.log` | installers, `installRoot.ts` | not moved; retired by the installers (Decision 6) |

**tmux — alias (Decision 3):** default session `agentboard` (`config.ts`, `scripts/agentboard-window.sh`, `AGENTS.md`) → `kawai`; per-connection `agentboard-ws-*` (derived from the session name in `ws/terminalProxy.ts`, `startupPreflight.ts`, `SessionManager.ts`, `sessionRefreshWorker.ts`, `remoteSessions.ts`) → `kawai-ws-*`; stored targets `agentboard:@N` (`agent_sessions.current_window`) → `kawai:@N`; remote managed name (`remoteSessions.ts`) accepts both.

**Release, updater, and services — alias:** `bin/agentboard` (`installRoot.ts`, `updateSwap.ts`, `updateRestart.ts`, `tmuxEnv.ts` comment, `release.yml`, installers, READMEs) → `bin/kawai`, legacy roots keep both; `agentboard-<platform>[.tar.gz]` (`release.yml`, `updateDownload.ts`, `scripts/release-checksums.sh`, installers) → `kawai-<platform>`, legacy tarball published in the transition; `agentboard.service`, `com.agentboard`, `com.agentboard.logrotate` (`updateRestart.ts`, installers, READMEs, `.gitignore` `systemd/agentboard.service`) → `kawai.service`, `com.kawai`, `com.kawai.logrotate`; `com.agentboard.tmux-watchdog` and `tmux-agentboard-watchdog.sh` (`launchd/README.md` snippet) → `com.kawai.tmux-watchdog`, `tmux-kawai-watchdog.sh`.

**Client storage keys — alias (Decision 7):** `agentboard-settings` (`settingsStore.ts`), `agentboard-theme` (`themeStore.ts`), `agentboard-workspace` (`workspaceStore.ts`), `agentboard-session` (`sessionStore.ts`) → `kawai-*`.

**Generated and internal names — rename:** `__agentboard_root__` (`tmuxFormat.ts`, `SessionManager.ts`); `agentboard-pipes` (`terminal/PipePaneTerminalProxy.ts`); `agentboard-paste-` (`routes/paste.ts`, `terminal/TerminalProxyBase.ts`); `agentboard-upload-` (`routes/pasteFile.ts`); `.agentboard-update-` (`updates/updateInstaller.ts`); `50-agentboard-update.conf` (`updateRestart.ts`, with stale-file cleanup); `agentboard-created` comment and `[agentboard]` log prefixes (`config.ts`, `chatProviderEnv.ts`); `[agentboard:settings]` (`settingsStore.ts`); `agentboard-tests-` (`scripts/test-runner.ts`); `agentboard-e2e-` (`playwright.config.ts`); `agentboard-run.sh`, `agentboard-log-rotate.sh`, `/tmp/agentboard-*.log` (`launchd/install.sh`, README); `scripts/agentboard-window.sh` → `scripts/kawai-window.sh`; the `agentboard release - <type> version` banner (`scripts/release.ts`); the `bun.lock` workspace name (regenerated to match `package.json`).

**User-visible text and comments — rename:** "Agentboard" in `prerequisites.ts`, `config.ts`, `chat/ChatSessionDriver.ts` (deny message), `ws/messageRouter.ts`, `routes/settings.ts`, `terminal/PtyTerminalProxy.ts`, `shared/chat.ts`, `client/terminal/setup.ts`, installer output; comments in `ChatWireLogs.ts`, `dbSafety/backupFiles.ts`, `displayName.ts`, `bootstrap.ts`, `tmuxEnv.ts`, `updates/*`, `TerminalProxyBase.ts`, `local-runner-test.yml`, `scripts/ios-sim.sh`.

**Docs and specs — rename:** `README.md`, `SECURITY.md`, `AGENTS.md` (`CLAUDE.md` is a symlink to it), `docs/pwa-install.md`, `docs/claude-session-profiles.md`, `docs/operations/database-backups.md`, `docs/verification/*/README.md`, `systemd/README.md`, `launchd/README.md`, and the specs listed in the proposal. Purpose text of `chat-debug`, `github-workflows`, and `workspace-navigation` is edited directly.

**Out of scope:** `openspec/changes/archive/`, `.pl4n/`, `notes/`, `docs/refactor-analysis/`. In-flight changes get a note only (task 8.3).

## Goals / Non-Goals

**Goals:**
- Look up every legacy name in one place per kind, so the transition fallback can be removed later in one small change.
- No install loses data, database backups, tmux windows, browser settings, or the ability to self-update without a manual step.
- A verified backup exists before any data moves.
- If a migration cannot complete, the server keeps running on the legacy layout instead of a partly moved one.

**Non-Goals:**
- Renaming unprefixed variables (`TMUX_SESSION`, `LOG_FILE`, `PRUNE_WS_SESSIONS`, `E2E_*`).
- Rewriting historical documents.
- Removing the legacy fallbacks. That belongs to a follow-up change.
- Moving `~/.agentboard/app` or `~/.agentboard/bin`. Only the installers retire those.
- Changing install roots this repository does not create.
- A new database schema migration: the database moves as a file; its contents only change by the stored-target rewrite of Decision 3.

## Decisions

### 1. One env helper with a legacy fallback
Add `src/server/env.ts` with `readEnv(name)`, where `name` is the suffix such as `'CHAT_ENV'`. It returns `process.env.KAWAI_<name>` when non-empty; otherwise `process.env.AGENTBOARD_<name>`, and the first time per name it writes `console.warn('[kawai] AGENTBOARD_<name> is deprecated; use KAWAI_<name>')`. The console is used because the logger is not set up when `config.ts` loads, as `config.ts` already does. It never logs the value. Every direct `process.env.AGENTBOARD_*` read is replaced. Code that sets variables for children uses only the new names. Strippers and fingerprints check both names (`tmuxEnv.ts`, the `STATIC_DIR` fingerprint in `SessionManager.ts`). The client never reads the environment; its Settings text just names `KAWAI_CHAT_ENV`.
*Alternative:* copy every legacy variable into `process.env` at startup. That changes the environment inherited by tmux and agent children and hides the deprecation logic. Rejected.

### 2. One data-home resolver that backs up, then migrates
Add `src/server/dataHome.ts`. `resolveDataHome()` is memoized and returns `{ dir, legacy, outcome }`; `config.ts` and `db.ts` take their defaults from it, removing today's duplicated `~/.agentboard` constant. The sibling stores keep deriving from the database directory. The migration runs only when `readEnv('DB_PATH')` is unset, `~/.kawai/kawai.db` is missing, and `~/.agentboard/agentboard.db` exists. Steps:

1. **In-use guard.** Rollback-journal SQLite gives no reliable "another process has it open" signal (an idle connection holds no lock), so the resolver checks open handles directly: on Linux, `/proc/*/fd` links to the database inode; on macOS, `lsof -t`. If another process holds it, or the check cannot run, skip the migration, run on the legacy directory, and report why. The next start tries again.
2. **Backup first.** Open the legacy database read-only, take a snapshot through the `DatabaseBackups` copy path (`serialize()`, `.partial`, fsync, rename, `integrity_check`) as `backups/agentboard-<stamp>-pre-rename.db`, and close. A failed or corrupt backup aborts the migration (legacy layout, error reported). Rotation keeps every `pre-rename` backup until the follow-up change.
3. **Plan.** A pure `planDataHomeMigration(listing)` returns `(from, to)` moves from a fixed allowlist: `agentboard.db` and `agentboard.db-journal` → `kawai.db*` (a hot journal moves with its database); `agentboard.log` and rotated `agentboard.log.*` → `kawai.log*`; `chat-wire/`, `chat-workers/`, `chat-tasks/`, `tmux-server.pid`, `tls-cert.pem`, `tls-key.pem` as-is; `backups/` as a directory, then each `agentboard-<stamp>-<reason>.db[.corrupt|.partial]` inside it → `kawai-…`, so rotation and the recovery doc keep finding them. Files that `parseBackupFile` does not recognize stay as named. `app/`, `bin/`, `launchd.*.log`, and unknown entries stay in `~/.agentboard/`. Existing `~/.kawai/` entries are never targets; a destination that exists aborts the plan before any move.
4. **Apply.** `fs.renameSync` in plan order. If any rename fails (for example `EXDEV`), the completed moves are undone in reverse order and the process runs on the legacy directory. If an undo rename itself fails, the server logs both paths of every entry not put back; it keeps running on the legacy directory only if `agentboard.db` (with its journal) is back in place, and otherwise exits with an error naming the `pre-rename` backup. Nothing is ever deleted: every entry stays at one of its two paths. There is no copy fallback for the live database; the step-2 backup is the safety copy.

The outcome is logged once the logger is ready. `initDatabase` then runs unchanged on `kawai.db`, so its own `startup` snapshot follows the move.
*Alternative:* migrate inside `initDatabase`. Rejected, because the log path is chosen earlier in `config.ts`, and the backup must precede any move.

### 3. tmux session rename and stored targets
In `SessionManager.ensureSession`, before the exact-match `has-session` check, and only when `TMUX_SESSION` is unset: if `=agentboard` exists and `=kawai` does not, run `tmux rename-session -t =agentboard kawai`. A new database method `rewriteWindowSessionPrefix('agentboard', 'kawai')` then runs in one transaction before the first refresh: it clears `current_window` on rows still pointing at `kawai:` (dead, since no `kawai` session existed), then rewrites `agentboard:%` to `kawai:` plus the suffix, so the unique index cannot collide. Startup pruning matches both `<session>-ws-` and `agentboard-ws-`, and the local discovery filters in `SessionManager.ts` and `sessionRefreshWorker.ts` skip both. Remote discovery takes a list of managed names, `[tmuxSession, 'agentboard']`, and of ws prefixes.
*Alternative:* keep using an existing `agentboard` session indefinitely. Rejected, because the rename would never finish on long-lived hosts.

### 4. Updater: accept both binary names; dual tarballs for a transition window
- `installRoot.ts` accepts the basename `kawai` or `agentboard` and reports `binName`. The source-run target becomes `~/.kawai/app/bin/kawai`.
- `updateDownload.ts` fetches `kawai-<platform>.tar.gz`, which always contains `bin/kawai`.
- The swap's live paths come from the install root: `['bin/kawai', 'dist/client']`, plus `'bin/agentboard'` when `binName === 'agentboard'`. For a legacy root, the installer copies the staged `bin/kawai` to `bin/agentboard` in staging, so the all-or-restore swap covers all three paths. A live path that does not exist yet (the first `bin/kawai` in a legacy root) is moved in with nothing set aside, and restore removes it. This also covers roots created outside this repository.
- `release.yml` builds `package/kawai-<platform>/bin/kawai`. The publish job derives `agentboard-<platform>.tar.gz` from the same artifact by copying `bin/kawai` to `bin/agentboard`, so both are identical and no extra upload is needed. `scripts/release-checksums.sh` takes the tarball base names and requires all eight.

Old updaters fetch `agentboard-<platform>.tar.gz`, swap `bin/agentboard`, and restart into the new build, which from then on fetches the Kawai tarball and, in a legacy root, refreshes both names.
*Alternative:* symlink `bin/agentboard` to `kawai`. Rejected: `process.execPath` and supervisor behavior with symlinked executables differ by platform, and a real copy keeps swap and restore uniform.

### 5. Restart target resolution
`detectRestartContext` resolves the systemd unit as `readEnv('SYSTEMD_UNIT')`, then the unit parsed from `/proc/self/cgroup` (the last path segment ending in `.service`, Linux only), then `kawai.service`. The launchd label is `readEnv('LAUNCHD_LABEL')`, then `XPC_SERVICE_NAME`, then `com.kawai`. The cgroup step covers units that never exported an override and used to be caught by the `agentboard.service` default. The drop-in becomes `50-kawai-update.conf`; a legacy `50-agentboard-update.conf` for the same unit is removed when the new one is written, so two drop-ins never fight over `ExecStart`.

### 6. Installers retire the legacy service
`systemd/install.sh`: when `~/.config/systemd/user/agentboard.service` exists, run `systemctl --user disable --now agentboard.service`, remove the unit and its `.d/`, and `daemon-reload`. Then install `kawai.service` running `~/.kawai/app/bin/kawai` with `KAWAI_SYSTEMD_UNIT=kawai.service`. `KAWAI_DIR` replaces `AGENTBOARD_DIR` (legacy still read). `launchd/install.sh` does the same for `com.agentboard` and `com.agentboard.logrotate`, replacing them with `com.kawai` and `com.kawai.logrotate`, wrappers `kawai-run.sh` and `kawai-log-rotate.sh` under `~/.kawai/bin`. Both print, without running it, a cleanup command for `~/.agentboard/app` and `~/.agentboard/bin`. Data is never copied or deleted; the server migrates it on first start (Decision 2).

### 7. Client storage key migration
Add `src/client/utils/legacyStorage.ts` with `migrateStorageKey(legacy, next)`. It copies the value only when `next` is missing, then removes `legacy`, using the safe wrappers in `storage.ts`. It runs for the four keys at module load, imported first from the client entry, before the `persist` stores hydrate. Persist versions and migrations are unchanged, because the stored value moves as-is.

### 8. Mechanical rename for everything else
The generated and internal names, user-visible text, comments, CI, docs, `AGENTS.md`, and tests from the inventory are plain renames with no fallback. They live for one process or are internal. A restart re-creates `__kawai_root__` safely, because the bootstrap-window check already tolerates a base session with other windows.

## Risks / Trade-offs

- **An old instance keeps writing to `~/.agentboard` after the migration** (a dev server on another port) → the in-use guard skips the migration while any other process holds the database. A process started later with an explicit `AGENTBOARD_DB_PATH` keeps its own path.
- **The handle check is unavailable** (restricted `/proc`, no `lsof`) → the migration is skipped and reported, never attempted blind (Open Question 4).
- **The tmux rename affects someone running both builds on one tmux server** → it happens only when no `kawai` session exists and `TMUX_SESSION` is unset. `TMUX_SESSION=agentboard` opts out.
- **Moving `tmux-server.pid` breaks an existing watchdog that reads the old path** → the README snippet moves to the new path; `KAWAI_TMUX_PID_FILE` (or the legacy name) pins it.
- **A legacy root keeps two copies of a roughly 100 MB binary** → accepted for the transition; re-running the installer moves the host to `~/.kawai/app` with one binary.
- **External scripts that grep for `agentboard`** (log names, `tmux ls`, `launchctl list`) break → the release notes list every renamed identifier; environment variables keep working through the fallback.
- **The cgroup unit parse is wrong on unusual setups** → the explicit override (new or legacy) always wins, and the installers export it.
- **The transition window has no fixed end** → the legacy names are confined to `env.ts`, `dataHome.ts`, `legacyStorage.ts`, the tmux and remote prefix lists, `installRoot.ts`, `updateRestart.ts`, and the release publish step, so the follow-up is easy to find.

## Migration Plan

1. Ship the renamed build. Its release carries both the `kawai-*` and `agentboard-*` tarballs.
2. Existing installs self-update through the legacy tarball. On first start the build backs up `~/.agentboard/agentboard.db`, moves the data into `~/.kawai`, renames the tmux session, rewrites stored targets, and restarts through the unit that launched it.
3. Operators rename their `AGENTBOARD_*` variables when they see the warnings, and optionally re-run the installer to move to `kawai.service` or `com.kawai`.
4. **Rollback:** before step 2 nothing changed. After it, the legacy build looks for `~/.agentboard/agentboard.db`. Stop the service; move `~/.kawai/kawai.db*`, `kawai.log*`, `chat-wire/`, `chat-workers/`, `chat-tasks/`, `backups/` (renaming `kawai-*` backups back to `agentboard-*`), and `tmux-server.pid` back under `~/.agentboard/` with their legacy names; run `tmux rename-session -t kawai agentboard`; reverse the stored-target rewrite with the documented `UPDATE … 'agentboard:' || substr(current_window, 7) …`; start the legacy binary. The `pre-rename` backup is the fallback if any step goes wrong. Document this in the README's upgrade notes and `docs/operations/database-backups.md`.

## Open Questions

These are the owner's product decisions. Each has a recommendation; none is decided by this change.

1. **How long does the transition window last** before the follow-up removes the legacy tarballs, the `AGENTBOARD_*` fallback, and the legacy tmux, remote, and storage names? *Recommendation:* until the owner confirms every known host runs the renamed build, and at least two releases. Only the follow-up depends on it. *Gate: before the follow-up change only; not this one.*
2. **Data home: `~/.kawai/` or a separate location?** Merging data into `~/.kawai/` puts runtime state beside hand-edited config (`groups/`, `routing/`, `teams.json`, `outbound.json`, `profiles.json`). An XDG data path would separate them but splits the home again. *Recommendation:* `~/.kawai/`, as proposed; it matches the existing `~/.agentboard/` shape and needs no second variable. *Gate: decide before section 2 (Decision 2 and tasks 2.x assume the recommendation).*
3. **Rename existing backups to the `kawai` stem, or leave them?** Leaving them keeps the migration smaller, but strands every `agentboard-*.db` backup outside rotation and the recovery doc's pointer. *Recommendation:* rename them in the same plan (Decision 2), and keep the `pre-rename` backup until the follow-up. *Gate: decide before section 2 (tasks 2.1 and 2.5 implement the recommendation).*
4. **When the in-use check cannot run, skip or migrate?** *Recommendation:* skip and report, so a migration never races a live writer; the server keeps running on the legacy layout. *Gate: decide before section 2 (task 2.2 implements the recommendation).*
5. **Install roots created outside this repository** keep a `bin/agentboard` launcher. Should the transition end only after their launchers move to `bin/kawai`? *Recommendation:* yes; the updater keeps refreshing both names in legacy roots until the owner says those launchers are updated. *Gate: before the follow-up change; this change implements the dual name either way (section 4).*
6. **Release-note visibility.** Should the first renamed release carry a prominent "Upgrading from agentboard" note in the GitHub Release body, not only in the README? *Recommendation:* yes, generated by `scripts/release.ts` for the transition releases. *Gate: decide before task 5.2 (`scripts/release.ts` output).*

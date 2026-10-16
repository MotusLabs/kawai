# Design

## Context

The legacy name shows up in several kinds of places, and each kind has a different compatibility cost. See the proposal's "Why" for the motivation.

- **Environment variables.** There are about 40 `AGENTBOARD_*` variables, read directly with `process.env.AGENTBOARD_X` in `config.ts`, `db.ts`, `chatProviderEnv.ts`, `developmentFixture.ts`, `terminal/*`, `updates/updateRestart.ts`, `bootstrap.ts`, and tests. Most are read once, when `config.ts` loads.
- **Data paths.** `config.ts` (log file, tmux PID file) and `db.ts` (`DEFAULT_DATA_DIR`) each hard-code `~/.agentboard`. `vite.config.ts` reads the dev TLS pem files from there, and `scripts/dev-server.ts` forces `LOG_FILE` there. `~/.kawai/` already exists for `groups/`, `routing/`, and `teams.json`, and none of those names collide with the files being moved.
- **tmux.** The session name is `config.tmuxSession`, which defaults to `agentboard`. Per-connection sessions are built as `${tmuxSession}-ws-${id}` in `ws/terminalProxy.ts` and pruned by prefix in `startupPreflight.ts`. `remoteSessions.ts` treats `sessionName === tmuxSessionPrefix` as managed. The database stores window targets with the session name, for example `agent_sessions.current_window = 'agentboard:@42'`.
- **Updater.** `installRoot.ts` refuses any compiled binary not named `agentboard`. `updateSwap.ts` hard-codes `LIVE_PATHS = ['bin/agentboard', 'dist/client']`. `updateDownload.ts` fetches `agentboard-<platform>.tar.gz`. `updateRestart.ts` falls back to `agentboard.service` and `com.agentboard`. Installed builds can only ever fetch the legacy tarball and only accept `bin/agentboard` inside it.
- **Installers.** Since `5c40867`, binary-running units have exported `AGENTBOARD_SYSTEMD_UNIT`. Older source-run units (`bun run start`) do not export it.
- **Client.** Four zustand `persist` keys use the `agentboard-` prefix: settings, theme, workspace, and session.

## Goals / Non-Goals

**Goals:**
- Look up every legacy name in one place, so the transition fallback can be removed later in one small change.
- No install loses data, tmux windows, browser settings, or the ability to self-update without a manual step.
- If a migration fails, the server keeps running on the legacy layout instead of a partly moved one.

**Non-Goals:**
- Renaming variables that have no prefix (`TMUX_SESSION`, `LOG_FILE`, `PRUNE_WS_SESSIONS`, `REMOTE_*`).
- Rewriting historical documents (`openspec/changes/archive/`, `.pl4n/`, `notes/`, `docs/handovers/`, `docs/refactor-analysis/`).
- Removing the legacy fallbacks. That belongs to a follow-up change after the transition window.
- Moving `~/.agentboard/app` or `~/.agentboard/bin`. Only the installers retire those.

## Decisions

### 1. One env helper with a legacy fallback
Add `src/server/env.ts` with `readEnv(name)`, where `name` is the unprefixed suffix such as `'CHAT_ENV'`. It returns `process.env.KAWAI_<name>` when that is non-empty. Otherwise it returns `process.env.AGENTBOARD_<name>` and, the first time per name, writes `console.warn('[kawai] AGENTBOARD_<name> is deprecated; use KAWAI_<name>')`. The warning goes to the console because the logger is not set up yet when `config.ts` loads; `config.ts` already warns this way. It never logs the value. Every direct `process.env.AGENTBOARD_*` read is replaced with a call to the helper. Code that writes variables for child processes uses only the new names, for example the paste helper's `KAWAI_PASTE_IMAGE_MAX_BYTES`. Strippers and fingerprints check both names: `tmuxEnv.ts` and the `STATIC_DIR` fingerprint in `SessionManager.ts`.
*Alternative:* copy every legacy variable into `process.env` at startup. That is simpler, but it changes the environment inherited by tmux and agent children and spreads the deprecation logic out of sight. Rejected.

### 2. One data-home resolver that also migrates
Add `src/server/dataHome.ts`. `resolveDataHome()` is memoized and returns `{ dir, legacy: boolean }`, and both `config.ts` and `db.ts` take their defaults from it. That removes today's duplicated `~/.agentboard` constant. The migration runs only when `KAWAI_DB_PATH` (or its legacy name) is unset, `~/.kawai/kawai.db` is missing, and `~/.agentboard/agentboard.db` exists. A pure `planDataHomeMigration(listing)` returns the list of `(from, to)` moves from a fixed allowlist:
- `agentboard.db` and its `-wal`, `-shm`, `-journal` files, renamed to `kawai.db` and so on
- `agentboard.log` and any rotated `agentboard.log.*`, renamed to `kawai.log*`
- `chat-wire/`, `chat-workers/`, `tmux-server.pid`, `tls-cert.pem`, `tls-key.pem`

Entries outside the allowlist stay in place: `app/`, `bin/`, `launchd.*.log`, and unknown files. Moves use `fs.renameSync`. If any rename fails (for example `EXDEV`, or a destination already exists), the completed moves are undone in reverse order and the server runs on the legacy directory, with `legacy: true` and an error logged once the logger is ready. There is no copy fallback, because copying a live SQLite database is how stores get corrupted.

**In-use guard:** before moving anything, the resolver opens the legacy database and runs `PRAGMA wal_checkpoint(TRUNCATE)`. If the result reports busy, another process still has the database open, for example an old instance on a different port. The resolver then skips the migration, runs on the legacy directory, and logs why. The next start tries again.
*Alternative:* migrate inside `initDatabase`. Rejected because the log file path is chosen earlier, in `config.ts`.

### 3. tmux session rename and stored targets
In `SessionManager.ensureSession`, before the exact-match `has-session` check, and only when `TMUX_SESSION` is unset: if `=agentboard` exists and `=kawai` does not, run `tmux rename-session -t =agentboard kawai`. Then a new database method `rewriteWindowSessionPrefix('agentboard', 'kawai')` runs `UPDATE … SET current_window = 'kawai:' || substr(current_window, 12) WHERE current_window LIKE 'agentboard:%'`, plus the same update for any other column found to store tmux targets (implementation task 3.3 audits these). It runs in one transaction before the first refresh. Startup pruning uses both `<session>-ws-` and the legacy `agentboard-ws-` prefix. Remote discovery takes a list of managed names, `[tmuxSession, 'agentboard']`, and a list of ws prefixes.
*Alternative:* keep using an existing `agentboard` session indefinitely. Rejected, because then the rename would never finish on long-lived hosts.

### 4. Updater: accept both binary names; dual tarballs for a transition window
- `installRoot.ts` accepts the basename `kawai` or `agentboard` and reports `binName`. The source-run target becomes `~/.kawai/app/bin/kawai`.
- `updateDownload.ts` fetches `kawai-<platform>.tar.gz`, which always contains `bin/kawai`.
- The swap's live paths come from the install root: `['bin/kawai', 'dist/client']`, plus `'bin/agentboard'` when `binName === 'agentboard'`. For a legacy root, the installer copies the staged `bin/kawai` to `bin/agentboard` in staging, so the existing all-or-restore swap covers all three paths. A live path that does not exist yet (the first `bin/kawai` in a legacy root) is moved in with nothing set aside, and restore removes it.
- `release.yml` keeps building `package/kawai-<platform>/bin/kawai`. The publish job then derives `agentboard-<platform>.tar.gz` from the same artifact by copying `bin/kawai` to `bin/agentboard`, so the two builds are identical and no extra artifact upload is needed. `scripts/release-checksums.sh` takes the list of tarball base names and requires all eight.

Old updaters fetch `agentboard-<platform>.tar.gz`, swap `bin/agentboard`, and restart into the new build, which from then on fetches the Kawai tarball. In a legacy root it keeps refreshing both names.
*Alternative:* symlink `bin/agentboard` to `kawai`. Rejected: `process.execPath` and launchd/systemd behavior with symlinked executables differ by platform, and a real copy keeps the swap and restore logic uniform.

### 5. Restart target resolution
`detectRestartContext` resolves the systemd unit in this order: `readEnv('SYSTEMD_UNIT')` (new, then legacy), then the unit name parsed from `/proc/self/cgroup` (the last path segment ending in `.service`, on Linux only), then `kawai.service`. The launchd label order is `readEnv('LAUNCHD_LABEL')`, then `XPC_SERVICE_NAME`, then `com.kawai`. The cgroup step covers old source-run units that never exported an override and used to be caught by the `agentboard.service` default. The drop-in becomes `50-kawai-update.conf`. If a legacy `50-agentboard-update.conf` exists for the same unit, it is removed when the new one is written, so two drop-ins never fight over `ExecStart`.

### 6. Installers retire the legacy service
`systemd/install.sh`: when `~/.config/systemd/user/agentboard.service` exists, it runs `systemctl --user disable --now agentboard.service`, removes the unit file and its `.d/` directory, and runs `daemon-reload`. Then it installs `kawai.service`, which runs `~/.kawai/app/bin/kawai` and exports `KAWAI_SYSTEMD_UNIT=kawai.service`. `launchd/install.sh` does the same for `com.agentboard` and `com.agentboard.logrotate`, replacing them with `com.kawai` and `com.kawai.logrotate`. Both scripts print, without running it, a cleanup command for `~/.agentboard/app` and `~/.agentboard/bin`. Data is never touched; the server migrates it on its first start (Decision 2).

### 7. Client storage key migration
Add `src/client/utils/legacyStorage.ts` with `migrateStorageKey(legacy, next)`. It copies the value only when `next` is missing, then removes `legacy`, and uses the existing safe wrappers in `storage.ts`. The client runs it for the four keys at module load, before the zustand `persist` stores hydrate (imported first from the client entry). Persist versions and migrations are unchanged, because the stored value moves as-is.

### 8. Mechanical rename for everything else
User-visible text, log prefixes (`[kawai]`, `[kawai:settings]`), temp-name prefixes, `__kawai_root__`, `agentboard-pipes` (renamed to `kawai-pipes`), `scripts/agentboard-window.sh` (renamed to `kawai-window.sh`), CI, docs, `CLAUDE.md`, and tests. Each is a plain rename with no fallback. These names only exist for the life of one process, or they are internal. A process restart re-creates `__kawai_root__` safely, because the bootstrap-window check already tolerates a base session that has other windows.

## Risks / Trade-offs

- **An old instance keeps writing to `~/.agentboard` after the migration** (for example a dev server still running) → the in-use guard skips the migration while the database is open. A process started afterwards with an explicit `AGENTBOARD_DB_PATH` keeps its own path.
- **The tmux rename affects a user who deliberately runs both builds on one tmux server** → the rename happens only when no `kawai` session exists and `TMUX_SESSION` is unset. Setting `TMUX_SESSION=agentboard` opts out.
- **A legacy root keeps two copies of a roughly 100 MB binary** → this is accepted for the transition. Re-running the installer moves the host to `~/.kawai/app` with a single binary.
- **External scripts that grep for `agentboard` (log names, `tmux ls`, `launchctl list`) break** → the release notes list every renamed identifier. Environment variables keep working through the fallback.
- **The cgroup unit parse is wrong on unusual setups** → the explicit override (new or legacy) always wins, and the installers export it.
- **The transition window has no fixed end** → the follow-up removal change is noted in the proposal. The legacy names are confined to `env.ts`, `dataHome.ts`, `legacyStorage.ts`, the tmux and remote prefix lists, `installRoot.ts`, and the release publish step, so the removal is easy to find.

## Migration Plan

1. Ship the renamed build. Its release carries both the `kawai-*` and `agentboard-*` tarballs.
2. Existing installs self-update through the legacy tarball. On first start the build migrates `~/.agentboard` data into `~/.kawai`, renames the tmux session, rewrites stored targets, and keeps restarting through the unit that launched it.
3. Operators rename their `AGENTBOARD_*` variables when they see the deprecation warnings, and optionally re-run the installer to move to `kawai.service` or `com.kawai`.
4. **Rollback:** before step 2, nothing changed. After step 2, the legacy build would look for `~/.agentboard/agentboard.db`. To roll back, stop the service, move `~/.kawai/kawai.db*`, `kawai.log`, `chat-wire/`, `chat-workers/`, and `tmux-server.pid` back under their legacy names, run `tmux rename-session -t kawai agentboard`, reverse the stored-target rewrite with the documented `UPDATE … 'agentboard:' || substr(current_window, 7) …`, then start the legacy binary. Document this sequence in the README's upgrade notes.

## Open Questions

- How long does the transition window last before the follow-up removes the legacy tarballs and environment fallback? (For example: two minor releases, or until the owner confirms all known hosts are migrated.) This affects only the follow-up change.

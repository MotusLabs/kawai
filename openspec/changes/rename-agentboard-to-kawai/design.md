# Design

This change stays one executable change with six ordered internal task
groups (tasks.md): **1** env aliases, **2** client storage keys, **3**
data-home migration, **4** tmux session, **5** release, updater, installers
and services, **6** docs. The groups share `config.ts`, `db.ts`,
`SessionManager.ts`, the e2e harness, and `AGENTS.md`, so one serialized
writer carries them in order; no `rename-*` sibling change exists or is
planned. Live cutover of the owner's install (data directory, service unit,
tmux session hosting live agents, profile chat-env wiring) is owner-only and
is never agent work (tasks 6.9, X1).

The first inventory was taken on master `492eada6` (2026-10-16). The section
below re-takes it at `f52963d0` (2026-11-17); where the two differ, the
current one is authoritative and the older Decisions text is annotated.

## Current inventory at f52963d0

Static `git grep` only; nothing was run. Counts exclude
`openspec/changes/archive/`, `notes/`, `.pl4n/`, and `docs/refactor-analysis/`.

**Environment variables.** 37 distinct `AGENTBOARD_*` names are read in
non-test `src/` (23 files); 41 distinct names appear across tracked files
including installers and tests; 56 `src/` files mention one when tests are
included; 48 `tests/e2e` files hold 124 occurrences. Non-test readers:

| Name | Non-test sites (`file:line`) |
|---|---|
| `CHAT_ENV` | `src/server/config.ts:191,193`, `src/server/bootstrap.ts:88`, `src/server/chat/chatProviderEnv.ts:4,53,65`, `src/server/chat/codexProfiles.ts:59,82` (new since 492eada6), `src/server/routes/chatProviderEnv.ts:4`, `src/shared/chatProviderSettings.ts:12`, `src/client/components/ChatProviderSettings.tsx:25` |
| `PROJECT_DIR` | `src/server/config.ts:187`, `src/server/routes/serverInfo.ts:70`, `src/client/App.tsx:49,135`, `src/client/components/SettingsModal.tsx:37,251`, `src/client/stores/settingsPresets.ts:63` (new) |
| `STATIC_DIR` | `src/server/bootstrap.ts:443`, `src/server/tmuxEnv.ts:6,11,22`, `src/server/SessionManager.ts:254,275` |
| `PREFER_WINDOW_NAME` | `src/server/config.ts:216`, `src/server/SessionManager.ts:750`, `src/server/displayName.ts:8`, `src/server/routes/settings.ts:80`, `src/client/components/Terminal.tsx:1287,1497` |
| `TMUX_SET_CLIPBOARD` | `src/server/terminal/PtyTerminalProxy.ts:34,36,37,506` |
| `TMUX_SYNC` | `src/server/terminal/TerminalProxyBase.ts:20,24,25` |
| `PASTE_IMAGE_MAX_BYTES` | `src/server/config.ts:195`, `src/server/routes/paste.ts:24,139` (child env) |
| `CLAUDE_NO_FLICKER` | `src/server/config.ts:223,225,226` |
| `CHAT_FIXTURE_HOLD_MS`, `CHAT_FIXTURE` | `src/server/chat/developmentFixture.ts:9,19,24,204` |
| `WS_DEFLATE` | `src/server/config.ts:145`, `src/server/ws/socketHandlers.ts:81` |
| `DB_PATH` | `src/server/db.ts:182,184` |
| `REMOTE_HOSTS`, `REMOTE_POLL_MS`, `REMOTE_TIMEOUT_MS`, `REMOTE_STALE_MS`, `REMOTE_SSH_OPTS`, `REMOTE_ALLOW_CONTROL`, `REMOTE_ALLOW_ATTACH` | `src/server/config.ts:109–136` |
| `LOG_POLL_MS`, `LOG_POLL_MAX`, `RG_THREADS`, `LOG_MATCH_WORKER`, `LOG_MATCH_PROFILE`, `LOG_WATCH_MODE`, `ENTER_REFRESH_MS`, `WORKING_GRACE_MS`, `INACTIVE_MAX_AGE_HOURS`, `EXCLUDE_PROJECTS`, `SKIP_MATCHING_PATTERNS`, `TMUX_PID_FILE`, `HOST`, `LOG_MATCH_YIELD_MS`, `TMUX_TIMEOUT_MS`, `TMUX_MUTATION_TIMEOUT_MS` | `src/server/config.ts:16–159` |
| `SYSTEMD_UNIT`, `LAUNCHD_LABEL` | `src/server/updates/updateRestart.ts:38,41` |
| `DIR`, `STATE_DIR` (installer-only) | `launchd/install.sh:11–13,43,153`, `systemd/install.sh`, `launchd/README.md` |

Outside `src/`: `AGENTBOARD_CHAT_FIXTURE` 78 occurrences (`.github/workflows/ci.yml:173`
fixture step, `playwright.config.ts`, `scripts/e2e-fixture-specs.ts:14`
`FIXTURE_VAR = 'AGENTBOARD_CHAT_FIXTURE'` and its test
`scripts/__tests__/e2eFixtureSpecs.test.ts`, README, 40+ e2e specs),
`AGENTBOARD_DB_PATH` 50 (`scripts/test-preload.ts:29`, `playwright.config.ts:46`, e2e),
`AGENTBOARD_STATIC_DIR` 18, `AGENTBOARD_REMOTE_HOSTS` 15,
`AGENTBOARD_TMUX_PID_FILE` 13, `AGENTBOARD_DIR` 10.

**Existing `KAWAI_*` names (keep; mixed prefix today):** `KAWAI_CODEX_PATH`,
`KAWAI_CLAUDE_PATH`, `KAWAI_TEST_JUNIT_DIR`, `KAWAI_TEST_WORKERS`,
`KAWAI_FULL_PROPERTIES`, `KAWAI_TEST_RUN_ROOT`, `KAWAI_TEST_DB_TEMPLATE`,
`KAWAI_REPLY_GUIDANCE`, `KAWAI_BUILD_VERSION`, `KAWAI_UPDATE_ENDPOINT`,
`KAWAI_NIGHTLY_FORCE_FAILURE`, `KAWAI_METRICS_TOKEN`, `KAWAI_METRICS_ENABLED`.
None collides with a renamed name.

**Data home.** `src/server/config.ts:87–88` (`defaultDataDir` `~/.agentboard`,
`agentboard.log`), `src/server/db.ts:179–181` (`DEFAULT_DATA_DIR`,
`agentboard.db`), `src/server/db.ts:193` (siblings beside the db),
`src/server/dbSafety/backupFiles.ts:3` (`agentboard-…` stem),
`scripts/dev-server.ts:5` (`LOG_FILE`), `vite.config.ts:80–81` (TLS pem),
`scripts/test-preload.ts:28–29`, `playwright.config.ts:46–47`,
`scripts/test-runner.ts:43` (`agentboard-tests-`), and the hint
`src/client/components/UpdatePanel.tsx:24`. `~/.kawai/` already holds
`groups/`, `routing/`, `teams.json`, `outbound.json`, `profiles.json`,
`providers.json`, and, written by the landed credential-store core
(`src/server/chat/credentialStore.ts`, dormant), `credentials.json`; the
readers are `profileCatalog.ts`, `outbound/destinations.ts`,
`team/groupCatalog.ts`, `team/routing/ruleLoader.ts`, `team/teamCaps.ts`.
None is a migration target.

**tmux.** `src/server/config.ts:204` default `'agentboard'`;
`scripts/agentboard-window.sh:4`; `src/server/tmuxFormat.ts:13`
`__agentboard_root__`; per-connection prefix derived as
`${session}-ws-` in `src/server/remoteSessions.ts:400`,
`src/server/sessionRefreshWorker.ts:314`, `src/server/startupPreflight.ts:3`;
remote managed test `remoteSessions.ts:441` (`sessionName === tmuxSessionPrefix`);
generated names `terminal/PipePaneTerminalProxy.ts:24`,
`terminal/TerminalProxyBase.ts:177`, `routes/paste.ts:50`,
`routes/pasteFile.ts:47`; e2e prefix `playwright.config.ts:9`. Stored tmux
targets: `agent_sessions.current_window` (`src/server/db.ts:237–251`);
re-check for other target columns before group 4 (task 4.3).

**Release, updater, services.** `.github/workflows/release.yml:43–163`
(artifacts `agentboard-<platform>`, `bin/agentboard`, smoke `./agentboard`);
`scripts/release-checksums.sh:11,28`; `scripts/release.ts:363` banner;
`src/server/updates/installRoot.ts:6,68–72,84`, `updateSwap.ts:2,17,55`
(`LIVE_PATHS`), `updateDownload.ts:49`, `updateInstaller.ts:4,52`,
`updateRestart.ts:38,41,47,49,143,150,184–196`; installers
`systemd/install.sh` (10 hits), `launchd/install.sh` (29),
`systemd/README.md` (14), `launchd/README.md` (34); `.gitignore`
`systemd/agentboard.service`.

**Client storage keys.** `src/client/stores/sessionStore.ts:9`
`agentboard-session`, `settingsStore.ts:293` `agentboard-settings`,
`themeStore.ts:22` `agentboard-theme`, `workspaceStore.ts:110`
`agentboard-workspace`. No other literal `agentboard-*` storage key.

**Text and comments.** 43 non-test `src/` files mention `agentboard`
(225 including tests); visible "Agentboard" strings include
`src/server/prerequisites.ts:29`, `ws/messageRouter.ts:81`,
`terminal/PtyTerminalProxy.ts:525`, `shared/chat.ts:596,599`,
`client/terminal/setup.ts:118`, `chat/provider/claudeDriverTypes.ts:53`.

**packages/agent-runtime.** One test file only
(`packages/agent-runtime/__tests__/activity.test.ts`); no runtime code uses
the legacy name. The package names (`@motuslabs/kawai`,
`@motuslabs/agent-runtime`) are already Kawai.

**Stale since 492eada6.** `src/server/chat/ChatSessionDriver.ts` no longer
exists (driver code lives under `src/server/chat/provider/` and the
runtime package); the three in-flight changes old task 8.3 named are archived
(`2026-10-18-execution-safety-recovery`, `2026-10-19-providers-and-workers`,
`2026-10-23-codex-chat-sessions`); fixture specs are now listed by
`scripts/e2e-fixture-specs.ts`, not by a hand-kept list in `ci.yml`.

## Source partition

Every requirement and scenario of this change's delta specs belongs to
exactly one group. Seven scenarios and one requirement are new in this
revision (marked †), added because the crash table H, the target-rewrite
table T, and the storage table K found unspecified cases (the last five
from review findings F1 and F2, including F2's explicit-path boundary and
its default-home alias).

| Capability › requirement | Scenarios | Group |
|---|---|---|
| runtime-naming › Operator environment variables use the KAWAI_ prefix | New name configures the server; Legacy name still configures the server; New name wins over legacy name | 1 |
| runtime-naming › Legacy environment names log a deprecation warning | One warning per legacy variable; Secrets are not logged | 1 |
| terminal-streaming › WebSocket compression is opt-in | Compression off by default; Compression enabled explicitly | 1 |
| terminal-streaming › Log-match captures yield to interactive traffic | Yield pause configuration; Match burst paced between windows; Wake-path matching uses the paced path | 1 |
| chat-sessions › Operators configure the chat provider from Settings | Settings override applies to the next spawn; Clearing the override restores the default | 1 |
| claude-session-profiles › Users select a predefined chat profile | Select a provider profile; Models are grouped by provider; Select a Codex profile; Project-level catalog extends the picker; Older client omits the profile; Catalog loading fails | 1 |
| claude-session-profiles › Named profiles configure independent provider sessions | Effective global provider overrides; Default and named profiles over the merged environment; GLM configuration; MiniMax and MiMo configuration; Kimi configuration; Profiles do not leak between sessions; Conflicting Claude settings; Global provider settings coexist with profiles | 1 |
| runtime-naming › Browser settings carry over to the Kawai storage keys | Settings survive the upgrade; New key is never overwritten; A failed copy keeps the legacy settings † | 2 |
| runtime-naming › Default data lives in the Kawai home directory | Fresh install uses the Kawai home; Explicit database path is honored; A new explicit database path is created †; An explicit path inside the Kawai home is honored † | 3 |
| runtime-naming › Legacy data directory is migrated on first start | Existing sessions survive the move; Program files stay in place; Existing Kawai team files are kept; Background-task outcomes survive the move; Already migrated | 3 |
| runtime-naming › The legacy database is backed up before it moves | Backup precedes the move; Failed backup stops the migration | 3 |
| runtime-naming › Existing database backups keep their rotation and recovery role | Migration backups stay findable; Owner files are untouched | 3 |
| runtime-naming › The migration never runs while another process holds the legacy database | Old instance still running | 3 |
| runtime-naming › A data migration that cannot complete leaves the legacy data usable | Cross-device move fails; Undo fails with the database still moved; A crash mid-migration recovers at the next start † | 3 |
| runtime-naming › A damaged migration record stops startup † | Unreadable record with the migrated database present †; Record with neither database present † | 3 |
| runtime-naming › The managed tmux session is named kawai | Running windows carry over; Tracked sessions keep their windows; Override is respected; Stored targets are rewritten after an interrupted rename † | 4 |
| runtime-naming › Legacy per-connection tmux sessions are pruned | Leftover legacy viewer sessions are removed | 4 |
| runtime-naming › Remote hosts on either name are recognized | Remote host not yet upgraded | 4 |
| app-updates › Update install verifies the tarball before extracting | Checksum mismatch refuses the update; Missing checksum file refuses the update; Matching checksum proceeds; Kawai tarball is downloaded | 5 |
| app-updates › Update install places both installed paths | Both paths are replaced; Legacy install root is updated in place; Partial layout is refused; Unknown binary name is refused | 5 |
| app-updates › Source checkouts install the release binary without rebuilding | Source install lands the binary; Git tree is untouched | 5 |
| github-workflows › Release binaries cross-compile from a single Linux job | All four platforms build on one runner; Frontend is built once | 5 |
| github-workflows › Release artifacts publish SHA256 checksums | Checksums accompany the release; Incomplete checksums block publishing; Legacy tarballs are covered | 5 |
| github-workflows › Releases publish legacy-named tarballs during the transition | Legacy updater finds its tarball; Legacy and Kawai tarballs carry the same build | 5 |
| runtime-naming › Service installers use Kawai service names | Re-running the installer on a legacy host; Data is not duplicated by the installer | 5 |
| runtime-naming › Restarts target the supervisor that launched the process | Legacy unit restarts itself; Legacy unit without an override | 5 |
| chat-debug › Chat protocol traffic is always captured | A turn's traffic is recorded; Control traffic is recorded; Non-JSON output is kept; Sequence continues after respawn | 6 |
| openspec-visibility › Automatically synchronize OpenSpec metadata | Task completion changes externally; Change is created externally; Rapid artifact writes occur | 6 |
| workspace-navigation › Automatically synchronize workspace metadata | External worktree is added; External branch or checkout changes; Discovery temporarily fails | 6 |

Totals: 29 requirements (28 original + 1 new); 78 original scenarios plus 7
new = 85. Every
MODIFIED block was re-derived against current main at `f52963d0`: each
equals the main requirement with only the rename edits (verified by a
textual diff of main vs delta after `AGENTBOARD_`→`KAWAI_` and
`Agentboard`→`Kawai`; the app-updates and github-workflows blocks add the
dual-name text and scenarios this change introduces). The earlier proposal
claim that the restated profile requirement swaps concrete gateway hosts
for reserved example hosts is stale: main and this delta carry the same
hosts, and no host changes.

### Source task map

All 35 original task ids at `f52963d0`, each mapped once.

| Old | Disposition | New |
|---|---|---|
| 1.1 | kept | 1.1 |
| 1.2 | kept | 1.2 |
| 1.3 | kept; adds `codexProfiles.ts`, `settingsPresets.ts` sites | 1.3 |
| 1.4 | kept | 1.4 |
| 1.5 | kept | 1.5 |
| 5.3 | moved to group 1 (CI/e2e env names incl. the fixture lister's `FIXTURE_VAR`; harness temp names are arbitrary, so renaming them early is safe); the obsolete "fixture invocation from ci.yml passes locally" check is replaced by the private fixture path | 1.6 |
| 7.1 | moved | 2.1 |
| 2.1 | kept | 3.2 |
| 2.2 | kept | 3.3 |
| 2.3 | kept | 3.4 |
| 2.4 | kept | 3.5 |
| 2.5 | kept | 3.7 |
| 2.6 | kept; `bun run dev` check replaced by a disposable-HOME check | 3.8 |
| 3.1 | kept | 4.1 |
| 3.2 | kept | 4.2 |
| 3.3 | kept; adds the idempotent startup rewrite (T6) and its recovery-matrix row | 4.3 |
| 3.4 | kept | 4.4 |
| 9.2 | moved; disposable HOME, private tmux socket only | 4.5 |
| 4.1 | kept | 5.1 |
| 4.2 | kept | 5.2 |
| 4.3 | kept | 5.3 |
| 4.4 | kept | 5.4 |
| 4.5 | kept | 5.5 |
| 5.1 | kept | 5.6 |
| 5.2 | kept | 5.7 |
| 6.1 | kept | 5.8 |
| 6.2 | kept | 5.9 |
| 9.3 | moved; compiled build outside `node_modules`, local release server | 5.10 |
| 8.1 | kept | 6.1 |
| 3.5 | moved (README is docs) | 6.2 |
| 6.3 | moved (installer READMEs are docs) | 6.3 |
| 7.2 | moved; the final residual-name sweep needs every compat site to exist; `ChatSessionDriver.ts` reference retargeted | 6.4 |
| 8.2 | kept | 6.5 |
| 8.3 | **retired** — all three named changes are archived (see inventory); replaced by the archive-time re-derivation check for shared requirements | 6.6 |
| 9.1 | replaced by the final campaign (clean committed pinned Bun 1.4.3 `bun run check --full-properties`, current verifier) | 6.7 |

New tasks without an old id: 1.7, 2.2, 3.10, 4.6, 5.11, 6.8 (group
checkpoints), 3.1 (blind second reading), 3.6 (crash reconciliation and its
recovery-matrix row), 3.9 (disposable migration rehearsal), and 6.9 (the
owner-only cutover row). 35 old ids map once each; 10 tasks are new; tasks.md
holds 45.

## Goals / Non-Goals

**Goals:**
- Look up every legacy name in one place per kind, so the transition fallback can be removed later in one small change.
- No install loses data, database backups, tmux windows, browser settings, or the ability to self-update without a manual step.
- A verified backup exists before any data moves.
- If a migration cannot complete, or the process dies during it, the server keeps or recovers the legacy layout instead of a partly moved one.

**Non-Goals:**
- Renaming unprefixed variables (`TMUX_SESSION`, `LOG_FILE`, `PRUNE_WS_SESSIONS`, `E2E_*`) or the existing `KAWAI_*` names.
- Rewriting historical documents.
- Removing the legacy fallbacks. That belongs to a follow-up change.
- Moving `~/.agentboard/app` or `~/.agentboard/bin`. Only the installers retire those.
- Changing install roots this repository does not create.
- A new database schema migration: the database moves as a file; its contents only change by the stored-target rewrite of Decision 3.
- Cutting over the owner's live install, publishing a release, or touching live data (owner-only, X1–X3).

## Decisions

### 1. One env helper with a legacy fallback
Add `src/server/env.ts` with `readEnv(name)`, where `name` is the suffix such as `'CHAT_ENV'`. It returns `process.env.KAWAI_<name>` when non-empty; otherwise `process.env.AGENTBOARD_<name>`, and the first time per name it writes `console.warn('[kawai] AGENTBOARD_<name> is deprecated; use KAWAI_<name>')`. The console is used because the logger is not set up when `config.ts` loads, as `config.ts` already does. It never logs the value. Every direct `process.env.AGENTBOARD_*` read is replaced. Code that sets variables for children uses only the new names. Strippers and fingerprints check both names (`tmuxEnv.ts`, the `STATIC_DIR` fingerprint in `SessionManager.ts`). The client never reads the environment; its Settings text just names `KAWAI_CHAT_ENV`. Test and CI harnesses (`scripts/test-preload.ts`, `playwright.config.ts`, `ci.yml`, `scripts/e2e-fixture-specs.ts`) set only the new names.
*Alternative:* copy every legacy variable into `process.env` at startup. That changes the environment inherited by tmux and agent children and hides the deprecation logic. Rejected.

### 2. One data-home resolver that backs up, then migrates
Add `src/server/dataHome.ts`. `resolveDataHome()` is memoized and returns `{ dir, legacy, outcome }`; `config.ts` and `db.ts` take their defaults from it, removing today's duplicated `~/.agentboard` constant. The sibling stores keep deriving from the database directory. **Mode first.** The resolver selects its mode before anything else, from `v = readEnv('DB_PATH')`: the generic helper keeps its raw first-non-empty E semantics (E6/E7: a literal empty `KAWAI_DB_PATH` falls back to `AGENTBOARD_DB_PATH`), and only this database setting is then trimmed, as `db.ts:186` trims it today. *Explicit mode*: `v.trim()` is non-empty. *Default mode*: anything else; steps 1–6 apply. A whitespace-only value is a **proposed database-only change**: today `db.ts:185-189` passes the trimmed `''` to SQLite, and this change makes it default mode (W10). No other variable is trimmed. With a whitespace-only `KAWAI_DB_PATH` and a set `AGENTBOARD_DB_PATH`, the raw new value wins in `readEnv` before the trim, so the mode is default and the legacy value is not consulted (W10b).

*Explicit mode delegates to today's baseline.* The target `t` is `:memory:` as given, or else `resolveProjectPath(v)` (`~` expansion, `path.resolve`; `paths.ts:6-21`). `initDatabase(t)` then behaves exactly as today, with its result or its error (`db.ts:209-230`, `:676-690`). The resolver runs no migration-owned step: no in-use probe, no `pre-rename` backup, no move or undo, no intent-record write or removal, and no refusal. A record under `~/.kawai/` is only reported by path and parse status. Alongside the database, the resolver chooses a **passive home `P`** from read-only presence checks, memoized before any target effect: `~/.kawai` when `~/.kawai/kawai.db` exists; otherwise `~/.agentboard`, with legacy names, when `~/.agentboard/agentboard.db` exists; otherwise `~/.kawai`. If the presence checks cannot be read, `P` falls back to `~/.kawai` and reports "unknown". It never triggers a migration or rejects the selected database. `P` names the default log, the `tmux-server.pid` file, and the sibling directory for `:memory:`. The `LOG_FILE` and `KAWAI_TMUX_PID_FILE` overrides (legacy `AGENTBOARD_TMUX_PID_FILE`, `config.ts:91`) keep their precedence. This is a new rename policy: today `config.ts:87-92` uses the fixed legacy home whatever `DB_PATH` is. A constant `~/.kawai` would create a `kawai.log` while legacy data awaits migration, and a later default start would then stop at H7. The Vite dev TLS files (`vite.config.ts:80-84`) are a separate consumer: they use the same exported presence rule (task 3.5), never an assumed `config.ts` read.

*Effect ownership* (explicit and default modes). Effects are compared with today's baseline for the same selected target, options, and observation phase:
- **Φ(t)** is the allowed effect footprint of the ordinary `initDatabase(t)`: the parent `mkdir -p` and `chmod 0700`; creating, opening, writing the schema of, and compacting `t` and `t-journal`; `dirname(t)/backups/` with `stem(t)` snapshots, `.partial` and `.corrupt` files, and rotation of that stem's victims only (`backups.ts:80-82`, `migrations.ts:303-306`); and the sibling stores `chat-wire/`, `chat-workers/`, and `chat-tasks/` under `dirname(t)`, or under `P` for `:memory:`.
- **N(P)** is the ordinary non-database footprint: the log (the eager logger opens it at module load, `logger.ts:92,121`), the pid file, the TLS files, and the `~/.kawai` team and config files written in every mode.
- Both footprints are permissions, not claims that a lazy file exists. A failing start allows only the prefix it actually reached.
- **M(row)** is the migration-effect prefix of the matched default row.
- **The untouched set U** is every pre-existing entry outside the effects actually permitted: Φ ∪ N in explicit mode, M(row) ∪ Φ(t_d) ∪ N in default mode, where `t_d` is the served database. U protects unrelated entries, never whole directories.

An explicit target may alias a default-home path: `~/.kawai/kawai.db`, the legacy database, or even the intent-record path. Each aliased path then changes only through Φ or N, and the collision is reported. No path is banned. The record's bytes are protected exactly when the record lies outside the selected footprint (W1, W11).

The migration runs only in default mode, when `~/.kawai/kawai.db` is missing and `~/.agentboard/agentboard.db` exists. Steps:

1. **In-use guard.** Rollback-journal SQLite gives no reliable "another process has it open" signal (an idle connection holds no lock), so the resolver checks open handles directly: on Linux, `/proc/*/fd` links to the database inode; on macOS, `lsof -t`. If another process holds it, or the check cannot run, skip the migration, run on the legacy directory, and report why. The next start tries again.
2. **Backup first.** Open the legacy database read-only, take a snapshot through the `DatabaseBackups` copy path (`serialize()`, `.partial`, fsync, rename, `integrity_check`) as `backups/agentboard-<stamp>-pre-rename.db`, and close. A failed or corrupt backup aborts the migration (legacy layout, error reported). Rotation keeps every `pre-rename` backup until the follow-up change.
3. **Plan.** A pure `planDataHomeMigration(listing)` returns `(from, to)` moves from a fixed allowlist: `agentboard.log` and rotated `agentboard.log.*` → `kawai.log*`; `chat-wire/`, `chat-workers/`, `chat-tasks/`, `tmux-server.pid`, `tls-cert.pem`, `tls-key.pem` as-is; `backups/` as a directory, then each `agentboard-<stamp>-<reason>.db[.corrupt|.partial]` inside it → `kawai-…`; and **last** `agentboard.db-journal` then `agentboard.db` → `kawai.db*` (a hot journal moves with its database, immediately before it). Files that `parseBackupFile` does not recognize stay as named. `app/`, `bin/`, `launchd.*.log`, and unknown entries stay in `~/.agentboard/`. Existing `~/.kawai/` entries (including `credentials.json` and the team files) are never targets; a destination that exists aborts the plan before any move.
4. **Intent record.** Before the first move, write `~/.kawai/.data-home-migration.json` (the plan's `(from, to)` list and the backup path, no data) through temp file, fsync, rename, and directory fsync.
5. **Apply.** `fs.renameSync` in plan order. If any rename fails (for example `EXDEV`), the completed moves are undone in reverse order, the intent record is removed, and the process runs on the legacy directory. If an undo rename itself fails, the server logs both paths of every entry not put back; it keeps running on the legacy directory only if `agentboard.db` (with its journal) is back in place, and otherwise exits with an error naming the `pre-rename` backup. After the final move (the database), the intent record is removed and the directory fsynced. Nothing is ever deleted: every entry stays at one of its two paths. There is no copy fallback for the live database; the step-2 backup is the safety copy.
6. **Startup reconciliation (new, H12–H15).** When the intent record exists at startup the process died mid-apply. Because the database moves last: if `~/.kawai/kawai.db` exists, every other move already happened, so the resolver removes the record and runs on `~/.kawai/` (roll forward); otherwise it undoes every recorded move whose destination exists and source is absent, leaves any entry present at both paths in place and reports it, removes the record when nothing is left at a destination, and then runs the normal migration (steps 1–5) again. Invariant (default mode only): while a record exists, the resolver never serves, opens, or creates a database path that does not already exist; recovery serves only a validated existing database (H12), and in default mode the only database created is a fresh `~/.kawai/kawai.db` with no record and neither database present (H3). Creating an absent explicit path is explicit mode's ordinary behavior, not recovery, and stays as it is. So a record it cannot parse (H14), whatever databases exist, and a valid record with neither database present (H15) both stop startup: the process exits non-zero before `initDatabase`, moves nothing, opens and creates no database, and logs the record path, both database paths with whether each exists, and the newest `pre-rename` backup it can find. These are early refusals. They perform no migration effect and no database initialization. The ordinary logger effects N(P) reached before them stay allowed: `P` is evaluated read-only, and no pre-logger gate is added. H11 is a late refusal. It keeps the `pre-rename` backup and the strays its earlier steps produced, and it forbids only further database initialization. The operator repairs by inspecting both directories and removing the record (rollback notes, task 6.1). *Alternative:* serve whichever database exists. Rejected: an unreadable record cannot say which siblings moved, so serving either side may split logs and sidecars; refusal is the smallest safe rule. This is a startup reconciliation, so it gets a `docs/recovery-matrix.md` row (task 3.6).

The outcome is logged once the logger is ready. `initDatabase` then runs unchanged on `kawai.db`, so its own `startup` snapshot follows the move.
*Alternative:* migrate inside `initDatabase`. Rejected, because the log path is chosen earlier in `config.ts`, and the backup must precede any move. *Alternative:* no intent record, database first (the 492eada6 design). Rejected: a crash after the database moved would leave the siblings in `~/.agentboard` with `kawai.db` present, which the "already migrated" rule then never repairs.

### 3. tmux session rename and stored targets
In `SessionManager.ensureSession`, before the exact-match `has-session` check, and only when `TMUX_SESSION` is unset: if `=agentboard` exists and `=kawai` does not, run `tmux rename-session -t =agentboard kawai`. A new database method `rewriteWindowSessionPrefix('agentboard', 'kawai')` then runs in one transaction before the first refresh: it clears `current_window` on rows still pointing at `kawai:` (dead, since no `kawai` session existed), then rewrites `agentboard:%` to `kawai:` plus the suffix, so the unique index cannot collide. The rewrite is also an idempotent startup reconciliation: whenever the managed session is the default `kawai`, no `=agentboard` session exists, and rows still point at `agentboard:`, it runs (covering a process that died between the rename and the rewrite, T6). Startup pruning matches both `<session>-ws-` and `agentboard-ws-`, and the local discovery filters in `SessionManager.ts` and `sessionRefreshWorker.ts` skip both. Remote discovery takes a list of managed names, `[tmuxSession, 'agentboard']`, and of ws prefixes. The server never kills the base `agentboard` session or any session with windows; `tmux rename-session` keeps every window and process.
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
`systemd/install.sh`: when `~/.config/systemd/user/agentboard.service` exists, run `systemctl --user disable --now agentboard.service`, remove the unit and its `.d/`, and `daemon-reload`. Then install `kawai.service` running `~/.kawai/app/bin/kawai` with `KAWAI_SYSTEMD_UNIT=kawai.service`. `KAWAI_DIR` replaces `AGENTBOARD_DIR` (legacy still read). `launchd/install.sh` does the same for `com.agentboard` and `com.agentboard.logrotate`, replacing them with `com.kawai` and `com.kawai.logrotate`, wrappers `kawai-run.sh` and `kawai-log-rotate.sh` under `~/.kawai/bin`. Both print, without running it, a cleanup command for `~/.agentboard/app` and `~/.agentboard/bin`. Data is never copied or deleted; the server migrates it on first start (Decision 2). Installer tests run against fixture homes with stubbed `systemctl`/`launchctl`; no test touches a real unit.

### 7. Client storage key migration
Add `src/client/utils/legacyStorage.ts` with `migrateStorageKey(legacy, next)`. It works on the persistent `localStorage` directly, never through `storage.ts`'s safe wrappers, because `safeStorage.setItem` (`src/client/utils/storage.ts:29-38`) swallows a failed write into a per-tab memory copy that does not survive reload, while `removeItem` (`:40-48`) can still delete the persistent legacy key. Invariant: a legacy key is removed only after `localStorage.getItem(next)` returns a value read back from persistent storage (equal to the legacy bytes when this call wrote it). When `next` is missing it writes the legacy bytes with `localStorage.setItem`, reads them back, and removes `legacy` only if they match. If the write throws (for example `QuotaExceededError`) or the read-back differs, it leaves both keys as they are and reports `retained`; the four stores' persist storage then reads `next`, falling back to the legacy key's bytes while `next` is absent, so the settings stay in effect, and the next load tries again. When storage is unavailable or `getItem` throws, it does nothing. It runs for the four keys at module load, imported first from the client entry, before the `persist` stores hydrate. Persist versions and migrations are unchanged, because the stored value moves as-is. Local choice (K3): the legacy key is removed even when the new key already exists, so a stale legacy value can never resurface; the cost is that rolling back to a legacy client starts from default browser settings, which the rollback notes state.

### 8. Mechanical rename for everything else
The generated and internal names, user-visible text, comments, CI, docs, `AGENTS.md`, and tests from the inventory are plain renames with no fallback. They live for one process or are internal. A restart re-creates `__kawai_root__` safely, because the bootstrap-window check already tolerates a base session with other windows.

## Acceptance oracles

Every row is observable. `*` is a don't-care. Each table is committed
verbatim as a table-driven test beside the code it covers (tasks.md names
the file and the mutant each must kill).

### E — env precedence and warn-once (group 1)

| # | `KAWAI_X` | `AGENTBOARD_X` | Value read | Warnings for X in this process |
|---|---|---|---|---|
| E1 | non-empty | unset | `KAWAI_X` | 0 |
| E2 | unset | non-empty | `AGENTBOARD_X` | exactly 1, naming both names, no value |
| E3 | non-empty | non-empty, equal | `KAWAI_X` | 0 (spec: a value from `KAWAI_` never warns) |
| E4 | non-empty | non-empty, different | `KAWAI_X` | 0 |
| E5 | unset | unset | undefined; the setting's default applies | 0 |
| E6 | empty string | non-empty | `AGENTBOARD_X` | exactly 1 |
| E7 | empty string | unset or empty | undefined; default | 0 |
| E8 | * | non-empty, read N≥2 times | as E2/E6 | still exactly 1 |
| E9 | child env written by the server (paste helper, e2e servers) | — | only `KAWAI_` names are set | — |
| E10 | strippers and fingerprints (`tmuxEnv.ts`, `SessionManager` `STATIC_DIR`) | either name present | both names stripped / recognized | — |

**Property PE (precedence and secrecy).** For random maps over the 37 suffixes
(each name unset / empty / random value with secret-shaped and unshaped
sentinels) and random read sequences, `readEnv` returns the first non-empty
of `KAWAI_`, `AGENTBOARD_`; the warning count equals the number of distinct
suffixes whose returned value came from the legacy name; no warning contains
any value byte sequence. Generator: seeded PRNG over the inventory list;
seams: `readEnv` with an injected env and console; seed `0x4b415731`; 200
cases (`propertyCases`); no new dependency.

### K — client storage keys (group 2)

| # | `kawai-*` | `agentboard-*` | Store hydrates from | After migration |
|---|---|---|---|---|
| K1 | present | absent | new key | unchanged |
| K2 | absent | present; persistent write and read-back succeed | new key holding the legacy bytes, before hydration | legacy key removed after the read-back matched |
| K3 | present in persistent storage | present | new key, unchanged | legacy key removed |
| K4 | absent | absent | defaults | nothing written |
| K5 | storage unavailable or `getItem` throws | * | defaults; no exception escapes | nothing written or removed |
| K6 | absent | present, malformed JSON | the bytes move as-is; the store's existing malformed-value handling applies | legacy key removed after the read-back matched |
| K8 | absent | present; `setItem` throws (`QuotaExceededError`) while `getItem` and `removeItem` work | the legacy bytes, read through the fallback | legacy key kept in persistent storage; no new key persisted; outcome `retained`; retried next load |
| K9 | absent | present; `setItem` returns but the read-back is absent or differs | the legacy bytes, read through the fallback | legacy key kept; outcome `retained` |

K8 is the reviewer's counterexample (both persistent keys were gone after
the safe-wrapper copy and remove); its control is a reload after K8, which
must still find `agentboard-settings` in persistent storage.

Ordering oracle K7: the migration runs before any of the four stores
hydrates (asserted through the real client entry import order, not a
direct call).

### H — data-home migration, held DB, backup, crash, rollback (group 3)

Mode (Decision 2 "Mode first"): explicit when `readEnv('DB_PATH')` is
non-blank after trimming, otherwise default. The two modes have separate
tables. Footprints Φ, N, M(row) and the untouched set U are as defined in
Decision 2 *Effect ownership*. Every row permits its stated effects and the
Φ/N effects it actually reaches, and leaves every entry in U unchanged.

**Explicit mode (X).** Axes: target kind (`:memory:` / filesystem path) ×
the target existed before start (yes / no; path only) × `initDatabase(t)`
(returns / throws). Each row holds for **every** default-home state:
`~/.kawai/kawai.db` (present / absent) × legacy db (present / absent) ×
intent record (absent / valid / unparseable). That state changes only the
report and `P`, never the row.

| # | Target and outcome | Serves | Permitted effects | Migration effects | Logged / exit |
|---|---|---|---|---|---|
| X1 | path, existed, `initDatabase` returns | `t` | Φ(t) ∪ N(P); a failed startup snapshot stays non-fatal as today | none | a record, if any, by path and parse status; an alias of a default-home or record path names both paths |
| X2 | path, absent, `initDatabase` returns | `t`, created with its parents as today | Φ(t) ∪ N(P) | none | as X1 |
| X3 | path or `:memory:`, `initDatabase` throws (target is a directory, EACCES, non-database bytes, newer schema, lineage mismatch, failed migration or pre-migration backup, uncreatable parent, or a failing in-memory migration) | — | only the Φ prefix reached before the throw, plus N(P) | none | today's failure: a `DatabaseStartupError` gets `openDatabaseOrExit`'s message and exit (`bootstrap.ts:566-575`); any other error propagates as today |
| X4 | `:memory:`, `initDatabase` returns | in-memory database | sibling stores under `P`, plus N(P); no database file or backup | none | as X1 |

**Default mode (H).** Axes: `~/.kawai/kawai.db` (present / absent) ×
legacy db (present / absent) × intent record (absent / valid / unparseable) ×
in-use probe (free / held / unavailable) × backup (ok / fails) × plan
(ok / destination exists) × apply (ok / move k fails) × undo (ok / fails with
legacy db restored / fails with db not restored).

| # | Inputs | Serves from | Moves | Logged / exit |
|---|---|---|---|---|
| H2 | `kawai.db` present, no record, * | `~/.kawai` | none (legacy untouched even if present) | — |
| H3 | both dbs absent, no record | `~/.kawai` (fresh) | none | — |
| H4 | legacy only, no record, probe held | `~/.agentboard` | none | reason "held", retried next start |
| H5 | as H4, probe unavailable | `~/.agentboard` | none | reason "unavailable" |
| H6 | probe free, backup fails or fails integrity | `~/.agentboard` | none | backup error |
| H7 | backup ok, a destination exists | `~/.agentboard` | none; the pre-existing destination is kept as it was and is not counted as migrated (backup stays under legacy `backups/`) | destination named |
| H8 | plan ok, apply ok | `~/.kawai` | all allowlisted entries; db last; record removed | outcome "migrated"; `pre-rename` backup in `~/.kawai/backups/` |
| H9 | move k fails, undo ok | `~/.agentboard` | none net; record removed | entry and cause named |
| H10 | move k fails, undo fails, legacy db in place | `~/.agentboard` | strays stay at their destination | both paths of each stray |
| H11 | move k fails, undo fails, legacy db not in place | — (late refusal: no further database initialization) | as found: the `pre-rename` backup, completed moves, strays, and the record are kept as the earlier steps left them | exit non-zero naming the `pre-rename` backup |
| H12 | restart with valid record, `kawai.db` present | `~/.kawai` | none; record removed (roll forward) | "completed interrupted migration" |
| H13 | restart with valid record, `kawai.db` absent | per the re-run (H4–H11) | recorded moves undone first; entries at both paths left and reported | "rolled back interrupted migration" |
| H14 | restart with unparseable record; any of `kawai.db` present/absent × legacy db present/absent | — (early refusal: no database opened or created) | none | exit non-zero naming the record path, both database paths with presence, and the newest `pre-rename` backup |
| H15 | restart with valid record, `kawai.db` absent, legacy db absent | — (early refusal: no database opened or created) | none; record kept | exit non-zero naming the record, both database paths, and the record's `pre-rename` backup |

Precedence: the mode decides first. Explicit mode matches exactly one of
X1–X4 by target kind, prior existence, and the `initDatabase` outcome. A
record there is reported, never applied. Default mode matches H14, H15, H12,
H13 (record rows), then H2–H11. A later start without the override returns
to default mode, where an unreadable record still refuses (H14).

Unreachable: in default mode, probe, backup, plan, apply, and undo outcomes
when no migration runs (H2, H3, H12, H14, H15), and undo outcomes when
apply succeeds (H8). In explicit mode, every probe, backup, plan, apply, and
undo outcome. Where `t` aliases a default database path, the presence axis
of that database is the same fact as "target existed", so the
contradictory tuples are excluded rather than generated.

**Completeness claim:** explicit mode × {`:memory:`, path × existed} ×
`initDatabase` outcome × the 12 default-home states, plus default mode ×
the H axes. Every combination matches exactly one row by that precedence,
or one unreachable claim. The completeness test expands these axes over
both tables.

**Witnesses** are controls of the canonical rows above, not rows. Each
asserts the row's outcome. It also asserts that the post-start state
restricted to U equals the pre-start state, and that every path it
changed lies in its permitted effects.

| # | Setup | Row | Asserts beyond the row |
|---|---|---|---|
| W1 | de81 alias: `KAWAI_DB_PATH=$HOME/.kawai/kawai.db`, absent; record unparseable; legacy db present | X2 | `~/.kawai/kawai.db` created and its startup snapshot taken unless that fails non-fatally (Φ); `P` = `~/.agentboard`, log `agentboard.log` (N); record bytes identical; no legacy entry moved; overlap reported. A later default start refuses at H14 while the record exists; once it is removed, H2 serves the new `kawai.db` and leaves the legacy data untouched |
| W2 | de81 missing custom: `KAWAI_DB_PATH=<tmp>/new/k.db`, absent; no record; legacy db present; `kawai.db` absent | X2 | `P` = `~/.agentboard`; the resolver adds no entry under `~/.kawai`; legacy entries unchanged |
| W3 | existing override; record unparseable; `kawai.db` present (old H1c) | X1 | `P` = `~/.kawai`; record bytes identical |
| W4 | absent custom path; no record; neither default db (old H1a) | X2 | `P` = `~/.kawai` |
| W5 | absent custom path; record unparseable, and as a second case valid; legacy db present (old H1b) | X2 | record bytes identical; no undo or roll-forward |
| W6 | alias legacy: `$HOME/.agentboard/agentboard.db`, present | X1 | `agentboard`-stem backups in the legacy `backups/` (Φ); no migration |
| W7 | `:memory:` with a valid record and neither db (H15's state) | X4 | no refusal; sibling stores under `P` = `~/.kawai` |
| W8 | absent target whose parent is a regular file | X3 | today's error; U unchanged |
| W9 | existing target newer than the build | X3 | `DatabaseStartupError` exit; only the reached prefix |
| W10 | `KAWAI_DB_PATH='  '` (whitespace only) | default mode | the proposed database-only change; the default row applies |
| W10b | `KAWAI_DB_PATH='  '` and `AGENTBOARD_DB_PATH=<tmp>/x.db` | default mode | the legacy value is not consulted |
| W11 | `KAWAI_DB_PATH=$HOME/.kawai/.data-home-migration.json`, absent; no record | X2 | SQLite created at that path (Φ); collision reported; no migration-owned record handling |
| W12 | `:memory:` with an injected failing migration | X3 | today's error; no file created |
| W13 | presence checks for `P` unreadable | X1 | `P` = `~/.kawai`, "unknown" reported; no migration; target served |
| H14a | default mode: `kawai.db` present, legacy absent, record unparseable | H14 | exit; no `agentboard.db` created; no migration effect |

**Property PH (no loss, single location).** For a seeded random legacy
listing (db, journal, rotated logs, sibling dirs, backups under both stems,
unknown files, `app/`, `bin/`), a random pre-existing `~/.kawai` team file
set, a random failing move index or none, a random crash point in
`[0, n]` followed by a restart, and a random mode (no override; an override
to a present or absent custom path; an alias of `~/.kawai/kawai.db`, of the
legacy database, or of the record path; or `:memory:`):

- **Explicit mode.** The served target is `t` (X1/X2/X4), or the start fails as X3. No migration effect occurs. Every pre-existing entry outside the permitted Φ(t) ∪ N(P) is unchanged, and so are the record's bytes when the record lies outside that footprint.
- **Default mode.** Every allowlisted data entry exists at exactly one of its two paths. The migration deletes no data entry; record removal and ordinary backup rotation are the only deletions, and both are permitted effects. The served directory holds a database that existed before the start, or the fresh H3 one when no record exists and neither database does. No database is created while a record exists. A run that cannot satisfy this ends in a modeled refusal: early (H14, H15: no migration effect, no database) or late (H11: the effects of the earlier steps kept, no further database initialization). Every pre-existing entry outside M(row) ∪ Φ(t_d) ∪ N is unchanged.
- **External deletion.** After an injected external deletion, the property asserts the table's outcome for the resulting state (H15 with a record, H3 without), never that the deleted database still exists.

Model-based: the two tables are the reference model under
seeded command sequences with a crash at each rename and at the record
write/remove boundaries, plus injected record corruption (truncated or
garbled bytes) and external deletion of either database before restart. Seams: `planDataHomeMigration`, the injected fs
rename/fsync, the injected probe, the backup seam. Seed `0x4b415733`; 200
cases; no new dependency.

**Blind second reading (required, persistence/recovery).** Before any
group-3 code: commit A1 with this table's inputs and every output `?`; an
advisor from another model family fills the outputs from the spec alone;
commit A2 holds the author's outputs; disagreements are resolved in the
table; the Lead records the resolved table as binding (task 3.1).

### T — tmux session naming (group 4)

| # | `TMUX_SESSION` | `=agentboard` | `=kawai` | Rows on `agentboard:` | Result |
|---|---|---|---|---|---|
| T1 | set (e.g. `work`) | * | * | * | manages `work`; no rename; no rewrite |
| T2 | unset | present | present | * | manages `kawai`; `agentboard` untouched (never killed) |
| T3 | unset | present | absent | * | renames to `kawai` (windows and processes kept); rewrite in one transaction before the first refresh |
| T4 | unset | absent | absent | none | creates `kawai` |
| T5 | unset | present | absent, rename fails (raced) | * | no rewrite; proceeds as T2 or T4 by what exists |
| T6 | unset | absent | present | present | rewrite runs (idempotent reconciliation after an interrupted rename) |
| T7 | * | orphan `agentboard-ws-*` / `kawai-ws-*` | * | — | pruned when pruning is enabled; never listed as external |
| T8 | * | base session with windows | * | — | never killed or pruned by name |

**Property PT.** For seeded random session sets and stored rows, after
startup the unique `current_window` index holds, every row whose window
exists in the managed session points at it, and no session with windows
was killed. Seed `0x4b415734`; 100 cases.

### R — remote hosts on mixed names (group 4)

| # | Remote sessions | Listed managed | Skipped |
|---|---|---|---|
| R1 | `agentboard` only | its windows | `agentboard-ws-*` |
| R2 | `kawai` only | its windows | `kawai-ws-*` |
| R3 | both | windows of both | both ws prefixes |
| R4 | other names | per the existing discover-prefix rules | — |

### U — release, updater, installers, services (group 5)

| # | Input | Observable result |
|---|---|---|
| U1 | compiled binary named `kawai` | `binName` `kawai`; live paths `bin/kawai`, `dist/client` |
| U2 | compiled binary named `agentboard` | live paths `bin/kawai`, `bin/agentboard`, `dist/client`; both binaries identical after update |
| U3 | any other binary name | update refused naming the layout |
| U4 | source run | installs `~/.kawai/app/bin/kawai` and `dist/client`; git tree unchanged |
| U5 | download | fetches and verifies `kawai-<platform>.tar.gz`; missing checksum file or entry refuses before extract |
| U6 | legacy build reads a transition release | finds `agentboard-<platform>.tar.gz` with `bin/agentboard` |
| U7 | systemd unit: `KAWAI_SYSTEMD_UNIT` / legacy only / neither with cgroup `*.service` / neither | that unit / legacy unit (one warning) / the cgroup unit / `kawai.service` |
| U8 | launchd label: `KAWAI_LAUNCHD_LABEL` / legacy / `XPC_SERVICE_NAME` / none | that label / legacy / XPC name / `com.kawai` |
| U9 | drop-in write with a stale `50-agentboard-update.conf` | `50-kawai-update.conf` written; stale file removed |
| U10 | `systemd/install.sh` with a legacy unit present / absent | legacy stopped, disabled, unit and `.d/` removed, reload, `kawai.service` installed / only `kawai.service` installed |
| U11 | `launchd/install.sh` with `com.agentboard*` present / absent | both legacy agents unloaded and removed, `com.kawai` + `com.kawai.logrotate` loaded / only the new ones |
| U12 | any installer run | no database copy or deletion |
| U13 | `release-checksums.sh` with all eight tarballs / one missing | eight entries / fails, no release |

**Property PU (swap all-or-restore).** For seeded failure points over the
two- and three-path swaps, either every live path holds the new build or
every live path holds the old one (a path absent before stays absent).
Seed `0x4b415735`; 100 cases.

## Implementation contract

### Acceptance
- A1: With only legacy `AGENTBOARD_<NAME>` set, the server uses the value and logs exactly one deprecation warning per name naming both names without the value; with `KAWAI_<NAME>` non-empty it uses that value and logs no warning (E1–E10, PE).
- A2: No non-test `src/` file reads `process.env.AGENTBOARD_*` except `src/server/env.ts` and the dual-name strippers/fingerprints; CI, `playwright.config.ts`, `scripts/test-preload.ts`, and `scripts/e2e-fixture-specs.ts` set only `KAWAI_*` names, and the fixture lister still lists the fixture-gated specs.
- A3: A browser holding `agentboard-*` keys loads the renamed client with the same settings under `kawai-*`, the legacy keys removed only after the new key is confirmed in persistent storage, an existing `kawai-*` key never overwritten, and a failed persistent write leaving the legacy key in place with the settings still in effect (K1–K9).
- A4: With a non-blank database path, the server opens that target or creates it, or fails, exactly as `initDatabase` does today. It performs no migration-owned effect and leaves every entry outside the target's footprint and the ordinary non-database effects unchanged (X1–X4, W1–W13). With default paths, a legacy-only home is backed up (`pre-rename`, integrity-checked) and moved to `~/.kawai/` with `kawai.db`/`kawai.log`/`kawai-*` backups, and sessions, tasks, mail, plans, and strategy read back from `kawai.db`; every row X1–X4 and H2–H15 (with H14a) produces its stated serving path, moves, and log or exit.
- A5: In default mode, after a crash at any rename or intent-record boundary, the next start either serves a directory that holds the database or, when the record is unreadable or names no existing database, exits without opening or creating one; every allowlisted entry exists at exactly one path (PH, H14, H15).
- A6: Without a `TMUX_SESSION` override, an `agentboard` session with windows becomes `kawai` with every window kept, tracked sessions point at `kawai:@N` and stay active, legacy ws sessions are pruned, and remote hosts on either name are listed managed (T1–T8, R1–R4).
- A7: A legacy `bin/agentboard` root updates to both binary names from `kawai-<platform>.tar.gz`; restarts target the launching unit or label; installers replace legacy units without touching data; releases publish eight checksummed tarballs (U1–U13, PU).
- A8: Docs and current spec Purpose text use the new names; `git grep -n -i agentboard` over `src` (non-test) and the current docs lists only the named compat sites and the upgrade/deprecation notes.

### Invariants
- I1: No legacy-name fallback writes, prints, or logs an environment value.
- I2: The data-home migration never deletes a data entry (record removal and ordinary backup rotation are its only deletions), never targets an existing `~/.kawai` file, never runs while another process holds the legacy database or the in-use check cannot run, and in default mode never serves, opens, or creates a missing database while a migration record exists; explicit mode keeps today's `initDatabase` behavior at the given target and runs no migration-owned effect.
- I3: No startup path kills a tmux session that has windows.
- I4: No test, rehearsal, or check reads or writes the owner's live data directory, live tmux server, or service units; rehearsals use a disposable HOME and private tmux socket.
- I5: An update either replaces every live path or leaves every live path as it was.

### Scope
- `src/server/env.ts`
- `src/server/dataHome.ts`
- `src/server/config.ts`
- `src/server/db.ts`
- `src/server/bootstrap.ts`
- `src/server/dbSafety/**`
- `src/server/chat/**`
- `src/server/routes/**`
- `src/server/ws/**`
- `src/server/terminal/**`
- `src/server/updates/**`
- `src/server/SessionManager.ts`
- `src/server/sessionRefreshWorker.ts`
- `src/server/startupPreflight.ts`
- `src/server/remoteSessions.ts`
- `src/server/tmuxEnv.ts`
- `src/server/tmuxFormat.ts`
- `src/server/displayName.ts`
- `src/server/prerequisites.ts`
- `src/server/__tests__/**`
- `src/client/**`
- `src/shared/**`
- `scripts/**`
- `tests/e2e/**`
- `playwright.config.ts`
- `vite.config.ts`
- `.github/workflows/**`
- `systemd/**`
- `launchd/**`
- `.gitignore`
- `bun.lock`
- `README.md`
- `SECURITY.md`
- `AGENTS.md`
- `docs/**`
- `packages/agent-runtime/__tests__/**`
- `openspec/specs/workspace-navigation/spec.md`
- `openspec/specs/chat-debug/spec.md`
- `openspec/specs/github-workflows/spec.md`

### Verification
- V1: Each oracle table (E, K, H, T, R, U) runs verbatim as a table-driven test beside its code, and each property (PE, PH, PT, PU) runs seeded with its stated seed and case count; every Verify bullet's named mutant fails at least one of them.
- V2: At least one oracle test per group runs through the production composition (the real `config.ts`/`db.ts` load, the client entry, `SessionManager.ensureSession`, the updater flow, the installer scripts against fixture homes), and its mutant removes that wiring.
- V3: The fixture-gated e2e coverage runs only through the private CI fixture path (listed by `scripts/e2e-fixture-specs.ts`; disposable checkout, database, and spare port with CI's fixture setup); `bun run test:e2e` is never run.
- V4: The disposable rehearsals (tasks 4.5, 5.10) record their HOME, socket, build path outside `node_modules`, and local release server, and assert the A4–A7 outcomes.
- V5: The result's head carries a clean committed pinned Bun 1.4.3 `bun run check --full-properties` pass, a zero-unresolved literal citation preflight, and `scripts/verify-result.ts` on that commit.

### Excluded
- X1: Cutting over the owner's live install (its data directory, database, service unit, chat-env wiring, or the tmux session hosting live agents) — owner-only.
- X2: Publishing a release, tagging, or uploading tarballs; package publication of any kind.
- X3: Reading or writing live data, the live tmux server, or real service units in any test or rehearsal.
- X4: Removing the legacy fallbacks, legacy tarballs, or legacy tmux/remote/storage names (follow-up change).
- X5: Renaming unprefixed variables or existing `KAWAI_*` names; rewriting historical documents and archived changes.

## Execution checkpoints

One writer, groups in order; each group ends at its checkpoint task and
lands separately (one PR per group is allowed; never two groups in flight).

| Group | Checkpoint (task) | Production path to show | Failure path to show |
|---|---|---|---|
| 1 | 1.7 | the real `config.ts` load with only `AGENTBOARD_REMOTE_HOSTS` set reaches the remote poller | a value-bearing legacy name never appears in captured stderr |
| 2 | 2.2 | the client entry migrates keys before the settings store hydrates | storage throwing on access (K5); a quota-failing write keeps the legacy key persistent (K8) |
| 3 | 3.1 (before code), 3.10 | blind second reading recorded; real `resolveDataHome` + `initDatabase` on a disposable HOME | held db (H4), a crash at the db move (H13), and an unparseable record with `kawai.db` present (H14a: exit, no db created); boundary control W1 (an alias of `~/.kawai/kawai.db` with a damaged record is created and served, record unchanged) |
| 4 | 4.6 | `SessionManager.ensureSession` on a private tmux socket renames and rewrites | rename raced (T5) |
| 5 | 5.11 | the updater flow on a legacy root fixture lands both binaries | failure on the third swap path restores all |
| 6 | 6.8 | final grep gate and docs review | a residual name outside the allowlist fails the gate |

## Dependencies and serialization

- **Shared requirement — `claude-session-profiles` › "Named profiles configure independent provider sessions".** Also MODIFIED by `mimo-million-token-context` and by the proposed `provider-credential-store` slice (the store replaces the Settings map in its "Effective global provider overrides" scenario). Whichever of them archives later re-derives its block from the then-current main text. This is serialization, not a rename-first hard edge: no change waits for rename to land.
- **Shared requirement — `chat-sessions` › "Operators configure the chat provider from Settings".** The credential-store slice's Settings migration changes what Settings persists; whichever archives later re-derives.
- **Shared requirement — `terminal-streaming` › "WebSocket compression is opt-in".** `fast-chat-switching` (owner-held) RENAMES it; whichever archives second re-derives. Rename does not wait for the hold.
- **`AGENTBOARD_CHAT_FIXTURE` consumers.** `scripts/e2e-fixture-specs.ts:14`, its test, `.github/workflows/ci.yml:173`, `playwright.config.ts`, and the fixture-gated specs. Group 1 runs in a quiet window after the dev-checks archives (`check-time-optimization`, `per-result-suite`) and coordinates the variable name with any concurrently added fixture-gated e2e (revision-control, plan-workspace, relay fixture).
- **Main-spec Purpose edits (task 6.5)** touch `workspace-navigation`, `chat-debug`, `github-workflows`; `team-workspace-redesign` also MODIFIES `workspace-navigation` requirements. Serialize the archive and re-derive whichever lands second.
- **Schema.** No numbered migration; the stored-target rewrite is a data reconciliation, not a schema change.

## Risks / Trade-offs

- **An old instance keeps writing to `~/.agentboard` after the migration** (a dev server on another port) → the in-use guard skips the migration while any other process holds the database. A process started later with an explicit `AGENTBOARD_DB_PATH` keeps its own path (X1–X4), and its default log follows the passive home `P`.
- **The handle check is unavailable** (restricted `/proc`, no `lsof`) → the migration is skipped and reported, never attempted blind (Open Question 4).
- **A crash during the moves** → the intent record and database-last order make the next start roll forward or back (H12, H13); a damaged record or a record with no database stops startup without creating one (H14, H15).
- **The tmux rename affects someone running both builds on one tmux server** → it happens only when no `kawai` session exists and `TMUX_SESSION` is unset. `TMUX_SESSION=agentboard` opts out.
- **Moving `tmux-server.pid` breaks an existing watchdog that reads the old path** → the README snippet moves to the new path; `KAWAI_TMUX_PID_FILE` (or the legacy name) pins it.
- **A legacy root keeps two copies of a roughly 100 MB binary** → accepted for the transition; re-running the installer moves the host to `~/.kawai/app` with one binary.
- **External scripts that grep for `agentboard`** (log names, `tmux ls`, `launchctl list`) break → the release notes list every renamed identifier; environment variables keep working through the fallback.
- **The cgroup unit parse is wrong on unusual setups** → the explicit override (new or legacy) always wins, and the installers export it.
- **The transition window has no fixed end** → the legacy names are confined to `env.ts`, `dataHome.ts`, `legacyStorage.ts`, the tmux and remote prefix lists, `installRoot.ts`, `updateRestart.ts`, and the release publish step, so the follow-up is easy to find.

## Migration Plan

1. Ship the renamed build (owner-only release). Its release carries both the `kawai-*` and `agentboard-*` tarballs.
2. Existing installs self-update through the legacy tarball. On first start the build backs up `~/.agentboard/agentboard.db`, moves the data into `~/.kawai`, renames the tmux session, rewrites stored targets, and restarts through the unit that launched it. On the owner's host this step is the owner's cutover (task 6.9).
3. Operators rename their `AGENTBOARD_*` variables when they see the warnings, and optionally re-run the installer to move to `kawai.service` or `com.kawai`.
4. **Rollback:** before step 2 nothing changed. After it, the legacy build looks for `~/.agentboard/agentboard.db`. Stop the service; move `~/.kawai/kawai.db*`, `kawai.log*`, `chat-wire/`, `chat-workers/`, `chat-tasks/`, `backups/` (renaming `kawai-*` backups back to `agentboard-*`), and `tmux-server.pid` back under `~/.agentboard/` with their legacy names; run `tmux rename-session -t kawai agentboard`; reverse the stored-target rewrite with the documented `UPDATE … 'agentboard:' || substr(current_window, 7) …`; start the legacy binary. Browser settings start from defaults on the legacy client (K3). The `pre-rename` backup is the fallback if any step goes wrong. Document this in the README's upgrade notes and `docs/operations/database-backups.md`.
5. **Damaged record (H14/H15):** the server refuses to start and names the record, both database paths, and the `pre-rename` backup. Repair: stop the service, inspect both directories, keep the side that holds the database (or restore the named `pre-rename` backup to `~/.agentboard/agentboard.db` when neither does), move any strays to that side, remove `~/.kawai/.data-home-migration.json`, and start again. Document this beside the rollback. An explicit path that names a default-home database (W1, W6) is honored as given. The server reports the overlap, and the operator owns that choice.

## Open Questions

These are the owner's product decisions. Each has a recommendation; none is decided by this change.

1. **How long does the transition window last** before the follow-up removes the legacy tarballs, the `AGENTBOARD_*` fallback, and the legacy tmux, remote, and storage names? *Recommendation:* until the owner confirms every known host runs the renamed build, and at least two releases. *Gate: before the follow-up change only.*
2. **Data home: `~/.kawai/` or a separate location?** *Recommendation:* `~/.kawai/`, as proposed. *Gate: before group 3.*
3. **Rename existing backups to the `kawai` stem, or leave them?** *Recommendation:* rename them in the same plan, and keep the `pre-rename` backup until the follow-up. *Gate: before group 3.*
4. **When the in-use check cannot run, skip or migrate?** *Recommendation:* skip and report. *Gate: before group 3.*
5. **Install roots created outside this repository** keep a `bin/agentboard` launcher. Should the transition end only after their launchers move to `bin/kawai`? *Recommendation:* yes. *Gate: before the follow-up change.*
6. **Release-note visibility.** Should the first renamed release carry a prominent "Upgrading from agentboard" note in the GitHub Release body? *Recommendation:* yes, generated by `scripts/release.ts`. *Gate: before task 5.7.*

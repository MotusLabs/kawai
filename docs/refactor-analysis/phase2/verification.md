# Phase 2 — verification of phase-1 claims + test-suite map + rename debt

Repo: /home/coder/kawai @ 2557b22. All verdicts re-derived with repo-wide grep including
configs, `scripts/`, `import()` forms, HTML/CSS. READ-ONLY pass.

## A. Dead-code verification

| # | Claim | Verdict | Detail |
|---|---|---|---|
| 1 | `src/shared/dependencyRisk.ts` (466 LOC) 0 production importers | **USED — not dead** | Zero *app* importers, but imported by `scripts/dependency-risk.ts:8`, which backs npm scripts `deps:risk` / `deps:risk:ci` / `deps:risk:json` (package.json). It is a lint-tooling module, alive. Classification should be "tooling-only", not dead. |
| 2 | `logMatcher.ts` ~22/47 exports externally dead | **CONFIRMED (exactly 22)** | Full list below. Correction: phase 1 listed `tryExactMatchWindowToLog` as externally used — its only "production" hit is a *doc comment* in `logMatchWorkerTypes.ts:58`. It is test-only + internal. 4 exports are functions *never called anywhere* (`getTerminalScrollback`, `getTerminalScrollbackAsync`, `extractLogText`, `verifyWindowLogAssociationAsync`). |
| 3 | `db.ts` 3 dead exports | **CONFIRMED** | `NewAgentSessionRecord`, `KnownSessionKey`, `MAX_LAST_USER_MESSAGE_LENGTH` — 0 external refs (prod or test). All 3 are used *inside* db.ts (SessionDatabase interface / slice helper), so export keyword is dead, symbols are not. |
| 4 | `remoteSessions.ts` 10 test-only re-exported internals | **CONFIRMED** | "Export for testing" block (lines 520-531) re-exports `sanitizeForId`, `parseTmuxWindows`, `buildRemoteSessionId`, `toIsoFromSeconds`, `splitSshOptions`, `buildBatchCaptureCommand`, `parseBatchCaptureOutput`, `enrichSessionsWithStatus`, `cleanupRemoteContentCache`, `remoteContentCache`. Sole importer of the block: `src/server/__tests__/remoteSessions.test.ts`. Only production importer of the module is `index.ts:96` (`RemoteSessionPoller`, `splitSshOptions`, `buildRemoteSessionId`) — note 2 of the 10 test-block names ARE also used by index.ts directly from the module, but not via the test block. |
| 5 | `SshTerminalProxy` re-export of `shellQuote` — 0 importers | **CONFIRMED-DEAD** | `export { shellQuote } from '../shellQuote'` (SshTerminalProxy.ts:537). All 4 importers of the module pull only `SshTerminalProxy`. `shellQuote` itself is very alive (index.ts, applyCommand.ts, remoteSessions.ts, SshTerminalProxy internally at :6). Purely a dead re-export line. |
| 6 | `ChatSessionManager` re-exports production-dead | **MOSTLY CONFIRMED, one caveat** | `chatAuthErrorMessage` re-export: dead as a re-export — 0 importers anywhere (function alive internally via the chatAuth import). `hasClaudeAuth` re-export: test-only (`chatSessionManager.test.ts:26` imports it *from ChatSessionManager*); function alive internally (line 1005). `ChatQueryFactory` re-export: NOT fully dead — `scripts/verify-claude-profile-resume.ts:7` (manual verification script, documented in docs/claude-session-profiles.md) imports it from ChatSessionManager; served-app code uses the ChatSessionDriver original. Verdict: production-dead in the app, script-consumed. |
| 7 | `transcriptReplay`: `parseTranscriptContent`, `withCancelledRequests` test-only | **CONFIRMED** | Imported only by `chatTranscriptReplay.test.ts`. Both are alive *internally* (`replayTranscriptFile` calls both; `readTranscriptTitle`/`readTranscriptCwd` call parseTranscriptContent) — dead exports, live functions. (Also found, not asked: `TranscriptReplayStatus`, `TranscriptTitle`, `ParsedTranscript` types have 0 external refs.) |
| 8 | `node-pty` imported nowhere | **CONFIRMED-DEAD** | String `node-pty` appears only in package.json and openspec archive prose. No static, dynamic (`import()`), or `require` reference anywhere (the repo's only two dynamic imports are `@anthropic-ai/claude-agent-sdk`). `PtyTerminalProxy.ts` imports nothing from it — its "pty" is a `Bun.spawn`'d tmux client; `'pty'` is only a mode enum value. Safe to remove (note: never had a native build in CI — openspec archive records node-gyp failing on the runner image). |
| 9 | `@fontsource-variable/jetbrains-mono` imported nowhere | **CONFIRMED-DEAD** | No import/CSS `@import`/HTML reference to the package. The font is self-hosted: `src/client/styles/index.css` declares `@font-face 'JetBrains Mono Variable'` from `/fonts/*.woff2` (public/), preloaded in `index.html:7`. Package is fully bypassed. |
| 10 | `index.ts` all 3 exports dead outside the file | **CONFIRMED (with nuance)** | `hydrateSessionsWithAgentSessions` — internal use x4 (1248/1275/1317/1458) + 1 test (`hydrateSessionsEmptyGuard.test.ts`); test-only as an export. `WorkspaceCoordinatorHook` — own-file only. `attachWorkspaceCoordinator` — own-file only, but *called internally* at :1548, so the function is live; only the `export` keyword is dead. No fully-dead symbols here. |

### A.2 — logMatcher.ts: all 47 exports

Production importers: `logPoller.ts`, `logMatchWorker.ts` (worker thread), `sessionRefreshWorker.ts`,
`logMatchWorkerTypes.ts`, `logPollData.ts`, `index.ts`. Test importer: `logMatcher.test.ts` (20 names).

| Export | Status |
|---|---|
| ExactMatchProfiler | production (type; logMatchWorkerTypes) |
| createExactMatchProfiler | production (logMatchWorker) |
| DEFAULT_SCROLLBACK_LINES | production (logPoller, index, logMatchWorker) |
| isToolNotificationText | production (logPoller, logMatchWorker) |
| stripPastePlaceholders | production (index) |
| isSameOrChildPath | production (logPoller) |
| extractRecentUserMessagesFromTmux | production (sessionRefreshWorker) |
| getLogTokenCount | production (logPollData, logMatchWorker) |
| extractLastUserMessageFromLog | production (logMatchWorker) |
| extractLastEntryTimestamp | production (logPoller) |
| matchWindowsToLogsByExactRgAsync | production (index, logMatchWorker) |
| WindowLogVerificationResult | production (type; index) |
| verifyWindowLogAssociationDetailed | production (index) |
| verifyWindowLogAssociationDetailedAsync | production (index) |
| hasMessageInValidUserContext | test-only (also called internally x3) |
| extractActionFromUserAction | test-only (also internal) |
| extractCommandInvocation | test-only (also internal) |
| iterateLogLinesBackward | test-only (also internal) |
| normalizeText | test-only |
| extractPiUserMessagesFromAnsi | test-only (also internal) |
| extractRecentTraceLinesFromTmux | test-only (also internal) |
| captureTerminalScrollback | test-only (also internal) |
| tryExactMatchWindowToLog | test-only (phase 1 wrongly called this production-used; also internal x3) |
| matchWindowsToLogsByExactRg | test-only |
| verifyWindowLogAssociation | test-only |
| LogTextMode | dead export (type, internal use only) |
| LogReadOptions | dead export (type, internal) |
| LogTextOptionsInput | dead export (type, internal) |
| ExactMatchSearchOptions | dead export (type, internal) |
| ExactMessageSearchOptions | dead export (type, internal) |
| ExactMatchContext | dead export (type, internal) |
| ExactMatchResult | dead export (type, internal) |
| ExactMatchRgResult | dead export (type, internal) |
| VerifyWindowLogOptions | dead export (type, internal) |
| WindowLogVerificationStatus | dead export (type, internal) |
| findLogsWithExactMessage | dead export (called only by its sync twin internally) |
| findLogsWithExactMessageAsync | dead export (called only by its async twin internally) |
| getTerminalScrollback | **FULLY DEAD — never called anywhere** (trivial wrapper) |
| getTerminalScrollbackAsync | **FULLY DEAD — never called anywhere** |
| captureTerminalScrollbackAsync | dead export (internal use in async twin) |
| getTerminalScrollbackWithAnsi | dead export (internal use) |
| getTerminalScrollbackWithAnsiAsync | dead export (internal use) |
| readLogContent | dead export (internal use x2) |
| extractLogText | **FULLY DEAD — never called anywhere** |
| filterCandidatesByAgentType | dead export (internal) |
| tryExactMatchWindowToLogAsync | dead export (internal) |
| verifyWindowLogAssociationAsync | **FULLY DEAD — never called anywhere** |

Totals: **14 production-used, 11 test-only, 22 dead exports** (of which 4 are functions with zero
callers anywhere — genuinely removable code, not just keywords). The `export` keyword on most of
the other 13 is dead but the functions are internal helpers; delisting `export` on the 18
types/constants is mechanical.

### A.3 — bonus findings (same sweep)

- `src/shared/devProxyErrors.ts` (40 LOC): **CONFIRMED-DEAD** — `isBenignProxyError`/`shouldSuppressProxyLog`
  have zero consumers outside their own test (incl. `scripts/dev-server.ts`, which is the stated
  consumer in the header comment).
- Every fully-dead symbol above is still counted by `tsc` and oxlint; removal is mechanical.

## B. Test suite map

### B1. The three trees and why `isolated/` exists

Mechanism (from `scripts/test-runner.ts` — `bun run test` is *not* plain `bun test`):

- Trees mirror src layout: `src/server/__tests__` (98 files), `src/client/__tests__` (61, react-test-renderer
  component/hook tests), `src/shared/__tests__` (7, pure modules). bunfig `[test] root = "./src"`; the
  runner passes explicit file lists to ONE `bun test` process for all non-isolated files (server +
  shared + client together).
- `src/server/__tests__/isolated/` is **process isolation, not DB isolation**. The runner globs
  `src/server/__tests__/isolated/*.test.ts`, sorts, and runs each file in its OWN `bun test` process.
  Reason (stated in runner comments): Bun's `mock.module()` persists for the lifetime of a process, so
  a file that mocks `../../terminal` (indexHandlers) or `../config` (terminalProxyFactory) poisons
  every later file in a shared process; framer-motion also keeps module-level projection state + global
  rAF callbacks that leak across files. Files with the same problem that predate the directory are
  listed by basename in hardcoded sets inside the runner (`ISOLATED_FILES`, `ISOLATED_REAL_TMUX_FILES`,
  `ISOLATED_CLIENT_FILES`) and get the same one-process-each treatment. `isolated/` is the scalable
  spelling of those sets.
- DB isolation is orthogonal and weak-ish: the runner creates ONE temp root per invocation with
  `AGENTBOARD_DB_PATH`, `LOG_FILE`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and every suite shares it
  (sequential processes, so no races). Tests needing their own DB pass `initDatabase({ path })` into a
  `mkdtemp` dir. `testEnvironment.ts` adds tmux availability checks and a `TMUX`-deleting tmpdir helper
  so nested tmux servers don't attach to the developer's session.
- Real-tmux integration files (`*.integration.test.ts`, 7) run isolated AND only when `--skip-real-tmux`
  is not passed (`test:ci` skips them; `bun run test` runs them).

### B2. `01-sessionRegistry.test.ts` numbering

Was functional, now vestigial. History: commit `11543b7` ("fix: rename test files to run before module
mocks are applied") renamed `terminalProxy.test.ts`→`00-` and `sessionRegistry.test.ts`→`01-` because
plain `bun test` runs files lexicographically and those files had to load *before*
`indexHandlers.test.ts` installed module mocks. Two supersessions later: (a) `00-terminalProxy` moved
into `isolated/` (which sorts separately), and (b) ordering is now dictated by the runner's explicit
isolation sets, not filenames (the runner even sorts only the `isolated/` list and relies on sets
elsewhere). Nothing in the config keys off `01-` today; it is a fossil of the pre-runner ordering fix.

### B3. The 14 test files >1,000 LOC

| File | LOC | describe | it/test | Subject — god-module or accretion? |
|---|---|---|---|---|
| server/__tests__/isolated/indexHandlers.test.ts | 7093 | 4 | 118 | **One file because index.ts is a god-module.** 4 describes map to index.ts's surfaces: "server message handlers" (lines 788-5680, ~4,900 LOC of the file), "server signal handlers", "server fetch handlers", "startup side effects". It stubs `../../terminal`, db, SessionManager and drives the module-level `websocketHandlers`/routes — one SUT, one file. |
| client/__tests__/useTerminal.test.tsx | 5046 | 5 | 66 | One SUT (useTerminal hook, 2016 LOC) — terminal lifecycle, paste, resize, mouse. God-hook, mostly coherent. |
| server/__tests__/chatSessionManager.test.ts | 3006 | 14 | 94 | One SUT (ChatSessionManager class) — lifecycle + auth + usage; accretion of feature tests onto one class test. |
| client/__tests__/app.test.tsx | 2395 | 1 | 34 | Whole-App render tests; accretion (single describe). |
| server/__tests__/sessionManager.test.ts | 2290 | 1 | 46 | One SUT (SessionManager tmux wrapper); accretion in one describe. |
| server/__tests__/chatSessionDriver.test.ts | 2275 | 6 | 67 | One SUT (ChatSessionDriver + SDK frame handling). |
| server/__tests__/logMatcher.test.ts | 2184 | 16 | 128 | One SUT (logMatcher) — but the SUT has 47 exports; accretion by feature area. |
| server/__tests__/logPoller.test.ts | 2065 | 1 | 30 | One SUT (LogPoller); accretion. |
| client/__tests__/websocketManager.test.ts | 1589 | 22 | 64 | WS client manager; 22 small describes. |
| client/__tests__/newSessionModal.test.tsx | 1480 | 7 | 32 | NewSessionModal + approval policy dialog. |
| server/__tests__/isolated/terminalProxy.test.ts | 1472 | 1 | 30 | PtyTerminalProxy (via barrel) against a fake tmux; isolated for Bun.spawnSync patching. |
| client/__tests__/chatComponents.test.tsx | 1456 | 15 | 69 | Chat transcript components — multi-component grab-bag (accretion). |
| client/__tests__/terminal.test.tsx | 1128 | 1 | 12 | Terminal.tsx render + drawer. |
| client/__tests__/sessionListGrouped.test.tsx | 1102 | 3 | 26 | Grouped navigator (SessionList + WorkspaceSectionList). |

Pattern: 9 of 14 are single-SUT files for a large class/module (test size mirrors source size, not
test sprawl); the client grab-bags (chatComponents, app) are the accretion cases. indexHandlers is the
only file whose size is directly *caused* by a god-module.

### B4. Coverage of the 21 production files >500 LOC

| Hotspot file | LOC | Test file(s) | it() | Verdict |
|---|---|---|---|---|
| src/server/index.ts | 4948 | isolated/indexHandlers.test.ts (+index, indexPortCheck, hydrateSessionsEmptyGuard, 7 integration) | 118 (+~20) | solid (via isolated harness) |
| src/server/logMatcher.ts | 2599 | logMatcher.test.ts (+logMatchWorker.test.ts) | 128 (+6) | solid |
| src/client/hooks/useTerminal.ts | 2016 | useTerminal.test.tsx | 66 | solid |
| src/client/components/Terminal.tsx | 1768 | terminal.test.tsx (+arrowKeys, paneResizeHandle, terminalShiftKeys, terminalControls) | 12 (+42) | thin direct, moderate spread |
| src/client/App.tsx | 1351 | app.test.tsx (+main.test.ts) | 34 (+1) | moderate |
| src/server/logPoller.ts | 1224 | logPoller.test.ts | 30 | solid |
| src/server/chat/ChatSessionManager.ts | 1221 | chatSessionManager.test.ts | 94 | solid |
| src/server/SessionManager.ts | 1184 | sessionManager.test.ts | 46 | solid |
| src/server/db.ts | 1162 | db.test.ts (+5 `*Db.test.ts`: chatApprovalPolicyDb, chatArchiveDb, chatContextDb, chatNameSourceDb, claudeProfileDb) | 4 (+21) | **thin** — 4 direct cases for a 449-line initDatabase; column-migration logic (12 migrate* helpers) barely covered |
| src/server/chat/ChatSessionDriver.ts | 1108 | chatSessionDriver.test.ts | 67 | solid |
| src/client/components/SessionList.tsx | 928 | sessionListComponent + sessionListGrouped + sessionListFilters + sessionList | 7+26+1+2 = 36 | moderate (spread) |
| src/server/terminal/PtyTerminalProxy.ts | 892 | isolated/terminalProxy.test.ts (+terminalProxyBase, pipePaneTerminalProxy for siblings) | 30 | solid |
| src/client/components/SessionPreviewContent.tsx | 877 | sessionPreviewDedup.test.ts (+Markdown.test.tsx, app.test.tsx touch it) | 10 | thin |
| src/client/components/SessionRow.tsx | 768 | sessionRowMemo + sessionRowMenu | 5+4 = 9 | **thin** |
| src/client/hooks/useWebSocket.ts | 753 | websocketManager.test.ts (+useWebSocketHook) | 64 (+2) | solid |
| src/client/components/NewSessionModal.tsx | 752 | newSessionModal.test.tsx | 32 | solid |
| src/client/components/WorkspaceSectionList.tsx | 589 | (none dedicated; sessionListGrouped covers it) | 26 (shared) | thin/no dedicated |
| src/server/chat/transcriptReplay.ts | 542 | chatTranscriptReplay.test.ts | 21 | solid |
| src/server/terminal/SshTerminalProxy.ts | 537 | sshTerminalProxy.test.ts | 16 | moderate |
| src/server/remoteSessions.ts | 531 | remoteSessions.test.ts | 70 | solid (thanks to the 10-internals test block) |
| src/client/stores/settingsStore.ts | 508 | settingsStore.test.ts | 35 | solid |

Weakest spots overall: `db.ts` migrations, `SessionRow`, `SessionPreviewContent`, `WorkspaceSectionList`.

### B5. Test-helper duplication

Phase 1 said "none found" — wrong; it only checked for same-named helper *files*. In-file duplication is real:

- **Bun.spawn/spawnSync patch dance**: `const bunAny = Bun as typeof Bun & { spawn, spawnSync }` +
  `originalSpawn`/`originalSpawnSync` save/restore is copy-pasted in ~13 server test files
  (logMatcher, logPoller, sessionManager, indexHandlers, terminalProxy, index, indexPortCheck,
  directories, pipePaneTerminalProxy, logMatchWorker, sessionRefreshWorker, prerequisites,
  hydrateSessionsEmptyGuard); 31 files patch Bun.spawn in some form. A `withPatchedBunSpawn()`
  helper in `testEnvironment.ts` would remove ~13 copies.
- **tmux output stubbing**: `tmuxOutputs` Map + `setTmuxOutput()` re-implemented in at least 6 files
  (logMatcher, logPoller, sessionManager, remoteSessions, tmuxText, logMatchWorker).
- **Client window stub** (`Object.defineProperty(window, 'innerWidth'…)` + restore) repeated in 6+
  component test files (sessionListComponent, sessionRowMenu, renderComponents, sessionListGrouped,
  numpad, sessionRowMemo) — exactly the pattern the runner comments describe as leak-prone.
- Shared `testEnvironment.ts` exists but only covers tmux availability/tmpdir helpers — the natural
  home for the above.

### B6. Test run

Ran `bun run test` (full runner incl. real-tmux suites) — **quick: ~73s wall** (real 1m12.7s), well
under the 2-minute skip threshold. Full log: `/tmp/kawai-analysis/phase2/test-run.log`.

- **2,266 pass / 0 fail / 0 skip**, exit 0, in 30 `bun test` invocations: 1 main batch (139 files,
  1,825 tests, 20.3s — 83 server + 7 shared + 49 client) + 29 one-file-per-process invocations
  (8 `ISOLATED_FILES` + 7 real-tmux integration + 12 client-isolated + 2 `isolated/`).

## C. Rename debt — 146 'agentboard' occurrences (src, tests excluded)

Counts: **(a) MUST-KEEP ~108, (b) cosmetic/internal ~34, (c) ambiguous ~4.**
(Tests add 155 more `AGENTBOARD_*` usages, all following the prod names.)

### (a) MUST-KEEP — external contracts (~108)

| Group | Occurrences | Representatives |
|---|---|---|
| `AGENTBOARD_*` env vars (37 distinct names) | 77 | `AGENTBOARD_STATIC_DIR`, `AGENTBOARD_CHAT_ENV`, `AGENTBOARD_DB_PATH`, `AGENTBOARD_PROJECT_DIR`, `AGENTBOARD_REMOTE_HOSTS`, `AGENTBOARD_SKIP_MATCHING_PATTERNS`, … — operator-facing deployment config; renaming breaks every deployment/doc |
| On-disk data dir + files | ~8 | `~/.agentboard` (config.ts:87, db.ts:146), `agentboard.log` (config.ts:88), `agentboard.db` (db.ts:148, ChatWireLogs sibling dir) |
| Self-install layout + updater artifacts | ~18 | `~/.agentboard/app`, `bin/agentboard` (installRoot checks `path.basename(execPath) === 'agentboard'`), `LIVE_PATHS = ['bin/agentboard', 'dist/client']` (updateSwap:17), tarball `agentboard-<platform>.tar.gz` (release asset name, must match CI release workflow) |
| Service-manager names persisted on user machines | ~8 | `DEFAULT_SYSTEMD_UNIT = 'agentboard.service'`, `DEFAULT_LAUNCHD_LABEL = 'com.agentboard'`, `50-agentboard-update.conf` drop-in (written once; a rename would orphan adopted units) |
| Browser localStorage keys (persisted user state) | ~9 | `agentboard-settings`, `agentboard-theme`, `agentboard-workspace`, `agentboard-session` — renaming silently resets all user settings unless a storage migration is added (settingsStore already has a v0→v7 migration, so a key migration is the established pattern) |

### (b) Cosmetic/internal (~34)

- Comments/prose: chat.ts:293,296; useTerminal.ts:859; index.ts:545,567,2661,2806; PtyTerminalProxy.ts:523;
  TerminalProxyBase.ts:15; displayName.ts:4; SessionManager.ts:154-157,249,813; tmuxEnv.ts:3-4;
  tmuxFormat.ts:21; ChatWireLogs.ts:2; ChatSessionDriver.ts:84; updateRestart.ts:187-188 (text inside a
  generated file's comment — harmless but written to disk).
- Log/console prefixes: `[agentboard:settings]` (settingsStore x4), `[agentboard]` (config.ts:173).
- User-facing strings that only name the app: "tmux is required to run Agentboard" (prerequisites.ts:29),
  "User denied this tool use in Agentboard" (ChatSessionDriver.ts:365), "removed outside Agentboard"
  (index.ts:2661) — renamable, but note users see them.
- Ephemeral names: `agentboard-pipes/` tmpdir (PipePaneTerminalProxy:24), `agentboard-paste-<conn>-<n>`
  tmux buffer names (TerminalProxyBase:177, created+deleted within a paste), `agentboard-paste-<uuid>.png`
  macOS temp (index.ts:2057), `agentboard-upload-` mkdtemp (pasteFile:47), `.agentboard-update-` staging
  dir (updateInstaller:52), `agentboard-ws-*` (comment/tests only), test temp prefixes
  `agentboard-tests-`/`agentboard-tmux-` (scripts/test-runner.ts, testEnvironment.ts).

### (c) Ambiguous (~4)

- `config.ts:204` default tmux session name `'agentboard'` (overridable via `TMUX_SESSION`): renaming
  would leave existing user sessions named `agentboard` while the app looks for the new name;
  SessionManager's daemon-repair comments explicitly reference "an older agentboard booted the tmux
  daemon" — a rename needs the same one-time-repair treatment.
- `tmuxFormat.ts:13` `'__agentboard_root__'` bootstrap window name: marker persisted in tmux server
  state across restarts/upgrades; renaming orphans detection of old keep-alive windows.
- `UpdatePanel.tsx:24`: user-facing sentence pointing at `~/.agentboard/agentboard.log` — path is
  must-keep, product name in the sentence is cosmetic; a partial rename here would confuse.
- `prerequisites.ts:29` error text: pure prose, but it is *the* first-run error message users see.

### Both-names-for-one-concept (confusion risks)

1. **Two config roots**: everything uses `~/.agentboard` (db, log, app install), but the Claude
   profile catalog uses `~/.kawai/profiles.json` (profileCatalog.ts:184,203, routes/claudeProfiles.ts).
   Same app, two dotdirs — worst offender.
2. **Two env prefixes**: `AGENTBOARD_*` (37 vars) vs `KAWAI_CLAUDE_PATH`, `KAWAI_UPDATE_ENDPOINT`,
   `KAWAI_BUILD_VERSION` (claudeExecutable.ts, releaseFeed.ts, version.ts).
3. **Release identity**: GitHub repo/package `MotusLabs/kawai` / `@motuslabs/kawai` publishes tarballs
   named `agentboard-<platform>.tar.gz` consumed by an updater that refuses to run unless the binary is
   literally named `agentboard`.
4. **UI shows both**: Header renders "Kawai v…" while error/log text says "Agentboard"
   (prerequisites, ChatSessionDriver denial message).
5. **Git identity**: worktree commits authored as `Kawai <kawai@localhost>` (createChangeWorktree.ts:299-302)
   vs the `agentboard` tmux/db/log world.

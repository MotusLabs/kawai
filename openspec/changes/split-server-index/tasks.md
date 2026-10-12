# Tasks

Line anchors below are approximate (post-S2/merge drift); locate blocks by symbol names per
design D2. Every task ends with `bun run lint && bun run typecheck && bun run test` green and
a commit; `indexHandlers.test.ts` must pass unchanged (design D5) throughout.

## 1. logContent module (no dependencies)

- [x] 1.1 Create `src/server/logContent.ts` (header comment, house style) and lift the
  log-line cache verbatim: `CachedLogLines`, `LOG_LINE_CACHE`, `MAX_CACHEABLE_LOG_BYTES`,
  `MAX_LOG_CACHE_BYTES`, `logLineCacheBytes`, the byte-accounting eviction, and the three
  readers (`getLogLinesWindow`-family, today ~index.ts:140–500)
- [x] 1.2 Rewire `index.ts` to import from `./logContent`; add a direct unit test for the
  window math and cache eviction (today covered only end-to-end); commit
  (`refactor: lift log content cache into logContent module`)

## 2. Session refresh loop

- [x] 2.1 Create `src/server/refresh/SessionRefreshLoop.ts` as a class taking
  `{ db, registry, sessionManager, sessionRefreshWorker, config, remoteMerge, broadcast }`
  (ChatSessionManagerOptions DI style); lift `hydrateSessionsWithAgentSessions` (keep its
  export and its empty-input guard FIRST — design D4), `verifyAllSessions`,
  `updateActiveAgentSessions`/`updateDormantAgentSessions`, `refreshSessions( Sync)`,
  `completeStartupVerification`, and the refresh state machine
  (`refreshInFlight`, `refreshGeneration`, `hasConfirmedLocalSessionSnapshot`,
  `lastSuccessfulRefreshWindowCount`, `refreshWindowCountFloor`, `startupExpectedWindowCount`,
  `enterRefreshTimer`, the two `setInterval` registrations, today ~index.ts:879–1500)
- [x] 2.2 Move `hydrateSessionsEmptyGuard.test.ts`'s import to the new module; delete the
  dead `WorkspaceCoordinatorHook`/`attachWorkspaceCoordinator` export pair (design D6,
  ~index.ts:1502–1510), keeping a single local coordinator reference; commit
  (`refactor: lift session refresh loop into refresh/SessionRefreshLoop`)

## 3. Session ops (kill/rename/hibernate/wake/moveToHistory)

- [x] 3.1 Create `src/server/sessions/` with `kill.ts`, `rename.ts`, `hibernate.ts`,
  `wake.ts`, `moveToHistory.ts` as functions over a shared `SessionOpsContext`
  (`{ registry, db, sessionManager, config, refresh, broadcast, send }`); lift the handlers
  verbatim (today ~index.ts:3165–4311); `wake.ts` takes the resume-command builders
  (~:3763–3877) with it
  - Deviations: the resume builders live in `sessions/resumeCommand.ts` (wake.ts alone
    would have exceeded the 500-LOC norm, per the split rule); `config` stays a direct
    module import per design D3 (matching the phase-2 pattern), so the context carries
    `{ registry, db, sessionManager, refresh, chatSessionManager, broadcast, send,
    runRemoteTmux, remoteSessionNameOverrides, remoteSessionTombstones }` — the extra
    members are the remote-control deps the kill/rename handlers verbatim-reference.
    `WSData` moved to `ws/wsTypes.ts` (pre-stage for phase 5), the local-host stamp
    helpers to `sessionStamp.ts`, and `readTmuxCapture` to `tmuxCapture.ts` (shared by
    wake and the phase-5 clipboard/copy-mode/attach modules).
- [x] 3.2 Add unit tests for `wake.ts` claim-race branches (~:4145–4256, today only covered
  end-to-end); commit (`refactor: lift session ops into sessions/ modules`)

## 4. Remote session service

- [ ] 4.1 Create `src/server/remote/RemoteSessionService.ts` owning the remote merge +
  protection/tombstone/override maps, `runRemoteTmux`/`runRemoteSsh`/`sshOptionsForHost`,
  `handleRemoteCreate`, and the `RemoteSessionPoller` (constructor-owned; today
  ~index.ts:655–799 + 2912–3072 + 4768–4813); commit
  (`refactor: merge remote session handling into RemoteSessionService`)

## 5. WebSocket modules

- [ ] 5.1 Create `src/server/ws/ConnectionHub.ts` (sockets, `WSData`, `broadcast`, `send`,
  `fireAndForget`, registry→broadcast wiring; today ~:601–653 + 1476–1494 + 2615–2647);
  `ws/clipboardWatch.ts` (~:640s consts + 2351–2598; `clipboardWatchGen` verbatim);
  `ws/copyMode.ts` (~:2901–3163; `copyModeCheckInFlight` verbatim); commit
  (`refactor: lift ws hub, clipboard watch, and copy mode into ws/ modules`)
- [ ] 5.2 Create `src/server/ws/terminalAttach.ts` lifting the proxy lifecycle, SSH proxy
  creation, and attach/detach/input/paste/resize handling (~:4313–4948;
  `terminalAttachSeq` verbatim); commit (`refactor: lift terminal attach lifecycle into
  ws/terminalAttach`)

## 6. HTTP routes

- [ ] 6.1 Extract remaining endpoints into `src/server/routes/` following the
  `routes/claudeProfiles.ts` pattern: `settings.ts` (~:1837–2012, collapsing the four
  copy-pasted setting blocks at ~:520–554), `sessionPreview.ts` (~:1572–1642, uses
  `./logContent`), `directories.ts`, `serverInfo.ts`, `updateInstall.ts`, `paste.ts`
  (~:2017–2168 incl. the Swift script constant); each route module receives its deps via the
  D3 context objects; commit (`refactor: extract HTTP routes into routes/ modules`)

## 7. Composition root and close-out

- [ ] 7.1 Create `src/server/bootstrap.ts` with `startServer()`: construct `db`, `registry`,
  managers, and every extracted module in one explicit, commented, linear sequence; own
  `Bun.serve`, signal handlers, and the shutdown list; `index.ts` shrinks to the boot-on-import
  entry (header + `startServer()` call, per design D1)
- [ ] 7.2 Confirm the shape: every new module under 500 LOC with a header comment; no
  module-scope mutable singletons outside `bootstrap.ts`; record actual per-module LOC in the
  change notes
- [ ] 7.3 Confirm the harness ran unmodified through every commit (design D5); run the full
  suite plus the two integration files (`chatRename.integration`, `double-attach.integration`)
  one final time
- [ ] 7.4 Mark S1 done in `docs/refactor-analysis/synthesis.md` (status note with commit
  hashes, mirroring the P0/S2 notes); commit (`docs: mark P1/S1 complete in refactor synthesis`)

## Workflow follow-up

- Merge `split-server-index` to master after review (user decision), then archive the change
  via the archive workflow.

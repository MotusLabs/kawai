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

- [x] 4.1 Create `src/server/remote/RemoteSessionService.ts` owning the remote merge +
  protection/tombstone/override maps, `runRemoteTmux`/`runRemoteSsh`/`sshOptionsForHost`,
  `handleRemoteCreate`, and the `RemoteSessionPoller` (constructor-owned; today
  ~index.ts:655–799 + 2912–3072 + 4768–4813); commit
  (`refactor: merge remote session handling into RemoteSessionService`)

## 5. WebSocket modules

- [x] 5.1 Create `src/server/ws/ConnectionHub.ts` (sockets, `WSData`, `broadcast`, `send`,
  `fireAndForget`, registry→broadcast wiring; today ~:601–653 + 1476–1494 + 2615–2647);
  `ws/clipboardWatch.ts` (~:640s consts + 2351–2598; `clipboardWatchGen` verbatim);
  `ws/copyMode.ts` (~:2901–3163; `copyModeCheckInFlight` verbatim); commit
  (`refactor: lift ws hub, clipboard watch, and copy mode into ws/ modules`)
  - Notes: `ConnectionHub` exposes `sockets` and arrow-bound `broadcast`/`send` (destructured
    once in the composition root) and also takes `createConnectionId`; clipboard watch and
    copy mode follow the `sessions/` style — functions over a small context
    (`{ registry, hub }`, plus `runRemoteTmux` for copy mode) — since their race guards live
    on the per-socket `WSData`, not on a class.
- [x] 5.2 Create `src/server/ws/terminalAttach.ts` lifting the proxy lifecycle, SSH proxy
  creation, and attach/detach/input/paste/resize handling (~:4313–4948;
  `terminalAttachSeq` verbatim); commit (`refactor: lift terminal attach lifecycle into
  ws/terminalAttach`)
  - Deviation: split in two to stay under the 500-LOC norm — `ws/terminalProxy.ts` (proxy
    create/start/swap incl. SSH proxy, attach dedup reset, terminal-error reporting) and
    `ws/terminalAttach.ts` (attach/detach/input/paste/resize, scrollback capture, socket
    cleanup); both are functions over `TerminalAttachContext`
    (`{ hub, remote, registry, refresh, clipboard }`).

## 6. HTTP routes

- [x] 6.1 Extract remaining endpoints into `src/server/routes/` following the
  `routes/claudeProfiles.ts` pattern: `settings.ts` (~:1837–2012, collapsing the four
  copy-pasted setting blocks at ~:520–554), `sessionPreview.ts` (~:1572–1642, uses
  `./logContent`), `directories.ts`, `serverInfo.ts`, `updateInstall.ts`, `paste.ts`
  (~:2017–2168 incl. the Swift script constant); each route module receives its deps via the
  D3 context objects; commit (`refactor: extract HTTP routes into routes/ modules`)
  - Notes: landed as two commits (settings first, then the rest). Each module returns a Hono
    sub-app mounted with `app.route` (`/api/settings`, `/api/session-preview`,
    `/api/directories`, `/api/update`; `serverInfo` and `paste` mount at `/api`).
    `serverInfo.ts` also takes `/api/client-log`, `/api/health`, and `getTailscaleIp`; the
    settings module owns the boot-time read (`loadStoredSettings`, the collapsed blocks via
    one `readStoredBoolean` helper) and reaches the runtime history max age through a
    get/set accessor rather than a module-scope `let`.

## 7. Composition root and close-out

- [x] 7.1 Create `src/server/bootstrap.ts` with `startServer()`: construct `db`, `registry`,
  managers, and every extracted module in one explicit, commented, linear sequence; own
  `Bun.serve`, signal handlers, and the shutdown list; `index.ts` shrinks to the boot-on-import
  entry (header + `startServer()` call, per design D1)
  - Deviation: three more modules so `bootstrap.ts` stays under 500 LOC (split rule) —
    `ws/messageRouter.ts` (`handleMessage` plus the worktree-create handlers and the stale
    project-path error, over a `MessageRouterContext`), `ws/socketHandlers.ts` (the `/ws`
    upgrade `fetch` and the Bun websocket open/message/close handlers), and
    `startupPreflight.ts` (`checkPortAvailable`, `pruneOrphanedWsSessions`). All state lives
    inside `startServer()`, so each harness re-import boots a fresh graph.
- [x] 7.2 Confirm the shape: every new module under 500 LOC with a header comment; no
  module-scope mutable singletons outside `bootstrap.ts`; record actual per-module LOC in the
  change notes
  - Result: every module has a header comment and is under 500 LOC. Two module-scope
    singletons left over from earlier phases were moved into boot-scoped instances (commit
    `a25b770`): the log-line cache became `LogLineCache` (constructed in `startServer()`,
    passed to the session-preview route; its unit test now builds its own instance), and
    wake's `wakeInFlight` set became `SessionOpsContext.wakeInFlight`. What remains at
    module scope is immutable (constants, `sessionStamp`'s boot host label, the paste MIME
    map) or the clipboard SGR regex, whose `lastIndex` is reset on every call.
  - LOC: `index.ts` 8 (was ~4,970), `bootstrap.ts` 498, `startupPreflight.ts` 118,
    `logContent.ts` 288, `sessionStamp.ts` 19, `tmuxCapture.ts` 47;
    `refresh/` SessionRefreshLoop 433, hydrateSessions 243;
    `sessions/` context 40, kill 264, rename 117, hibernate 220, wake 489, resumeCommand 92,
    moveToHistory 50; `remote/RemoteSessionService.ts` 412;
    `ws/` wsTypes 39, ConnectionHub 81, clipboardWatch 249, copyMode 132, terminalProxy 303,
    terminalAttach 364, messageRouter 350, socketHandlers 126;
    `routes/` settings 265, sessionPreview 95, directories 156, serverInfo 81,
    updateInstall 55, paste 165.
- [x] 7.3 Confirm the harness ran unmodified through every commit (design D5); run the full
  suite plus the two integration files (`chatRename.integration`, `double-attach.integration`)
  one final time
  - Result: no commit on this branch touches `isolated/indexHandlers.test.ts` (it is identical
    to master's); the pre-commit hook ran the full suite green on every commit. Final run:
    `bun run test` 2,788 pass / 0 fail (incl. the real-tmux integration files);
    `chatRename.integration` 4/4 and `double-attach.integration` 3/3 run on their own with
    the runner's isolated env; `bun run lint`, `bun run typecheck`, `bun run build` clean.
- [x] 7.4 Mark S1 done in `docs/refactor-analysis/synthesis.md` (status note with commit
  hashes, mirroring the P0/S2 notes); commit (`docs: mark P1/S1 complete in refactor synthesis`)

## Workflow follow-up

- Merge `split-server-index` to master after review (user decision), then archive the change
  via the archive workflow.

# Phase 2 — Server architecture review (`src/server/`)

Repo: /home/coder/kawai @ 2557b22 (master), working tree.
Scope: `src/server/**` excluding `__tests__`, read in full for the hotspots (index.ts, logMatcher.ts, logPoller.ts, SessionManager.ts, db.ts, chat/*, terminal/*) and skimmed for the rest. Phase 1 metrics were re-verified where cited; corrections are called out explicitly.

---

## §1 Executive verdict

**Yes — the server needs refactoring, but selectively: one god-file, one dead-code half of a module, and a transport abstraction gap account for most of the damage; the chat and git/workspace subsystems are already in the target shape.**

`src/server/index.ts` (4,948 LOC) is a sequential boot script that mixes a composition root with seven distinct runtime subsystems and ~35 pieces of module-scope mutable state, and it is unreachable by normal imports (its only 3 exports are test hooks) — every change to kill/wake/refresh/attach logic has to be tested through a 7,093-LOC harness that mocks `Bun.serve` globally. `logMatcher.ts` carries ~700 lines of sync twins whose only production consumer sits behind a branch that is provably unreachable (the worker uses the async variants exclusively), so half the module is test-only code compiled into the server. The Pty/Ssh proxy duplication persists because `TerminalProxyBase` abstracts the wrong axis (lifecycle queueing + sync tmux) instead of the actual difference (sync local vs async SSH command transport). Everything else — chat lifecycle, TurnQueue, the pure reducers, the registry, the worker clients, git/workspace/updates — is well-factored, heavily commented, and adequately tested; refactoring those would be churn, not improvement.

---

## §2 Architecture map as-is

### Module layers (dependency direction: top depends on bottom)

```
index.ts (composition root + everything)          ← 4,948 LOC, imports 46 modules
├─ HTTP routes: routes/{claudeProfiles,pasteFile,chatProviderEnv}.ts   (only 3 of ~18 endpoints extracted)
├─ session core
│   SessionManager.ts (sync tmux window ops, spawnSync)                1,184
│   SessionRegistry.ts (EventEmitter; sessions + chatSessions maps,
│                       broadcast suppression via 30s activity buckets)   224
│   statusInference.ts + forceWorkingStatus.ts (status derivation)
│   sessionRefreshWorker.ts (worker: listAllWindows + paneContentCache)  418
│   sessionRefreshWorkerClient.ts (promise client, generation/timeouts)  291
├─ log pipeline
│   logPoller.ts (LogPoller: poll/watch modes, orphan rematch)        1,224
│   logMatchWorkerClient.ts → logMatchWorker.ts (worker thread)         222/426
│   logMatcher.ts (scrollback capture, prompt extraction, exact
│                  matching, verification — sync + async twins)       2,599
│   logDiscovery.ts, logPollData.ts, logMatchGate.ts, logWatcher.ts
├─ chat subsystem (clean module boundary)
│   ChatSessionManager.ts (lifecycle, 11 per-session maps)            1,221
│   ChatSessionDriver.ts (SDK query stream → ChatEvents)              1,108
│   ChatConnections.ts (per-socket fan-out + tick batching)             332
│   TurnQueue.ts, transcriptReplay.ts, transcriptTitleWatcher.ts,
│   usageLimits.ts, contextUsage.ts, chatActivity.ts (pure reducers),
│   ClaudeProfiles.ts, profileCatalog.ts, claudeExecutable.ts, wireTap/ChatWireLog(s).ts
├─ terminal subsystem
│   TerminalProxyBase.ts (start/switch queue, sync runTmux, paste)      296
│   PtyTerminalProxy.ts (local; owns grouped-session logic)             892
│   SshTerminalProxy.ts (remote; own async runTmuxAsync)                537
│   PipePaneTerminalProxy.ts, TerminalProxyFactory.ts, outputCoalescer.ts
├─ remoteSessions.ts (RemoteSessionPoller over SSH)                     531
├─ git/ workspace/ updates/ (already modular, headers accurate)
└─ db.ts (bun:sqlite, check-and-add migrations, closure-object API)   1,162
```

### index.ts internal responsibilities (line anchors)

| Responsibility | Lines (approx.) | State owned |
|---|---|---|
| Port check, tmux prerequisite, terminal-mode resolve | 109–138, 508–514 | — |
| Log-line pagination cache + 3 readers | 140–397 | `LOG_LINE_CACHE`, `logLineCacheBytes` |
| Tailscale IP discovery; WS-session reaper | 399–496 | — |
| DB init, settings bootstrap, `config` mutation | 516–561 | `runtimeHistoryMaxAgeHours`, `config.preferWindowName/terminalColorsEnabled` |
| tmux base-session ensure + env scrub | 563–598 | — |
| Socket table + per-connection `WSData` (17 fields) | 601–653 | `sockets` |
| Remote merge (protection/tombstones/name overrides), host statuses, `remotePoller` | 655–799 | `protectedRemoteSessionIds`, `remoteSessionTombstones`, `remoteSessionNameOverrides`, `hostStatuses`, `hostStatusSnapshot`, `remotePoller` |
| Chat wiring (wireLogs → manager → connections, fixture, peers) | 806–844 | `chatWireLogs`, `chatSessionManager`, `chatConnections`, `chatPeers` |
| LogPoller + 2 refresh-worker clients | 846–877 | `logPoller`, `sessionRefreshWorker`, `lastUserMessageWorker` |
| Agent-session hydration + startup verification | 879–1164 | (`hydrateSessionsWithAgentSessions`, exported for tests) |
| Refresh machinery (generation guard, window-count estimates) | 1166–1319 | `refreshInFlight`, `refreshGeneration`, `hasConfirmedLocalSessionSnapshot`, `lastSuccessfulRefreshWindowCount`, `refreshWindowCountFloor`, `startupExpectedWindowCount` |
| Enter-key capture (force-working, locks, timers) | 1321–1389 | `enterRefreshTimer`, `lastUserMessageTimers`, `lastUserMessageLocks` |
| Startup logging, refresh interval, update checker, event-loop monitor | 1391–1441 | `updateChecker`, uncleared intervals |
| Registry→broadcast wiring, workspace seeds/coordinator/watcher | 1476–1556 | `workspaceCoordinator` (dead hook), `workspaceCoordinatorInstance`, `workspaceWatcherInstance` |
| HTTP routes (~18 endpoints incl. Swift pasteboard script) | 1558–2173 | `pasteImageExtensionByMime`, `macPasteboardSwiftScript` |
| TLS, `serverFetch`, `websocketHandlers`, two `Bun.serve` | 2170–2308 | `websocketHandlers`, `boundTailscaleIp`, `tlsOptions` |
| Poller startup, `completeStartupVerification`, SIGINT/SIGTERM | 2310–2343 | — |
| tmux clipboard-buffer watch (750ms poll per connection) | 2351–2598 | per-`WSData` clipboard fields + `clipboardWatchGen` |
| broadcast/send (coalescer-aware), fireAndForget | 2600–2647 | — |
| `handleMessage` dispatcher (~26 message types) | 2708–2899 | — |
| Copy-mode probe/cancel | 2901–3163 | `copyModeCheckInFlight` |
| Kill / rename / move-to-history / hibernate | 3165–3761 | `wakeInFlight` |
| Wake: resume-command build, dormant rematch, claim races | 3763–4311 | — |
| Terminal attach lifecycle, SSH proxy creation, remote ssh helpers | 4313–4948 | per-`WSData` terminal fields, `terminalAttachSeq` |

### Key data flows

- **Session list refresh**: `setInterval(refreshSessions)` → `sessionRefreshWorker.refresh()` (worker: `list-windows -a` + per-pane capture, status inference against `paneContentCache`) → `hydrateSessionsWithAgentSessions` (DB overlay, orphan judgment) → `applyForceWorkingOverrides` → `mergeRemoteSessions` → `registry.replaceSessions` → broadcast. Optimistic mutations bump `refreshGeneration`; in-flight refreshes discard stale snapshots (index.ts:1231–1245).
- **Log matching**: `LogPoller.pollOnce`/`pollChanged` → `LogMatchWorkerClient.poll` → worker scans log dirs (`collectLogEntryBatch`), gates entries (`logMatchGate`), runs `matchWindowsToLogsByExactRgAsync` (scrollback capture → prompt extraction → rg candidate search → agent-family/project filters → ordered-message scoring) → `processMatchResponse` on the main thread applies row updates, dormant rematch claims (`db.claimCurrentWindow`, 60s cooldown), slug supersede, new-session inserts with boot deferral.
- **Chat**: WS `chat-*` → `ChatConnections.handle` → `ChatSessionManager` (records/drivers maps) → `ChatSessionDriver` (SDK `query()` over `TurnQueue`, `canUseTool` bridge) → events sequenced in manager → batched per-connection flush in `ChatConnections` → `chat-events` frames; snapshots = replayed transcript history + live events.
- **Terminal**: WS `terminal-attach` → `ensureCorrectProxyType` → Pty/PipePane/Ssh proxy → `switchTo` queues through base → grouped-session indirection (local only) → output coalesced per connection.

---

## §3 Findings

Phase 1 claims re-verified below; where they are wrong, the correction is stated.

### F1. index.ts is a sequential boot script acting as the entire server runtime — high

**Evidence**: 4,948 LOC, 3 exports, all test-only: `hydrateSessionsWithAgentSessions` (index.ts:1004) is imported only by `src/server/__tests__/hydrateSessionsEmptyGuard.test.ts:148`; `WorkspaceCoordinatorHook`/`attachWorkspaceCoordinator` (index.ts:1517–1527) have **zero** consumers anywhere (verified by grep across `src`, `scripts`, `bin`). 46 import statements; `handleMessage` is a 192-line switch (2708–2899) closing over ~10 singletons.

**Why it matters**: (a) The only test path is `__tests__/isolated/indexHandlers.test.ts` (7,093 LOC), which mocks `Bun.serve`/`Bun.spawn`/`Bun.spawnSync` globally and re-imports the whole module — slow, order-dependent, and unusable for unit-testing e.g. `handleSessionWake` in isolation. (b) Merge conflicts and review cost concentrate in one file. (c) The module cannot be instantiated twice (module-scope state), so no test parallelism. Phase 1's numbers confirmed.

### F2. Init-order correctness is accidental, not enforced — high (fragility, not a live bug)

**Evidence**: Top-level statements execute sequentially 508–2314. Functions defined before their dependencies' declarations are safe only because nothing calls them before `Bun.serve` (2266) / `logPoller.start` (2310):
- `mergeRemoteSessions` (683) reads `remotePoller`, declared at 781.
- `chatSessionManager`'s options (810–830) close over `chatConnections` (declared 831) and `workspaceCoordinatorInstance` (declared 1529 — the comment at 1515–1516 admits the TDZ concern for the *other* variable).
- `websocketHandlers.open` (2221) calls `send`/`broadcast`, declared at 2625/2615 (hoisted function declarations), which read `sockets` (634).
**Why it matters**: Any refactor that moves a declaration, or any constructor that starts emitting events earlier (e.g. `ChatSessionManager` calling `onEvent` from `restorePersisted`), produces a runtime `ReferenceError` (TDZ) or silently wrong ordering with no compile-time signal. There is also a vestigial dual reference: `workspaceCoordinator` (hook, 12 refs) and `workspaceCoordinatorInstance` (7 refs) are the same object reached through two names, one of which exists only to support the dead `attachWorkspaceCoordinator` export.

### F3. ~700 lines of logMatcher's sync/async twinning is dead in production — high (best cost/benefit in the review)

**Evidence**:
- The worker thread uses **only async variants**: `logMatchWorker.ts` imports `matchWindowsToLogsByExactRgAsync` (line 18) and calls it at 126 and 163; `getLogTokenCount`, `extractLastUserMessageFromLog` are sync but are file-IO helpers, not twins.
- The only production caller of the sync matching chain is `verifyWindowLogAssociationDetailed` at index.ts:1068, inside `hydrateSessionsWithAgentSessions`'s `else if (verifyAssociations)` branch (1063), which requires `verifyAssociations && !precomputedVerifications` (1027). The only call site that sets `verifyAssociations: true` is `completeStartupVerification` (1459), which **always** passes `precomputedVerifications` from `verifyAllSessions` (934–1002) — and `verifyAllSessions` returns one entry per active session (including the catch fallback), so the map is complete and the sync branch is unreachable.
- `refreshSessionsSync({verifyAssociations: true})` has no production caller (all four call sites — 1411, 3414, 3882, 4200/4231 — pass nothing).
- Hence dead-in-production: `tryExactMatchWindowToLog` (1874–2072), `findLogsWithExactMessage`/`...InPaths` (620–822), `scoreOrderedMessageMatches`/`...WithRg` (1016–1110), `getRgMatchLines` (923), `captureTerminalScrollback`/`getTerminalScrollback`/`getTerminalScrollbackWithAnsi` (1424–1536), `matchWindowsToLogsByExactRg` (2291–2352), `verifyWindowLogAssociation`/`...Async` (2439–2492) — all kept alive by `logMatcher.test.ts` and the one unreachable branch.

**Verdict on Phase 1's question**: the twinning is **accidental, not a hot-path requirement**. The sync variants look like the pre-worker implementation that was never deleted after matching moved to the worker thread (which is precisely where sync spawns would have been fine).

**Why the export surface reaches 47**: five concerns accreted in one module (log text/token reading, scrollback capture, prompt extraction, exact matching, verification), each exported for tests, with every matching-layer API doubled sync/async. Phase 1's count of 22 production-dead exports is consistent with what I verified.

### F4. Chat snapshot/restore parses full transcripts synchronously on the main event loop — high (user-facing latency)

**Evidence**: `ChatConnections.handle('chat-attach')` calls `manager.getSnapshot` synchronously (ChatConnections.ts:256, by design for ordering). `getSnapshot` → `captureHistory` → `getHistory` (ChatSessionManager.ts:256–292, 387–403) → `findTranscriptPath` = recursive `readdirSync` walk of `~/.claude/projects` (transcriptReplay.ts:100–130) + `replayTranscriptFile` = `fs.readFileSync` of the whole JSONL + full parse (453). Startup is worse: `restorePersisted` (733–774) calls `readTranscriptTitle` **and** `readTranscriptCwd`, each of which re-reads and re-parses the entire transcript separately (486, 499) — 2 full parses + 1 directory walk per persisted chat per boot, plus a third parse on first attach.

**Why it matters**: A long agent conversation is easily tens of MB of JSONL. Parsing that synchronously stalls the single server thread — freezing keystroke echo and terminal streaming for every connected client — exactly the failure mode the codebase's own event-loop-lag monitor (index.ts:1421–1441) and "async spawn" comments (2384–2422, 3080–3091) exist to prevent. The sync *snapshot* contract is fine; the file IO inside it is not.

### F5. TerminalProxyBase abstracts the wrong axis, so Pty/Ssh duplication survives — medium-high

**Evidence**: Base provides lifecycle queueing (`start`/`switchTo`/`flushSwitchQueue`), sync `runTmux` via `spawnSync` (TerminalProxyBase.ts:136–161), and sync paste plumbing (`deliverPasteViaTmux`, 207–229). The essential Pty/Ssh difference is the command transport (sync local spawn vs async SSH round-trip), which is **not** abstracted: `SshTerminalProxy` defines its own `runTmuxAsync` (136–174) and then re-implements on top of it: `dispose` (99–129 vs Pty 363–404), `doSwitch` skeleton (435–497 vs 618–718), `discoverClientTty` backoff loop (499–533 vs 852–889), `clientFeatureArgs` (236–249 vs 720–737), the `terminal:{data,exit}` decode/`outputSuppressed`/`onData` block (350–368 vs 540–557), the `proc.exited` handler, and the paste sequence in async form (51–86). Phase 1's line-by-line mirror list is accurate.

**Correction to Phase 1**: the claim that *grouped-session logic is mirrored between the two proxies* is **wrong**. `SshTerminalProxy` contains no grouped-session code at all — no `externalGroupedSessions`, no `ensureExternalTarget` override (base's default returns the target unchanged), no `resolveGroupedSessionSwitchTarget` import. Remote sessions attach to the remote session directly without the focus-isolation indirection. That asymmetry is itself worth a comment/design decision, but it is not duplication. (The duplication Phase 1 saw inside PtyTerminalProxy — mouse-option copy at `doStart` 448–481 vs `ensureExternalGroupedSession` 301–322, and stale-derived-session kill+evict at 256–266 vs 686–703 — is real and internal to Pty.)

**Also**: `SshTerminalProxy.ts:537` re-exports `shellQuote` with zero importers anywhere — dead.

**Why it matters**: every bug fix to the attach/switch lifecycle (attempt-race handling, tty discovery backoff, exit settlement) must be applied twice; the two copies have already drifted (Pty verifies switch identity via `readClientIdentity` + retries; Ssh does not verify at all; Pty has a `disposed` flag guarding resurrection, Ssh does not).

### F6. db.ts: missing dormancy index, redundant indexes, no WAL, per-boot scans — medium

**Evidence**:
- `getHibernatingSessions`/`getHistorySessions` (db.ts:305–313) filter `current_window IS NULL AND is_pinned = ?` with `ORDER BY last_activity_at DESC` and **no supporting index** (CREATE_INDEXES_SQL at 207–217 covers `session_id`, `log_file_path`, `current_window`, plus the partial unique). These are full table scans + sorts, and they run on **every poll cycle** (logPoller.ts:1073–1079 loads active + hibernating + history(72h) each `pollOnce`) and on every mutation (`updateDormantAgentSessions`, index.ts:908–921).
- Redundant indexes: `idx_session_id` and `idx_log_file_path` duplicate the `UNIQUE` constraints' automatic indexes (151–154); `idx_current_window` is mostly covered by the partial unique index. Three write-amplifying indexes for effectively one useful (partial unique) index.
- No `PRAGMA journal_mode=WAL` or `synchronous` tuning anywhere; bun:sqlite defaults to the rollback journal, so the poller's steady stream of `updateSession` writes pays journal fsyncs while serving terminals.
- `migrateDeduplicateDisplayNames` (969–1021) runs its `GROUP BY ... HAVING count>1` scan on every boot with no guard, unlike its siblings.
- The chat_sessions column adds inline in `initDatabase` (245–271) repeat the exact shape of the twelve `migrate*Column` helpers (857–967) — Phase 1 confirmed.
- Multi-step domain operations are not transactional (e.g. `processMatchResponse`'s slug-supersede `updateSession` + later `insertSession`; `handleKill`'s unpin → killWindow → update sequence). The partial unique index is the real guard and it holds, but sequences can be observed half-applied by a concurrent poll.
**What is good**: `claimCurrentWindow` (465–492) is an exemplary atomic guard (dormant + NOT EXISTS, backed by `idx_current_window_unique`), and `MAX_LAST_USER_MESSAGE_LENGTH` clamping shows the table bloat lesson was learned.

### F7. Shutdown ordering is incomplete — medium

**Evidence**: `cleanupAllTerminals` (index.ts:2317–2335) disposes terminal proxies, stops workspaceWatcher/logPoller/remotePoller, shuts down chat, closes the DB — but never calls `sessionRefreshWorker.dispose()` / `lastUserMessageWorker.dispose()` (both exist, sessionRefreshWorkerClient.ts:165–170, and are simply never invoked), never calls `updateChecker.stop()` (exists, updateChecker.ts:33), and never clears `setInterval(refreshSessions)` (1412), the event-loop-lag interval (1426, debug only), `enterRefreshTimer` (1322), or `lastUserMessageTimers` (1323). Because the signal handlers immediately `process.exit(0)` after the cleanup promise settles, the impact is bounded to the cleanup window: an in-flight `refreshSessionsAsync` can write to a closed DB (its `hydrateSessionsWithAgentSessions` runs after `db.close()`), and worker threads die with the process.

### F8. Sync tmux bursts on WebSocket request paths — medium

**Evidence**: `refreshSessionsSync()` is invoked inside async handlers: `handleRename` (3414), `tryRematchDormantSession` (3882), and twice in the wake claim-race paths (4200, 4231). It calls `sessionManager.listWindows()` — an N+1 `Bun.spawnSync` cascade: `list-sessions`, then `list-windows` per session (SessionManager.ts:768–780), then `capturePaneWithDimensions` per window (1111–1180) via `inferStatus`. Each spawn can block up to `config.tmuxTimeoutMs`. This contradicts the codebase's own rationale comments for async spawns (index.ts:2384–2386, 3080–3085, 3101–3123).

### F9. ChatSessionManager: duplication and sink-creep — low-medium

**Evidence (Phase 1 confirmed)**: `send` (412–436) and `start` (446–468) are identical except `driver.send(text)` vs `driver.start()` and a `touch()`. `resolveApproval` (591–606) / `answerQuestion` (608–623) differ only in the error noun and delegation. `createAvailableSession` (227–251) repeats `createSession`'s (325–361) path/launch/auth guard chain. The executable/auth verify block is duplicated between `ensureDriver`'s dead-driver path (837–848) and `probeAvailability` (940–946). Beyond duplication, the manager owns four concerns that are really sinks/collaborators: transcript title watching (`titleWatchers`, 801–830), cwd-move workspace refresh debouncing (`cwdRefreshTimers`, 1114–1131), context-usage persistence policy (1069–1091), and the plan-usage store (`usageLimits`). Eleven per-session maps total.
**Lifecycle gaps found**: `archive()` (487–519) does not `cancelCwdRefresh` (kill and shutdown do) — a debounced workspace refresh can fire for an archived session (harmless but inconsistent). `liveEvents` grows unboundedly per session for the process lifetime (only killed on kill; `snapshotHistory` is captured once and never re-based), so a very long-lived chat accumulates the full event list in memory.
**Lifecycle correctness otherwise**: the create/attach/idle/archive/restore/kill state machine is sound — `ensureDriver`'s promise-sharing prevents double spawns, the archived guard inside the driver promise (913–919) discards races, `startBlocker` centralizes refusals, and `claimCurrentWindow`-style atomicity is respected on the wake side. Restart/resume is well covered (`restorePersisted` resets status to waiting; missing-transcript refusal preserves the SDK id).

### F10. tmux capture plumbing exists in four independent implementations — low-medium

**Evidence**: `logMatcher.runCommandSync/runCommandAsync` (93–129), `sessionRefreshWorker.runTmux/capturePane/captureScrollback` (180–305), `SessionManager.runTmux` (module fn ~933) + `capturePaneWithDimensions` (1111), and `index.ts readTmuxCapture` (2387–2422). Each re-solves timeout handling, UTF-8 flagging, and stderr draining slightly differently (e.g. only `readTmuxCapture` has the belt-and-suspenders kill timer).

### F11. Cross-cutting error handling is inconsistent but not negligent — low

HTTP routes return `{error: string}` with per-route status codes and shape (e.g. `directories` has structured `DirectoryErrorResponse`, settings routes return bare strings); WS errors are `{type:'error', message}`; async handler failures funnel through `fireAndForget` → `unhandled_async_error` log (2640–2647). `handleKill`'s chat branch (3251–3254) returns without the `session_kill_completed` audit log the terminal paths emit. `handleSessionHibernate` is the one WS mutation not wrapped in `fireAndForget` (2866) — it is synchronous today, so this is latent rather than a bug.

### F12. Race handling is a strength, not a liability (for the record)

`refreshGeneration` (1166–1179), `clipboardWatchGen` (2443–2457), `terminalAttachSeq` + `isTerminalAttachCurrent` (4369 ff.), `copyModeCheckInFlight` with reply-currency re-check (3097–3163), `pollInFlight` + `drainPendingChangedPaths` (logPoller 690–693), `claimCurrentWindow` atomicity, and the match worker's serialized dispatcher (logMatchWorker.ts:395–415) are all deliberate, documented, and tested. The one soft spot: `hydrateSessionsWithAgentSessions` performs DB writes (`updateSession` for display-name sync, 1137) and `killWindow` (1048) during a refresh whose generation guard only covers the *window list*, not concurrent kills — low practical risk since the empty-input guard (1018–1023) and unique window index contain the damage.

---

## §4 Recommendations

Ordered by priority. Effort: S ≤ 1 day, M ≤ 1 week, L > 1 week for one contributor.

### P1-1. Decompose index.ts into a composition root plus domain modules

**Problem**: F1 + F2 (4,948-LOC untestable god-file; accidental init ordering; dead hook exports).
**Proposed change** — keep the existing module style (small modules, constructor-injected deps, header comments), creating `src/server/` peers of `chat/` and `terminal/`:

1. `server/logContent.ts` — lift index.ts:140–397 verbatim (`LogLineWindow`, `LOG_LINE_CACHE`, the three readers). No deps; unit-testable immediately.
2. `server/refresh/SessionRefreshLoop.ts` — lift 879–1164 + 1166–1319 + 1443–1474 (`hydrateSessionsWithAgentSessions`, `verifyAllSessions`, `updateActive/DormantAgentSessions`, refresh state machine, `completeStartupVerification`) as a class taking `{db, registry, sessionManager, sessionRefreshWorker, config, remoteMerge, broadcast}`. The six `let` counters become fields; `hydrateSessionsWithAgentSessions` becomes a real (still-testable) method instead of an export hack.
3. `server/sessions/kill.ts | rename.ts | hibernate.ts | wake.ts | moveToHistory.ts` — lift 3165–4311 as functions over a shared `SessionOpsContext` (`{registry, db, sessionManager, config, refresh, broadcast, send}`). `wake.ts` takes the resume-command builders (3763–3877) with it; these become directly unit-testable without `Bun.serve` mocks.
4. `server/remote/RemoteSessionService.ts` — merge `mergeRemoteSessions` + protection/tombstone/override maps + `runRemoteTmux`/`runRemoteSsh`/`sshOptionsForHost` + `handleRemoteCreate` (655–799, 2912–3072, 4768–4813). Deletes the TDZ hazard in F2 outright (constructor owns the poller).
5. `server/ws/ConnectionHub.ts` — `sockets`, `WSData`, `broadcast`, `send`, `fireAndForget`, registry→broadcast wiring (601–653, 1476–1494, 2615–2647); `server/ws/clipboardWatch.ts` (2351–2598); `server/ws/copyMode.ts` (2901–3163); `server/ws/terminalAttach.ts` (4313–4948, the proxy lifecycle + SSH proxy creation + attach/detach/input/paste/resize).
6. `server/routes/` — extract the remaining HTTP endpoints following the existing `routes/claudeProfiles.ts` pattern: `settings.ts` (1837–2012, which also kills the four copy-pasted setting blocks noted at 520–554), `sessionPreview.ts` (1572–1642, uses `logContent.ts`), `directories.ts`, `serverInfo.ts`, `updateInstall.ts`, `paste.ts` (2017–2168 incl. the Swift script constant).
7. `server/bootstrap.ts` — the composition root: constructs `db`, `registry`, managers, services in an explicit `startServer()` with a linear, commented init sequence; owns `Bun.serve`, signal handlers, and the shutdown list. `index.ts` shrinks to `startServer()` (or re-exports it). Delete `WorkspaceCoordinatorHook`/`attachWorkspaceCoordinator`; reference the coordinator through one name.
   **Singletons**: only `bootstrap.ts` holds them; every extracted module receives its dependencies (the `ChatSessionManagerOptions` DI style is the template). This converts the TDZ hazards of F2 into constructor arguments.
**Risk**: behavior drift during extraction (the ordering guards in F12 must move verbatim — treat `refreshGeneration`, `clipboardWatchGen`, `terminalAttachSeq` as load-bearing); test harness churn.
**Effort**: L (do it in the order listed, one PR per module, each a pure lift).
**Verify safety**: `__tests__/isolated/indexHandlers.test.ts` (7,093 LOC, exercises kill/rename/hibernate/wake/attach/settings through the real module), `__tests__/index.test.ts`, `hydrateSessionsEmptyGuard.test.ts` (the empty-input guard), plus `chatRename.integration.test.ts` and `double-attach.integration.test.ts`. During extraction, add per-module unit tests for `wake.ts` (claim-race branches at 4145–4256 currently only covered end-to-end) and `logContent.ts` window math.

### P1-2. Delete the dead sync matcher chain; split logMatcher by concern

**Problem**: F3 (~700 LOC of twins whose only production path is unreachable; 47-export surface).
**Proposed change**:
1. Remove the `else if (verifyAssociations)` sync branch in `hydrateSessionsWithAgentSessions` (index.ts:1063–1083) and the `verifyAssociations` option entirely — `completeStartupVerification` already always supplies precomputed (async) verifications. Then delete the sync chain: `matchWindowsToLogsByExactRg`, `tryExactMatchWindowToLog`, `findLogsWithExactMessage(±InPaths)`, `scoreOrderedMessageMatches(±WithRg)`, `getRgMatchLines`, `captureTerminalScrollback`, `getTerminalScrollback(±WithAnsi)`, `verifyWindowLogAssociation`, `verifyWindowLogAssociationAsync` (superseded by `...DetailedAsync`), and `runCommandSync` where it becomes unused.
2. Split what remains (target <500 LOC each, per repo norm): `logMatcher/scrollback.ts` (async captures), `logMatcher/promptExtract.ts` (`extractRecentUserMessagesFromTmux`, `extractPiUserMessagesFromAnsi`, `extractRecentTraceLinesFromTmux`, `isToolNotificationText`, `stripPastePlaceholders`, prompt-line heuristics), `logMatcher/logText.ts` (`readLogContent`, `extractLogText`, `getLogTokenCount`, `extractLastUserMessageFromLog`, `extractLastEntryTimestamp`, `iterateLogLinesBackward`, `zeroTokenLogCache`), `logMatcher/exactMatch.ts` (async matching + scoring + profiler), `logMatcher/verify.ts` (`verifyWindowLogAssociationDetailedAsync`). Keep `logMatcher.ts` as a temporary barrel if desired, but shrink the export list to the 16 production-consumed symbols Phase 1 identified.
3. Port `logMatcher.test.ts` (2,184 LOC) cases that exercise sync variants to their async twins (most already have mirrored cases).
**Risk**: low — the deleted code has no production callers; the only subtlety is keeping test parity for the matching heuristics.
**Effort**: M (mostly test migration).
**Verify safety**: `logMatcher.test.ts`, `logMatchWorker.test.ts`, `logPoller.test.ts`, `logMatchGate.test.ts`; add one test asserting `completeStartupVerification` never takes the (removed) sync path — trivially true after deletion, but keeps the option from being reintroduced.

### P1-3. Take transcript parsing off the main thread (chat startup + first attach)

**Problem**: F4 (sync `readFileSync` + full JSONL parse + recursive `readdirSync` on the event loop, 2–3× per session).
**Proposed change**:
1. `transcriptReplay.ts`: add `readTranscriptMeta(path)` returning `{title, cwd}` from a **single** parse pass, and make `findTranscriptPath`/`replayTranscriptFile` async (`fs/promises`) — or keep them sync but confine all calls to one place.
2. `ChatSessionManager.restorePersisted` becomes `async restorePersisted()` awaited in the constructor path from `bootstrap.ts` (or kicked off without blocking server start, since chat rows only need to exist before the first `chat-attach`, which the WS handler can await). Use the single-pass meta reader instead of `readTranscriptTitle` + `readTranscriptCwd`.
3. `getSnapshot`: keep the synchronous *assembly* contract, but make `ChatConnections.handle('chat-attach')` await an async `manager.loadHistory(sessionId)` (memoized in `snapshotHistory`) before building the snapshot — events emitted while loading are already sequenced after via `liveEvents`, and the existing `captureHistory`-before-`start()` ordering is preserved because `start()` is awaited after the snapshot send.
4. Bound `liveEvents` by folding into `snapshotHistory` at turn boundaries (e.g. when `liveEvents` exceeds N events and no client snapshot is mid-flight), which also caps memory (F9).
**Risk**: medium — snapshot ordering is the invariant ("live events cannot overtake the initial snapshot"); must be re-checked for the reconnect/restore flows.
**Effort**: M.
**Verify safety**: `chatSessionManager.test.ts` (3,006 LOC) covers snapshots/restore/kill settlement; `chatTranscriptReplay.test.ts`, `chatConnections.test.ts`, `chatRename.integration.test.ts`. Add a test that a `chat-attach` racing a live `assistant_delta` still yields the delta after the snapshot.

### P2-1. Terminal proxies: extract a transport, hoist the lifecycle template

**Problem**: F5 (Pty/Ssh mirror; base abstracts sync tmux only; drift already present — identity verification and the `disposed` flag exist only in Pty).
**Proposed change**:
1. Define `interface TmuxTransport { run(args, opts?): Promise<string>; runSync(args, opts?): string }` in `terminal/types.ts`. Local transport wraps `Bun.spawnSync` (today's base `runTmux`, with `sanitizedTmuxEnv` and `TmuxTimeoutError` mapping); SSH transport wraps `SshTerminalProxy.runTmuxAsync` with shell-quoting and timeout-kill. Inject via `TerminalProxyOptions`.
2. Make `TerminalProxyBase` fully async over `transport.run` and hoist the shared templates as protected final methods with hooks: `doStart()` becomes `startBackingSession() → spawnAttach() → discoverClientTty() → markReady()` in the base (the attempt-id race checks, `proc.exited` settlement, `outputSuppressed` decode block, and dispose sequence live here once). `doSwitch()` becomes a base template calling `switchClient(target)` + an optional `verifyTargetIdentity()` hook — then give **Ssh** the Pty identity-verification step it currently lacks, and both the `disposed` resurrection guard.
3. Move Pty's grouped-session management (`externalGroupedSessions`, `resolveExternalGroupedTarget`, `ensureExternalGroupedSession`, eviction/evacuation, 114–323 + 686–703 + 739–754) into `terminal/groupedSessions.ts` as a collaborator used only by the local proxy, and document in `SshTerminalProxy`'s header that remote attach intentionally skips focus isolation (correcting the record).
4. Delete the `shellQuote` re-export (SshTerminalProxy.ts:537).
**Risk**: medium-high — attach/switch is the most race-sensitive code in the server; the attempt-id guards must be preserved exactly.
**Effort**: M–L.
**Verify safety**: `__tests__/isolated/terminalProxy.test.ts` (1,472 LOC), `double-attach.integration.test.ts`, `copy-mode-async.integration.test.ts`, output-coalescing integration test. Add an Ssh-side test for identity verification (currently untested because unimplemented).

### P2-2. db.ts: WAL, dormancy index, index cleanup, migration tidy

**Problem**: F6 (per-poll full scans, write amplification, duplicated migration shapes).
**Proposed change**: (1) `PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;` after open. (2) Add `CREATE INDEX IF NOT EXISTS idx_dormant ON agent_sessions (is_pinned, last_activity_at DESC) WHERE current_window IS NULL;` — serves both dormancy queries. (3) Drop `idx_session_id`, `idx_log_file_path`, and `idx_current_window` (all redundant with the UNIQUE constraints / partial unique index; verify with `EXPLAIN QUERY PLAN` in a test). (4) Fold the inline chat_sessions column adds (245–271) into the `migrate*Column` helper convention, and give `migrateDeduplicateDisplayNames` the same cheap `columns.includes` no-op guard shape. (5) Optional: introduce a `schema_version` row so migrations run once instead of per boot — nice but not required given the guards are cheap once the dedupe scan is guarded.
**Risk**: low; index drops are behavior-neutral if the UNIQUE auto-indexes are confirmed via EXPLAIN.
**Effort**: S.
**Verify safety**: `db.test.ts` (exists), plus add EXPLAIN-based assertions for the three dormancy queries and a migration idempotency test (open twice on a fixture DB).

### P2-3. ChatSessionManager: merge the twin methods, extract the sink collaborators

**Problem**: F9 (duplicated guard chains; manager as sink dumping ground).
**Proposed change**: (1) Replace `send`/`start` with `submit(sessionId, text?: string)` (one guard chain, `text == null ? driver.start() : driver.send(text)` + `touch`). (2) Replace `resolveApproval`/`answerQuestion` with a single `respondToRequest(sessionId, requestId, payload)` dispatcher, or extract the shared "no driver / unknown session" error builder. (3) Fold `createAvailableSession`'s probe around `createSession` instead of duplicating the path/launch/auth chain. (4) Extract `ChatTitleWatcherRegistry` (title locate/backoff/tail per session) and `CwdRefreshScheduler` (debounce map) into `chat/` collaborators — the manager keeps calling them; also call `cancelCwdRefresh` in `archive()`.
**Risk**: low (pure refactor inside the best-tested subsystem).
**Effort**: S–M.
**Verify safety**: `chatSessionManager.test.ts` (3,006 LOC), `chatConnections.test.ts`, `chatArchiveDb.test.ts`, `chatRename.integration.test.ts`.

### P2-4. Complete the shutdown path

**Problem**: F7 (undisposed workers, uncleared timers, DB close vs in-flight refresh).
**Proposed change**: In the composition root's shutdown (today `cleanupAllTerminals`): `sessionRefreshWorker.dispose(); lastUserMessageWorker.dispose(); updateChecker.stop(); clearInterval(refreshInterval); clearTimeout(enterRefreshTimer); for (t of lastUserMessageTimers.values()) clearTimeout(t);` before `chatSessionManager.shutdown()` and `db.close()`, and set a `shuttingDown` flag that makes `refreshSessionsAsync` return early.
**Risk**: none of substance.
**Effort**: S.
**Verify safety**: extend `index.test.ts` shutdown case to assert the workers' `dispose` was called (mock the clients).

### P2-5. Remove sync refresh from WS handler paths

**Problem**: F8 (N+1 `spawnSync` cascade inside `handleRename`/wake/tryRematch).
**Proposed change**: The wake paths call `refreshSessionsSync()` only to make the registry reflect a racing claim before reading it back (comments at 4228–4231 say exactly this). Replace with `await sessionRefreshWorker.refresh(...)` (already exists and is what the periodic loop uses) plus the same generation check, or — cheaper — read the claim state from the DB (which the wake path already trusts via `db.claimCurrentWindow`) instead of re-listing tmux. `handleRename`'s use (3414) is a stale-registry fallback and can await the worker refresh too.
**Risk**: medium — the sync call was chosen for inline correctness; the replacement must preserve "registry reflects the claim before we look up the live session".
**Effort**: M.
**Verify safety**: `isolated/indexHandlers.test.ts` wake-race cases (it mocks `spawnSync`, so the tests will catch a path change), `sessionRefreshWorker.test.ts`.

### P3-1. Unify tmux command plumbing

**Problem**: F10 (four implementations). **Change**: one `server/tmuxClient.ts` exposing `runTmuxSync(args, {timeoutMs})` and `runTmux(args, {timeoutMs, killMarginMs})` (the `readTmuxCapture` kill-timer pattern), consumed by logMatcher remnants, SessionManager, sessionRefreshWorker, and index.ts's clipboard/copy-mode paths. The UTF-8 flag and `TmuxTimeoutError` mapping live in one place. **Risk**: low. **Effort**: M. **Verify**: `tmuxFormat`/`sessionManager`/`sessionRefreshWorker` tests unchanged; add timeout-mapping unit tests.

### P3-2. logPoller.processMatchResponse: split the entry loop

**Problem**: 350-line function (695–1044) mixing three policies (row update, dormant rematch, new-session insert with deferral/supersede). **Change**: extract `applyEntryToExisting` (762–912, both branches share `applyLogEntryToExistingRecord` already — collapse the by-logPath/by-sessionId twins) and `insertNewSession` (894–1025). **Risk**: low. **Effort**: S. **Verify**: `logPoller.test.ts` (2,065 LOC) covers rematch/cooldown/supersede/deferral.

### P3-3. De-duplicate window listing + status inference (SessionManager vs sessionRefreshWorker)

**Problem**: `SessionManager.listWindows` (476–500 + 724–766) and `sessionRefreshWorker.listAllWindows` (307–380) are parallel implementations of "list tmux windows, capture panes, infer status" with separate `paneContentCache`s. **Change**: extract shared pure functions (`parseWindowData`, `deriveTerminalSession`) into `server/windowListing.ts` used by both; keep the sync/async spawn difference at the edges. **Risk**: low-medium. **Effort**: M. **Verify**: `sessionManager.test.ts` (2,290 LOC) + `sessionRefreshWorker.test.ts`.

---

## §5 What NOT to refactor

1. **The sync-vs-async spawn discipline itself** (workers use `spawnSync`, main thread uses `Bun.spawn` with kill timers). This is the performance architecture — the comments at index.ts:2384–2422, 3080–3091 and logMatchWorker's serialized dispatcher document real production incidents. P1-2 deletes *dead sync code*, not the pattern.
2. **`db.claimCurrentWindow` + `idx_current_window_unique`.** The atomic dormant-and-unclaimed guard is the linchpin that makes wake/logPoller/orphan-rematch concurrency safe without locks. Keep exactly as is.
3. **The generation/attempt/watch-generation guard patterns** (`refreshGeneration`, `clipboardWatchGen`, `terminalAttachSeq`, `copyModeCheckInFlight`, `startAttemptId`, worker `generation`). They look like scattered primitive obsession but each encodes a specific race fix; during P1-1 move them verbatim into the owning class, do not "clean them up".
4. **`SessionRegistry`'s broadcast suppression** (30-second activity buckets, `sessionsEqualForBroadcast`). Load-bearing for UI performance; heavily commented and tested.
5. **`hydrateSessionsWithAgentSessions`' empty-input guard** (index.ts:1018–1023). A regression-tested mass-kill protection; whatever module it lands in must keep it first.
6. **`ChatConnections` batching, `TurnQueue`, `chatActivity`/`contextUsage`/`usageLimits` reducers, `wireTap`/`ChatWireLog`.** Small, pure or queue-shaped, accurately documented, well tested — these are the model for the rest of the codebase, not problems.
7. **`logPoller.ts`'s overall shape** (single export, DI-friendly constructor with `matchWorkerClient` injection, watch/poll modes, empty-log and rematch cooldown caches). Its length is one linear loop plus one long function (see P3-2 for the optional split); a rewrite would risk the carefully tuned poll economics (72h history window, 2KB message prefixing, backfill limits).
8. **The chat event-sourcing split** (SDK transcript = history, `liveEvents` = delta). The double-parse issue (P1-3) is an implementation flaw, not a design flaw; do not move conversation content into SQLite — the D5 decision to keep the DB minimal is correct.
9. **`developmentFixture.ts` and the injected `queryFactory`/`spawn` conventions.** Test injection points are deliberate and consistently used; they are why the chat/terminal subsystems are unit-testable without processes.
10. **The `remoteSessions.ts` "export for testing" block** (520–531). Slightly inflates the export count, but it buys direct unit tests of the parsers; the module itself is a clean pipeline and only ~30 LOC over the size norm.

# Phase 1: server core (`src/server/*.ts`) mechanical metrics

Scope: 33 `.ts` files directly in `/home/coder/kawai/src/server/` (no subdirs, no `__tests__`). 15,439 LOC total.
Measured with `wc -l`, `grep -c '^export '`, brace-count function scan, and cross-repo symbol greps.

## Section 1: Hotspot table (sorted by LOC desc)

| file | LOC | >500? | #exports | long funcs (>100 lines) | TODOs | one-line main problem |
|---|---|---|---|---|---|---|
| index.ts | 4948 | YES | 3 | 6 (handleMessage 192, handleRemoteCreate 161, handleKill 170, handleRename 106, handleSessionHibernate 206, tryRematchDormantSession 119) | 0 | god-file: HTTP routes, WS protocol, log caching/reading, remote merge, chat wiring, workspace, update checker, pasteboard, TLS all as module-level singletons; no header comment |
| logMatcher.ts | 2599 | YES | 47 | 3 (tryExactMatchWindowToLog ~199, tryExactMatchWindowToLogAsync ~210, iterateLogLinesBackward ~107) | 0 | 47 exports mixing scrollback capture, log reading, token counting, exact-match, and verification; ~10 sync/async twin functions are near-identical copies; no header comment |
| logPoller.ts | 1224 | YES | 1 | 3 (processMatchResponse ~350, runOrphanRematchInBackground 245, pollOnce 173) | 0 | processMatchResponse alone is ~350 lines; no header comment |
| SessionManager.ts | 1184 | YES | 2 | 1 (createWindow ~128; ensureSession 78, setMouseMode 66 below threshold) | 0 | tmux lifecycle + window ops + env scrubbing + option config in one class; no header comment |
| db.ts | 1162 | YES | 9 | 1 (initDatabase 449) | 0 | initDatabase is a 449-line function repeating column-add blocks that duplicate the `migrate*Column` helpers in the same file; no header comment |
| remoteSessions.ts | 531 | YES | 3 (12 incl. test re-export block) | 0 (max: parseTmuxWindows 73) | 0 | slightly over limit; test-only re-export of 10 internals inflates API surface |
| logMatchWorker.ts | 426 | no | 2 | 0 | 0 | worker-thread twin of logMatcher matching logic |
| logDiscovery.ts | 421 | no | 15 | 0 | 0 | no header comment |
| sessionRefreshWorker.ts | 418 | no | 2 | 0 | 0 | worker twin of main-thread refresh |
| sessionRefreshWorkerClient.ts | 291 | no | 4 | 0 | 0 | request/response client with generation tracking |
| config.ts | 266 | no | 2 | 0 | 0 | env parsing; no header comment |
| statusInference.ts | 238 | no | 15 | 0 | 0 | shared status inference |
| SessionRegistry.ts | 224 | no | 3 | 0 | 0 | EventEmitter registry |
| logMatchWorkerClient.ts | 222 | no | 2 | 0 | 0 | worker client with timeout bookkeeping |
| logPollData.ts | 202 | no | 7 | 0 | 0 | snapshot/mapping helpers |
| logger.ts | 152 | no | 4 | 0 | 0 | pino wrapper; header accurate |
| logWatcher.ts | 142 | no | 1 | 0 | 0 | debounced fs watcher |
| logMatchGate.ts | 110 | no | 5 | 0 | 0 | match-gating decision logic |
| nameGenerator.ts | 98 | no | 3 | 0 | 0 | adjective-noun word lists |
| tmuxFormat.ts | 69 | no | 1 | 0 | 0 | format constants/splitters; header documents separator choice |
| forceWorkingStatus.ts | 66 | no | 5 | 0 | 0 | module-level Map of forced statuses |
| paths.ts | 54 | no | 3 | 0 | 0 | path resolution |
| applyCommand.ts | 51 | no | 2 | 0 | 0 | apply-command map; header accurate |
| agentDetection.ts | 42 | no | 4 | 0 | 0 | thin re-export + family detection; header accurate |
| agentSessions.ts | 38 | no | 2 | 0 | 0 | record-to-DTO mappers |
| tmuxEnv.ts | 36 | no | 2 | 0 | 0 | env hygiene; header explains rationale in detail |
| version.ts | 34 | no | 3 | 0 | 0 | build version; header accurate |
| prerequisites.ts | 33 | no | 1 | 0 | 0 | tmux availability check |
| displayName.ts | 23 | no | 1 | 0 | 0 | display-name resolution; header accurate |
| tmuxTimeout.ts | 21 | no | 3 | 0 | 0 | timeout error class |
| validators.ts | 21 | no | 5 | 0 | 0 | session-id/target patterns |
| shellQuote.ts | 11 | no | 1 | 0 | 0 | single quoting function |

TODO/FIXME/HACK/XXX: 0 across all 33 files (case-insensitive grep).

## Section 2: Files >500 LOC

### index.ts (4948 LOC, 3 exports)
- Header: **none** — file begins with imports. Verdict: missing (nothing to be stale).
- Long functions: `handleMessage` 2708-2899 (192), `handleRemoteCreate` 2912-3072 (161), `handleKill` 3236-3405 (170), `handleRename` 3407-3512 (106), `handleSessionHibernate` 3556-3761 (206), `tryRematchDormantSession` 3879-3997 (119). Near-threshold: `pollClipboardBuffer` 88, `mergeRemoteSessions` 79, `createAndStartSshProxy` 73.
- Exported symbols / responsibility guesses:
  - `hydrateSessionsWithAgentSessions` (1004) — merge DB agent-session rows into session list.
  - `WorkspaceCoordinatorHook` (1517) — narrow interface for the workspace coordinator dependency.
  - `attachWorkspaceCoordinator` (1525) — set/clear the module-level coordinator reference.
  Everything else (~4900 lines: server bootstrap, `websocketHandlers`, all Hono routes, log-line cache, remote merge, chat wiring, update checker, TLS/static serving) is module-private singletons.
- Duplication within file:
  - Lines ~520-554: four near-identical app-setting read/coerce blocks (`TMUX_MOUSE_MODE_KEY`, `HISTORY_MAX_AGE_HOURS_KEY`, `PREFER_WINDOW_NAME_KEY`, `TERMINAL_COLORS_ENABLED_KEY`).
  - `refreshSessionsAsync` / `refreshSessions` / `refreshSessionsSync` (1220/1286/1311) — three refresh entry points sharing core logic.
  - `ensureCorrectProxyType` / `createAndStartSshProxy` (4407/4469) — overlapping SSH proxy lifecycle.
- Dead-export candidates: **all 3 exports are dead externally**:
  - `hydrateSessionsWithAgentSessions` — only own-file refs + 1 test ref (test-only).
  - `WorkspaceCoordinatorHook` — own-file only (0 external, 0 test).
  - `attachWorkspaceCoordinator` — own-file only (0 external, 0 test).

### logMatcher.ts (2599 LOC, 47 exports)
- Header: **none** — begins with imports. Verdict: missing.
- Long functions: `tryExactMatchWindowToLog` 1874-2072 (~199), `tryExactMatchWindowToLogAsync` 2074-2283 (~210), `iterateLogLinesBackward` 493-~599 (~107). Near-threshold: `hasMessageInValidUserContext` ~69, `findLogsWithExactMessageInPaths` ~68, `findLogsWithExactMessage` ~70.
- Exported symbols / responsibility guesses (grouped):
  - Text/log reading: `LogTextMode`, `LogReadOptions`, `LogTextOptionsInput`, `readLogContent`, `extractLogText`, `getLogTokenCount`, `extractLastUserMessageFromLog`, `extractLastEntryTimestamp`, `normalizeText` — parse JSONL logs into display text/tokens.
  - Scrollback capture: `getTerminalScrollback`, `captureTerminalScrollback`, `getTerminalScrollbackAsync`, `captureTerminalScrollbackAsync`, `getTerminalScrollbackWithAnsi`, `getTerminalScrollbackWithAnsiAsync` — tmux capture-pane wrappers (sync + worker-safe async).
  - Prompt/message extraction: `extractRecentUserMessagesFromTmux`, `extractRecentTraceLinesFromTmux`, `extractPiUserMessagesFromAnsi`, `extractActionFromUserAction`, `extractCommandInvocation`, `isToolNotificationText`, `stripPastePlaceholders` — pull user messages from captured panes.
  - Exact matching: `ExactMatchSearchOptions`, `ExactMessageSearchOptions`, `ExactMatchContext`, `ExactMatchResult`, `ExactMatchProfiler`, `createExactMatchProfiler`, `hasMessageInValidUserContext`, `iterateLogLinesBackward`, `findLogsWithExactMessage`, `findLogsWithExactMessageAsync`, `filterCandidatesByAgentType`, `tryExactMatchWindowToLog`, `tryExactMatchWindowToLogAsync`, `matchWindowsToLogsByExactRg`, `matchWindowsToLogsByExactRgAsync`, `ExactMatchRgResult` — match window scrollback to log files.
  - Verification: `VerifyWindowLogOptions`, `verifyWindowLogAssociation`, `verifyWindowLogAssociationAsync`, `WindowLogVerificationStatus`, `WindowLogVerificationResult`, `verifyWindowLogAssociationDetailed`, `verifyWindowLogAssociationDetailedAsync` — confirm window-to-log pairing.
  - Misc: `DEFAULT_SCROLLBACK_LINES` (constant), `isSameOrChildPath` (path containment check).
- Duplication within file: pervasive sync/async twin pairs — `tryExactMatchWindowToLog`/`...Async` are line-for-line identical except `await` (verified by side-by-side read); same pattern for `findLogsWithExactMessage`/`Async`, `findLogsWithExactMessageInPaths`/`Async`, `scoreOrderedMessageMatches`/`Async`, `scoreOrderedMessageMatchesWithRg`/`Async`, `matchWindowsToLogsByExactRg`/`Async`, `verifyWindowLogAssociation`/`Async`/`Detailed`/`DetailedAsync`, and the four scrollback capture functions.
- Dead-export candidates (external refs excluding tests; test-only noted):
  - Dead (own-file only): `LogTextMode`, `LogReadOptions`, `LogTextOptionsInput`, `ExactMatchSearchOptions`, `ExactMessageSearchOptions`, `findLogsWithExactMessage`, `findLogsWithExactMessageAsync`, `getTerminalScrollback`, `getTerminalScrollbackAsync`, `captureTerminalScrollbackAsync`, `getTerminalScrollbackWithAnsi`, `getTerminalScrollbackWithAnsiAsync`, `readLogContent`, `extractLogText`, `ExactMatchContext`, `filterCandidatesByAgentType`, `ExactMatchResult`, `tryExactMatchWindowToLogAsync`, `ExactMatchRgResult`, `VerifyWindowLogOptions`, `verifyWindowLogAssociationAsync`, `WindowLogVerificationStatus`.
  - Test-only: `hasMessageInValidUserContext`, `extractActionFromUserAction`, `extractCommandInvocation`, `iterateLogLinesBackward`, `normalizeText`, `captureTerminalScrollback`, `extractPiUserMessagesFromAnsi`, `extractRecentTraceLinesFromTmux`, `matchWindowsToLogsByExactRg`, `verifyWindowLogAssociation`.
  - Externally used: `ExactMatchProfiler`, `createExactMatchProfiler`, `DEFAULT_SCROLLBACK_LINES`, `isToolNotificationText`, `isSameOrChildPath`, `extractRecentUserMessagesFromTmux`, `getLogTokenCount`, `extractLastUserMessageFromLog`, `extractLastEntryTimestamp`, `tryExactMatchWindowToLog`, `matchWindowsToLogsByExactRgAsync`, `WindowLogVerificationResult`, `verifyWindowLogAssociationDetailed`, `verifyWindowLogAssociationDetailedAsync`, `stripPastePlaceholders`.
  - 22 of 47 exports have no external consumer.

### logPoller.ts (1224 LOC, 1 export)
- Header: **none** — begins with imports. Verdict: missing.
- Long functions: `processMatchResponse` 695-~1045 (~350), `runOrphanRematchInBackground` 329-573 (245), `pollOnce` 1051-1223 (173).
- Exported symbols: `LogPoller` — periodic log-directory poller orchestrating worker matching, orphan rematch, and registry updates (single export).
- Duplication within file: `pollOnce` (worker path) and `pollChanged` (watcher path) both build session snapshots and drive `processMatchResponse`; `runComprehensiveReconciliation` and `runOrphanRematchInBackground` overlap on orphan handling. Stats accumulation (`workerMs`/`snapshotMs`/`processMs`) repeated across paths.
- Dead-export candidates: `LogPoller` — externally used.

### SessionManager.ts (1184 LOC, 2 exports)
- Header: **none** — begins with imports. Verdict: missing.
- Long functions: `createWindow` 502-629 (~128). Near-threshold: `ensureSession` 78, `capturePaneWithDimensions` (module fn) 71, `setMouseMode` 66.
- Exported symbols: `SessionManager` — tmux server/window lifecycle (create/kill/rename/list, options, env scrub, pane capture); `detectsPermissionPrompt` — pure re-export of `statusInference.detectsPermissionPrompt`.
- Duplication within file: `setMouseMode`/`setTerminalColors` + `applyMouseMode`/`applyTerminalColors` pairs follow the same set-with-rollback shape; `listWindows`/`listExternalWindows`/`listWindowsForSession` share capture-parse-filter flow.
- Dead-export candidates: `SessionManager` used externally; `detectsPermissionPrompt` used (1 external ref).

### db.ts (1162 LOC, 9 exports)
- Header: **none** — begins with imports. Verdict: missing.
- Long functions: `initDatabase` 236-684 (449). Near-threshold: `migrateAgentTypeConstraint` 72, `migrateDeduplicateDisplayNames`/`migrateDeduplicateCurrentWindows` ~50-60 each.
- Exported symbols / responsibility guesses:
  - `AgentSessionRecord` / `NewAgentSessionRecord` — agent_sessions row shape + insert type.
  - `KnownSessionKey` — lightweight session identity for the match worker.
  - `ChatSessionRecord` — chat_sessions row shape.
  - `MAX_LAST_USER_MESSAGE_LENGTH` — column length constant.
  - `ClaimCurrentWindowPatch` — partial update type for window claims.
  - `SessionDatabase` — full DB interface (agent sessions, chat sessions, app settings).
  - `resolveDataDir` — `~/.agentboard` resolution.
  - `initDatabase` — open SQLite DB, run migrations, return `SessionDatabase` implementation (449 lines, includes all method implementations as a closure object).
- Duplication within file: 12 `migrate*Column` helper functions (857-1078) share the `getColumnNames` + `includes` guard + `ALTER TABLE ADD COLUMN` shape; `initDatabase` itself repeats the same guard/add pattern inline for 6+ chat_sessions columns (profile_id, archived_at, approval_policy, context_tokens, ...) instead of using the helpers. `mapRow`/`mapChatRow` are parallel row mappers.
- Dead-export candidates: `NewAgentSessionRecord`, `KnownSessionKey`, `MAX_LAST_USER_MESSAGE_LENGTH` — own-file only (0 external, 0 test). Others externally used.

### remoteSessions.ts (531 LOC, 3 export statements / 13 symbols)
- Header: **none** — begins with imports. Verdict: missing.
- Long functions: none >100 (max `parseTmuxWindows` 389-461, 73).
- Duplication: none obvious; clean pipeline structure.
- Note: explicit "Export for testing" block (520-531) re-exports 10 module-private internals (`sanitizeForId`, `parseTmuxWindows`, `buildRemoteSessionId`, `toIsoFromSeconds`, `splitSshOptions`, `buildBatchCaptureCommand`, `parseBatchCaptureOutput`, `enrichSessionsWithStatus`, `cleanupRemoteContentCache`, `remoteContentCache`). `RemoteSessionPollerOptions` is dead externally (own-file only); `RemoteSessionPoller` used.

## Section 3: Files under 500 LOC (one line each)

- logMatchWorker.ts (426) — worker-thread twin of logMatcher's exact-match pipeline; no header beyond a webworker reference directive.
- logDiscovery.ts (421) — log-dir scanning, path/agent inference, project-path extraction; no header comment.
- sessionRefreshWorker.ts (418) — worker twin of main-thread tmux refresh + status inference; header accurate.
- sessionRefreshWorkerClient.ts (291) — promise-based worker client with generation/timeout handling; header accurate.
- config.ts (266) — env/config parsing, module-level `config` singleton; no header comment.
- statusInference.ts (238) — shared tmux-pane status inference; header accurate.
- SessionRegistry.ts (224) — EventEmitter registry of sessions/agent-sessions with typed events.
- logMatchWorkerClient.ts (222) — worker client with ready/timeout bookkeeping for match requests.
- logPollData.ts (202) — snapshot construction and per-log polling data helpers.
- logger.ts (152) — pino wrapper with env-configured level/file; header accurate.
- logWatcher.ts (142) — recursive fs watcher with debounce/max-wait flush.
- logMatchGate.ts (110) — decides whether a window/log pair needs re-matching (gate logic).
- nameGenerator.ts (98) — random adjective-noun session names + uniqueness.
- tmuxFormat.ts (69) — tmux format-string constants and tab-based field splitting; header explains the design choice.
- forceWorkingStatus.ts (66) — module-level Map forcing "working" status after Enter; header accurate.
- paths.ts (54) — `resolveProjectPath` home/tilde/path normalization.
- applyCommand.ts (51) — per-agent apply auto-start command map; header accurate and detailed.
- agentDetection.ts (42) — agent family detection + re-export of shared token resolution; header accurate.
- agentSessions.ts (38) — DB record → API DTO mappers.
- tmuxEnv.ts (36) — strips leaked env vars from spawned tmux clients; header explains the daemon-env rationale at length.
- version.ts (34) — build-baked version constant; header accurate.
- prerequisites.ts (33) — `ensureTmux()` spawn check.
- displayName.ts (23) — external-window display-name resolution; header accurate.
- tmuxTimeout.ts (21) — `TmuxTimeoutError` class + code constant.
- validators.ts (21) — session-id/tmux-target regex validation.
- shellQuote.ts (11) — one shell-quoting function; header accurate.

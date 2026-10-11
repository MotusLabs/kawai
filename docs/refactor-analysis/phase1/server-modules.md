# Phase 1: server modules mechanical triage

Scope: all .ts under `src/server/{chat,terminal,git,updates,workspace,routes,sessionWake}/`, excluding `__tests__`. 56 files, 11,765 LOC. Measured 2026-10-11 at commit 2557b22 (working tree).

Export counts = top-level `export` statement lines (a line may export 2 symbols; corrected where noted). Long function = >100 lines by brace tracking. TODO metric = case-sensitive matches of TODO|FIXME|HACK|XXX (whole scope: 0).

## Section 1: HOTSPOT TABLE (sorted by LOC desc)

| file | LOC | >500? | #exports | long funcs (>100 lines) | TODOs | one-line main problem |
|---|---|---|---|---|---|---|
| chat/ChatSessionManager.ts | 1221 | YES | 7 | ensureDriver ~100 (832-932) | 0 | 2.2x over size norm: lifecycle, persistence, title/cwd watching, usage/context sinks all in one 1048-line class; send/start and resolveApproval/answerQuestion are near-duplicate pairs |
| chat/ChatSessionDriver.ts | 1108 | YES | 3 | none (longest spawnQuery ~72, 451-522) | 0 | 2.2x over size norm; SDK frame fan-out plus approval bridge in one class; pending-request settle pattern repeated 4x |
| terminal/PtyTerminalProxy.ts | 892 | YES | 1 | doStart ~210 (406-616), ensureExternalGroupedSession ~103 (220-323), doSwitch ~100 (618-718) | 0 | no header comment; doStart does session create + option copy + clipboard opt + spawn + tty discovery in one method; grouped-session logic mirrored with SshTerminalProxy |
| chat/transcriptReplay.ts | 542 | YES | 11 | parseTranscriptContent ~201 (172-373) | 0 | 201-line parser function; 2 of 11 exports (parseTranscriptContent, withCancelledRequests) are test-only |
| terminal/SshTerminalProxy.ts | 537 | YES | 2 | doStartCore ~178 (255-433) | 0 | near-line-for-line mirror of PtyTerminalProxy (dispose, doSwitch, discoverClientTty, attempt invalidation); stray `shellQuote` re-export |
| terminal/PipePaneTerminalProxy.ts | 482 | no | 1 | none (longest write ~99) | 0 | no header comment |
| chat/usageLimits.ts | 409 | no | 13 | none | 0 | none observed |
| git/createChangeWorktree.ts | 333 | no | 3 | none (seedChangeArtifacts ~96) | 0 | none observed |
| chat/ChatConnections.ts | 332 | no | 3 | none (class 296 lines, methods small) | 0 | none observed |
| updates/updateRestart.ts | 312 | no | 20 | none | 0 | highest export density in scope (20 exports / 312 LOC) |
| chat/contextUsage.ts | 301 | no | 8 | none (class 183 lines, longest method ~35) | 0 | none observed |
| terminal/TerminalProxyBase.ts | 296 | no | 3 | none (longest flushSwitchQueue ~27) | 0 | no header comment |
| workspace/workspaceCoordinator.ts | 281 | no | 4 | none (runPass ~88) | 0 | none observed |
| chat/chatActivity.ts | 258 | no | 11 | none | 0 | none observed |
| chat/profileCatalog.ts | 256 | no | 8 | none | 0 | none observed |
| workspace/openspecDiscovery.ts | 243 | no | 10 | none | 0 | none observed |
| chat/claudeExecutable.ts | 239 | no | 12 | none | 0 | none observed |
| chat/developmentFixture.ts | 232 | no | 2 | none | 0 | none observed |
| chat/ChatWireLog.ts | 211 | no | 4 | none (class 100 lines) | 0 | none observed |
| chat/transcriptTitleWatcher.ts | 195 | no | 2 | watchTranscriptTitle ~165 (30-195) | 0 | single 165-line function is 85% of the file |
| workspace/workspaceWatcher.ts | 184 | no | 8 | none | 0 | none observed |
| git/createWorktree.ts | 171 | no | 2 | createWorktree ~135 (36-171) | 0 | one 135-line function is 79% of the file |
| chat/chatCommands.ts | 168 | no | 5 | none | 0 | none observed |
| git/worktreeList.ts | 163 | no | 7 | none | 0 | none observed |
| git/workspaceSnapshot.ts | 161 | no | 2 | none | 0 | none observed |
| terminal/outputCoalescer.ts | 147 | no | 2 | none (class 103 lines) | 0 | none observed |
| git/gitCommand.ts | 140 | no | 9 | none | 0 | none observed |
| chat/wireTap.ts | 140 | no | 4 | none (write ~97) | 0 | none observed |
| routes/chatProviderEnv.ts | 130 | no | 4 | none | 0 | none observed |
| chat/ClaudeProfiles.ts | 124 | no | 9 | none | 0 | none observed |
| updates/updateSwap.ts | 121 | no | 6 | none | 0 | none observed |
| updates/updateDownload.ts | 112 | no | 5 | none | 0 | none observed |
| chat/ChatWireLogs.ts | 100 | no | 3 | none | 0 | none observed |
| git/repositoryResolution.ts | 99 | no | 6 | none | 0 | none observed |
| updates/installRoot.ts | 97 | no | 4 | none | 0 | none observed |
| updates/releaseFeed.ts | 90 | no | 5 | none | 0 | none observed |
| chat/chatProviderEnv.ts | 86 | no | 3 | none | 0 | none observed |
| terminal/types.ts | 79 | no | 2 | n/a | 0 | no header comment |
| updates/updateChecker.ts | 75 | no | 4 | none | 0 | none observed |
| updates/updateInstaller.ts | 70 | no | 3 | none | 0 | none observed |
| chat/contentBlocks.ts | 65 | no | 3 | none | 0 | none observed |
| routes/pasteFile.ts | 60 | no | 2 | none | 0 | none observed |
| terminal/tmuxText.ts | 58 | no | 11 | none | 0 | no header comment |
| chat/TurnQueue.ts | 58 | no | 1 | none | 0 | none observed |
| workspace/changeRegistry.ts | 54 | no | 2 | none | 0 | none observed |
| chat/chatAuth.ts | 49 | no | 3 | none | 0 | none observed |
| chat/sdkAvailability.ts | 43 | no | 1 | none | 0 | none observed |
| git/worktreeStatus.ts | 38 | no | 3 | none | 0 | none observed |
| updates/updateVersions.ts | 36 | no | 2 | none | 0 | none observed |
| routes/claudeProfiles.ts | 32 | no | 2 | none | 0 | none observed |
| terminal/TerminalProxyFactory.ts | 29 | no | 1 | none | 0 | no header comment |
| updates/updateErrors.ts | 26 | no | 2 | none | 0 | none observed |
| terminal/groupedSessionTarget.ts | 24 | no | 1 | none | 0 | none observed |
| chat/approvalPolicy.ts | 24 | no | 3 | none | 0 | none observed |
| sessionWake/rematchTarget.ts | 19 | no | 1 | none | 0 | none observed |
| terminal/index.ts | 7 | no | 7 | n/a | 0 | barrel; re-exports consumed only via server/index.ts |
| updates/updateConstants.ts | 6 | no | 1 | n/a | 0 | none observed |

## Section 2: files over 500 LOC

### chat/ChatSessionManager.ts (1221 LOC, 7 exports)

Header verdict: ACCURATE. The 14-line header (lifecycle, persistence, restore-on-start, kill settlement, activity/title/cwd behavior, dynamic SDK import, executable check) matches the content.

Exports and responsibilities:
- `ChatQueryFactory` (re-export of driver type) — injected SDK query() signature. Production consumers import it from ChatSessionDriver directly; the re-export is test-consumed only.
- `chatAuthErrorMessage` (re-export), `hasClaudeAuth` (re-export) — auth-gate helpers from chatAuth.ts. No production consumer imports them from this module (hasClaudeAuth has a test-only importer via this re-export).
- `ChatSessionManagerOptions` — constructor DI contract (sinks, probes, test hooks). Referenced only inside this file.
- `ChatCreateResult` — creation result union. Referenced only inside this file.
- `ChatActionResult` — ok/error union for session actions. In-file use plus a test-only importer (chatConnections.test.ts).
- `ChatSessionManager` — the lifecycle class: create/start/send/interrupt/archive/restore/kill/shutdown, snapshot assembly, 8 per-session Maps, driver construction, title/cwd/usage handlers.

Long functions: `ensureDriver` 832-932 (~100 lines, at threshold); everything else <=~45 lines.

Duplication:
- `send` (412-436) and `start` (446-468): identical body except the final `driver.send(text)` vs `driver.start()` (record lookup, captureHistory, startBlocker, ensureDriver, error mapping).
- `resolveApproval` (591-606) and `answerQuestion` (608-623): identical no-driver error branches differing in one word.
- `createAvailableSession` (227-251) repeats `createSession`'s (325-335) path-check + launchFor + authOk guard sequence.
- Executable-verify/auth block duplicated between `ensureDriver` dead-driver path (837-848) and `probeAvailability` (940-946).

Dead-export candidates: the two re-export lines (64-65) — `ChatQueryFactory` re-export has no production importer; `chatAuthErrorMessage` has no importer at all outside the module; `hasClaudeAuth` re-export is test-only. `ChatSessionManagerOptions`, `ChatCreateResult` are types referenced only within the file. All noted, none used by production code outside the module.

### chat/ChatSessionDriver.ts (1108 LOC, 3 exports)

Header verdict: ACCURATE (streaming-input query, cancellable approval bridge, status from driver state, activity reducer, context tracker delegation, SDK types confined here — all true).

Exports: `ChatQueryFactory` (query factory signature; used by developmentFixture, manager, tests), `ChatSessionDriverOptions` (constructor contract; referenced only inside this file — dead-export candidate as a type), `ChatSessionDriver` (the class).

Long functions: none over 100. Longest: `spawnQuery` 451-522 (~72), `canUseTool` 845-912 (~68), `validateAnswers` (module fn) 1068-1108 (~41).

Duplication:
- Pending-request settlement (get → settled check → delete → settle → emit request_resolved → refreshStatus) repeated in `resolveApproval` (344-371), `answerQuestion` (374-407), `onApprovalPolicyChanged` (325-341), `cancelRequest` (914-926).
- `handleAssistant` (645-685) and `handleUser` (706-731) repeat the seenToolCallIds.add → emit → isSubagentFrame-gated feedActivity pattern per block.

Dead-export candidates: `ChatSessionDriverOptions` (in-file only).

### terminal/PtyTerminalProxy.ts (892 LOC, 1 export)

Header verdict: NONE — file starts with imports; no header comment.

Exports: `PtyTerminalProxy` (local tmux attach proxy: grouped/derived session management, paste, resize, switch with identity verification). No dead exports (consumed via TerminalProxyFactory and the terminal barrel; barrel consumed by server/index.ts).

Long functions: `doStart` 406-616 (~210 lines: session create, mouse/allow-passthrough/set-clipboard option staging, spawn, attempt-race handling, tty discovery); `ensureExternalGroupedSession` 220-323 (~103); `doSwitch` 618-718 (~100).

Duplication:
- Mouse-option copy: `doStart` 448-481 (base → grouped session) vs `ensureExternalGroupedSession` 301-322 (raw → derived session) — same show-option/set-option dance.
- Stale-derived-session kill+evict: `ensureExternalGroupedSession` 256-266 vs `doSwitch` catch block 686-703.
- Session-before-colon extraction (`colonIndex > 0 ? slice : target`) repeated in `resolveExternalGroupedTarget` (120), `ensureExternalGroupedSession` (224-236), `doSwitch` (692-694).
- Whole-file structural mirror of SshTerminalProxy (dispose, attempt-id invalidation, exited handler, start/ready logging) — see SshTerminalProxy below.

### chat/transcriptReplay.ts (542 LOC, 11 exports)

Header verdict: ACCURATE (best-effort replay, unknown lines ignored, dead requests as cancelled pairs).

Long functions: `parseTranscriptContent` 172-373 (~201 lines — one function is 37% of the file).

Duplication:
- user_message emission duplicated between string-content path (261-274) and block-content path (299-311).
- `readTranscriptTitle` (484-490) and `readTranscriptCwd` (497-503) each read and fully re-parse the entire transcript to extract one field; `replayTranscriptFile` parses the same file a third way when history is requested.

Dead exports: `parseTranscriptContent` and `withCancelledRequests` are imported only by `server/__tests__/chatTranscriptReplay.test.ts` — no production caller (production goes through `replayTranscriptFile`). `parseTranscriptTitleLine` has one production consumer (transcriptTitleWatcher.ts).

### terminal/SshTerminalProxy.ts (537 LOC, 2 exports)

Header verdict: ACCURATE — and self-incriminating: "Mirrors PtyTerminalProxy" is literally the structure.

Exports: `SshTerminalProxy` (remote tmux proxy over SSH); `shellQuote` (line 537: pure re-export of `../shellQuote` with no importer anywhere — dead re-export).

Long functions: `doStartCore` 255-433 (~178 lines: session create with duplicate recovery, attach spawn, attempt-race handling, tty discovery).

Duplication:
- With PtyTerminalProxy: `dispose` (99-129 vs Pty 363-404), `doSwitch` skeleton (435-497 vs 618-718), `discoverClientTty` retry/backoff loop (499-533 vs 852-889), attempt-id invalidation, the terminal options data/exit callback block (350-368 vs Pty 540-557), start/ready/dead log events, clientFeatureArgs (236-249 vs Pty 720-737).
- Internal: `doStart` timeout wrapper (180-226) vs the isStartAttemptCurrent guards sprinkled through doStartCore.

## Section 3: files at or under 500 LOC

- chat/usageLimits.ts — 409 LOC, 13 exports, no long funcs, header accurate.
- git/createChangeWorktree.ts — 333 LOC, seedChangeArtifacts ~96 lines, header accurate.
- chat/ChatConnections.ts — 332 LOC, one 296-line class of small methods, header accurate.
- updates/updateRestart.ts — 312 LOC, 20 exports (supervisor detection + restart writers), header accurate.
- chat/contextUsage.ts — 301 LOC, pure tracker class, longest method ~35 lines, header accurate.
- terminal/TerminalProxyBase.ts — 296 LOC, no header comment, no long funcs.
- workspace/workspaceCoordinator.ts — 281 LOC, runPass ~88 lines, header accurate.
- chat/chatActivity.ts — 258 LOC, pure reducer module, 11 exports, header accurate.
- chat/profileCatalog.ts — 256 LOC, layered catalog resolution, header accurate.
- workspace/openspecDiscovery.ts — 243 LOC, header accurate.
- chat/claudeExecutable.ts — 239 LOC, 12 exports, header accurate.
- chat/developmentFixture.ts — 232 LOC, dev-only fake SDK, header accurate.
- chat/ChatWireLog.ts — 211 LOC, serialized log writer, header accurate.
- chat/transcriptTitleWatcher.ts — 195 LOC, single watchTranscriptTitle function ~165 lines (85% of file), header accurate.
- workspace/workspaceWatcher.ts — 184 LOC, header accurate, longest method ~28 lines.
- git/createWorktree.ts — 171 LOC, single createWorktree function ~135 lines (79% of file), header accurate.
- chat/chatCommands.ts — 168 LOC, header accurate.
- git/worktreeList.ts — 163 LOC, porcelain parser, header accurate.
- git/workspaceSnapshot.ts — 161 LOC, header accurate.
- terminal/outputCoalescer.ts — 147 LOC, header accurate (carries its own design-D2 note), no long funcs.
- git/gitCommand.ts — 140 LOC, 9 exports, header accurate.
- chat/wireTap.ts — 140 LOC, spawn tap; write ~97 lines; header accurate (env exclusion honored).
- routes/chatProviderEnv.ts — 130 LOC, header accurate.
- chat/ClaudeProfiles.ts — 124 LOC, launch config resolution, header accurate.
- updates/updateSwap.ts — 121 LOC, swap/restore ordering, header accurate.
- updates/updateDownload.ts — 112 LOC, header accurate.
- chat/ChatWireLogs.ts — 100 LOC, registry, header accurate.
- git/repositoryResolution.ts — 99 LOC, header accurate.
- updates/installRoot.ts — 97 LOC, header accurate.
- updates/releaseFeed.ts — 90 LOC, ETag-cached feed, header accurate.
- chat/chatProviderEnv.ts — 86 LOC, header accurate.
- terminal/types.ts — 79 LOC, no header comment.
- updates/updateChecker.ts — 75 LOC, header accurate.
- updates/updateInstaller.ts — 70 LOC, header accurate.
- chat/contentBlocks.ts — 65 LOC, header accurate.
- routes/pasteFile.ts — 60 LOC, header accurate.
- terminal/tmuxText.ts — 58 LOC, 11 exports, no header comment.
- chat/TurnQueue.ts — 58 LOC, header accurate.
- workspace/changeRegistry.ts — 54 LOC, header accurate.
- chat/chatAuth.ts — 49 LOC, header accurate.
- chat/sdkAvailability.ts — 43 LOC, header accurate.
- git/worktreeStatus.ts — 38 LOC, header accurate.
- updates/updateVersions.ts — 36 LOC, header accurate.
- routes/claudeProfiles.ts — 32 LOC, header accurate.
- terminal/TerminalProxyFactory.ts — 29 LOC, no header comment.
- updates/updateErrors.ts — 26 LOC, header accurate.
- terminal/groupedSessionTarget.ts — 24 LOC, header accurate.
- chat/approvalPolicy.ts — 24 LOC, header accurate.
- sessionWake/rematchTarget.ts — 19 LOC, header accurate.
- terminal/index.ts — 7 LOC barrel; consumed by server/index.ts; no dead re-exports found (all 7 names resolve to consumers through it).
- updates/updateConstants.ts — 6 LOC, header accurate.

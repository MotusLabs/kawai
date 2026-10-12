# Kawai Refactoring Assessment — 2026-10-11

Method: 3-phase tiered analysis. Phase 1: five cheap agents (haiku) produced mechanical metrics
over all ~119k LOC (reports in `phase1/`). Phase 2: two opus architecture reviews + one sonnet
verification pass, pointed at the confirmed hotspots (reports in `phase2/`). Phase 3: this
synthesis. Every claim below that survived verification is marked from its source report;
Phase 1 claims that Phase 2 disproved are listed in the Corrections log.

## Verdict

**Yes — kawai needs refactoring, but a targeted one, not a rewrite.**

The codebase is structurally healthier than its raw metrics suggest:

- Zero layering violations (no client↔server imports), zero circular deps among top files
- The WS protocol is a complete, typed, drift-free union (`src/shared/chat.ts`, `types.ts`)
- Zustand stores use field selectors everywhere — no re-render storms
- The chat subsystem (lifecycle, TurnQueue, pure reducers, registries), git/, and workspace/
  modules are already in the target shape: deliberate, documented, tested
- Test suite: 2,266 tests, 0 failures, ~73s

The debt is concentrated in **six god-units plus a handful of cheap hygiene items**:

| Unit | LOC | Problem |
|---|---|---|
| `src/server/index.ts` | 4,948 | Boot script mixing composition root + 7 subsystems, ~35 module-scope mutable state, accidental init-order correctness, testable only via a 7,093-line `Bun.serve`-mocking harness |
| `src/server/logMatcher.ts` | 2,599 | ~700 LOC of sync twins behind a provably unreachable branch; 47 exports across 5 concerns |
| `src/client/hooks/useTerminal.ts` | 2,016 | Monolith hook (~1,683-line body): xterm lifecycle + paste/images + copy-mode + backpressure + iOS/WebGL; 3x duplicated WebGL-create, 4x duplicated detach/copy-mode-exit blocks |
| `src/client/components/Terminal.tsx` | 1,768 | ~1,640-line component, 22 refs, 20 hooks; mobile drawer/chrome co-located |
| `src/client/App.tsx` | 1,351 | ~380-line WS-subscribe effect routing ~25 message types inline; 8x setServerError+timeout pattern |
| `src/server/db.ts` | 1,162 | 449-line `initDatabase` duplicating its own migrate helpers; thinnest test coverage in the repo |

`App.tsx` + `useTerminal.ts` + `Terminal.tsx` together are 5,135 LOC (~25% of the client).

## Priority plan

### P0 — Hygiene (minutes each, do first)
> **Status: DONE 2026-10-11** — all four items landed as commits `0c84ff7` (deps), `d820a0b`
> (devProxyErrors + its test — **reverted**: the module is live via `vite.config.ts`, which the
> dead-code sweep never searched; the deletion broke build/dev and was restored 2026-10-12), `600ddf5` (logMatcher: 4 functions + 18 export keywords, net −48
> LOC), `75f4a49` (headers on the 14 largest modules that lacked them). Full suite green on
> every commit via the pre-commit hook.
> **Correction 2026-10-12**: item 2 was wrong — root `vite.config.ts` imports
> `shouldSuppressProxyLog`; `bun run build` failed with UNRESOLVED_IMPORT and the module was
> restored verbatim (`ad6b9b8` on `split-log-matcher`). Lesson recorded: grep repo-root
> configs and scripts/, not just src/, before declaring a module dead.

1. Remove dead dependencies `node-pty` and `@fontsource-variable/jetbrains-mono` (both verified:
   zero static/dynamic/require references; "pty" is a Bun.spawn'd tmux client; fonts are
   self-hosted via `@fontface`). [verification.md]
2. ~~Delete `src/shared/devProxyErrors.ts`~~ — withdrawn: `vite.config.ts` imports it (root-level
   consumers were outside the sweep). [verification.md]
3. `logMatcher.ts`: delete the 4 never-called functions (~79 LOC:
   `getTerminalScrollback(Async)`, `extractLogText`, `verifyWindowLogAssociationAsync`) and strip
   18 dead `export` keywords (live internal helpers). NOTE: the bigger ~700-LOC sync-chain
   deletion is P1, not P0 — it requires removing the unreachable `verifyAssociations` branch
   first. [verification.md]
4. Add header comments to the largest files (project norm; ~35 files lack them, incl. all top files).

### P1 — Structural (the real refactors)

**S1. Decompose `index.ts`** into a composition root + domain modules (logContent,
SessionRefreshLoop, per-op session modules, RemoteSessionService,
ws/{ConnectionHub, clipboardWatch, copyMode, terminalAttach}, remaining routes/, bootstrap.ts);
singletons live only in bootstrap. Kills the accidental init-order risk.
Effort: L. Risk: med (mitigated by the existing indexHandlers harness — refactor it alongside).
[server-architecture.md §4]
> **Status: DONE 2026-10-12** (branch `split-server-index`, OpenSpec change of the same name) —
> landed as `af9b778` (logContent), `be4053a` (refresh/SessionRefreshLoop + hydrateSessions;
> dead workspace-coordinator hook deleted), `6e0d637` (ws/wsTypes), `73d7782` (sessions/
> ops + resumeCommand, sessionStamp, tmuxCapture), `76d268f` (remote/RemoteSessionService),
> `9514f3f` (ws/ConnectionHub, clipboardWatch, copyMode), `2654e67` (ws/terminalProxy +
> terminalAttach), `030d41a` + `2cb6fd2` (routes/settings, sessionPreview, directories,
> serverInfo, updateInstall, paste), `cf85202` (bootstrap.ts `startServer()` plus
> ws/messageRouter, ws/socketHandlers, startupPreflight), and `a25b770` (log-line cache and
> wake guard made boot-scoped). `index.ts` went from ~4,970 LOC to an 8-line boot-on-import
> entry; `bootstrap.ts` is 498 LOC and every new module is under 500. Pure lifts: the
> `indexHandlers` harness ran unmodified through every commit (it was not split — a follow-up
> now that the modules are importable on their own); new direct tests cover logContent and
> wake's claim-race branches. Full suite green on every commit via the pre-commit hook.

**S2. Delete the dead sync matcher chain; split `logMatcher` by concern.** First remove the
unreachable `verifyAssociations` branch, then ~700 LOC of sync twins (the match worker uses async
variants exclusively). Split the remainder into scrollback / promptExtract / logText / exactMatch /
verify modules. Effort: M. Risk: low — pure deletion with existing test coverage. [server-architecture.md §4]
> **Status: DONE 2026-10-12** (branch `split-log-matcher`) — landed as `999c644` (unreachable
> `verifyAssociations` branch + plumbing removed from hydration), `37eaf1e` (sync chain deleted,
> net −898 LOC; sync-twin tests deleted or ported to the async twins per coverage), and `e9dbb62`
> (split into `src/server/logmatch/`: common, scrollback, promptExtract, logText, candidateSearch,
> exactMatch, verify + barrel). Candidate search became its own module — keeping it inside
> exactMatch would have left that file at ~735 LOC, over the 500 norm; all modules landed at
> 55–489 LOC. Full suite green on every commit via the pre-commit hook.

**S3. Client WS router extraction.** Table-driven protocol module under `src/client/protocol/`
(session/workspace/chat/server handler files, all via `getState()`), killing the
resubscribe-on-selection-change effect in App.tsx. Effort: M. Risk: low-med. [client-architecture.md §4]

**S4. Decompose `useTerminal.ts`** into composables under `src/client/terminal/` (webgl,
attachState, copyMode, outputStream, pasteChannel, snapshotCache, iosRepaint); hook shrinks to
~400–500 LOC. Effort: M-L. Risk: med (attach/backpressure is the hardest correctness logic —
lean on useTerminal.test.tsx, 5,046 LOC). [client-architecture.md §4]

**S5. Split `Terminal.tsx`; host the mobile drawer at App level.** Extract iOS
selection/touch/resume hooks + mobile chrome; lifts SessionDrawer's 12-prop drill-through out of
Terminal. Effort: M. Risk: med. [client-architecture.md §4]

**S6. Transcript parsing off the main thread.** `restorePersisted` does 2 full transcript parses +
recursive `readdirSync` per chat per boot; `chat-attach` adds a third — all synchronous on the
event loop. Effort: S-M. Risk: low. [server-architecture.md §4]

### P2 — Worth doing, not urgent
- **Terminal transport abstraction rework**: `TerminalProxyBase` abstracts lifecycle queueing +
  sync tmux instead of the real difference (sync-local vs async-SSH); copies have drifted
  (identity verification + disposed-guard exist only in Pty). [server-architecture.md §4]
- **`db.ts`**: restructure `initDatabase` around its 12 migration helpers; add tests (currently
  4 direct cases). [verification.md Part B]
- **Shared API client** for the 10 direct-fetch component sites. [client-architecture.md §4]
- **Component duplication**: SessionRow/SortableSessionItem ~20-prop surface; twin filter
  dropdowns. [client-architecture.md §4]
- **Test utils**: extract the `bunAny`/`originalSpawn` spawn-patch dance copy-pasted across ~13
  server test files, tmux stub Maps in 6+, client window-stub in 6+ into `testEnvironment.ts`;
  document why `isolated/` exists (process isolation from Bun's `mock.module()` lifetime leaks —
  NOT DB isolation). [verification.md Part B]

### P3 — Background
- Rename debt: ~34 cosmetic `agentboard`→`kawai` identifiers; document the ~108 must-keeps
  (env vars, `~/.agentboard` paths, wire strings). Worst confusion: two config roots
  (`~/.agentboard` vs `~/.kawai/profiles.json`) and two env prefixes (`AGENTBOARD_*`/`KAWAI_*`).
  [verification.md Part C]
- The 7,093-line `indexHandlers.test.ts` mostly dissolves with S1.

## What NOT to refactor
- Chat subsystem (ChatSessionManager/Driver boundaries, TurnQueue, pure reducers, wire tap)
- git/ and workspace/ modules — already small, focused, tested
- Zustand store design (settingsStore's 29 exports are an ergonomics issue, not a re-render hazard)
- The shared protocol types
- The `isolated/` test mechanism itself (it's load-bearing; just document it)
- SessionList/WorkspaceSectionList "co-ownership" — a deliberate placement-vs-rendering boundary

## Corrections log (Phase 1 claims Phase 2 disproved)
- `shared/dependencyRisk.ts` is NOT dead — it powers the `deps:risk*` npm scripts via
  `scripts/dependency-risk.ts`. Tooling, not app code.
- `tryExactMatchWindowToLog`'s "production use" was a doc comment in `logMatchWorkerTypes.ts:58`.
- The "grouped-session logic mirrored between Pty/Ssh proxies" claim is wrong — Ssh has none.
- `SessionDrawer` duplicates nothing — it wraps the same SessionList (prop drilling, not copies).
- Direct-fetch sites: 10, not 6. setServerError pattern: 8x, not 7x.
- "No duplicated test helpers" was wrong — see P2 test-utils item.
- `ChatSessionManager`'s `ChatQueryFactory` re-export is used by `scripts/verify-claude-profile-resume.ts`.
- Dead code is ~119 strictly-removable LOC, not the thousands the triage implied — most "dead
  exports" are live helpers wearing dead `export` keywords.

## Artifacts
- phase1/: server-core.md, server-modules.md, client-core.md, client-components.md, cross-cutting.md
- phase2/: server-architecture.md, client-architecture.md, verification.md
- All under /tmp/kawai-analysis/ — ephemeral; copy into the repo if wanted.

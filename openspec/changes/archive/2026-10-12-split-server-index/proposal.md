# Proposal

## Why

`src/server/index.ts` (4,944 LOC) is a sequential boot script that mixes a composition root
with seven runtime subsystems (log-content cache, session refresh loop, per-op session
handlers, remote session merging, the WebSocket hub with clipboard/copy-mode/terminal-attach
flows, HTTP routes, and the update/restart wiring) plus ~35 pieces of module-scope mutable
state. Its init-order correctness is accidental — it works only because `Bun.serve` opens
last — and it is testable almost exclusively through the 7,093-line `Bun.serve`-mocking
harness in `src/server/__tests__/isolated/indexHandlers.test.ts`. This is P1/S1 of the
refactor analysis (`docs/refactor-analysis/synthesis.md`), the largest single item in the
prioritized backlog; S2 (logMatcher) has already landed, and this removes the remaining
server-side god-file.

## What Changes

Decompose `index.ts` into a composition root plus domain modules, keeping the existing module
style (`chat/`, `terminal/`, `logmatch/`): small modules, constructor-injected dependencies,
header comments. Per the analysis's module map:

- `src/server/logContent.ts` — the log-line cache and its three readers (today ~140–500).
- `src/server/refresh/SessionRefreshLoop.ts` — hydration, verification, the refresh state
  machine, startup verification; the six `let` counters become class fields.
- `src/server/sessions/{kill,rename,hibernate,wake,moveToHistory}.ts` — per-op session
  handlers over a shared context; wake takes the resume-command builders with it.
- `src/server/remote/RemoteSessionService.ts` — remote merge/protection/tombstone maps, SSH
  runners, and remote-create handling, owning its poller in the constructor.
- `src/server/ws/ConnectionHub.ts`, `ws/clipboardWatch.ts`, `ws/copyMode.ts`,
  `ws/terminalAttach.ts` — sockets/broadcast/send, the clipboard watch loop, copy-mode
  sync, and the terminal proxy attach lifecycle.
- `src/server/routes/{settings,sessionPreview,directories,serverInfo,updateInstall,paste}.ts`
  — remaining HTTP endpoints following the existing `routes/claudeProfiles.ts` pattern.
- `src/server/bootstrap.ts` — the composition root: explicit `startServer()` with a linear,
  commented init sequence; owns `Bun.serve`, signal handlers, shutdown. `index.ts` shrinks to
  the boot-on-import entry that calls it.

No behavior changes — pure decomposition with verbatim logic moves. Marked `skip_specs: true`.

## Capabilities

### New Capabilities

None. Pure refactor; no spec-level behavior changes (`skip_specs: true` in `.openspec.yaml`).

### Modified Capabilities

None.

## Impact

- Code: `src/server/index.ts` (~4,944 LOC → thin entry), ~18 new modules; import updates in
  the modules' consumers.
- Tests: `isolated/indexHandlers.test.ts` keeps working unchanged (it `mock.module`s
  dependency paths and dynamically imports `../../index?test=N` — both contracts are
  preserved); new unit tests added for `wake.ts` claim-race branches and `logContent.ts`
  window math, which today are covered only end-to-end.
- Risk: extraction-order and init-order regressions (mitigated by constructor injection and
  one-module-per-commit); race-guard drift (guards move verbatim, by decision).
- Effort: L, delivered as a sequence of pure-lift commits, each independently green.

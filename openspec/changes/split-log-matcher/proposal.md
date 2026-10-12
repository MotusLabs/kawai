# Proposal

## Why

`src/server/logMatcher.ts` is a 2,599-line module exporting ~25 symbols across five distinct
concerns, and roughly 700 lines of it — the synchronous matcher chain — is production-dead:
the match worker uses the async variants exclusively, and the sync chain's only production
consumer (`verifyWindowLogAssociationDetailed` at `src/server/index.ts:1071`) sits behind an
`else if (verifyAssociations)` branch that provably never executes (verified 2026-10-11; see
`docs/refactor-analysis/phase2/server-architecture.md` and `verification.md`). This is P1/S2 of
the refactor analysis: delete the dead chain, then split the live remainder into cohesive
modules so the matching pipeline stops being a god-module.

## What Changes

- Remove the unreachable sync-verification branch in `hydrateSessionsWithAgentSessions`
  (`src/server/index.ts`) and the `verifyAssociations` option plumbing that exists only to
  gate it (`HydrateSessionsOptions.verifyAssociations`, the `refreshSessionsSync` pass-through,
  and the now-dead `logDirs` computation). The `precomputedVerifications` path — the one that
  actually runs — is untouched.
- Delete the sync matcher chain from `logMatcher.ts`: `tryExactMatchWindowToLog`,
  `matchWindowsToLogsByExactRg`, `verifyWindowLogAssociation`,
  `verifyWindowLogAssociationDetailed`, `findLogsWithExactMessage(InPaths)`,
  `getTerminalScrollbackWithAnsi`, `captureTerminalScrollback`, and any helpers orphaned by
  these deletions (e.g. sync command-running helpers used only by the chain).
- Split the remaining live code into concern-scoped modules under `src/server/logmatch/`
  (scrollback capture, prompt/message extraction, log-text reading, candidate search,
  exact-match, association verification) with a barrel `index.ts`, following the existing
  `terminal/` module pattern. Delete the root `logMatcher.ts`; update the six importers
  (`index.ts`, `logPoller.ts`, `logMatchWorker.ts`, `logMatchWorkerTypes.ts`,
  `sessionRefreshWorker.ts`, `logPollData.ts`) to the new path.
- Update `src/server/__tests__/logMatcher.test.ts`: delete tests that exist only to cover
  removed sync twins (the async variants keep their own equivalent coverage); point remaining
  imports at the new modules.

No externally observable behavior changes — this is dead-code removal plus a module split.
Marked `skip_specs: true` for that reason.

## Capabilities

### New Capabilities

None. Pure refactor; no spec-level behavior changes (`skip_specs: true` set in
`.openspec.yaml`).

### Modified Capabilities

None.

## Impact

- Code: `src/server/logMatcher.ts` (dissolved), `src/server/index.ts` (dead branch + option
  plumbing), `src/server/logPoller.ts`, `src/server/logMatchWorker.ts`,
  `src/server/sessionRefreshWorker.ts`, `src/server/logPollData.ts` (import paths only),
  `src/server/__tests__/logMatcher.test.ts` (imports; sync-twin tests removed).
- Net LOC: approximately −700 deleted plus file-level reorganization; no new logic.
- Risk surface: low — deletions are proven unreachable by call-site audit
  (`refreshSessionsSync` is never called with `verifyAssociations: true`; the one caller that
  passes `true` at `index.ts:1461` always supplies `precomputedVerifications`, which takes the
  earlier branch), and the suite (2,266 tests) covers the async pipeline.

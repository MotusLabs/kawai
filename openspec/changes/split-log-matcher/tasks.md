# Tasks

## 1. Remove the unreachable sync-verification branch in index.ts

- [x] 1.1 Delete the `else if (verifyAssociations)` branch in `hydrateSessionsWithAgentSessions`
  (src/server/index.ts:1074-1094) and the `logDirs` computation it alone consumes
  (index.ts:1038-1040); keep the `precomputedVerifications` path byte-identical in behavior
- [x] 1.2 Remove the `verifyAssociations` field from `HydrateSessionsOptions` (index.ts:941),
  the destructured default at index.ts:1017, the `refreshSessionsSync` parameter and its
  pass-through (index.ts:1322-1328), and the `verifyAssociations: true` argument at
  index.ts:1470
- [x] 1.3 Remove the now-unused sync import `verifyWindowLogAssociationDetailed` from
  index.ts's logMatcher import block (keep `verifyWindowLogAssociationDetailedAsync`)
- [x] 1.4 Run `bun run lint && bun run typecheck && bun run test`; commit
  (`refactor: remove unreachable verifyAssociations branch from hydration`)

## 2. Delete the sync matcher chain from logMatcher.ts

- [ ] 2.1 Delete the sync twins: `tryExactMatchWindowToLog`, `matchWindowsToLogsByExactRg`,
  `verifyWindowLogAssociation`, `verifyWindowLogAssociationDetailed`,
  `findLogsWithExactMessage`, `findLogsWithExactMessageInPaths`,
  `getTerminalScrollbackWithAnsi`, `captureTerminalScrollback`
- [ ] 2.2 Delete helpers orphaned by 2.1 only (verify each with a repo-wide grep before
  deleting: sync command-running wrappers, candidate-filter helpers used solely by the sync
  chain); do NOT delete helpers the async chain or extraction code still use
- [ ] 2.3 In `src/server/__tests__/logMatcher.test.ts`, delete tests covering only the removed
  sync functions; port any case whose matrix is not already covered against the async twin
  (rule: coverage, not symmetry — design D3); fix the import block
- [ ] 2.4 Run lint, typecheck, and the full suite; commit
  (`refactor: delete production-dead sync matcher chain`)

## 3. Split the remaining module into src/server/logmatch/

- [ ] 3.1 Create `src/server/logmatch/` with `scrollback.ts`, `promptExtract.ts`,
  `logText.ts`, `exactMatch.ts`, `verify.ts` (boundaries per design D2); move the live code
  without modification, adding `common.ts` only for helpers shared by two or more modules
- [ ] 3.2 Add `src/server/logmatch/index.ts` barrel re-exporting exactly the consumed surface
  (verify the list against the five importers: index.ts, logPoller.ts, logMatchWorker.ts,
  sessionRefreshWorker.ts, logPollData.ts — nothing more)
- [ ] 3.3 Delete `src/server/logMatcher.ts`; update the five importers from `./logMatcher` to
  `./logmatch`; update `logMatcher.test.ts` (and any other test importing the old path) to
  the new modules
- [ ] 3.4 Add header comments to each new module (one to three lines, house style)
- [ ] 3.5 Run lint, typecheck, and the full suite; commit
  (`refactor: split logMatcher into concern-scoped logmatch modules`)

## 4. Verify and close out

- [ ] 4.1 Grep the repo for lingering `logMatcher` references (imports, path strings in test
  configs or the runner's isolated-file sets) and clean them up
- [ ] 4.2 Confirm LOC outcome: logMatcher.ts (~2.6k) replaced by five modules each under the
  500-LOC norm; record actual numbers in the commit or change notes
- [ ] 4.3 Mark S2 done in `docs/refactor-analysis/synthesis.md` (status note with commit
  hashes, mirroring the P0 note); commit (`docs: mark P1/S2 complete in refactor synthesis`)

## Workflow follow-up

- Merge `split-log-matcher` to master after review (user decision), then archive the change
  via the archive workflow.

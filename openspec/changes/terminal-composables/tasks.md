# Tasks

Each task ends with `bun run lint && bun run typecheck && bun run test` green and a commit;
tick the checkbox in the same commit. Implementation starts only after PR #96 (S3) merges.

> Pre-implementation check against master a41323f (standing in for the skipped
> proposal review): the S3 prerequisite is met — synthesis.md §S3 marks it DONE
> via da3bc48, 6ae4dc8, 45a8e43. Every named block is present as described:
> 3 WebGL-create blocks (useTerminal.ts:676/1287/1944), 4 detach-reset blocks
> (the attached-refs nulling at ~1346/1369/1401/1544), 4 paired copy-mode-exit
> sites in the hook (854/903/1028/1116), the inline `fetchClipboardImagePath`
> duplicate (990–1008), and the importers in App.tsx, sessionMessages.ts,
> Terminal.tsx, and `src/client/__tests__/useTerminal.test.tsx`. The analysis's
> "8 paired copy-mode sites" counts 4 more inside Terminal.tsx — those are S5
> scope, not paired with the hook's state setter. No scope change.

## 1. Mechanical moves (verbatim)

- [x] 1.1 Move the module-level blocks: `terminal/snapshotCache.ts` (cache Map, limits,
  `invalidateSnapshotCache`/`clearSnapshotCache`), `terminal/droppedOutputLog.ts`
  (rate limiter + `resetDroppedOutputRateLimiterForTests`), `terminal/iosRepaint.ts`, and
  the link-sanitize helpers; re-export/update importers (`App.tsx`, `sessionMessages.ts`,
  tests) so the public functions keep their paths or move cleanly
- [x] 1.2 Extract `terminal/webgl.ts` (`loadWebglAddon(terminal, onContextLoss)`),
  `terminal/attachState.ts` (`detachFrom`, cancel-pending-attach), and
  `terminal/copyMode.ts` (`exitTmuxCopyMode(send, sessionId)`) as verbatim bodies the
  hook calls; suite green; commit (`refactor: move terminal concerns into terminal/ modules`)
- [x] 1.3 Extract `terminal/outputStream.ts` (buffer + flush timers + backpressure with
  generation token as a class) and `terminal/pasteChannel.ts` (resolver machinery +
  `resolveImagePasteData` + single `fetchClipboardImagePath`, deleting the inline copy);
  suite green; commit (`refactor: extract output stream and paste channel from useTerminal`)

## 2. Dedupe duplicated blocks

- [x] 2.1 Collapse the now-adjacent duplicates onto the shared helpers: 3× WebGL-create →
  `loadWebglAddon`, 4× detach-reset → `attachState.detachFrom`, the paired copy-mode-exit
  sites → `exitTmuxCopyMode`; suite green; commit
  (`refactor: dedupe webgl, detach, and copy-mode blocks in useTerminal`)

## 3. Unit tests + close-out

- [ ] 3.1 Add direct unit tests for `outputStream.ts` (buffer/flush/backpressure/
  generation-token discard) and `copyMode.ts` (optimistic set, debounce, poll, mouse-mode
  writes); suite green; commit (`test: unit-test output stream and copy mode modules`)
- [ ] 3.2 Confirm `useTerminal.ts` is composition + subscribe (~400–500 LOC) and every
  new module is under 500 LOC with a header comment; record actual numbers in this file
- [ ] 3.3 Mark S4 done in `docs/refactor-analysis/synthesis.md` (status note with commit
  hashes, mirroring the earlier notes); commit
  (`docs: mark P1/S4 complete in refactor synthesis`); push and open the PR; wait for merge

## Workflow follow-up

- After merge: sync master, remove the worktree/branch, archive the change; then propose S5
  (Terminal.tsx split + drawer lift).

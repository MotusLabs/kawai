# Proposal

## Why

`src/client/hooks/useTerminal.ts` (2,019 LOC) is a monolith hook: a ~1,680-line body owning
xterm lifecycle, attach/detach bookkeeping, output buffering with backpressure, paste/image
handling, tmux copy-mode state, snapshot caching, iOS repaint workarounds, and WebGL
renderer management — with three duplicated WebGL-create blocks, four duplicated
detach-reset blocks, and four copy-mode-exit blocks (analysis F2;
docs/refactor-analysis/phase2/client-architecture.md, P1-2). It is the least-testable
correctness-critical unit in the client. This is P1/S4 of the refactor program.

## What Changes

Decompose into composables under `src/client/terminal/` — refs stay hook-owned, logic moves
out as plain modules/classes that take setters:

- `terminal/webgl.ts` — `loadWebglAddon(terminal, onContextLoss)` replacing the 3 copies
- `terminal/attachState.ts` — `detachFrom(prevAttached)`, cancel-pending-attach bookkeeping
  replacing the 4 copies
- `terminal/copyMode.ts` — `exitTmuxCopyMode(send, sessionId)` for the paired sites plus
  the status-tracking state (optimistic set, debounced check, poll, mouse-tracking writes)
- `terminal/outputStream.ts` — buffer + flush timers + backpressure with a generation
  token, as a class (directly unit-testable)
- `terminal/pasteChannel.ts` — resolver promise machinery + `resolveImagePasteData` + a
  single `fetchClipboardImagePath` (deleting the inline copy)
- `terminal/snapshotCache.ts`, `terminal/iosRepaint.ts`, `terminal/droppedOutputLog.ts` —
  mechanical moves of the module-level blocks (incl. `sanitizeLink` helpers where they
  belong)
- `hooks/useTerminal.ts` shrinks to composition + the subscribe effect (~400–500 LOC)

No behavior changes — pure decomposition, verbatim logic moves first, dedupes second.
Marked `skip_specs: true`.

## Capabilities

### New Capabilities

None — pure refactor (`skip_specs: true`).

### Modified Capabilities

None.

## Impact

- Code: `src/client/hooks/useTerminal.ts` (2,019 → ~450 LOC), ~9 new `terminal/` modules;
  `App.tsx`/`Terminal.tsx` import updates only where module-level functions move
  (`invalidateSnapshotCache`, `sanitizeLink`).
- Tests: `useTerminal.test.tsx` (66 tests) must pass unchanged through the mechanical
  commits; new direct unit tests for `outputStream.ts` (backpressure/flush/generation) and
  `copyMode.ts` state machine.
- Risk: medium — effects share refs; ref ownership stays in the hook with setters passed
  into modules so lifecycles stay identical.

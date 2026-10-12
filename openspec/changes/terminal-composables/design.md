# Design

## Context

useTerminal.ts (2,019 LOC) mixes eight concerns in one hook body plus module-level caches.
The client-architecture report (P1-2, verified) mapped the duplicated blocks: 3× WebGL
create, 4× detach-reset, 4× copy-mode exit, an inline 987–1005 duplicate of
`fetchClipboardImagePath`, and the module-level `snapshotCache` / dropped-output limiter /
iOS repaint blocks. The hook's attach path is epoch-guarded (1407–1409 in the analysis's
numbering) and its tests (66) are the correctness gate.

## Goals / Non-Goals

**Goals:**

- Each concern becomes a module under `src/client/terminal/` that is importable and
  testable without rendering the hook.
- The hook keeps ownership of every ref and effect; modules receive refs/setters, so
  component lifecycles are untouched.
- `useTerminal.test.tsx` passes unchanged through the mechanical-move commits.

**Non-Goals:**

- No changes to attach/backpressure/copy-mode semantics, timing constants, or wire
  protocol.
- Not splitting `Terminal.tsx` (S5) or the WS manager.
- No new features (e.g. no renderer fallback policy changes).

## Decisions

### D1: Two-stage commits — verbatim moves, then dedupe

Commit 1: mechanical moves (snapshotCache, droppedOutputLog, iosRepaint, sanitizeLink
helpers, webgl loader, attachState, copyMode exit fn, pasteChannel, outputStream class)
with the hook calling them — zero logic edits. Commit 2: collapse the duplicated call
sites onto the shared helpers (3 WebGL → 1, 4 detach-resets → 1, copy-mode pairs → fn)
now that they sit next to each other. Suite green after each.

### D2: Refs stay hook-owned; modules take setters

The hook's correctness rests on ref identity across renders. Modules receive
`{ get, set }`-shaped accessors or the ref object itself (as `MutableRefObject`), never
duplicate state. `outputStream.ts` is the one exception: its buffer/timers/generation
token become a class the hook constructs once per attach target, because that state is
already per-attach, not per-render.

### D3: Module-level singletons become explicitly-owned instances where cheap

`snapshotCache` (Map + MAX entries + invalidate/clear) moves as a module singleton with
its two existing exported functions — it is genuinely app-global today and its consumers
(App, sessionMessages) import by function. `droppedOutputLog` and `iosRepaint` likewise
move as module singletons preserving their test hooks
(`resetDroppedOutputRateLimiterForTests`).

### D4: Browser-API seams stay injectable

WebGL addon loading, `matchMedia`, and clipboard/image fetch keep their existing
injectable/derived seams so tests keep working without jsdom upgrades; no new DI beyond
what the modules' function parameters introduce.

## Risks / Trade-offs

- [Effect/ref identity drift during the move] → Mitigation: D2 rule; the 66-test hook
  suite gates every commit; `double-attach`-style epoch behavior is unchanged by design.
- [Deduping the 3 WebGL copies hides a subtle variance] → Mitigation: the report verified
  them as copies; commit 2 dedupes only after commit 1 proves the moves, so any variance
  surfaces as a test delta at exactly that step.
- [Terminal.tsx still large after S4] → Expected; S5 owns it.

## Migration Plan

Branch `terminal-composables`, commits per D1 (plus unit tests for outputStream/copyMode
and the synthesis note), PR after implementation; S5 starts only after merge. Rollback is
revert.

## Open Questions

None blocking.

# Design

## Context

`logMatcher.ts` (2,599 LOC after the P0 cleanup) mixes five concerns: tmux scrollback capture,
prompt/message extraction from captures, log-file text reading, exact-match search, and
association verification. Each concern exists twice — a sync and an async variant — because the
module predates the match worker; since the worker took over, only the async variants run in
production (call-site audit in `docs/refactor-analysis/phase2/server-architecture.md`). The sync
chain survives only through `logMatcher.test.ts` and one unreachable branch in `index.ts`.

Consumers of the module surface (post-deletion): `index.ts` (async match + verify),
`logMatchWorker.ts` (async match, profiler, extraction), `logPoller.ts` (constants, timestamps,
path checks, tool-notification filter), `sessionRefreshWorker.ts` (tmux message extraction),
`logPollData.ts` (token counts).

## Goals / Non-Goals

**Goals:**

- Remove the unreachable `verifyAssociations` branch and its plumbing from `index.ts`.
- Delete every sync-only matcher twin and the helpers they alone sustain.
- End with concern-scoped modules whose public surface is async-only for anything that touches
  tmux or the filesystem.
- Keep every commit independently green (lint, typecheck, full suite).

**Non-Goals:**

- No behavior changes to matching, verification, or orphan semantics — the async pipeline is
  moved, not redesigned.
- No changes to `logPoller.ts`'s polling logic beyond its import path.
- Splitting `logMatcher.test.ts` into per-module test files (follow-up if desired; this change
  only updates its imports and drops sync-twin tests).
- The other refactor-analysis P1 items (index.ts decomposition is S1, separate change).

## Decisions

### D1: Delete the index.ts branch first, as its own commit

Removing `else if (verifyAssociations)` (and the `HydrateSessionsOptions.verifyAssociations`
field, the `refreshSessionsSync({ verifyAssociations })` pass-through, the `logDirs` local at
`index.ts:1030`, and the `verifyAssociations: true` argument at `index.ts:1462`) un-deads
nothing on its own — `verifyWindowLogAssociationDetailed` becomes production-dead — but it makes
the subsequent logMatcher deletion a pure module-level operation. Alternative (delete both at
once) was rejected: two small provable commits beat one large one when bisecting.

### D2: New home is `src/server/logmatch/` with a barrel, not flat root files

Five modules: `scrollback.ts` (tmux capture, ANSI + plain, async), `promptExtract.ts`
(message/prompt/trace extraction from captures and log lines — the pure string logic),
`logText.ts` (log-file reading, role filtering, token counts, last-message/timestamp
extraction), `exactMatch.ts` (profiler, candidate search, window→log exact matching),
`verify.ts` (detailed association verification and its result types). Shared low-level bits
(`runCommandAsync`, tmux flag helpers, `isSameOrChildPath`, `normalizeText`) live in the module
that uses them; if used by two modules, a `common.ts` inside `logmatch/`.

An `index.ts` barrel re-exports the consumed surface, mirroring `src/server/terminal/index.ts`
(precedent: all re-exports consumed, per the analysis). Importers change `./logMatcher` →
`./logmatch`. Alternatives rejected: keeping a root `logMatcher.ts` as a pure re-export shell
(perpetuates the god-module name and hides ownership), and updating every importer to deep
paths (noise; the barrel is the module boundary).

### D3: Sync-twin tests are deleted, not ported

`logMatcher.test.ts` imports four sync-only names (`matchWindowsToLogsByExactRg`,
`tryExactMatchWindowToLog`, `verifyWindowLogAssociation`, `captureTerminalScrollback`). Their
test matrices already exist against the async twins in the same file (both variants are
imported and exercised). Porting sync tests to async would duplicate existing coverage; the
tests are deleted with the code. If a matrix turns out to cover only the sync variant, that
case is ported to the async twin in the same commit — the deciding rule is coverage, not
symmetry.

### D4: Orphan detection is mechanical and enforced

After each deletion step, grep for the removed symbols across `src/` (including `__tests__`)
and let `tsc --noEmit` confirm no dangling references; helpers rendered private-dead (e.g. sync
command-running wrappers) are deleted in the same step. `oxlint` unused-export/unused-function
rules provide a second net.

## Risks / Trade-offs

- [A sync twin has a hidden consumer the audit missed] → Mitigation: consumers are static ES
  imports only (no dynamic `import()` of logMatcher exists — the repo's only dynamic imports
  are the SDK); grep + typecheck run per step; the full suite gates every commit.
- [The "unreachable" branch is reachable in a path not audited] → Mitigation: audited both
  flag-setting sites (`index.ts:1462` always pairs with `precomputedVerifications`;
  `refreshSessionsSync` never passes `true` across all five call sites) and the existing
  hydration tests (`hydrateSessionsEmptyGuard`, `indexHandlers` suite) exercise the
  precomputed path.
- [Test coverage shrinks] → Mitigation: only duplicate sync-mirror coverage is removed (D3);
  the async matrices that production uses remain.
- [Importer churn creates merge conflicts with in-flight branches] → Mitigation: five importers,
  one-line changes each; in-flight OpenSpec changes (`add-chat-context-usage`,
  `chat-session-spawned-subagents`, etc.) touch chat code, not the log pipeline.

## Migration Plan

Straight-through on branch `split-log-matcher`, one commit per task (see tasks.md); no data,
protocol, or config changes, so rollback is `git revert`. No deployment ordering.

## Open Questions

None blocking. (Whether to later split `logMatcher.test.ts` per module is a follow-up decision
that does not affect this change's approach.)

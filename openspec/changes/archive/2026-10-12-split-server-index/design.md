# Design

## Context

`index.ts` currently holds: the Hono app + 19 route registrations; the log-line cache
(`LOG_LINE_CACHE` at :165 and its readers); module-scope settings state (:524–560); the WS hub
(`sockets`, `broadcast`, `send`); clipboard watch loop (:640s consts, :2351–2598 logic);
remote-session merge and protection maps (:674–799); `hydrateSessionsWithAgentSessions`
(export at :1013) plus the refresh state machine (:1152–1160 counters, intervals at
:1398/:1412); the workspace coordinator hook (:1502–1510); paste/Swift-script handling
(:2017–2168); session ops (kill/rename/hibernate/wake/moveToHistory, ~:3165–4311); and the
terminal proxy attach lifecycle (:4313–4948) ending in `Bun.serve`.

The test harness contract (`isolated/indexHandlers.test.ts`): it `mock.module`s ~10 dependency
paths (`../../config`, `../../logger`, `../../db`, `../../SessionManager`,
`../../SessionRegistry`, `../../terminal`, chat availability probes, …) and then boots the
server via `await import(\`../../index?test=${importCounter}\`)` — a cache-busting dynamic
import that re-executes module side effects per section.

## Goals / Non-Goals

**Goals:**

- One module per concern, each under the 500-LOC norm, constructor-injected deps.
- All singletons constructed in exactly one place (`bootstrap.ts`), explicit init order.
- Harness keeps passing without redesign; mockable module paths unchanged.
- Every commit a pure lift: logic moves verbatim, suite green at each step.

**Non-Goals:**

- No behavior/protocol changes, no route redesign beyond mechanical extraction.
- Not touching `chat/`, `terminal/`, `logmatch/`, `logPoller` internals (other changes' scope).
- Not splitting `indexHandlers.test.ts` (follow-up once index.ts stops being the only SUT).
- Client-side P1s (S3–S5) and S6 (transcript parsing off the event loop).

## Decisions

### D1: Preserve boot-on-import semantics

`index.ts` stays as the importable entry: it gains a header and a single call to
`startServer()` from `bootstrap.ts`. Rationale: the harness's cache-busting dynamic import
re-runs the whole graph's side effects per counter value; keeping boot-on-import means the
harness works unchanged. Alternative rejected — exporting `startServer()` and having the
harness call it — would rewrite the harness's boot section for no gain and break the
re-import-per-section pattern.

### D2: Extraction order = dependency order, one module per commit

`logContent` (no deps) → `refresh/SessionRefreshLoop` → `sessions/*` ops →
`remote/RemoteSessionService` → `ws/*` → `routes/*` → `bootstrap.ts` last (it is the only
module that may reference all others). Each commit lifts one module verbatim and rewires
`index.ts` to use it; intermediate states keep remaining logic in `index.ts`. This is the
analysis report's P1-1 order (docs/refactor-analysis/phase2/server-architecture.md:185-195);
its line anchors predate S2/upstream merges by ±30 lines — locate blocks by symbol names.

### D3: DI style = the ChatSessionManagerOptions pattern

Extracted classes/functions take a typed options/context object
(`{ db, registry, sessionManager, config, broadcast, send, refresh, … }`) constructed in
`bootstrap.ts`. Extracted modules keep importing leaf utilities (`logger`, `config`,
`shellQuote`, `logmatch`) directly by module path — which also keeps the harness's
`mock.module` patches effective for those paths. Alternatives rejected: a service locator
(recreates hidden ordering); passing the Hono `app` everywhere (couples domain modules to
HTTP).

### D4: Race guards move verbatim

`refreshGeneration`, `clipboardWatchGen`, `terminalAttachSeq`, `copyModeCheckInFlight`,
`startAttemptId`, and the worker `generation` counters become fields of their owning class
with their exact current semantics — no renaming, no "simplification". The report flags them
as load-bearing race fixes (§5.3). Likewise `hydrateSessionsWithAgentSessions`' empty-input
guard (the mass-kill protection, covered by `hydrateSessionsEmptyGuard.test.ts`) must remain
the first thing the function does wherever it lands, and the function keeps its export (its
one non-harness consumer is that guard test).

### D5: Harness is the acceptance gate, not a rewrite target

`indexHandlers.test.ts` must pass unchanged through every extraction commit except where an
extraction renames a mock path (none planned — no mocked module moves). If a commit would
require harness edits, that is a design smell: stop and reassess. New coverage added during
extraction (not before): `wake.ts` claim-race branches (~:4145–4256 today) and `logContent`
window math get direct unit tests once they become importable without `Bun.serve`.

### D6: Workspace coordinator hook is deleted, not extracted

`WorkspaceCoordinatorHook` / `attachWorkspaceCoordinator` (:1502–1510) exist only for the
test-hook export the analysis flagged; the coordinator is referenced through one local name
in `bootstrap.ts`. The hook export dies; `hydrateSessionsEmptyGuard.test.ts` (the remaining
export consumer of hydration) keeps hydration exported from `refresh/SessionRefreshLoop.ts`.

## Risks / Trade-offs

- [Init-order regression during extraction] → Mitigation: D2's one-module-per-commit order;
  `bootstrap.ts` makes the order explicit and commented; suite + harness gate each commit.
- [Race-guard drift] → Mitigation: D4 verbatim-move rule; the guards' owning tests
  (double-attach integration, clipboard sections in the harness) run per commit.
- [Harness breaks silently on mock-path changes] → Mitigation: D5 rule that harness edits are
  a stop-and-reassess signal, not routine.
- [Merge conflicts with in-flight branches] → Mitigation: `index.ts` is the conflict surface;
  in-flight changes (`team-tasks`, `profile-routing`) mainly touch `chat/`; land this change
  promptly and rebase rather than letting it age.
- [Big change review burden] → Mitigation: each commit is a pure lift reviewable by diff
  shape ("code moved, imports rewired"); the final commit deletes ~4.5k lines from index.ts.

## Migration Plan

Straight-through on branch `split-server-index` (worktree), one commit per module in D2
order; no data/protocol/config changes; rollback is per-commit revert. Merge to master after
review, then archive.

## Open Questions

None blocking. (Whether `index.ts` ultimately becomes `bootstrap.ts`'s one-line re-export or
keeps the boot call inline is a cosmetic call made at the final step.)

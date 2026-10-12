# Design

## Context

Builds on `agent-teams`/`team-tasks` (dispatcher, worktree staffing, `team_spawns` reservations) and `profile-routing` (candidates, caps, router holds, cooldowns). The dispatcher already recomputes everything a waiting reason needs on every pass: `MailRecipient` (idle, pendingRequest, available, worktree, parked, profile, cooldownUntil) in `sessionMailbox.recipient()`, the eligibility filter in `MailDispatcher.eligibleFor`, the capacity counts in `WorktreeStaffing.counts` and `buildCandidates`, the router's hold/cooling decisions, and the spawn backoff in `WorktreeStaffing.failedAt`. Passes run on session status/archive/path/request changes (`ChatSessionManager.applyPatch`), limit events, rule loads, mailbox changes, and turn ends. Two gaps break visibility: `TeamMailboxPanel.tsx`'s categories match none of the states for `spawning`, so reserved mail vanishes from the view; and the reasons are never computed or published — `team-mailbox-snapshot` carries rows and routing state, nothing else. One gap breaks correctness: after a failed spawn, `staffing.ts` requeues the mail and records `failedAt` (a 30 s per-message backoff), but nothing ever wakes the dispatcher at the backoff's end — `armTimer` arms on `nextDueAt()`, recipient cooldowns, dispatcher holds, and `wakeAt()` (only `outcomes.nextNoteAt()`), so the retry fires only when an unrelated change happens to notify.

## Goals / Non-Goals

**Goals:** every unsettled mailbox row renders with a section; every waiting row carries a server-computed reason (immediate blocker plus other constraints, with counts and named sessions) derived from the same state that makes dispatch decisions; reasons refresh when capacity or availability changes; a failed spawn retries on its own; worktree occupancy is readable as one model.

**Non-Goals:** staffing-rule changes (a manual session still never occupies a worktree for spawning; caps keep their current semantics); watching `~/.kawai/teams.json` (a changed cap applies at the next pass, as today); persisting reasons, roster, or ledger (in-memory, rebuilt by the first pass after restart); new sequenced chat events or database migrations; the Team view, attention queue, and staffing controls (`team-workspace`, Wave B2); threads and delivered history (`team-message-threads`); assignment state and accountable owners (`task-assignment`); stage gates, revision barriers, checkpoints, and safety denials (Wave C); changing the parked/uncertain rows' existing explanations (they already say why they wait; only their label texts may be shared with the new formatter).

## Decisions

### D1. Reasons are typed constraints, blocker first

`src/shared/team.ts` gains `WaitingConstraint` — `{ kind, counts?, sessionIds?, retryAt?, detail? }` with one `kind` per cause (recipient-busy, recipient-pending-request, recipient-unavailable, profile-cooling, startup-failed, no-eligible-member (+ why each member was excluded: busy / pending card / parked / other worktree / unavailable / cooling / excluded profile), group-cap `n/m`, profile-cap `n/cap`, team-spawn-cap `n/m`, worktree-occupied, spawn-backoff, routing-hold, all-profiles-cooling, group-missing, starting-agent) — and `WaitingReason = { blocker: WaitingConstraint; others: WaitingConstraint[] }`. The server sends an ordered list; the first entry is the immediate blocker, the rest are whatever else applies. Clients render the blocker as one line and the rest behind an expander, so the doc's "display the immediate blocker and allow expansion for the others" is a rendering rule over one payload. *Alternative:* a single human-readable string per message — rejected: the doc requires blocker-first display with expandable others, and links (named sessions, worktrees) need structure.

### D2. The decision path computes the reason, not an observer

Group mail: `ProfileRouter.route` already sees members, caps, spawn allowance, holds, and cooldowns; `RouteResult`'s `none` and `hold` gain a `diagnosis: WaitingConstraint[]` built from the same inputs (eligibility breakdown from the dispatcher's member states, counts from `buildCandidates`' live tallies, spawn facts from `spawnContext`). The decision log keeps its role (a log); reasons are not scraped from it. The dispatcher's `eligibleFor`/`push` eligibility checks are extracted into one shared classifier both the router view and the diagnosis use, so a reason can never disagree with the rule that made the decision. Direct mail: the dispatcher's recipient view computes the reason (busy / pending card / unavailable with `startBlocker` text exposed by `ChatSessionManager` / profile cooling). Spawn reservations (`spawning`) diagnose as `starting-agent` with the reservation's group, profile, worktree, and elapsed since `team_spawns.created_at`. Per-message start failures (today only `failedThisPass`, which dies with the pass) are tracked with their error text until the message is delivered, requeued by the human, or dead-lettered. *Alternative:* an independent explainer that re-derives state from snapshots after each pass — rejected: two derivations drift, and the drift is exactly the wrong-reason bug this change fixes.

### D3. Publication: after-pass diff, additive snapshot fields

The dispatcher gains an `afterPass` hook; `sessionMailbox.ts` keeps a per-team ledger `Map<messageId, WaitingReason>` updated from the diagnoses of the settled pass. When any team's ledger changed, its mailbox snapshot is re-sent (`mailboxConnections.publish`) — today snapshots re-send only on row state changes. The snapshot (`team-mailbox-snapshot` in `src/shared/types.ts`) gains optional `waiting: Record<messageId, WaitingReason>` and `worktrees: TeamWorktreeOccupancy[]` fields; older clients ignore them (existing precedent: the additive `routing` field). Elapsed/age rendering stays client-ticked as today; no timer-driven server refresh.

### D4. One worktree-occupancy read model

New pure `src/server/team/teamRoster.ts`: `teamRoster(teamId)` groups live (non-archived) sessions by `worktreeRootOf(projectPath)`, each entry `{ worktree, sessions: [{ sessionId, group, profile, status, spawned, taskId }], pendingSpawns: [{ group, profile }] }` (pending from `team_spawns` rows). It includes manual and spawned sessions — transparency — while staffing semantics stay unchanged: `WorktreeStaffing`'s worktree-writer count and the `worktree-occupied` reason read the roster (manual sessions listed but not counted as writers), so the name shown as occupant is the same fact that blocked the spawn. Cap arithmetic (group `max`, per-profile caps, team spawn cap) stays in `staffing`/`candidates`, which already count pending reservations. The roster rides the mailbox snapshot (D3) so the later `team-workspace` view and `task-assignment` dispatch preview can reuse it without a second source.

### D5. The failed-spawn backoff wakes the dispatcher

`WorktreeStaffing` exposes `nextRetryAt(): number | null` (min unexpired `failedAt + RETRY_AFTER_MS`). `sessionMailbox.ts` folds it into the dispatcher's `wakeAt` (min with `outcomes.nextNoteAt()`); `armTimer` already arms on `wakeAt`. No polling, no new timer source: the existing minimum-wins timer simply learns one more time. The `spawn-backoff` constraint's `retryAt` is that same timestamp, so what the UI shows as "retry at" is the time the retry will actually run.

### D6. Dead-letter labels are a shared code map

`waitingLabels.ts` (client) maps known reason codes (`worktree-missing`, `killed-recipient`, `killed-sender-without-group`, `hop-limit`) to readable text, falling back to the raw string; the raw code stays visible. Unknown codes render verbatim, so future codes degrade gracefully instead of lying.

### D7. Scope of states that carry reasons

Reasons apply to `queued` (due now), `awaiting-request`, and `spawning`. `queued` with a future `deliverAt` keeps its "Due …" line (nothing blocks it); `claimed` is Receiving; `parked`, `uncertain`, `dead` keep their existing explanations, and `dead` additionally gets D6 labels. This is the entire unsettled surface — no state is left without a section once `spawning` renders as Starting agent.

## Risks / Trade-offs

- [Reason churn floods snapshots] → publish only when a team's ledger actually changed (structural compare, not timestamps); counts and names change rarely while mail waits.
- [Shared classifier changes dispatch behavior] → the classifier is an extraction of the existing checks (`eligibleFor` + the `push` claim predicate), not a rewrite; dispatcher tests pin delivery order and claims.
- [Roster in every snapshot grows payload] → teams are small (single-digit sessions); the roster is flat and bounded by live sessions plus reservations.
- [`startBlocker` becomes public API] → exposed as a read-only accessor returning the existing refusal text; no behavior change to `available`, which keeps calling it.
- [Start-failure memory lost on restart] → accepted (non-goal: persistence); after restart the first pass recomputes everything it can, and a still-failing spawn re-records its failure.

## Migration Plan

None. Additive optional snapshot fields; in-memory ledger, roster, and diagnosis state; one dispatcher hook; one staffing accessor. No tables, columns, or new sequenced events.

## Open Questions

- **Q1 — constraint ordering when several apply** (e.g. no eligible member *and* group cap reached). *Recommended default:* the diagnosis lists eligibility/member facts before caps before spawn specifics, deterministically, and the first entry is the blocker — the order the built-in strategy itself rechecks. The human may prefer caps first (they are the lever in `team-workspace` later).
- **Q2 — controls on a Starting agent row.** Today `spawning` rows have no controls (they match no category). *Recommended default:* none in this change; cancelling a live spawn reservation is a staffing control for `team-workspace` (Wave B2). Keep Cancel/Retry/Discard/Hand off exactly as today.
- **Q3 — roster payload placement.** *Recommended default:* carry `worktrees` on every `team-mailbox-snapshot` (small, always fresh, no new message type). Alternative: only while a Mailbox panel is open — saves bytes but makes the later Team view need a second subscription.

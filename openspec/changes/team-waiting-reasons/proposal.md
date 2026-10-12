# Proposal

## Why

When team mail does not arrive, the mailbox panel cannot say why. A message reserved for a spawning agent (`spawning`) is sent in every mailbox snapshot but matches none of `TeamMailboxPanel.tsx`'s categories, so it disappears from the view while its agent starts. A queued message shows only its age, and the few states with canned lines (`awaiting-request`, `parked`, `uncertain`) explain their state but never what else applies, even though the dispatcher, staffing, and router already know the cause: a busy recipient, a pending card, no member in the target worktree, a group/team/profile cap, a worktree held by another spawned member, a failed spawn in backoff, a routing hold, or a cooling profile. Today the human has to guess from session badges, which often point the wrong way. A spawned member can be busy for a different message, and a manual session in the worktree never blocks spawning. This is baseline P0 in `docs/multi-agent-development-ux.md` ("Waiting work never silently disappears", scenario E04), and the later task-assignment and team-workspace changes need the same facts.

Depends on `agent-mailbox`, `team-worktree-staffing`, and `profile-routing` (implemented, not archived). It does not depend on any other wave-B1 change.

## What Changes

- **Starting agent is visible.** The mailbox panel gets a **Starting agent** section for `spawning` rows. Each row shows the group, profile, and worktree of its reservation, and how long it has been starting. No pending state is left without a section.
- **Authoritative waiting reasons.** For every message waiting in `queued` (due now), `awaiting-request`, or `spawning`, the server computes a waiting reason. The reason has an immediate blocker and any other constraints that also apply, each with its counts and named sessions. The reasons are:
  - recipient busy;
  - recipient awaiting an approval or answer;
  - recipient unavailable (archived, directory missing, or cannot start), with the start blocker's text;
  - recipient profile cooling until a time;
  - agent startup failed, with the error;
  - no eligible member, broken down as busy / pending card / parked / in another worktree / unavailable / startup failed / excluded profile; cooling is not a group-path exclusion (cooling members stay candidates and surface as the separate all-profiles-cooling constraint) — only direct mail excludes cooling recipients;
  - group cap `n/m`;
  - per-profile caps `n/cap`;
  - team spawn cap `n/m`;
  - worktree occupied by a named spawned session or a pending spawn;
  - spawn failed, with a retry time;
  - routing hold, with the rule's reason and a retry time;
  - every candidate profile cooling until a time;
  - group definition missing;
  - starting agent.

  Group-mail reasons are recorded by the routing decision itself, from the same eligibility checks and capacity counts that made it. Direct-mail reasons come from the dispatcher's recipient view. Nothing is inferred from navigator badges. Constraints are ordered deterministically — capacity (group, per-profile, team spawn, worktree occupancy) before member facts before spawn/routing specifics — and the first is the immediate blocker (design D1, open question Q1).
- **Re-evaluated on change.** Every dispatch pass runs on session record changes (status, archive, path, SDK identity), request resolution, team resolution, limit, rule, and mailbox changes, and it refreshes the reasons. A team's mailbox snapshot is re-sent when its reasons change, not only when a row changes state. Reasons are in-memory and never persisted. After a restart they are rebuilt by the first pass.
- **Dead-letter labels.** Dead letters whose reason is a known code get readable labels. The codes today are `worktree-missing: <path>`, `killed-recipient`, `killed-sender-without-group`, and `hop-limit`; for example, `worktree-missing: <path>` becomes "Target worktree is missing". The code stays visible.
- **Failed spawns actually retry.** Staffing waits 30 s after a failed spawn, but nothing wakes the dispatcher when the backoff ends. A failed spawn retries only when something else happens to notify the dispatcher. The dispatcher's timer now includes the end of each backoff, so the "retry at" a reason shows is a real time.
- **Worktree occupancy read model.** A server-side `teamRoster` function lists a team's live (non-archived) sessions per resolved worktree root. It includes manual and spawned sessions, with group, profile, status, and task, and pending spawn reservations. Staffing's worktree count and the waiting reasons read it, and mailbox snapshots carry it. Task-assignment's dispatch preview can reuse it.
- **Mailbox panel.** Each waiting row shows its immediate blocker as one line. The other constraints sit behind an expandable list. Named sessions link to their chat, and worktrees show their basename with the full path. The existing Cancel / Retry / Discard / Hand off controls are unchanged.

Non-goals:
- **Team view, attention queue, and staffing controls.** These include raising a cap or releasing a worktree from the UI. They belong to `team-workspace`.
- **Threads and delivered history.** These belong to `team-message-threads`.
- **Assignment state and accountable owners.** These belong to `task-assignment`.
- **Stage or dependency gates, revision barriers, checkpoints, and safety denials.** These are the later rows of the doc's label list and belong to wave C (`durable-plans`, `execution-safety-recovery`).
- **Staffing rule changes.** The rules stay as they are. In particular, a manual session does not occupy a worktree for spawning (design D4 keeps it listed but not blocking).
- **Watching `~/.kawai/teams.json`.** A changed cap applies at the next dispatch pass, as it does today.
- **Persisting reasons or adding new sequenced events.** No database migration: no new tables or columns; the reasons, the roster, and the diagnosis ledger live in memory.

## Capabilities

### New Capabilities
- `team-waiting-reasons`: per-message waiting reasons (immediate blocker plus other constraints, with counts and named sessions), when they are recomputed and published, and the per-worktree live-session read model they and later team views use.

### Modified Capabilities
- `agent-mailbox`: the "Team mailbox is inspectable" requirement now names every unsettled state, including **Starting agent** for `spawning` and the today-unnamed awaiting-approval state; a new "Waiting rows render their reason" requirement carries the blocker-first line with expandable constraints and readable dead-letter labels.
- `team-worktree-staffing`: a failed spawn retries on its own once its backoff ends. Before this change, it waited for an unrelated wake-up.

## Impact

- Server:
  - New pure `src/server/team/waitingReasons.ts` (explainer) and `src/server/team/teamRoster.ts` (occupancy).
  - `dispatcher.ts` gains a member-state cause reporter beneath the unchanged `eligibleFor`/claim predicates, a per-message diagnosis ledger, in-flight and start-failure tracking, and an `afterPass` hook for reason-only refreshes; `spawning` rows are diagnosed at the reserve transition itself (design D3), not after the pass.
  - `staffing.ts` exposes `capacity()` with counts, caps, occupants, and backoff, plus `nextRetryAt()`.
  - `routing/router.ts` returns a diagnosis with `none`/`hold` and keeps hold reasons.
  - `sessionMailbox.ts` adds the availability reason, wiring, and reason-change publishing. `ChatSessionManager.ts` exposes `startBlocker` text as the availability reason.
  - `mailboxConnections.ts` adds snapshot fields.
- Shared: `src/shared/team.ts` gains `WaitingReason`, `WaitingConstraint`, and `TeamWorktreeOccupancy`. `team-mailbox-snapshot` in `src/shared/types.ts` gains the additive optional fields `waiting` and `worktrees`. Older clients ignore them.
- Client:
  - `TeamMailboxPanel.tsx` gets the Starting agent section and waiting lines.
  - New `waitingLabels.ts` holds the label formatting.
  - `teamMailboxStore.ts` stores the new fields.
- Tests:
  - Unit tests for the explainer, roster, dispatcher ledger, staffing capacity, router diagnosis, and panel.
  - An integration test for the E04 sequence.
  - Playwright `tests/e2e/chat-teams.spec.ts` scenarios with a fixture knob to hold or fail spawned-agent startup.
- No database migration. No change to delivery order, caps, or routing decisions.

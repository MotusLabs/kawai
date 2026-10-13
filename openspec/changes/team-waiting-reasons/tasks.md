# Tasks

## 1. Shared reason model

- [x] 1.1 Add `WaitingConstraint` (typed kind with optional counts, session names, retry time, detail) and `WaitingReason` (ordered constraints, first is the immediate blocker) to `src/shared/team.ts`, and the optional additive `waiting` and `worktrees` fields to the `team-mailbox-snapshot` message in `src/shared/types.ts`; verify type-level tests or compilation cover every constraint kind's fields and that the snapshot stays optional-field compatible with older clients.
- [x] 1.2 Add the dead-letter reason label map (`worktree-missing`, `killed-recipient`, `killed-sender-without-group`, `hop-limit`) with a verbatim fallback for unknown codes; verify unit tests cover each known code rendering a readable label with the code visible and an unknown code passing through unchanged.

## 2. Worktree occupancy read model

- [x] 2.1 Add pure `teamRoster(teamId)` in `src/server/team/teamRoster.ts` grouping live non-archived sessions by resolved worktree root with group, profile, status, spawned identity, and task, plus pending `team_spawns` reservations; verify unit tests cover manual and spawned sessions, members in subdirectories, missing group definitions, archived exclusion, and pending reservations.
- [x] 2.2 Make `WorktreeStaffing`'s worktree-writer count read the roster so the occupant named in a reason is the same fact that blocks the spawn, while manual sessions stay listed-but-not-blocking; verify staffing tests (caps, one writer per worktree, reservation accounting) still pass unchanged and roster tests show a manual session not occupying.
- [x] 2.3 Carry the roster on the team mailbox snapshot for every subscribed client; verify connection tests cover open, change, and reconnect snapshots including `worktrees`, and that teams without sessions serialize an empty list.

## 3. Dispatcher diagnosis and spawn-backoff wake-up

- [ ] 3.1 Add a member-state cause reporter over the shared recipient fields (idle, available, pendingRequest, parked, worktree, group, team, profile, cooldown, excluded profile) reporting each member's exclusion cause (busy, pending card, parked, other worktree, unavailable, startup failed, excluded profile), with `eligibleFor` and the `push` claim predicate rebuilt unchanged on top of it — their boolean shapes stay exactly as today, since they check different subsets; verify dispatcher tests for delivery order, claims, and urgent interrupt still pass unchanged, pin both predicates' shapes, and cover each reported cause.
- [ ] 3.2 Compute direct-mail waiting reasons in the dispatcher from the recipient view (busy, pending card, unavailable with the manager's start-refusal text, profile cooling) and track per-message agent-start failures with their error text until the message leaves the queued surface (delivered, cancelled, dead-lettered, discarded); verify unit tests cover each reason, failure persistence across passes, and clearance on each leaving transition.
- [ ] 3.3 Expose `WorktreeStaffing.nextRetryAt()` (earliest unexpired `failedAt` + backoff), fold it into the dispatcher's `wakeAt` alongside recovery notes, and clear `failedAt` entries when their message leaves the queued surface (delivered, cancelled, dead-lettered, discarded — the start-failure tracker's lifetime); verify a test that fails a spawn, changes nothing else, and observes the retry run at the backoff's end, a test that `armTimer` fires no earlier than every armed time, and a test that stale entries are cleared so `nextRetryAt()` never arms on a dead backoff.
- [ ] 3.4 Diagnose `spawning` rows at the reserve transition — the store notify at `reserveForSpawn` publishes the only guaranteed `spawning` snapshot (an unrelated message's notify during the awaited spawn can also publish one), and the state is left within the same awaited pass — deriving `starting-agent` from the pending reservation (`team_spawns`: group, profile, worktree, elapsed since `created_at`); to make that source visible at the reserve notify, the reservation transaction inserts the `team_spawns` row before flipping the message to `spawning` and throws on a failed reserve so the transaction rolls the insert back; record `spawn-backoff` with its retry time in the sessionMailbox reason ledger next to `failedAt`, before the requeue notify publishes, and keep the `afterPass` hook for pass-computed reason-only refreshes (cap release, cooldown end, eligibility changes); verify tests cover the reserve-notify snapshot already carrying the starting-agent reason with the reservation's facts, a failed reserve leaving no `team_spawns` row (persisted end state identical to today), the failure snapshot carrying the backoff reason and retry time, a `spawning` row's blocker being `starting-agent` even though its own reservation fills the caps (the capacity effects appear among the other constraints), reason-only changes publishing, and reasons clearing when a message leaves its waiting state.

## 4. Router diagnosis

- [ ] 4.1 Extend the routing result's `none` and `hold` with a diagnosis built from the same eligibility breakdown, live counts, spawn allowance, and cooldowns the decision used (group cap, per-profile caps, team spawn cap, worktree occupancy from the roster, spawn backoff with retry time, hold reason from the rule, all-profiles-cooling with the earliest end); verify router tests cover each constraint kind, that counts match `buildCandidates` tallies, and that the built-in fallback after a rule throw still diagnoses.
- [ ] 4.2 Diagnose a missing group definition as its own constraint while mail to a gone group still routes to eligible members; verify a test covers group removal and restoration mid-wait.

## 5. Server publication

- [ ] 5.1 Keep the per-team reason ledger in `sessionMailbox.ts`, updated from `afterPass` and router diagnoses, and re-publish a team's mailbox snapshot when its ledger structurally changes — not only on row state changes; verify tests cover reason-only changes publishing, unchanged passes staying silent, and reason updates after cap release, cooldown end, archive, and idle transitions.
- [ ] 5.2 Expose `ChatSessionManager.startBlocker`'s refusal text read-only for the unavailable-recipient reason while `available` keeps calling it; verify manager tests show unchanged availability behavior and the reason carrying the start blocker's text.

## 6. Mailbox panel

- [ ] 6.1 Add the Starting agent section to `TeamMailboxPanel.tsx` covering `spawning` rows with reservation facts and elapsed time, so every state on `listForTeam`'s surface (queued, awaiting-request, spawning, claimed, parked, dead, uncertain) matches exactly one category; verify component tests cover a spawning row rendering, its transition to Receiving, and that no state on that surface renders in zero sections.
- [ ] 6.2 Render each waiting row's immediate blocker as one line with the other constraints expandable, named sessions linking to their chats and worktrees showing basename with full path, and readable dead-letter labels beside the code; verify component tests cover blocker-plus-expansion, links, label fallbacks, and unchanged Cancel/Retry/Discard/Hand off controls.
- [ ] 6.3 Store the new snapshot fields in `teamMailboxStore.ts`; verify store tests cover reason-only snapshot updates and roster updates without row changes.

## 7. Integration and validation

- [ ] 7.1 Add a headless integration test of the E04 sequence with a fixture knob that holds spawned-agent startup open: the message stays visible as Starting agent, then group cap, team cap, and occupied worktree each show the right reason and counts when exercised independently, and freeing the blocking slot updates the reason and delivers to exactly one agent; verify the failed-spawn path retries at its backoff end with nothing else changing, using `cleanGitEnv()` for every test git command.
- [ ] 7.2 Add Playwright scenarios in `tests/e2e/chat-teams.spec.ts` walking the Starting agent section, blocker lines with expandable constraints, dead-letter labels, and the slot-free update; verify DOM state and screenshots against the fixture.
- [ ] 7.3 Document in the How It Works section of `CLAUDE.md`: the mailbox panel's full state list including Starting agent, waiting reasons with their blocker-first rendering and deterministic caps-first order, dead-letter labels, and the failed-spawn 30 s backoff now being woken at its end; verify the documented states match `listForTeam`'s surface and the panel's sections, and the backoff wording replaces "retries no sooner than 30s later" with the woken retry.
- [ ] 7.4 Run `bun run lint && bun run typecheck && bun run test` and `openspec validate team-waiting-reasons --strict`; verify the full suite is green and the change validates.

## Workflow follow-up

- Keep this change proposal-only until the human approves it and the Wave B1 set is scheduled; implementation order follows the human's wave plan (B1 implementations after all four proposals land).
- Do not absorb assignment state, threads, or the Team view here: they are `task-assignment`, `team-message-threads`, and `team-workspace`.

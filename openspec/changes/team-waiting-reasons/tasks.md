# Tasks

## 1. Shared reason model

- [ ] 1.1 Add `WaitingConstraint` (typed kind with optional counts, session names, retry time, detail) and `WaitingReason` (ordered constraints, first is the immediate blocker) to `src/shared/team.ts`, and the optional additive `waiting` and `worktrees` fields to the `team-mailbox-snapshot` message in `src/shared/types.ts`; verify type-level tests or compilation cover every constraint kind's fields and that the snapshot stays optional-field compatible with older clients.
- [ ] 1.2 Add the dead-letter reason label map (`worktree-missing`, `killed-recipient`, `killed-sender-without-group`, `hop-limit`) with a verbatim fallback for unknown codes; verify unit tests cover each known code rendering a readable label with the code visible and an unknown code passing through unchanged.

## 2. Worktree occupancy read model

- [ ] 2.1 Add pure `teamRoster(teamId)` in `src/server/team/teamRoster.ts` grouping live non-archived sessions by resolved worktree root with group, profile, status, spawned identity, and task, plus pending `team_spawns` reservations; verify unit tests cover manual and spawned sessions, members in subdirectories, missing group definitions, archived exclusion, and pending reservations.
- [ ] 2.2 Make `WorktreeStaffing`'s worktree-writer count read the roster so the occupant named in a reason is the same fact that blocks the spawn, while manual sessions stay listed-but-not-blocking; verify staffing tests (caps, one writer per worktree, reservation accounting) still pass unchanged and roster tests show a manual session not occupying.
- [ ] 2.3 Carry the roster on the team mailbox snapshot for every subscribed client; verify connection tests cover open, change, and reconnect snapshots including `worktrees`, and that teams without sessions serialize an empty list.

## 3. Dispatcher diagnosis and spawn-backoff wake-up

- [ ] 3.1 Extract the member-eligibility checks shared by `eligibleFor` and the `push` claim predicate into one classifier that also reports each member's exclusion cause (busy, pending card, parked, other worktree, unavailable, cooling, excluded profile); verify dispatcher tests for delivery order, claims, and urgent interrupt still pass unchanged and new tests cover each exclusion cause.
- [ ] 3.2 Compute direct-mail waiting reasons in the dispatcher from the recipient view (busy, pending card, unavailable with the manager's start-refusal text, profile cooling) and track per-message agent-start failures with their error text until delivery or human requeue; verify unit tests cover each reason, failure persistence across passes, and clearance on delivery.
- [ ] 3.3 Expose `WorktreeStaffing.nextRetryAt()` (earliest unexpired `failedAt` + backoff) and fold it into the dispatcher's `wakeAt` alongside recovery notes; verify a test that fails a spawn, changes nothing else, and observes the retry run at the backoff's end — plus `armTimer` firing no earlier than every armed time.
- [ ] 3.4 Add the `afterPass` hook through which the dispatcher reports each pass's per-message diagnoses, including `starting-agent` with the reservation's group, profile, worktree, and elapsed time; verify dispatcher tests cover spawning rows reporting reservation facts and reasons clearing when a message leaves its waiting state.

## 4. Router diagnosis

- [ ] 4.1 Extend the routing result's `none` and `hold` with a diagnosis built from the same eligibility breakdown, live counts, spawn allowance, and cooldowns the decision used (group cap, per-profile caps, team spawn cap, worktree occupancy from the roster, spawn backoff with retry time, hold reason from the rule, all-profiles-cooling with the earliest end); verify router tests cover each constraint kind, that counts match `buildCandidates` tallies, and that the built-in fallback after a rule throw still diagnoses.
- [ ] 4.2 Diagnose a missing group definition as its own constraint while mail to a gone group still routes to eligible members; verify a test covers group removal and restoration mid-wait.

## 5. Server publication

- [ ] 5.1 Keep the per-team reason ledger in `sessionMailbox.ts`, updated from `afterPass` and router diagnoses, and re-publish a team's mailbox snapshot when its ledger structurally changes — not only on row state changes; verify tests cover reason-only changes publishing, unchanged passes staying silent, and reason updates after cap release, cooldown end, archive, and idle transitions.
- [ ] 5.2 Expose `ChatSessionManager.startBlocker`'s refusal text read-only for the unavailable-recipient reason while `available` keeps calling it; verify manager tests show unchanged availability behavior and the reason carrying the start blocker's text.

## 6. Mailbox panel

- [ ] 6.1 Add the Starting agent section to `TeamMailboxPanel.tsx` covering `spawning` rows with reservation facts and elapsed time, so every `MessageState` matches exactly one category; verify component tests cover a spawning row rendering, its transition to Receiving, and that no unsettled state renders in zero sections.
- [ ] 6.2 Render each waiting row's immediate blocker as one line with the other constraints expandable, named sessions linking to their chats and worktrees showing basename with full path, and readable dead-letter labels beside the code; verify component tests cover blocker-plus-expansion, links, label fallbacks, and unchanged Cancel/Retry/Discard/Hand off controls.
- [ ] 6.3 Store the new snapshot fields in `teamMailboxStore.ts`; verify store tests cover reason-only snapshot updates and roster updates without row changes.

## 7. Integration and validation

- [ ] 7.1 Add a headless integration test of the E04 sequence with a fixture knob that holds spawned-agent startup open: the message stays visible as Starting agent, then group cap, team cap, and occupied worktree each show the right reason and counts when exercised independently, and freeing the blocking slot updates the reason and delivers to exactly one agent; verify the failed-spawn path retries at its backoff end with nothing else changing, using `cleanGitEnv()` for every test git command.
- [ ] 7.2 Add Playwright scenarios in `tests/e2e/chat-teams.spec.ts` walking the Starting agent section, blocker lines with expandable constraints, dead-letter labels, and the slot-free update; verify DOM state and screenshots against the fixture.
- [ ] 7.3 Run `bun run lint && bun run typecheck && bun run test` and `openspec validate team-waiting-reasons --strict`; verify the full suite is green and the change validates.

## Workflow follow-up

- Keep this change proposal-only until the human approves it and the Wave B1 set is scheduled; implementation order follows the human's wave plan (B1 implementations after all four proposals land).
- Do not absorb assignment state, threads, or the Team view here: they are `task-assignment`, `team-message-threads`, and `team-workspace`.

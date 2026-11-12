# Design

## Context

See proposal.md, Why, for the incident. These code facts constrain the design:

- **Pass order.** `MailDispatcher.dispatch()` (`src/server/team/dispatcher.ts`)
  runs urgent direct interrupts, then for each priority a `directPass` and then
  a `groupPass`. `directPass` gives every idle recipient its next direct
  message, and the recipient's idle slot is consumed before any group message
  is routed. A lead with direct mail queued therefore never reaches the group
  pass.
- **What group routing sees.** `GroupRouter.route` (`routing/router.ts`) sees
  only members the dispatcher found eligible. It also reads the group's
  members (`options.members`), so it can tell a busy member from an absent
  one.
- **The pure eligibility check.** `evaluateEligibility`
  (`routing/workerEligibility.ts`) orders members as the dispatcher gives them
  (longest idle first). `builtinPick` (`routing/builtin.ts`) re-sorts members
  by strategy and idle time.
- **Message fields and the sender's task.** `team_messages.task_id` drives the
  envelope's task section and `associateTask`, which re-points the
  recipient's `chat_sessions.task_id`. A dev's current task is in
  `chat_sessions.task_id`, set when task mail is pushed to it.
- **Group frontmatter.** It is parsed in `src/server/team/groupFile.ts`, with
  strict per-key validation and warnings for bad values.
- **Task rights.** `tasks.creator_kind` and `tasks.creator_session`
  (`taskStore.ts`) decide who amends and sends revision notices
  (`TaskService.ts`) and who closes (`taskStatusRights.ts`). A creator that is
  archived or context-exhausted leaves its open tasks with no agent able to
  amend or close them.
- **Waiting-reason kinds.** They are listed in `src/shared/team.ts`
  (`WaitingConstraint`), rendered by `src/client/utils/waitingLabels.ts`, and
  computed in `waitingReasons.ts` and from router diagnoses.

## Goals / Non-Goals

**Goals:**

- A lead receives group mail about the tasks it owns, and another lead takes
  it only when the owner is unavailable or has been busy past a bounded wait.
  Nothing assumes a number of leads: with one lead affinity changes nothing,
  and with several each owner is preferred.
- A replacing lead can take over a departed lead's tasks, and a lead can hand
  a task to another before leaving it.
- No group's mail can be starved indefinitely by a stream of direct mail.
- The router, the dispatch preview, `team_capacity`, and waiting reasons give
  one answer.

**Non-Goals:**

- **No automatic reassignment.** Ownership moves only when an agent calls
  `task_transfer_owner` (D7); nothing rebalances by load. Until a takeover,
  a departed owner's mail falls back to the group's strategy.
- **No ownership for human or Kawai tasks.** They keep today's rights.
- **No affinity for direct mail, replies, or mail without a resolvable task**
  (human requests, Kawai plan mail).
- **No change to urgent ordering**, to interrupts, or to the worktree
  targeting of task mail.
- **Not the `uncertain` receipts** seen on one Codex lead. That is a separate
  issue.
- **Not task_get or tool output size.** `bounded-metrics-and-task-get` covers
  that.

## Decisions

### D1: The task is recorded at send; its owner is resolved at route time

At send time, `TeamMailbox.send` resolves the affinity task: `input.task_id`,
else the sender session's `chat_sessions.task_id`. When the target group sets
`affinity: task-owner` and a task resolves, it stores the task id in a new
nullable column, `team_messages.affinity_task`. That covers
`messageSchema.ts`, `EnqueueInput.affinityTask`, and the
`TeamMessage.affinityTask` field.

At each routing decision the dispatcher looks up the task's
`owner_session` (D7) and passes it to the router as the message's task owner
only when that session's group is the target group. The lookup is one
indexed read per group message per pass, batched per pass by task id.

- **Why a new column, not `task_id`.** Setting `task_id` would add a task
  section to the lead's envelope and run `associateTask`, re-pointing the
  lead's own current task to the dev's task. That is wrong for a lead.
- **Why the task at send time.** The sender's current task can change after
  the message is sent, and the recorded value makes the decision auditable.
- **Why the owner at route time.** Ownership can move while mail is queued
  (D7). A stored owner would keep sending a departed lead's mail to the
  fallback after a takeover; the resolved owner follows the transfer.
  Whether the owner is a live member is judged at route time too (D3).
- **Rejected:** inferring the task from the message body. It is unreliable,
  and rules never see bodies.
- **Replies.** A reply already goes to its original sender, so replies need
  no owner. A limit forward keeps `affinity_task`, since it is the same
  message and the same task.

### D2: Opt-in per group: `affinity` and `affinityWait`

`groupFile.ts` accepts `affinity: task-owner`; any other value raises a group
warning and no affinity applies. It also accepts `affinityWait: <whole
minutes ≥ 0>`, default 30; an invalid value raises a warning and the default
applies, so an invalid wait never disables affinity. `affinityWait: 0` means
prefer the owner when it is idle, never wait. Routing reads both settings from
the group's current file on each pass (D3), so an edit applies to mail that is
already queued.

- **Rejected: always on.** Developer groups already narrow by worktree, and
  holding their mail for a busy creator would only slow them.
- **Why 30 minutes.** Lead turns in the incident ran 1 to 94 minutes, with a
  median near 5. 30 minutes covers most turns without losing a whole long one
  to idling.

### D3: One pure derivation decides prefer, hold, or fall back

A new pure function, `ownerAffinity(state)`, sits beside
`evaluateEligibility`. Its inputs are:

- the group's current `affinity` and `affinityWait`, read at route time;
- the task owner, as resolved at route time;
- the owner member's causes (from `memberStateCauses`, or absent when the
  owner is not a live group member);
- the filter reasons for the owner's profile;
- the message's due time, `deliver_at ?? created_at`, the same origin aging
  uses (D4);
- `now`.

It returns one of:

- `prefer`: the owner is an eligible candidate;
- `hold(until)`, with `until = due + affinityWait`: the owner's only causes
  are `busy` and/or `pending-card`, no filter reason applies, and
  `now < until`;
- `none`: every other case, which falls through to the strategy. This
  includes a group that does not set `affinity` at route time. A recorded
  owner on such a group (affinity removed after the send, or a limit forward
  to a group without it) stays on the row for audit and is ignored.

These consumers all call it:

- `evaluateEligibility` takes the owner in its state and moves an eligible
  owner's candidate first;
- `builtinPick` takes a `preferSessionId` and returns that candidate first
  when it is present and not cooling;
- the router turns `hold` into a `{ kind: 'hold', retryAt: until }` with an
  `owner-busy` diagnosis;
- the dispatch preview and waiting reasons read the same result.

One function means the readers cannot drift apart (oracle hazard "Several
readers disagreeing on derived state").

**Cooling.** A cooling owner gives `none`, not `hold`. A provider limit is
exactly the case where another lead should take over, and the lead group's
`onLimit: release` already expresses that intent.

**Order.** The order inside `route()` is:

1. the eligibility check, which ranks a `prefer` owner first;
2. if there are no candidates, the existing `none`. No rule runs, as today.
   When `ownerAffinity` returns `hold`, the diagnosis also carries
   `owner-busy` with the hold's `retryAt`, so the waiting reason names the
   owner even when nobody else could take the message;
3. the rule, which sees `message.taskOwner` and whose pick or hold wins;
4. the owner hold;
5. `builtinPick` with the owner preferred.

The hold is evaluated after the rule, so a rule can override it. It is
evaluated before `builtinPick`, so the default path waits for the owner.

**Re-routing.** The owner hold is not stored in the router's hold map, which
keeps rule holds keyed by candidate signature. Every pass re-derives it from
`ownerAffinity`, so it ends on the first pass after the owner goes idle, the
wait runs out, or the group stops setting `affinity`. The `retryAt` re-arms
the dispatcher timer, so a pass runs at the end of the wait at the latest.

### D4: Aged group mail gets its own step in each pass

The per-pass order becomes:

```
urgent direct (interrupts) -> urgent direct -> urgent group
  -> aged normal group -> normal direct -> normal group
```

Aged means `now - (deliver_at ?? created_at) >= 15 min` (`GROUP_AGING_MS`).
The aged step routes those group messages before `directPass('normal')`, so
an idle recipient chosen for one is claimed before its direct mail is
offered. Messages that are not aged keep today's position.

- **Rejected: lower priority for direct mail between members of one group.**
  It needs a sender-group rule and still starves group mail under other
  direct-mail patterns. Aging fixes the class.
- **Rejected: strict oldest-first across direct and group mail.** That
  reorders every conversation and every thread reply for little gain.
- **Why a constant.** The 15-minute threshold is a constant, not a knob. No
  group has a need to tune it yet, and a constant keeps the order easy to
  state in the spec.

### D5: Waiting reason `owner-busy`

A new `WaitingConstraint` kind `owner-busy` carries `sessionIds: [owner]` and
`retryAt`. It is the immediate blocker while the hold applies. The members'
own causes still follow as other constraints. The label goes in
`waitingLabels.ts`. After the wait ends, `ownerAffinity` returns `none` and
the constraint disappears.

### D6: The lead group opts in, and its guidance changes

`.kawai/groups/lead.md` gains `affinity: task-owner`, with the default wait.
A short paragraph tells leads three things:

- group mail about another lead's task reaches that lead, so do not relay it;
- record coordination in the task journal, and send direct mail to another
  lead only when it must act;
- before leaving a task, hand it to another lead with `task_transfer_owner`;
  a replacing lead takes over a departed lead's tasks with `from_session`.

The human owns this file's guidance text, so the task that edits it asks for
review.

### D7: Tasks carry an owner that agents can transfer

`tasks` gains a nullable `owner_session` column. An agent-created task
starts with owner = creator; human and Kawai tasks have none. A migration
backfills `owner_session = creator_session` for existing agent tasks. The
creator stays as the author; every right the creator held as an agent
(amend, revision notices, done/cancel) moves to the owner. Human and Kawai
rights are unchanged.

`task_transfer_owner { task_id | from_session, to_session?, reason? }`:

- **Handover:** the owner moves its task to `to_session`, a live,
  non-flagged session of the owner's group.
- **Takeover:** a session of the owner's group takes a task for itself
  (`to_session` absent or itself) when the owner is not a live session
  (gone or archived) or is flagged context-exhausted. `from_session` takes
  every open, active, and blocked task of that owner in one call.
- Each move appends a journal entry `owner: A -> B by C (reason)` in the
  same transaction as the column write, so a crash never leaves one without
  the other.

The liveness check reads the owner's session record, the same facts that
remove it from routing for good: no record (gone), `archivedAt`, or the
context-exhausted flag (`departure()` in `taskOwnership.ts`). Routing's
transient causes (busy, cooling, parked) never permit a takeover; the
owner hold's bounded wait covers them. The group check compares the
sessions' current groups; an owner with no record left is matched by the
caller's right to own tasks (its group sets `canCreateTasks`). The column
write is conditional on the owner still being the one checked, so two
concurrent takers cannot both win.

- **Rejected: taking over a live owner.** Two leads would race on one task;
  the live owner hands over instead.
- **Rejected: a human-only reassign.** The incident's lead replacements
  happened while the human was away; a replacing lead must recover alone.
- **Supersedes change-coordination's no-claim rule.** "Coordinator recovery
  respects durable ownership" said a replacement never claims another
  session's amend or close rights. This change keeps that for implicit
  claims, but lets a recorded takeover from a departed owner grant them. The
  human chose to include handover in this change, and without a takeover a
  replaced lead's open tasks keep refusing every agent.
- **Rejected: storing the owner on the message (an earlier draft of D1).**
  It cannot follow a transfer.

## Acceptance oracles

### Owner affinity derivation (`ownerAffinity`, pure)

Axes: the group's current affinity setting; the task owner as resolved at route time; the owner's
live state: eligible, only busy or awaiting a card, other cause (parked,
context-exhausted, unavailable, startup-failed, other worktree), cooling,
filtered (outside the role, worker choice, excluded profile), or not a live
member; and whether `now < due + wait`. The derivation does not look at the
other candidates or the rule.

| Id | Affinity now | Owner recorded | Owner state | `now < due + wait` | Result |
|---|---|---|---|---|---|
| A1 | on | no | * | * | `none` |
| A2 | on | yes | eligible | * | `prefer` |
| A3 | on | yes | busy or card | yes | `hold(due + wait)` |
| A4 | on | yes | busy or card | no, including `now = due + wait` | `none` |
| A5 | on | yes | other cause | * | `none` |
| A6 | on | yes | cooling | * | `none` |
| A7 | on | yes | filtered | * | `none` |
| A8 | on | yes | not live | * | `none` |
| A9 | off | yes | * | * | `none` |

A3 and A4 each have a scheduled row (`deliver_at` later than `created_at`),
so the wait is measured from `deliver_at`.

Unreachable or excluded: with `affinityWait: 0`, `now < due + wait` is
false, so A3 cannot occur.

### Owner affinity routing (`route()`, production composition)

| Id | Candidates | Rule decision | `ownerAffinity` | Result |
|---|---|---|---|---|
| B1 | yes | none or default | `none`, no owner | strategy pick (unchanged) |
| B2 | yes, the owner and `B` idle longer | none or default | `prefer` | the owner |
| B3 | yes, `profile-order`, the owner on a lower profile | none or default | `prefer` | the owner, despite rank |
| B4 | yes, the owner not among them | none or default | `hold(t)` | hold until `t`, diagnosis `owner-busy` |
| B5 | none | does not run | `hold(t)` | a hold until `t` whose diagnosis is `owner-busy` with `t` followed by the existing no-candidate constraints; at `t` the pass re-routes and the message waits as before |
| B6 | none | does not run | `none` | the existing `none`, no `owner-busy`; the owner takes it once idle |
| B7 | yes, the owner not among them | none or default | `none` (wait over, other cause, cooling, filtered, not live) | strategy pick among the others, no wait |
| B8 | yes | pick `B` | `prefer` or `hold` | `B` |
| B9 | yes | hold | any | the rule's hold, no `owner-busy` |
| B10 | yes, the owner busy | none or default | `hold` before an edit, `none` after | after `affinity` is removed from the group file, the next pass gives the strategy pick; after a restart likewise. The row still records the owner. |

Unreachable: a rule deciding with no candidates (step 2 returns first), and an
eligible owner with no candidates (an eligible owner is a candidate).

- **Task owner on a group without affinity:** D1 records no affinity task.

### Group aging (dispatcher pass)

| Id | Group mail | Direct mail for the idle chosen member | Result |
|---|---|---|---|
| G1 | normal, due 5 min | normal | direct delivered first |
| G2 | normal, due ≥ 15 min | normal | group delivered first |
| G3 | normal, due ≥ 15 min | urgent | urgent direct first |
| G4 | urgent, any age | normal | group first (unchanged) |
| G5 | normal, due ≥ 15 min, owner hold active | normal | direct to the idle member; the group stays held |
| G6 | normal, due ≥ 15 min, idle owner | normal, for the owner | group to the owner first |
| G7 | normal, created 20 min ago, `deliver_at` 5 min ago | normal | direct delivered first (age counts from `deliver_at`) |

### Affinity task at send and owner at route (D1)

| Id | `task_id` | Sender's current task | Group affinity | Task's owner at route | Affinity task / task owner |
|---|---|---|---|---|---|
| R1 | given | * | on | lead session of the target group | `task_id` / that owner |
| R2 | absent | set | on | lead session of the target group | sender's task / that owner |
| R3 | absent | absent | on | * | none / none |
| R4 | * | * | off | * | none / none |
| R5 | resolved | * | on | none (human or Kawai task) or a session of another group | the task / none |
| R6 | given | set, different | on | owners differ | `task_id` / the owner of `task_id` |
| R7 | resolved | * | on | moved from `A` to `B` after send | the task / `B` |

Every row also checks that the message's `task_id` is exactly what the
sender gave, and that the envelope carries no task section unless `task_id`
was given.

### Ownership transfer (D7)

| Id | Caller | Selector | Owner's state | Target | Result |
|---|---|---|---|---|---|
| T1 | owner | `task_id` | live | live, unflagged, same group | moved; journaled by the owner |
| T2 | owner | `task_id` | live | other group, archived, or flagged | refused naming the target |
| T3 | same group | `task_id` | archived or gone | self (default) | moved; journaled |
| T4 | same group | `task_id` | context-exhausted | self | moved; journaled |
| T5 | same group | `task_id` | live, unflagged | self | refused naming the owner; suggests messaging it |
| T6 | other group | * | * | * | refused |
| T7 | same group | `from_session` | archived, gone, or flagged | self | every open, active, blocked task moved; done and cancelled kept; ids listed |
| T8 | same group | `from_session` | live, unflagged | self | refused naming the owner |
| T9 | * | `task_id` of a human or Kawai task | none | * | refused: no owner |
| T10 | * | both or neither | * | * | refused |
| T11 | non-owner taker | `task_id` | departed | someone else | refused: a takeover names only the caller |

Rights after a move (one table-driven test):

| Id | Actor | Amend / notices | Done / cancel |
|---|---|---|---|
| O1 | new owner | allowed | allowed |
| O2 | former owner (still the creator) | refused naming the owner | refused naming the owner |
| O3 | human | allowed | allowed |
| O4 | Kawai, on its own task | as today | as today |

Properties over transfers:

- **P4, one owner.** Seeded sequences (seed 2718, 300 cases) of creates,
  transfers, takeovers, archives, and flags: after every step, each
  agent task has exactly one owner, the journal's last owner entry (or the
  creator, with none) equals the column, and a refused call changes nothing.

### Properties

- **P1, no starvation.** A generator produces seeded command sequences over
  two lead members, both with direct mail to each other always waiting
  (enqueued at every idle moment), one group message, and clock steps of 1–5
  minutes, with `affinityWait` drawn from 0, 10, and 30 and the message
  scheduled in a third of the cases. Fixed seed 4242, 300 cases, through the
  production `MailDispatcher` plus `ProfileRouter` composition (hazard M1).
  No urgent mail and no rule. With `due = deliver_at ?? created_at`, let `T`
  be the first idle moment at or after `due + 15 min` at which the owner is
  idle, or at which `now ≥ due + wait` and some member is idle. The property:
  the message is not claimed before `due + 15 min` (direct mail is always
  waiting, G1), it is claimed at `T`, and its claimant is the owner when the
  owner is idle at `T`. Before `due + wait`, no other member claims it (G5).
- **P2, at most one claim.** Under the same generator, with replays and a
  restart between passes, no message is ever claimed by two sessions.
- **P3, one derivation.** For random states (seed 1717, 500 cases), with no
  rule or a rule that returns default: the router holds with `owner-busy`
  exactly when `ownerAffinity` gives `hold` and there are candidates (B4); it
  holds until `t` with `owner-busy` leading the no-candidate diagnosis exactly
  when it gives `hold` and there are none (B5); it picks the owner, and the dispatch preview names the owner
  first, exactly when it gives `prefer`; and the waiting reason shows
  `owner-busy` exactly when it gives `hold`. With a rule that picks or holds,
  the router follows the rule (B8, B9) and no `owner-busy` is reported.

## Risks / Trade-offs

- **[Imbalance: one lead owns the busy tasks]** → `affinityWait` bounds the
  delay, so overflow goes to any free lead, and an owner can hand tasks over
  with `task_transfer_owner`.
- **[A departed lead's mail until a takeover]** → the owner is not a live
  member, so A9 applies: mail routes by strategy with no wait. Only the
  rights wait for a takeover.
- **[Owner rights change who may close]** → for tasks never transferred the
  owner is the creator, so nothing changes until someone transfers.
- **[A wrong owner when a dev's current task is stale]** → the explicit
  `task_id` wins (R6). The worst case is a delay of at most `affinityWait`.
- **[Aging reorders conversations]** → it applies only to group mail that has
  already waited 15 minutes. Urgent direct mail is unaffected. The spec
  scenario "Direct before group at equal priority" is narrowed to fresh group
  mail and recorded as BREAKING in the proposal.
- **[Routing rules written for the old context]** → `taskOwner` is additive.
  A rule that ignores it keeps today's behavior, minus the hold, which only
  the built-in default path applies.
- **[Restart]** → the owner hold is never stored; the first pass re-derives it
  from the due time and the group's current settings. `affinity_task` persists
  with the row, and the owner is read from the task each pass. The transfer is
  one transaction. No new exclusive slot or
  recovery mechanism, so no recovery-matrix row.

## Migration Plan

- An additive nullable column, `affinity_task`, added in `messageSchema.ts`.
  Existing rows stay null and route exactly as today.
- An additive nullable column, `tasks.owner_session`, backfilled from
  `creator_session` for agent tasks in the same migration, so existing tasks
  keep their creator's rights.
- Deploy and restart. The lead group takes effect when `lead.md` carries
  `affinity`, which a group reload or restart picks up.
- **Rollback:** remove `affinity` from `lead.md`. The next dispatch pass
  routes queued and scheduled mail by the group's strategy (A9, B10), with no
  restart needed; the recorded `affinity_task` values stay as an audit trail.
  Aging has no switch, so reverting it means reverting the dispatcher commit.

## Open Questions

- Should the Mailbox row show the resolved task owner beside the recipient? This
  is display only and can follow without changing the specs.

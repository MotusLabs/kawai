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
applies. `affinityWait: 0` means prefer the owner when it is idle, never wait.

- **Rejected: always on.** Developer groups already narrow by worktree, and
  holding their mail for a busy creator would only slow them.
- **Why 30 minutes.** Lead turns in the incident ran 1 to 94 minutes, with a
  median near 5. 30 minutes covers most turns without losing a whole long one
  to idling.

### D3: One pure derivation decides prefer, hold, or fall back

A new pure function, `ownerAffinity(state)`, sits beside
`evaluateEligibility`. Its inputs are the resolved task owner, the owner member's
causes (from `memberStateCauses`, or absent when the owner is not a live
group member), the filter reasons for the owner's profile, the message's
creation time, `affinityWait`, and `now`. It returns one of:

- `prefer`: the owner is an eligible candidate;
- `hold(until)`: the owner's only causes are `busy` and/or `pending-card`, no
  filter reason applies, and `now < created + wait`;
- `none`: every other case, which falls through to the strategy.

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

1. the eligibility check;
2. if there are no candidates, the existing `none`;
3. the rule, which sees `message.taskOwner` and whose pick or hold wins;
4. the owner hold;
5. `builtinPick` with the owner preferred.

The hold is evaluated after the rule, so a rule can override it. It is
evaluated before `builtinPick`, so the default path waits for the owner.

**Re-routing.** The router's existing hold map keys holds by candidate
signature. The owner going idle changes the candidates, which ends the hold
on the next pass. The `retryAt` re-arms the dispatcher timer at the end of
the wait.

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

The liveness and group checks reuse the predicates routing uses
(`memberStateCauses` and the session's group), so a takeover is allowed
exactly when routing would no longer prefer the owner.

- **Rejected: taking over a live owner.** Two leads would race on one task;
  the live owner hands over instead.
- **Rejected: a human-only reassign.** The incident's lead replacements
  happened while the human was away; a replacing lead must recover alone.
- **Rejected: storing the owner on the message (an earlier draft of D1).**
  It cannot follow a transfer.

## Acceptance oracles

### Owner affinity (`ownerAffinity`, then routing)

Axes:

- the task owner, as resolved at route time;
- the owner's live state: eligible, only busy or awaiting a card, other cause
  (parked, context-exhausted, unavailable, startup-failed, other worktree),
  cooling, filtered (outside the role, worker choice, excluded profile), or
  not a live member;
- the wait: `now < created + wait` or not;
- other candidates: whether any other candidate is eligible;
- the rule's decision.

| Id | Task owner | Owner state | Within wait | Other candidate | Rule | Result |
|---|---|---|---|---|---|---|
| A1 | no | * | * | yes | none/default | strategy pick (unchanged) |
| A2 | yes | eligible | * | * | none/default | owner receives it |
| A3 | yes | busy or card | yes | * | none/default | hold until created+wait, `owner-busy` |
| A4 | yes | busy or card | no | yes | none/default | strategy pick among others |
| A5 | yes | busy or card | no | no | * | existing no-candidate wait; owner later takes it |
| A6 | yes | other cause | * | yes | none/default | strategy pick among others, no wait |
| A7 | yes | cooling | * | yes | none/default | another candidate, no wait |
| A8 | yes | filtered | * | yes | none/default | strategy pick among others, no wait |
| A9 | yes | not live | * | yes | none/default | strategy pick, no wait |
| A10 | yes | eligible or busy | * | yes | pick other | the rule's pick |
| A11 | yes | * | * | * | hold | the rule's hold |
| A12 | yes | eligible | * | * | default, `profile-order` | owner first despite rank |

Unreachable or excluded combinations:

- **Task owner on a group without affinity:** D1 records no affinity task.
- **Owner eligible with no candidates:** an eligible owner is a candidate.
- **`affinityWait: 0`:** within the wait is always false, so A3 cannot occur
  and A4–A5 apply.

### Group aging (dispatcher pass)

| Id | Group mail | Direct mail for the idle chosen member | Result |
|---|---|---|---|
| G1 | normal, due 5 min | normal | direct delivered first |
| G2 | normal, due ≥ 15 min | normal | group delivered first |
| G3 | normal, due ≥ 15 min | urgent | urgent direct first |
| G4 | urgent, any age | normal | group first (unchanged) |
| G5 | normal, due ≥ 15 min, owner hold active | normal | direct to the idle member; the group stays held |
| G6 | normal, due ≥ 15 min, idle owner | normal, for the owner | group to the owner first |

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
  minutes. Fixed seed 4242, 300 cases, through the production `MailDispatcher`
  plus `ProfileRouter` composition (hazard M1). The property: the group
  message is claimed no later than the first idle moment at or after
  `max(15 min, created + wait)` when the owner stays busy, or at the owner's
  first idle moment within the wait.
- **P2, at most one claim.** Under the same generator, with replays and a
  restart between passes, no message is ever claimed by two sessions.
- **P3, one derivation.** For random states (seed 1717, 500 cases), the
  router's hold or pick, the dispatch preview's first candidate, and the
  waiting reason's `owner-busy` presence all agree with `ownerAffinity`.

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
- **[Restart]** → holds are in memory and recomputed from `created_at` on the
  first pass. `affinity_task` persists with the row, and the owner is read
  from the task each pass. The transfer is one transaction. No new exclusive
  slot or recovery mechanism, so no recovery-matrix row.

## Migration Plan

- An additive nullable column, `affinity_task`, added in `messageSchema.ts`.
  Existing rows stay null and route exactly as today.
- An additive nullable column, `tasks.owner_session`, backfilled from
  `creator_session` for agent tasks in the same migration, so existing tasks
  keep their creator's rights.
- Deploy and restart. The lead group takes effect when `lead.md` carries
  `affinity`, which a group reload or restart picks up.
- **Rollback:** remove `affinity` from `lead.md` to disable affinity. Aging
  has no switch, so reverting it means reverting the dispatcher commit.

## Open Questions

- Should the Mailbox row show the resolved task owner beside the recipient? This
  is display only and can follow without changing the specs.

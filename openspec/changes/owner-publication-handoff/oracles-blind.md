# Oracles A1 — inputs only (blind reading)

Commit A1 of the blind second reading (`docs/agent-collaboration.md`,
"Write acceptance as oracles"). Every output cell reads `?`. The advisor
fills each `?` from the delta specs under `specs/` alone and cites the
scenario or requirement that decides it; where the specs do not decide a
cell, write `undecided` and say what is missing. Commit A2 adds the
author's outputs; the two readings are then diffed and resolved in
`design.md`'s tables.

Conventions: `*` is a don't-care input. `H` is the handoff under test, `T`
its task, `N` the task's revision before the command. "Refusal" outputs
name what the error message names and what is written (handoff, event,
revision, notice, revision-published fact, draft, wakeup, mail).

## Table H — handoff commands

Each command is its own partition. Inside a partition the checks run in
the order given and the first failing check decides the row. Every
partition's first two checks are: a task or handoff of another team (H4);
an unknown id (H16).

| Id | Case | Result |
| --- | --- | --- |
| H4 | the task or handoff belongs to another team | ? |
| H16 | the task or handoff id is unknown | ? |

### H-REQ — `task_request_publication`

Axes: key relation (new, replay-same, replay-different); requester right
(ok, group cannot create tasks, caller is the live owner); task status
(open, closed); base (current, behind); payload (valid, invalid); pending
handoff on the task (none, open/stale by the requester side, open/stale by
another group). Check order: team/id, key, right, status, base, payload,
pending. "Requester side" means the pending handoff's requester or a
session of its group.

| Id | First failing check, or every check passes | Result |
| --- | --- | --- |
| H10 | key replay-same (same key, same payload), including after the task moved past the base or closed | ? |
| H11 | key replay-different (same key, a different payload field) | ? |
| H5 | right: the caller's group cannot create tasks | ? |
| H6 | right: the caller is the task's live owner | ? |
| H3 | status: closed (done or cancelled) | ? |
| H2 | base: behind the task's current revision | ? |
| H7 | payload invalid (direction, acceptance, contract parse, rationale, size limits, evidence references, base commit) | ? |
| H9 | pending handoff by another group | ? |
| H8 | pending handoff by the requester side | ? |
| H1 | no pending handoff | ? |

Combined-failure inputs (each row's id is an output):

| Tuple | Matching row |
| --- | --- |
| authorized request, task closed, base behind | ? |
| new key, group cannot create tasks, task closed | ? |
| replay-same key, task closed since | ? |
| payload with both a malformed contract and an oversized rationale | ? (and the problem named: ?) |

### H-PUB — Publish prepared revision

Entry: human `team-task-handoff-publish { handoffId }` or owner
`task_amend { handoff_id }` (the prepared entry; it takes no caller key).
Axes, read from one consistent snapshot of T's revisions and H's row:

- revision facts R, the joint domain of the task-scoped association (a
  revision of T whose `handoff_id` is H.id, any request key) and the
  prepared-key row (the revision of T whose stored key is exactly
  `handoff:<H.id>`):
  - R0: no associated revision, no prepared-key row;
  - R1: no associated revision, an orphan prepared-key row;
  - R2: the associated revision is the prepared-key row;
  - R3: the associated revision carries another key, no prepared-key row;
  - R4: the associated revision carries another key, plus a separate
    orphan prepared-key row;
- publisher right (human or owner, other);
- extra fields beside `handoff_id` on `task_amend` (none, some);
- handoff state (open, stale, published, declined, withdrawn,
  superseded, closed).

Declared product: 5 × 2 × 2 × 7. Check order for tuples that match a row:
team/id, key, extra fields, right, state.

| Id | Case | Result |
| --- | --- | --- |
| H14 | R2, state `published` (a replay, including concurrent duplicates) | ? |
| H35 | extra fields on `task_amend` | ? |
| H13 | right: another agent or Kawai | ? |
| H15 | R0, state stale, declined, withdrawn, superseded or closed | ? |
| H16b | R3, state `published` (published through its linked draft) | ? |
| H12 | R0, state `open`, every check passes | ? |

Classification of the product:

| Question | Answer |
| --- | --- |
| which (R, state) pairs match an H row | ? |
| number of tuples that match an H row | ? |
| number of tuples excluded, and the U reasons of each excluded (R, state) pair | ? |

Paired witnesses (classification before the command runs):

| Tuple | U reasons | Matching row | Notes |
| --- | --- | --- | --- |
| R3, `published`, human, no extras | ? | ? | ? |
| R0, `published`, human, no extras | ? | ? | ? |
| R2, `published`, human, no extras | ? | ? | ? |
| R0, `open`, human, no extras | ? | ? | ? |
| R1, `open`, human, no extras | ? | ? | ? |
| R4, `published`, human, no extras | ? | ? | ? |
| R3, `open`, human, no extras | ? | ? | ? |
| R4, `open`, human, no extras | ? | ? | ? |

### H-DRAFT — load into draft, and publish the linked draft

Load (`team-task-handoff-load-draft`). Axes: caller (human, agent);
handoff state; draft (none, exists); `replace` (false, true). Order:
team/id, caller, state, draft/replace.

Publish the linked draft (the ordinary entry, `team-task-publish` with
`fromDraft`). Axes: the canonical key `k = requestKey?.trim() || undefined`
(ordinary, reserved `handoff:` prefix), with the raw input bare or padded;
the existing `team-task-publish` checks (ordinary key replay, rationale,
stale base); the linked handoff's state. Order: reserved prefix, then the
existing checks unchanged, then the linked state.

| Id | First failing check, or every check passes | Result |
| --- | --- | --- |
| H36 | load by an agent | ? |
| H37 | load of a handoff that is not `open` (stale or ended) | ? |
| H18 | load while a draft exists, `replace` false | ? |
| H19 | load, every check passes | ? |
| H33d | publish linked draft, `k` starts with `handoff:` | ? |
| H17r | publish linked draft, its ordinary key already names a revision | ? |
| H38s | publish linked draft, draft base no longer current (including after a prepared publish of the same handoff) | ? |
| H17 | publish linked draft, base current, handoff `open` | ? |
| H38 | publish linked draft, base current, handoff declined, withdrawn, superseded or closed | ? |

Whitespace variants for H33d (each with a draft loaded from H, H `open`):

| Raw key | Result |
| --- | --- |
| `handoff:H` | ? |
| ` handoff:H` | ? |
| `\thandoff:H\n` | ? |
| `handoff:H  ` | ? |

Cross-command traces:

| Trace | Result of the second command |
| --- | --- |
| H published through its linked draft, then **Publish prepared revision** for H | ? |
| H published through the prepared entry, then the linked draft (base H's base) is published | ? |
| linked draft edited, published with H's derived key `handoff:<H.id>` while H is `open`, then **Publish prepared revision** for H | ? |

### H-OTHER — a publication not from this handoff

Any author, the ordinary entry with no linked draft, or another
handoff's publication. Axes: the canonical key `k` (ordinary, reserved
prefix), with the raw input bare or padded with leading or trailing
whitespace (space, tab, newline); the task's pending handoff state (none,
open, stale).

| Id | Case | Result |
| --- | --- | --- |
| H33 | `k` starts with `handoff:` | ? |
| H20 | ordinary `k`, pending handoff `open` | ? |
| H21 | ordinary `k`, pending handoff `stale` | ? |
| H39 | ordinary `k`, no pending handoff | ? |

Whitespace variants (no draft, H `open`):

| Raw key | Result | H afterwards | After a restart |
| --- | --- | --- | --- |
| `handoff:H` | ? | ? | ? |
| ` handoff:H` | ? | ? | ? |
| `\thandoff:H\n` | ? | ? | ? |
| `handoff:H  ` | ? | ? | ? |
| `  ordinary-key  ` (no pending handoff), then a resend with `ordinary-key ` | ? | ? | ? |

### H-SETTLE — decline and withdraw

`task_settle_publication` (agents) and `team-task-handoff-decline`
(human). Axes: action (decline, withdraw); right (decline: human or the
task's owner session; withdraw: the requester or a session of its group);
reason (given, empty); state. Order: team/id, right, reason, state.

| Id | First failing check, or every check passes | Result |
| --- | --- | --- |
| H23 | right missing | ? |
| H23b | reason empty | ? |
| H26 | state not pending | ? |
| H22 | decline, every check passes | ? |
| H24 | withdraw, every check passes | ? |

### H-CLOSE — the task moves to `done` or `cancelled`

Any authorized path: the owner, the human, Kawai's closing, and an
override's cancellation of an earlier fix task (`prepareOverrideFix`).

| Id | Handoff state | Result |
| --- | --- | --- |
| H27 | open or stale | ? |
| H40 | published, declined, withdrawn, superseded or closed | ? |

### H-NEUTRAL — other events

| Id | Event | Result |
| --- | --- | --- |
| H28 | a decision answer, own call, or an override that does not close the handoff's task; a journal note; mail; elapsed time; archival or exhaustion of the requester, the owner or the holder; a notice retry; an acknowledgement — any handoff state | ? |
| H28b | an override that also cancels the handoff's task | ? |

### H-RESTART — startup sweep

Five declared observations per pending handoff H of task T, from one
pre-sweep snapshot:

| Observation | Values | Source |
| --- | --- | --- |
| `associationPresent` | true, false | a revision of T whose `handoff_id` is H.id, whatever its request key |
| `unassociatedReservedKeyPresent` | true, false | a revision of T whose stored `request_key` is exactly `handoff:<H.id>` and whose `handoff_id` is not H.id (null included) |
| task status | open, closed | T's status |
| base relation | current, behind | T's revision against H's `base_revision` |
| state | open, stale | H's row |

| Id | Case | Result |
| --- | --- | --- |
| H29 | `associationPresent` false, `unassociatedReservedKeyPresent` false, task open, and either `open` with a current base or `stale` | ? |

Classification of the product (2 × 2 × 2 × 2 × 2):

| Question | Answer |
| --- | --- |
| which tuples match H29 | ? |
| the U reasons of every other tuple | ? |

Paired witnesses (classification before the restart):

| Tuple | U reasons | Matching row | Sweep writes / sends |
| --- | --- | --- | --- |
| (1) both revision facts false, task open, base current, `open` | ? | ? | ? |
| (2) as (1) with `unassociatedReservedKeyPresent` true | ? | ? | ? |

Restart scenarios:

| Case | Result |
| --- | --- |
| a publication of H committed, Kawai crashed before the requester's message was sent | ? |
| an ordinary publication with a key in H's namespace was refused while H is `open` with a current base; restart | ? |
| one `open` handoff with a current base and one `declined` handoff; restart | ? |
| H became `stale` through another revision; restart, whatever keys earlier revisions carry | ? |

## Unreachable claims (U)

For each claim: is the combination reachable through the commands above
(yes/no), the reason, and which partitions evaluate it.

| Claim | Combination | Reachable | Reason | Evaluated in |
| --- | --- | --- | --- | --- |
| U1 | state `published` without an associated revision, or an associated revision with a state other than `published` | ? | ? | ? |
| U2 | two pending handoffs on one task | ? | ? | ? |
| U3 | an `open` handoff whose base is not the task's current revision | ? | ? | ? |
| U4 | an ended handoff (published, declined, withdrawn, superseded, closed) changing state | ? | ? | ? |
| U5 | a pending handoff on a closed task | ? | ? | ? |
| U6 | a revision holding `handoff:<id>` without that handoff's association | ? | ? | ? |
| U7 | a linked draft whose base is current while its handoff is `stale` or `published` | ? | ? | ? |
| W-U1 | (table W) a pending handoff on a closed task | ? | ? | ? |

## Table DF — defensive fixtures

States seeded directly into the database. For each: the classifier's
reason set and matching H row before the command, then the command's
result.

| Id | Seeded state | U reasons | Matching row | Command | Result |
| --- | --- | --- | --- | --- | --- |
| DF1 | pending handoff with an associated revision | ? | ? | startup sweep | ? |
| DF2 | pending handoff on a closed task | ? | ? | startup sweep | ? |
| DF3 | `open` handoff, task revision past its base | ? | ? | startup sweep | ? |
| DF4a | orphan reserved key (`unassociatedReservedKeyPresent` true), no association, task open, base current, `open` | ? | ? | startup sweep | ? |
| DF4b | orphan reserved key, no association, task open, base behind, `open` | ? | ? | startup sweep, then a second restart | ? (first) / ? (second) |
| DF5 | associated revision, task closed, base behind, handoff pending | ? | ? | startup sweep | ? |
| DF5o | DF5's snapshot plus a separate orphan reserved-key revision | ? | ? | startup sweep | ? |
| DF6 | revision holding `handoff:<id>` with no association (R1), handoff `open` | ? | ? | Publish prepared revision | ? |
| DF6p | R4: handoff `published` through its linked revision, plus an orphan `handoff:<id>` row | ? | ? | Publish prepared revision | ? |

Production fixture (CP3): DF3's fixture on one task beside a healthy
`open` handoff with a current base on another task; boot the production
composition (`ChatSessionManager` starting `teamMail`).

| Handoff | State after start | Mail |
| --- | --- | --- |
| DF3 fixture | ? | ? |
| healthy `open` | ? | ? |

## Wakeups

| Transition | Requester | Message count | Recipient |
| --- | --- | --- | --- |
| published | live | ? | ? |
| published | archived | ? | ? |
| declined | live | ? | ? |
| stale | archived | ? | ? |
| closed | context-exhausted | ? | ? |
| superseded | live | ? | ? |
| withdrawn | live | ? | ? |
| any transition, replayed command or second sweep | * | ? | ? |
| any transition, its message later dead-lettered | * | ? (transition kept?) | ? |

## Table W — attention for a handoff

Pending handoffs. Inputs: state, task owner liveness, requester liveness.

| Id | State | Task owner | Requester | Item | Owner | Needs human | Next action |
| --- | --- | --- | --- | --- | --- | --- | --- |
| W1 | open | live agent | * | ? | ? | ? | ? |
| W2 | open | none or gone | * | ? | ? | ? | ? |
| W3 | stale | * | live | ? | ? | ? | ? |
| W4 | stale | * | gone | ? | ? | ? | ? |

Published handoffs (published as revision P). Inputs are facts; the phase
is an output. "Claimant" is the session holding the task's claimed
assignment; "delivered" is the highest task revision carried by task mail
confirmed delivered to the claimant; "acknowledged" is the claimant's
highest acknowledged revision; "notices" are revision notices to the
claimant for revision P or later.

| Id | Task | Claimant | Acknowledged ≥ P | Delivered ≥ P | Notices | Execution owns | Phase | Item | Owner | Needs human | Next action |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| W5 | closed | * | * | * | * | * | ? | ? | ? | ? | ? |
| W6 | open | live | yes | * | any, including failed or uncertain | * | ? | ? | ? | ? | ? |
| W7 | open | none live | * | * | * | yes | ? | ? | ? | ? | ? |
| W8 | open | none live | * | * | * | no | ? | ? | ? | ? | ? |
| W12d | open | live | no | yes | a failed one | * | ? | ? | ? | ? | ? |
| W9 | open | live | no | no | one uncertain | * | ? | ? | ? | ? | ? |
| W12 | open | live | no | no | one queued, none uncertain | * | ? | ? | ? | ? | ? |
| W10 | open | live | no | no | every one failed | * | ? | ? | ? | ? | ? |
| W11 | open | live | no | no | none | * | ? | ? | ? | ? | ? |

Ended handoffs (declined, withdrawn, superseded, closed):

| Id | State | Item |
| --- | --- | --- |
| W13 | declined, withdrawn, superseded or closed | ? |

History inputs (each row's id and output are to be filled):

| History | Matching row | Item and next action | Notify / Retry notification offered |
| --- | --- | --- | --- |
| published without notify; claimant reads `task_get` and acknowledges P; no task mail carrying P delivered | ? | ? | ? |
| notice for P dead-lettered; later ordinary task mail carrying P delivered to the same claimant; not acknowledged | ? | ? | ? |
| notice for P dead-lettered; claimant then acknowledges P | ? | ? | ? |
| an older notice for P uncertain, a newer notice for P failed | ? | ? | ? |
| an older notice for P queued, a newer notice for P failed | ? | ? | ? |
| task closed before the claimant acknowledges | ? | ? | ? |
| published with notify unset, claimant live, not acknowledged | ? | ? | ? |

Notice-action parity question: for which rows does
`TaskNotices.notify` with a fresh command key write at least one new
notice row, and is **Notify** or **Retry notification** offered in exactly
those rows? Answer: ?

## Table F — fixes requested

Inputs: the failing result's submitter liveness, a live claimant of the
task's assignment, whether a running execution owns the task, the task
owner's liveness.

| Id | Submitter | Live claimant | Execution owns | Task owner | Owner | Needs human | Next action | Cause names |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F1 | live | * | * | * | ? | ? | ? | ? |
| F2 | gone | yes | * | * | ? | ? | ? | ? |
| F3 | gone | no | yes | * | ? | ? | ? | ? |
| F4 | gone | no | no | live agent | ? | ? | ? | ? |
| F5 | gone | no | no | none or gone | ? | ? | ? | ? |

## Table S — supervision and the post-Amend item

Inputs: a pending handoff on the change's task; another named wait; an
open convergence diagnosis awaiting a revision; holder and progress facts.

| Id | Pending handoff | Other named wait | Convergence awaiting revision | Other facts | Change cause | Stall | Attention for the task |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S1 | yes | no | no | none | ? | ? | ? |
| S2 | yes | yes | no | none | ? | ? | ? |
| S3 | yes | * | yes | none | ? | ? | ? |
| S4 | no | * | yes | none | ? | ? | ? |
| S5 | no | no | no | holder archived, no progress past the deadline | ? | ? | ? |
| S6 | * | * | no | repeating failure | ? | ? | ? |

Execution limits with a pending handoff (parallel limit 2, two running
changes, one with an open handoff on its task):

| Question | Answer |
| --- | --- |
| both running changes count toward the limit | ? |
| a third change's state | ? |
| dependents of the change with the handoff | ? |
| the landing slot holder | ? |

Transitions (observed on the supervision read and the dispatched mail):

| Id | From | Event | Result |
| --- | --- | --- | --- |
| S7 | S1 | the handoff is published | ? |
| S8 | S3 | the handoff is published as revision N | ? |
| S9 | S1 | the handoff becomes stale | ? |
| S10 | S1 | the handoff ends (declined, withdrawn, closed) | ? |

## Agent reads

| Case | Result |
| --- | --- |
| the holder calls `task_get` while H is `open` | ? (rows shown, direction shown) |
| `task_get` with `handoff_id` of another team's handoff | ? |
| task mail delivered to the holder while a handoff for revision 2 is `open` | ? (delivered direction, handoff mention) |
| the human has a saved draft; an agent records a handoff for the task | ? (draft afterwards) |

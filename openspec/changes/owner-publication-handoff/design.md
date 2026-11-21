# Design

## Context

See proposal.md, "Why". The facts the design builds on, from the current
sources:

- `TaskService.publish` (`src/server/team/TaskService.ts`) is the one
  publication path. It refuses Kawai (`revisionPublisher`), refuses an agent
  that is not the task's owner, parses the contract before writing, and
  calls `TaskStore.publish` with a `within` callback that re-maps findings
  and writes revision notices in the revision's transaction. The partial
  unique index on `team_task_revisions (task_id, request_key)`
  (`taskRevisionSchema.ts`) arbitrates replays and concurrent duplicates.
- Drafts (`taskDrafts.ts`) are one per task, human-only, and invisible to
  agents; `TaskDirectionEditor.tsx` publishes them with a base revision, a
  rationale, and **Publish and notify**.
- Tasks Kawai or the human created have no owner (team-tasks, "Tasks have
  an owner"), so for them only the human publishes.
- `DecisionService.answer` records a decision and sends mail; an answered
  card leaves the queue (`planAttention.ts`, `decisionQuestionItems`).
- The only owner-publication attention item is `amendItems`, raised for a
  convergence stall whose diagnosis awaits a revision.
- Fixes-requested items are owned by the result's submitter
  (`attentionAcceptance.ts`), whether or not that session is live.
- Supervision waits are an append-only list (`src/shared/planSupervision.ts`,
  `stageWaits`); a named wait suppresses the `no-progress` stall, and
  `HolderFacts.gone` already marks an archived holder.
- `convergenceNotice.ts` shows the established way Kawai sends a system
  message inside a domain transaction, keyed so a replay sends nothing.

## Goals / Non-Goals

**Goals:**
- One typed record that carries a prepared revision from an agent to the
  party who may publish it, with exact provenance, and one publish action.
- A single derived phase per handoff that attention, supervision and
  `task_get` all read, so the readers cannot disagree.
- Exactly-once publication, exactly-once wakeups, and restart safety built
  on the transactions and keys the publication path already has.

**Non-Goals:**
- Changing who may publish, approve plans, Stop, Retry, or accept results.
- Publishing from a decision answer, a note, or mail; interpreting prose.
- Backfilling handoffs from existing cards, notes, receipts or private files;
  amending any existing task or plan; resolving existing publication gates.
- Changing max-parallel, dependency, landing-slot or dispatch behavior.

## Decisions

### D1. A dedicated handoff record, not a draft, card, or widened right

New tables (additive, in a new `taskHandoffSchema.ts` migrated from
`TaskStore`'s constructor beside `migrateRevisionSchema`):

- `team_task_handoffs`: `id`, `team_id`, `task_id`, `base_revision`,
  `base_contract_hash` (null without a contract), `direction`,
  `acceptance`, `contract_text`, `rationale`, `notify`, `payload_hash`,
  `base_commit`, `evidence_refs` (JSON array), `requester_session`,
  `requester_group`, `request_key`, `state`, `state_reason`,
  `state_actor_kind`, `state_actor_session`, `published_revision`,
  `published_payload_hash`, `superseded_by`, `created_at`, `updated_at`.
  Unique `(task_id, request_key)`; partial unique index
  `(task_id) WHERE state IN ('open','stale')` enforces one pending handoff.
- `team_task_handoff_events`: append-only transitions (`handoff_id`,
  `seq`, `from_state`, `to_state`, `actor`, `reason`, `revision`, `at`).
- `team_task_handoff_wakeups`: `(handoff_id, transition)` primary key and
  the mailbox `message_id`.
- `team_task_drafts.handoff_id` (nullable column) links a draft loaded
  from a handoff.

Alternatives: (a) write the prepared content into the human's draft —
rejected: one draft per task, human-private, an agent write would clobber
the human's text and the draft is invisible to agents and Attention;
(b) attach the payload to a decision card — rejected: cards are plan-only,
an answer is prose, and the observed failure is exactly a card answer that
published nothing; (c) let Lead sessions publish unowned tasks — rejected:
it removes the human's publication authority (I1 of the contract below).

### D2. Rights: who requests, who publishes, who settles

- **Request:** an agent session whose group has `canCreateTasks`, on a
  task of its team, that is not the task's live owner (the owner uses
  `task_amend`). The right is "may author directions", the same right that
  lets a Lead write tasks; developers keep notes and mail.
- **Publish / Decline:** exactly the parties `TaskService.publish`
  accepts — the human, or the task's owner session. No new right.
- **Withdraw / supersede:** the requester, or a session of the
  requester's group (so a replacement Lead can continue after the
  original Lead is archived).

Alternative: any team agent may request — rejected: it lets the reviewer
or developer whose work the correction judges prepare its own contract.

### D3. Publishing reuses `TaskService.publish` under a derived key

`TaskPublishInput` gains `handoffId`. **Publish prepared revision** (human
command `team-task-handoff-publish`; owner `task_amend { handoff_id }`)
calls `publish` with the handoff's prepared fields, `baseRevision` =
`base_revision`, `notify` = the handoff's choice, and
`requestKey = 'handoff:' + id`. Inside the `within` callback the handoff
row is re-read and must still be `open`; it moves to `published` with the
new revision and writes its event and wakeup rows. Everything — revision,
notices, findings re-map, handoff transition, wakeup mail — commits or
rolls back together. A replay hits the unique request key and returns the
prior revision; the handoff is already `published` with that revision, so
nothing else is written (H14). `task_amend` with `handoff_id` refuses any
direction, acceptance or contract argument beside it.

**Edit before publishing** copies the handoff into the draft
(`team-task-handoff-load-draft`, requiring `replace: true` when a draft
exists) and sets `handoff_id`. Publishing that draft passes `handoffId`;
the handoff becomes `published` with `published_payload_hash` set to the
published payload's hash, shown as "published as edited" when it differs.

### D4. Every publication path checks pending handoffs in its transaction

The stale transition lives in `TaskStore.publish`, not in `TaskService`,
so the human form, `task_amend`, a handoff publication and any future
path cannot bypass it (oracle hazard "Several readers disagreeing on
derived state"). After inserting revision N, a pending handoff of the
task that this publication does not fulfill moves `open → stale` naming N
(a `stale` one stays stale; its wakeup is keyed once). Closing the task —
every `done`/`cancelled` transition, including Kawai's — moves a pending
handoff to `closed` in the status transaction (`TaskService.setStatus`'s
transaction, beside `onStatusTransition`).

### D5. States, and one derived follow-up phase

Stored state: `open`, `stale`, `published`, `declined`, `withdrawn`,
`superseded`, `closed`. Only `open` and `stale` are pending; the rest are
terminal and immutable.

The follow-up phase of a `published` handoff is derived at read time by
one pure function, `handoffPhase(handoff, task, publicationDetail,
holder, executionOwns)` in `src/shared/taskHandoffs.ts`, from the facts
the publication detail already shows (notice state, delivered and
acknowledged revision per holder) and holder liveness:
`no-holder` > `notice-failed` > `not-notified` > `awaiting-ack` >
`acknowledged`. Attention, the supervision loader and `task_get` all call
it. Nothing new is stored for notice or acknowledgement, so restart has
nothing to reconcile for it.

### D6. Wakeups are system mail written in the transition's transaction

Each of `published`, `declined`, `stale`, `closed` inserts
`team_task_handoff_wakeups (handoff_id, transition)` and enqueues one
system message (as `convergenceNotice.ts` does) in the same transaction.
The recipient is resolved at the transition: the requester session if it
is live (not archived, killed, or context-exhausted), else the
requester's group as group mail, so an archived session is not revived by
direct mail. The primary key makes a replay or a second sweep a no-op.
`superseded` and `withdrawn` are the requester side's own acts and wake
nobody. A later dead-letter of that mail is the mailbox's ordinary
failure, visible in the Mailbox tab; it never rolls back the transition.

Alternative: an after-commit outbox — rejected: it needs its own
recovery, while the in-transaction write is the pattern the codebase
already trusts for revision notices.

### D7. Startup reconciliation

At startup, one idempotent sweep reads pending handoffs and applies, in
this order: a revision whose `request_key` is `handoff:<id>` exists →
`published` (defensive; D3 makes it unreachable); the task is
`done`/`cancelled` → `closed`; the task's revision exceeds the base and
the handoff is `open` → `stale`. Each applies with its wakeup row, so the
sweep sends a message only for a transition it performs. This is a
recovery mechanism, so it adds its `docs/recovery-matrix.md` row. It holds
no exclusive slot, so no liveness predicate is needed.

### D8. Attention sources

A new `src/server/team/handoffAttention.ts` source produces one
`publication-handoff` item per pending handoff and one
`publication-follow-up` item per published handoff whose phase is not
`acknowledged`, per tables W. `AttentionOwner` gains the kind `kawai`
(label "Kawai"); an unknown owner kind already renders by label.
`amendItems` skips a task with a pending handoff (plan-supervision delta).
`attentionAcceptance.ts` resolves a failing result's owner per table F,
using the session directory's liveness and the execution ownership the
workspace read already has. Links target the task with a `handoffId`
anchor (`attentionLinks.ts`).

### D9. Supervision

`SupervisionInput` gains `handoff: { id, state, baseRevision, nextActor }
| null`, filled by the supervision loader from the task's pending handoff.
`stageWaits` appends `{ kind: 'owner-publication', handoffId, state,
baseRevision, nextActor }` last (the append-only rule), so an earlier wait
remains the cause and this one is listed as also applying. The stall item
and the report add `holderGone` from `HolderFacts.gone`. Nothing reads the
new wait in the scheduler, so parallel counts, dependencies and the
landing slot are untouched (P5 checks it).

### D10. Agent surface

- `task_request_publication(task_id, base_revision, rationale, direction?,
  acceptance?, contract?, notify = true, base_commit?, evidence_refs?,
  request_key)`; allowed without approval cards, like `task_note`.
- `task_settle_publication(handoff_id, action: 'withdraw' | 'decline',
  reason)`; decline only for the task's owner session.
- `task_amend` gains `handoff_id` (D3).
- `task_get` gains `handoffs` rows (bounded, newest 20) and
  `handoff_id` for one whole handoff.
- Delivered task context names a pending handoff in one line, never its
  text as the direction.
- The team prompt and the `decision_ask` description say: to have a
  task revision published, use `task_request_publication`; a card answer
  publishes nothing.

Limits: direction, acceptance, contract and rationale up to 64 KiB each;
up to 20 evidence references of up to 512 bytes, each a repository-
relative path (no leading `/`, no `..`), a task, note, result or message
id, or a commit id. A base commit must be 40 hex digits and pass
`git cat-file -e <sha>^{commit}` in the task's worktree, else the team
repository (spawned with `cleanGitEnv`). `payload_hash` is the SHA-256 of
the canonical JSON of the prepared fields and notify choice, shown as its
first 12 hex digits.

### D11. Human surface

`TeamTaskDetail.tsx` shows a handoff panel above the direction: requester,
base revision and contract identity, base commit, evidence, the diff
against the base revision (the editor's existing diff and contract parse
view), and three actions — **Publish prepared revision** (labelled
**Publish and notify** when notify is set), **Edit before publishing**,
**Decline** (reason required). The three WS commands join the router
whitelist and `chatConnectionTypes.ts`. Each carries a client command key;
a resend replays.

### D12. No backfill, no new gate

Existing tasks start with no handoffs. Nothing derives a handoff from
cards, notes, receipts or files, and no plan validation or gate reads
handoffs, so existing publication decisions stay independent (contract
I3).

## Acceptance oracles

All tables judge observable results: stored rows read through the
service, tool results, the workspace snapshot, the supervision read, and
mailbox rows. `*` is a don't-care.

### Table H — handoff commands

Axes: command; handoff state before (`none`, `open`, `stale`, `published`,
terminal-other = `declined`/`withdrawn`/`superseded`/`closed`); actor's
right for the command (yes/no); validity (base current, task open, same
team, payload valid); key relation (new, replay-same, replay-different).

| Id | Command | State before | Right | Validity / key | Result |
| --- | --- | --- | --- | --- | --- |
| H1 | request | none | yes | valid, new | handoff `open`; task revision unchanged; no notice, fact or mail |
| H2 | request | * | yes | base not current | refused naming current revision; nothing written |
| H3 | request | * | yes | task done/cancelled | refused naming status; nothing written |
| H4 | request | * | * | foreign team | same not-found as unknown id; nothing written |
| H5 | request | * | no (group cannot create tasks) | * | refused suggesting `task_note`/message; nothing written |
| H6 | request | * | no (caller is live owner) | * | refused naming `task_amend`; nothing written |
| H7 | request | * | yes | bad contract, empty, oversize, bad ref, unknown commit | refused naming the problem; nothing written |
| H8 | request | open/stale | yes, same requester or group | valid, new | old `superseded` by new; new `open`; no wakeup |
| H9 | request | open/stale | yes, other group | valid, new | refused naming pending handoff and requester |
| H10 | request | * | yes | replay-same | returns existing handoff; nothing written |
| H11 | request | * | yes | replay-different | refused naming differing field; nothing written |
| H12 | publish-prepared | open | yes | base current, new key | revision N+1 with prepared fields; `published`; notices iff notify; one fact; one wakeup `published` |
| H13 | publish-prepared | open | no (other agent, Kawai) | * | refused as publication is; unchanged |
| H14 | publish-prepared | published | yes | replay-same (incl. concurrent) | same revision returned; no revision, notice, fact or mail written |
| H15 | publish-prepared | stale/terminal-other | yes | * | refused naming state |
| H16 | publish-prepared | none | * | unknown id | not found |
| H17 | publish edited draft | open | yes | draft linked | revision N+1 with edited fields; `published` as edited; both hashes; one wakeup |
| H18 | load into draft | open/stale | human | draft exists, not confirmed | refused; draft and handoff unchanged |
| H19 | load into draft | open | human | confirmed or no draft | draft holds prepared fields, linked; handoff `open` |
| H20 | other publication | open | * | * | `stale` naming the new revision; one wakeup `stale` |
| H21 | other publication | stale | * | * | stays `stale`, newest revision shown; no second wakeup |
| H22 | decline | open/stale | yes (human/owner), reason | * | `declined` with reason and actor; one wakeup `declined` |
| H23 | decline | open/stale | no, or no reason | * | refused; unchanged |
| H24 | withdraw | open/stale | yes (requester side), reason | * | `withdrawn`; no wakeup |
| H25 | withdraw | open/stale | no | * | refused; unchanged |
| H26 | settle (decline/withdraw) | published/terminal-other | * | * | refused naming state |
| H27 | task closed | open/stale | * | * | `closed`; one wakeup `closed` |
| H28 | neutral event (card answer/decision/override, note, mail, time, archive, exhaustion) | * | * | * | handoff rows unchanged; task revision unchanged |
| H29 | restart | consistent | * | * | nothing changes; no mail |
| H30 | restart | open, task revision > base | * | * | `stale` once with its wakeup |
| H31 | restart | open/stale, task closed | * | * | `closed` once with its wakeup |

Unreachable, with reasons:

- U1: `published` without a revision keyed `handoff:<id>` and vice versa —
  D3 writes both in one transaction (H30's defensive branch in D7 still
  has its own test).
- U2: two pending handoffs on one task — the partial unique index refuses
  the second insert; H8 supersedes in the inserting transaction.
- U3: publish-prepared of an `open` handoff whose base is not current —
  D4 makes it `stale` in the transaction that advanced the revision.
- U4: a terminal handoff changing state — every transition's `UPDATE`
  is guarded by `state IN ('open','stale')`.

Completeness claim: every combination of (command × state before × right
× validity/key) matches exactly one row of H1–H31 or one of U1–U4, with
refusals checked in the order foreign team, unknown id, right, state,
validity, key. The completeness test expands the axes, applies that
order, and fails on a gap or an overlap.

### Table W — attention for a handoff

| Id | Phase | Task owner | Requester | Execution owns | Item kind | Owner | Needs human | Next action |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| W1 | open | live agent | * | * | publication-handoff | owner session | no | Publish prepared revision |
| W2 | open | none or gone | * | * | publication-handoff | human | yes | Publish prepared revision |
| W3 | stale | * | live | * | publication-handoff | requester session | no | Re-prepare or withdraw |
| W4 | stale | * | gone | * | publication-handoff | requester group | no | Re-prepare or withdraw |
| W5 | published: no-holder | * | * | yes | publication-follow-up | Kawai | no | Wait for Kawai |
| W6 | published: no-holder | * | * | no | publication-follow-up | human | yes | Hand off the task |
| W7 | published: notice-failed | * | * | * | publication-follow-up | human | yes | Retry notification |
| W8 | published: not-notified | * | * | * | publication-follow-up | human | yes | Notify |
| W9 | published: awaiting-ack | * | * | * | publication-follow-up | holder session | no | Wait for acknowledgement |
| W10 | published: acknowledged | * | * | * | none | — | — | — |
| W11 | declined/withdrawn/superseded/closed | * | * | * | none | — | — | — |

The phases are `handoffPhase`'s precedence (D5), so each published
handoff has exactly one phase. Unreachable: W-U1, `open` or `stale` on a
closed task (D4).

### Table F — fixes requested

| Id | Submitter | Live claimant | Execution owns | Task owner | Owner | Needs human | Next action |
| --- | --- | --- | --- | --- | --- | --- | --- |
| F1 | live | * | * | * | submitter | no | Wait for fixes |
| F2 | gone | yes | * | * | claimant | no | Wait for fixes |
| F3 | gone | no | yes | * | Kawai | no | Wait for Kawai to dispatch the fix |
| F4 | gone | no | no | live agent | task owner | no | Hand off for fixes |
| F5 | gone | no | no | none or gone | human | yes | Hand off for fixes |

F2–F5 name the submitter as archived and, in F3–F5, no session running
the task.

### Table S — supervision and the post-Amend item

| Id | Pending handoff | Other named wait | Convergence awaiting revision | Change cause | Stall | Attention for the task |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | yes | no | no | owner-publication | none | handoff item only |
| S2 | yes | yes | no | the other wait; owner-publication also applying | none | handoff item and the other wait's item |
| S3 | yes | * | yes | convergence stall (unchanged precedence) | convergence | handoff item only (no **Publish a task revision**) |
| S4 | no | * | yes | convergence stall | convergence | **Publish a task revision** (unchanged) |
| S5 | no | no | no, holder gone, no progress past deadline | no-progress stall | no-progress, holder named gone | Lead role's **Unblock the holder** naming the holder archived |

A `repeating-failure` stall keeps its precedence over any wait, with or
without a handoff (unchanged; row S6 asserts it).

### Properties

Each runs through `propertyCases(CASES)` on a fresh `freshTestDatabase`
with the real `TaskStore`, `TaskService`, `TeamMailbox` and workspace read;
generators use the existing `mulberry32` helper (`src/shared/__tests__/contractFixtures.ts`), no new dependency.

- **P1 exactly once.** Seeded command sequences over request, re-request,
  publish-prepared (1–3 duplicates, some concurrent through
  `Promise.all`), edit-and-publish, other publication, decline, withdraw,
  close, neutral events, and restart. Invariant: per handoff at most one
  revision keyed `handoff:<id>`; `published` iff exactly one such revision;
  at most one wakeup row and one mailbox row per (handoff, transition); at
  most one notice per holder per revision. Seed `0x0A11CE01`, 400 cases.
- **P2 visibility.** Same generator; after every command the workspace
  snapshot holds exactly the items table W predicts from the model state
  (the table is the reference model), and no pending handoff of an open
  task is absent. Seed `0x0A11CE02`, 400 cases.
- **P3 no authority from neutral events.** Interleave H28's events among
  the others; the digest of every handoff row, every revision row and the
  task's revision is identical to the same sequence with them removed.
  Seed `0x0A11CE03`, 200 cases.
- **P4 crash recovery.** Model-based: the H table is the reference model;
  sequences include a crash at each transaction boundary (the request
  insert, the publish transaction, the status transaction, the reconcile
  sweep) by throwing inside the transaction (rollback) or immediately
  after commit (before post-commit announce and recipient restore), then
  reopening the database and running startup reconciliation. Every stored
  state equals the model's, and P1's counts hold. Seed `0x0A11CE04`,
  200 cases.
- **P5 limits unchanged.** Seeded plans with parallel limits, dependencies
  and a landing slot, run through the supervision derivation and the
  scheduler's admission with and without random handoffs on running
  changes' tasks: admitted changes, parallel counts, dependency waits and
  the slot holder are identical. Seed `0x0A11CE05`, 200 cases.
- **P6 one derivation.** For random handoff and publication states,
  attention, the supervision loader and `task_get` report the same phase
  and next actor (each reader gets its own row over `handoffPhase`).
  Seed `0x0A11CE06`, 200 cases.

### Mutation controls

Each named mutant must make at least one cited oracle fail; tasks name
which.

- MU1 the publish key is random instead of `handoff:<id>` (H14, P1).
- MU2 the stale transition is removed from `TaskStore.publish` (H20, P2).
- MU3 the handoff transition runs after the publish commit (P4).
- MU4 the publisher check accepts any agent of the team (H13).
- MU5 deciding a card that mentions a handoff publishes it (H28, P3).
- MU6 the attention source keeps only `open` (W3, W4).
- MU7 liveness always reads live (W2, F2–F5, D6 recipient row).
- MU8 `owner-publication` is not appended in `stageWaits` (S1).
- MU9 the request tool is not registered in the team tool server, and
  separately the publish command is missing from the WS whitelist (CP1).
- MU10 the wakeup primary key is dropped (P1, H14).
- MU11 the supervision wait frees the change's parallel slot (P5).
- MU12 `amendItems` is not suppressed for a pending handoff (S3).
- MU13 the close hook is missing from the status transaction (H27).
- MU14 the replay check compares only the unique key, not the surrounding
  rows (H10/H14 snapshot rows; oracle hazard "An idempotence oracle
  observing only the uniquely constrained row").

### Production-composition checkpoints

- **CP1** (before expanding beyond the request and publish path): through
  the real chat-session composition's `kawai-team` tool server, a Lead
  session calls `task_request_publication` on a Kawai-created task; the
  team workspace snapshot over the real WS connection shows W2; the
  human's `team-task-handoff-publish` over the same connection publishes
  revision 2, queues one notice to the claimed holder and one message to
  the requester; a resent command replays. Failure path: a stale-base
  request is refused through the same tool server. Mutant: MU9.
- **CP2** (before attention and supervision polish): through the real
  supervision monitor and loader, a change whose holder is archived and
  whose task has an open handoff reads `owner-publication`, raises no
  stall-alert row, and the workspace shows W2 and no Lead stall item.
  Mutant: MU8.

## Risks / Trade-offs

- [A Lead prepares many handoffs that the human ignores] → one pending
  handoff per task, and each is a single queue item with the base revision
  and requester, not a mail stream.
- [Group mail wakes a different Lead than the requester] → it carries the
  handoff id, task, transition and revision, so any group member can
  continue from `task_get`.
- [`kawai` as an attention owner may be misread as "nothing to do"] → it
  is used only where a running execution owns the next dispatch (W5, F3),
  the case the existing task row already calls Wait for Kawai.
- [Stale handoffs accumulate after quick human edits] → stale returns the
  item to the requester side with Re-prepare or withdraw, and closing the
  task ends it.
- [Base commit checks spawn git] → only when a commit is given, with
  `cleanGitEnv` and a timeout; an unresolvable commit is refused, never
  stored as unverified.

- [Relation to the in-flight `team-workspace-redesign` change] → its
  Today view lists attention items by kind and falls back to the source
  link for a kind without an inline control, so the two new kinds work
  there unchanged; neither change orders the other, and an inline publish
  control on Today would reuse D11's commands.
- [Relation to `delivery-outcome-metrics` and `fix-team-document-scroll`]
  → both only add `team-workspace` requirements; none modifies the
  requirement this change modifies.

## Migration Plan

Additive tables and one nullable draft column, created idempotently at
store construction; no existing row changes. Rollback: the older build
ignores the new tables and column; handoffs then sit unread, and their
tasks keep publishing through the existing paths.

## Implementation contract

### Acceptance
- A1: `task_request_publication` records one `open` handoff per table H rows H1–H11, with exact provenance (task, base revision and contract identity, requester, payload hash, base commit, evidence) and no revision, notice, fact or mail.
- A2: **Publish prepared revision** (human command and owner `task_amend { handoff_id }`) publishes exactly one revision through `TaskService.publish` under key `handoff:<id>` with the prepared fields, notices per notify, and the handoff `published`, per H12–H19.
- A3: Every publication not from a pending handoff makes it `stale`, every task close makes it `closed`, decline and withdraw end it with reason and actor, and neutral events change nothing, per H20–H28.
- A4: Startup reconciliation applies H29–H31 once and adds its row to `docs/recovery-matrix.md`.
- A5: Each `published`, `declined`, `stale` and `closed` transition enqueues exactly one system message to the live requester, else its group, in the transition's transaction.
- A6: The workspace attention snapshot matches tables W and F, and the post-Amend item is suppressed per S3.
- A7: Supervision lists `owner-publication` per S1–S2 and names a gone holder per S5, with parallel counts, dependencies and landing slot unchanged (P5).
- A8: `task_get` shows handoff rows and one handoff whole, team-scoped; delivered task context names a pending handoff without using its text as the direction.
- A9: The task detail shows the handoff panel with diff, provenance and the three actions; the agent guidance names `task_request_publication` and states that a card answer publishes nothing.

### Invariants
- I1: Only the human or the task's owner session publishes or declines; Kawai, other agents, a card answer, mail, a note, elapsed time, a restart or an archival never publish or settle a handoff.
- I2: A handoff is published at most once, and each transition sends at most one wakeup, across replays, concurrency and crashes (P1, P4).
- I3: No existing task, revision, card, decision, plan, receipt or publication gate is backfilled or changed; plan validation reads no handoff.
- I4: Execution ownership, Stop/Retry, acceptance, max-parallel, dependency and landing-slot behavior are unchanged (P5).
- I5: Attention, supervision and `task_get` derive a handoff's phase from one function (P6).

### Scope
- `src/server/team/taskHandoff*.ts`
- `src/server/team/handoffAttention.ts`
- `src/server/team/TaskService.ts`
- `src/server/team/taskStore.ts`
- `src/server/team/taskDrafts.ts`
- `src/server/team/taskRevisionSchema.ts`
- `src/server/team/taskTools.ts`
- `src/server/team/taskConnections.ts`
- `src/server/team/taskContext.ts`
- `src/server/team/taskReadWindows.ts`
- `src/server/team/teamPrompt.ts`
- `src/server/team/workspaceRead.ts`
- `src/server/team/attentionAcceptance.ts`
- `src/server/team/planAttention.ts`
- `src/server/plans/supervision/**`
- `src/server/plans/decisions/decisionTools.ts`
- `src/server/chat/chatConnectionTypes.ts`
- `src/server/chat/ChatSessionManager.ts`
- `src/shared/taskHandoffs.ts`
- `src/shared/planSupervision.ts`
- `src/shared/teamTasks.ts`
- `src/shared/teamWorkspace.ts`
- `src/shared/types.ts`
- `src/client/components/team/TaskPublicationHandoff*.tsx`
- `src/client/components/team/TeamTaskDetail.tsx`
- `src/client/components/team/TaskDirectionEditor.tsx`
- `src/client/components/team/TeamAttentionQueue.tsx`
- `src/client/components/team/attentionLinks.ts`
- `src/client/stores/teamTaskStore.ts`
- `src/server/__tests__/**`
- `src/client/__tests__/**`
- `docs/architecture/tasks.md`
- `docs/architecture/team-page.md`
- `docs/architecture/plan-supervision.md`
- `docs/recovery-matrix.md`
- `docs/oracle-hazards.md`
- `openspec/changes/owner-publication-handoff/**`

### Verification
- V1: Tables H, W, F and S are committed verbatim as table-driven tests beside the code they cover, with H's completeness test expanding its axes against H1–H31 and U1–U4.
- V2: P1–P6 run with the stated seeds and case counts through `propertyCases`; P4 runs the H table as the reference model with a crash at each named transaction boundary.
- V3: Each mutant MU1–MU14 is applied once and makes its cited oracle fail; the result maps each oracle id to a test title and a killed mutant.
- V4: CP1 and CP2 pass through the production composition before the work expands past them, with their failure paths.
- V5: The blind oracle reading (inputs-only commit, a cross-model advisor's outputs, author's outputs, resolved diff) is journaled and bound by the Lead before production code.
- V6: `bun run check` passes on the clean committed head with the pinned Bun, and `scripts/verify-result.ts` runs on the submitted commit; UI changes are verified in a real browser against a disposable server and database.

### Excluded
- X1: No change to who may publish, approve, Stop, Retry or accept; no Lead publication right for unowned tasks.
- X2: No backfill from existing cards, notes, receipts or private evidence, and no amendment of existing tasks or plans.
- X3: No parsing of decision answers, notes or mail into publications.
- X4: No change to scheduler admission, parallel limits, dependencies or the landing slot.
- X5: No main-spec sync or archive in the implementation task; that is the archive step's.

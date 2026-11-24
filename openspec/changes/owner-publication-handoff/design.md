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

The schema is one new numbered migration, `taskHandoffMigration` in a
new `src/server/team/taskHandoffSchema.ts`, appended to `MIGRATIONS` in
`src/server/dbSafety/migrations.ts` (the next dense version after the last
entry at implementation time). It is never added to the frozen baseline
(`baseline.ts`, `ensureTaskSchema`) or to a store constructor: stores never
create their own tables (`docs/architecture/database.md`), and the
migration runner takes the `pre-migration-<n>` backup and applies `up` and
its version row in one transaction. Additive, no backfill:

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
  from a handoff, beside a nullable server-owned draft identity column
  (the lineage marker of D3's draft provenance); both are set by a load
  and cleared together.
- `team_task_revisions.handoff_id` (nullable column, partial unique index
  `(handoff_id) WHERE handoff_id IS NOT NULL`): the server-written
  association between a revision and the handoff it fulfilled (D3). It is
  the only proof of fulfillment; older revisions read null.

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
  accepts — the human, or the task's current live owner session. No new
  right.
- **Withdraw / supersede:** the requester, or a session of the
  requester's group (so a replacement Lead can continue after the
  original Lead is archived).

Rights come before replay. `TaskService.publish` already checks ownership
before a store-level key replay can return anything, and both handoff
commands keep that order: a request key or a prepared key is never
authority. A request checks team scope and identity, refuses the live
owner (pointing to `task_amend`), then checks `canCreateTasks`; only an
eligible requester reaches the replay lookup (H-REQ). A request-key match
is a replay only for the original requester or a session of its recorded
group (the requester side) with the same payload; another requester side
using the key is refused without the earlier handoff being returned. A
prepared publish checks scope, then the caller's current publication
right, then refuses payload overrides, and only then reads replay and
state (H-PUB): a former owner after an ownership transfer, an unrelated
agent and Kawai are refused even when the handoff was already published,
and never receive the revision. Task closure through an authorized
status change and D7's reconciliation of already-persisted facts are the
only other paths that end a handoff; decisions, archival, mail and time
are not.

Alternatives: any team agent may request — rejected: it lets the reviewer
or developer whose work the correction judges prepare its own contract.
Replay before rights — rejected: a guessed or leaked key would return a
handoff or revision to a party with no right to it.

### D3. Publishing reuses `TaskService.publish`; fulfillment is a server-written association

Invariant: a handoff is fulfilled only by a revision whose row the
handoff transaction wrote with that handoff's id. A request key, a
matching payload, or both never prove fulfillment (findings-6e7d3c2c F1:
`TaskStore.publish` resolves a matching key before the base check and
before `within`, so a key alone cannot show the handoff transaction ran).

Command origin and draft association are separate facts
(findings-0854c403 F1). The origin decides the key namespace; the
association decides fulfillment; neither is inferred from the other.

`TaskService` keeps one internal publication routine that takes a
server-internal `handoffId` and key, and exposes two entries over it:

- the **ordinary entry** `publish(input)` — `team-task-publish` (with or
  without a linked draft) and `task_amend` without `handoff_id`. Its first
  step computes the canonical key once, exactly as `TaskService.publish`
  does today: `k = input.requestKey?.trim() || undefined` (no case
  folding or other normalization; an empty or blank key stays "no key").
  It refuses `k` when it starts with `handoff:`, after the connection's
  normal team-scope resolution and before anything else: before the WS
  handler's rationale guard (`taskConnections.ts` checks
  `rationale.trim()` before calling the service, so the canonical check
  moves ahead of it), before it reads the addressed task, the draft or any
  handoff, looks up a replay, or writes anything (H33, H33d); so
  ` handoff:H`, `\thandoff:H\n` and `handoff:H  ` are refused like
  `handoff:H`, and a reserved key with a blank rationale, an unknown task
  or a stale base reads the reserved-key refusal (mixed-error rows). The
  same `k` is then the only value used for replay lookup and storage: the
  raw input is never classified, looked up or stored. There is no
  exemption: a linked draft's association never widens what key the
  caller may send. After that check the existing checks run unchanged
  (rationale, actor, team, owner, content, then the store's same-payload
  replay or differing-field refusal); only then does it read the draft's
  `handoff_id` (never the client payload) and pass it as `handoffId`,
  with `k`.
- the **prepared entry** `publishHandoff(handoffId, actor)` — human
  command `team-task-handoff-publish { handoffId }` and owner
  `task_amend { handoff_id }`. It takes no caller key: it builds
  `handoff:<id>` itself. Its order is: team scope and handoff identity
  (H4, H16); the caller's current publication right — the human or the
  task's current live owner (H13); prepared payload overrides refused —
  on `task_amend` only `task_id` and `handoff_id` are accepted, so a
  direction, acceptance, contract, rationale or notify argument beside
  `handoff_id` is refused (H35; the transport's own addressing and command
  key are not payload); then the replay and state checks. Only then does
  it re-read the handoff and call the routine with the prepared fields,
  `baseRevision` = `base_revision`, `notify` = its choice and
  `handoffId`.

Inside `within` the handoff row is re-read and must still be `open`; the
revision row gets `handoff_id`, the handoff moves to `published` with the
new revision, and its event and wakeup rows are written. Revision,
association, notices, findings re-map, transition and wakeup mail commit
or roll back together.

Key namespaces are disjoint: every key the prepared entry writes starts
with `handoff:`, and no key the ordinary entry accepts does, so neither
command can replay the other's revision. A replay of the prepared command
resolves through `resolveKey` to the revision whose `handoff_id` is this
handoff (H14), and only for a caller that passed the right and override
checks: the human and the current owner each receive the original
revision with every row unchanged, while a former owner, an unrelated
agent or an extra-field resend is refused (H13, H35). The store's
unique-constraint catch path and every repeated call apply the same
authorization and association rule: a key row is returned only when its
`handoff_id` is this handoff (R2), never an orphan (R1, R4) and never an
ordinary linked revision (R3, H16b). Whether a handoff has an associated revision is one
task-scoped fact, read the same way by every reader (H-PUB, H-RESTART,
U1): a revision of the task whose `handoff_id` is this handoff, whatever
its request key. The prepared-key lookup is a separate fact used only as
replay and orphan evidence, never to infer association. A prepared
publish after the handoff was published through its linked draft finds no
revision under `handoff:<id>`, finds the associated revision under the
draft's ordinary key, and is refused by the state check naming that
linked revision (H16b); a linked-draft publish
after a prepared publish is refused by the existing stale-base check
(H38s). A revision holding `handoff:<id>` without the association cannot
arise (U6: the ordinary entry refuses the prefix, and before this change
no handoff id existed to collide with); defensive fixture DF6 still
proves the prepared entry refuses it instead of reading it as
fulfillment.

**Edit before publishing** copies the handoff into the draft
(`team-task-handoff-load-draft`, requiring `replace: true` when a draft
exists) and sets the draft's `handoff_id`, its base to the handoff's
`base_revision`, and a fresh server-owned draft identity (the linked
draft's lineage marker; the writer picks its representation, for example
a random id column beside `handoff_id`). Publishing that draft goes
through the ordinary entry with the human's ordinary key; the association
is written as above, with `published_payload_hash` shown as "published as
edited" when it differs.

Draft provenance (A10). The form captures the draft identity it loaded
together with the fields it edits, and sends that observed identity (or
none, for a form opened without a stored draft) with every save and
publish. With its edited values it also captures its publish intent:
a draft publish (the existing `team-task-publish` discriminator
`fromDraft: true`, set from the draft the form was editing when the edit
began, never re-read from a later draft snapshot) or an explicit ordinary
publication (`fromDraft: false`, chosen by the operator; an owner's
`task_amend` is always ordinary). Intent is never inferred from a missing
identity. The marker is only a precondition and carries no publication
authority; the server compares it with the stored draft:

- a save whose observed identity is the stored linked draft's, at the
  same base, keeps the text, the identity and the link (H41);
- a save or `team-task-draft-rebase` that moves the base keeps the text
  and detaches the link and identity, leaving the handoff as it was
  (H42); `taskDrafts.ts`'s `INSERT OR REPLACE` save must carry the
  columns over explicitly, so it never drops them by accident;
- a save, rebase or draft publish (`fromDraft: true`) whose observed
  identity does not match the stored linked draft's is refused until the
  form refreshes, whatever the form was editing: an old form from before
  a re-load, or a form editing an earlier ordinary draft that another
  window replaced by loading H (it sends no identity). The stored
  replacement draft, the handoff and the form's unsaved text are kept
  (H43). Matching bases never attach a draft, and a mismatch never
  silently detaches one;
- only an explicit ordinary publication (`fromDraft: false`, or an
  owner's `task_amend`) publishes past a replacement linked draft: as
  today, with no association, making the handoff stale by D4 and leaving
  the replacement in place (H44); that draft's later publish meets the
  stale-base check (H38s);
- the linked publish verifies the observed identity, the stored link and
  the base inside the shared publish transaction, before the draft
  discard, so a replacement that lands between read and write is refused,
  not discarded (H43).

Replay keeps today's store rule. A resend of the same linked publish
(same ordinary key, same payload, same association) returns its revision
even after its own draft was discarded (H17r): the replay lookup runs
before the lineage check, after the ordinary right checks. The same
ordinary key with a different payload or a different linked handoff is a
mismatch and is refused naming the differing field (H17m). Concurrent
ordinary editing beyond these linked-draft cases is unchanged.

### D4. Every publication path checks pending handoffs in its transaction

The stale transition lives in `TaskStore.publish`, not in `TaskService`,
so the human form, `task_amend`, a handoff publication and any future
path cannot bypass it (oracle hazard "Several readers disagreeing on
derived state"). After inserting revision N, a pending handoff of the
task whose id is not this publication's `handoffId` moves `open → stale`
naming N (a `stale` one stays stale; its wakeup is keyed once). Closing
the task — every `done`/`cancelled` transition through
`TaskService.setStatus` or `prepareStatus`, including Kawai's and the
override path's cancellation of earlier fix tasks
(`src/server/plans/decisions/fixTasks.ts`, `prepareOverrideFix`) — moves a
pending handoff to `closed` in that status transaction. A `published`
handoff is not changed by closing; its follow-up item ends because the
task is closed (D5).

Both hooks live in the store (`TaskStore.publish` and
`TaskStore.setStatus`, which `prepareStatus().commit` also calls), so the
paths that bypass `TaskService.publish` share them: the pause
resolution's Adapt (`pauseResolve.ts` publishes through
`tasks.store.publish` under its `pause:` key) makes a pending handoff
stale (H20), and the override's cancellation closes it (H28b). The two
orders of a publication and a close are both rows: published then closed
leaves the handoff `published` with its one wakeup (H40); closed then
prepared publish is refused naming `closed` (H15), with only the
`closed` wakeup.

### D5. States, and one derived follow-up phase

Stored state: `open`, `stale`, `published`, `declined`, `withdrawn`,
`superseded`, `closed`. Only `open` and `stale` are pending; the rest are
terminal and immutable.

The follow-up phase of a `published` handoff is derived at read time by
one pure function, `handoffPhase(handoff, task, publicationDetail,
holder, executionOwns)` in `src/shared/taskHandoffs.ts`, from the facts
the publication detail already shows (notice state, delivered and
acknowledged revision per holder), holder liveness and task status. First
match wins:

1. `task-closed` — the task is `done` or `cancelled`: no follow-up item.
2. `acknowledged` — the current claimant's acknowledged revision is at
   least the published revision: no item, whatever any notice's state
   (a failed or uncertain notice followed by an acknowledgement through
   another path needs nothing more).
3. `no-holder` — no live claimed assignment.
4. `delivered-awaiting-ack` — task mail carrying that revision or a later
   one is confirmed delivered to the claimant (its delivered revision is
   at least the published one), not acknowledged: the holder's wait,
   whatever any notice's state. A dead notice followed by ordinary task
   mail that delivered the revision needs no human (findings-0854c403
   F3).
5. `notice-uncertain` — any notice to the claimant for that revision or
   later is `uncertain`: the human resolves it in the Mailbox (Retry or
   Discard), as `TaskPublications.tsx` already directs; **Notify** and
   **Retry notification** stay suppressed.
6. `notice-queued` — any such notice is still queued: the holder's wait.
7. `notice-failed` — a notice exists and every such notice is `failed`
   (dead, cancelled, discarded, forwarded): **Retry notification**.
8. `not-notified` — no such notice: **Notify**.

Suppression outranks notice parity (findings-7c473fea F3). Phases 1–2
end the follow-up whatever a low-level `notify` with a fresh key could
still write: a holder that acknowledged without any delivery (the task
published without notify, read through `task_get`, then acknowledged)
needs no notice, and a closed task needs none (P7a). Only for an open
task with a live current claimant whose acknowledged revision is below
the published one (phases 4–8) do the notice phases mirror
`taskNotices.ts` `reached` exactly: phases 4–6 are where it skips the
claimant (confirmed delivery points to the holder's acknowledgement,
uncertain to the Mailbox, queued to waiting; none offers **Notify** or
**Retry notification**), and 7–8 where it does not (all failed offers
**Retry notification**, no notice offers **Notify**), so either action is
offered there exactly when `notify` with a fresh key writes a new notice
(P7b). `reached` and `notify` are unchanged: no resend force, and a
human retry is never a silent no-op.

Attention, the supervision loader and `task_get` all call it. Nothing new
is stored for notice or acknowledgement, so restart has nothing to
reconcile for it.

### D6. Wakeups are system mail written in the transition's transaction

Each of `published`, `declined`, `stale`, `closed` (only these four)
inserts `team_task_handoff_wakeups (handoff_id, transition, message_id)`
and enqueues one system notification through `MailboxStore` (as
`convergenceNotice.ts` does) in the same transaction as the state
mutation. The message carries no task-work attachment (no `task_id` on
the mailbox row): its body names the task, the handoff, the transition
and the revision, and the wakeup row links the message id. This matters
for closure: `memberRelease.ts` dead-letters a closed task's scoped group
work mail, so a `closed` wakeup sent as task mail would be dropped even
though the transition enqueued it atomically; as a plain notification it
is routed like any other system mail, and member release and dispatch
policy are unchanged.

The recipient is resolved once, at the transition, by the existing
direct/group routing: the requester session if it is live (its record is
present and neither archived, killed nor context-exhausted), else the
requester's group as group mail, so an archived session is not revived by
direct mail and no task assignment is created. A worktree-scoped group
delivers it to an eligible live member (real-composition rows, including
DF2 with an exhausted requester). The primary key makes a replay or a
second sweep a no-op. `superseded` and `withdrawn` are the requester
side's own acts and wake nobody.

Atomicity: a fault after the attempted insert of the mutation, the wakeup
row or the mailbox row rolls all three back. A later delivery failure
(dead-letter) is the mailbox's ordinary failure, visible in the Mailbox
tab, and never rolls back the transition. After a crash past the commit,
boot dispatches the original queued mailbox row once by its message id,
without reselecting its recipient, and a later boot sends no second
message.

Alternative: an after-commit outbox — rejected: it needs its own
recovery, while the in-transaction write is the pattern the codebase
already trusts for revision notices.

### D7. Startup reconciliation

At startup, one idempotent sweep (`reconcileHandoffs` in
`taskHandoffStore.ts`) reads pending handoffs. In every state the system
can produce (the healthy domain) it changes nothing (H29): D3, D4 and the
status hooks already made each transition in the transaction that caused
it, and a refused command (H33, H33d) wrote nothing. The sweep is
defensive against states the U-claims call unreachable (an older build's
rows, manual edits, a future bug) and applies, in this order: a revision
whose `handoff_id` is this handoff exists → `published` (DF1, U1); the
task is `done`/`cancelled` → `closed` (DF2, U5); the task's revision
exceeds the base and the handoff is `open` → `stale` (DF3, U3). A revision
that merely carries a `handoff:` key without the association is never
fulfillment (DF4). Each applies with its wakeup row, so the sweep sends a
message only for a transition it performs. The sweep reconciles only
persisted facts that an authorized path already wrote (an association, a
closed status, a newer revision); it never infers a publication or
disposition from decisions, archival, mail or time. A `stale` handoff
whose base reads current is tolerated as a no-op (H29): no legal history
produces it, since `stale` is entered only by a revision past the base,
and the sweep neither rewrites it nor sends a wakeup for it.

Production hook: `SessionMailbox.start()` (`src/server/team/
sessionMailbox.ts`) calls the sweep after `reconcileMailbox` and before
`this.dispatcher.release()`, so the wakeup mail it enqueues is dispatched
by the first cycle; `ChatSessionManager` already calls `teamMail.start()`
once after persisted chat records are restored. This is a recovery
mechanism, so it adds its `docs/recovery-matrix.md` row. It holds no
exclusive slot, so no liveness predicate is needed.

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
| null`, filled by the supervision loader from the task's pending (open
or stale) handoff only: publication ends the wait (S7), so the loader
projects no published phase.
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

Limits (checked before any field is parsed, so an oversized field is
named ahead of a contract parse error):
direction, acceptance, contract and rationale up to 64 KiB each;
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
whitelist and `chatConnectionTypes.ts`. Each publish and decline carries a
client command key armed per payload; it correlates a resend with its
transport request, and the replay semantics are the commands' own: a
resent prepared publish returns the revision it originally published
(H14), while a repeated decline or withdrawal after a disposition follows
H26 — it reports the terminal state and writes no event or notification.
There is no settlement replay ledger.

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

Each command is its own partition with fixed axes. Inside a partition
the refusal checks run in the order given, and the first failing check is
the result. So a tuple with several failing conditions (for example an
authorized request on a closed task with a stale base) matches exactly
one row: the earliest failing check. Every partition starts with the same
two checks: a task or handoff of another team gets the same not-found as
an unknown id (H4), and an unknown id is not found (H16). Each refused row
writes nothing: no handoff, event, revision, notice, fact, draft change
or mail.

**H-REQ — `task_request_publication`.** Axes: requester right (ok, caller
is the live owner, group cannot create tasks); key relation (new,
replay by the requester side with the same payload, replay by the
requester side with a different payload, key held by another requester
side); task status (open, closed); base (current, behind); payload
(valid, invalid); pending handoff on the task (none, open/stale by the
requester side, open/stale by another group). The requester side of a
handoff is its requester session or any session of its recorded group.
Key uniqueness stays per task and key. Order: team/id, right (live owner
first, then `canCreateTasks`), key, status, base, payload, pending; only
an eligible requester reaches the key lookup, so a key is never
authority.

| Id | First failing check, or the accepted case | Result |
| --- | --- | --- |
| H6 | right: caller is the live owner | refused naming `task_amend` |
| H5 | right: group cannot create tasks | refused suggesting `task_note` or a message to the owner |
| H11s | key held by another requester side | refused naming a different requester side for the key; the earlier handoff is not returned; nothing written |
| H10 | key replay by the requester side, same payload | returns the existing handoff in its current state, even if the task moved past its base, the handoff went stale, or the task closed since; nothing written |
| H11 | key replay by the requester side, different payload | refused naming the first differing field (direction, acceptance, contract, rationale, notify, base revision, base commit, evidence) |
| H3 | status: closed | refused naming the status |
| H2 | base: behind | refused naming the current revision |
| H7 | payload invalid | refused naming the first problem in field order: size limits, direction, acceptance, contract parse, rationale, evidence references, base commit |
| H9 | pending by another group | refused naming the pending handoff and its requester |
| H8 | pending by the requester side, else accepted | old handoff `superseded` by the new one in one transaction; new `open`; no wakeup |
| H1 | none pending, accepted | handoff `open`; task unchanged; no notice, fact or mail |

Combined rulings (each a row of the table test; the first failing check
wins):

- the live owner whose group also cannot create tasks → H6;
- new key, group cannot create tasks, task closed → H5;
- the original requester replays its key after losing eligibility (it
  became the task's owner by a transfer, or its group lost
  `canCreateTasks`) → H6 or H5; the handoff is not returned;
- the requester side replays the same key and payload after the task
  closed or the handoff went stale → H10 with the current state;
- another requester side sends the key with the identical payload on a
  closed task → H11s;
- authorized, new key, task closed, base behind → H3;
- an oversized rationale together with a malformed contract → H7 naming
  the size limit.

**H-PUB — Publish prepared revision** (human `team-task-handoff-publish`
or owner `task_amend { handoff_id }`, the prepared entry; it takes no
caller key). Axes, read from one consistent snapshot of the task's
revisions and the handoff row:

- revision facts R (findings-4b13b98a), the joint domain of the
  task-scoped association (a revision whose `handoff_id` is H.id, any
  key) and the prepared-key row (the revision whose stored key is exactly
  `handoff:<H.id>`), under the unique (`task_id`, `request_key`) and
  unique `handoff_id` constraints: **R0** no associated revision, no
  prepared-key row; **R1** no associated revision, an orphan prepared-key
  row; **R2** the associated revision is the prepared-key row; **R3** the
  associated revision carries another key, no prepared-key row (a linked
  draft's ordinary key); **R4** the associated revision carries another
  key, plus a separate orphan prepared-key row. These five cells are every
  consistent combination; the two facts are never inferred from each
  other;
- publisher right (the human or the task's current live owner; other:
  an unrelated agent, a former owner after a transfer, or Kawai); extra
  prepared-payload fields beside the handoff id (none, some: a direction,
  acceptance, contract, rationale or notify argument on `task_amend`, or
  payload fields on the human command);
- handoff state (open, stale, published, declined, withdrawn, superseded,
  closed), every state kept.

Declared product 5 × 2 × 2 × 7 = 140. Reasons: U1 when (state is
`published`) differs from association present (R2, R3, R4); U6 when an
orphan prepared-key row exists (R1, R4). The empty-reason (R, state)
pairs are R0 with each non-published state, R2 with `published` and R3
with `published`: 8 × 4 = 32 healthy tuples, 108 excluded. Order for
healthy tuples: team/id, right, extra fields, then replay and state.
Row multiplicities over the 32: H13 = 16 (every pair, both extras
values), H35 = 8 (every pair with the right), H14 = 1 (R2), H12 = 1 (R0
`open`), H15 = 5 (R0 with each other non-published state), H16b = 1
(R3).

Paired witnesses (asserted on classification): R3, `published`, human,
no extras → empty, H16b naming the linked revision; R0, `published`,
same caller → `{U1}`, zero H rows (the pair differs only in the
association, both lacking a prepared-key row). R2, `published` → empty,
H14. R0, `open` → empty, H12. R1, `open` → `{U6}` (DF6). R4,
`published` → `{U6}`, no H16b, and the orphan is never returned as the
fulfilling revision. Every other tuple keeps all its reasons (R3 with
`open` is `{U1}`; R4 with `open` is `{U1, U6}`).

| Id | First failing check, or the accepted case | Result |
| --- | --- | --- |
| H13 | right: an unrelated agent, a former owner after a transfer, or Kawai | refused as their publication is; no revision returned, even when the handoff is already published; handoff unchanged |
| H35 | extra prepared-payload fields beside the handoff id | refused; no revision returned; nothing written |
| H14 | R2 with `published`: the prepared-key row carries this handoff's association (an authorized replay, including concurrent duplicates and the catch path) | that revision returned; no revision, notice, fact, event or mail written (snapshot of every handoff, revision, notice, wakeup and mailbox row identical before and after) |
| H15 | R0 with state stale, declined, withdrawn, superseded or closed | refused naming the state |
| H16b | R3 with state published (through its linked draft: associated revision under an ordinary key, no prepared-key row) | refused naming published and the linked revision; no cross-command replay |
| H12 | R0 with state open, accepted | revision N+1 with the prepared fields and `handoff_id`; handoff `published` with N+1; notices iff notify; one fact; one wakeup `published` |

Traces (each a sequence test over the rows above):

- the owner publishes H (H12), ownership transfers, and the former owner
  resends → H13, no revision returned;
- an unrelated agent of the team sends the prepared publish for an open
  and for a published H → H13 both times;
- after H12, the human and the current owner each resend → H14, each
  receives the original revision, and the snapshot of every handoff,
  revision, notice, wakeup and mailbox row is identical before and after;
- after H12, the owner resends `task_amend` with `handoff_id` and a
  rationale → H35, not the revision;
- ordinary publication is unchanged: the same ordinary key and payload
  replays its revision, and the same key with a changed field is refused
  naming it, as today (H39 rows).

**H-DRAFT — load into draft and publish the linked draft** (human only).
Load axes: caller (human, agent); handoff state; draft (none, exists);
`replace` (false, true). Order: team/id, caller, state, draft/replace.
Save and rebase axes: the form's observed draft identity (the stored
linked draft's, another or none); base (unchanged, moved). Order: team/id,
observed identity, base.
Publish adds the form's publish intent (draft: `fromDraft: true`;
ordinary: `fromDraft: false` or `task_amend`), captured with the form's
values. Against a stored linked draft, a draft publish needs the matching
observed identity (else H43) and an ordinary publish ignores the draft
(H44); without a stored linked draft both behave as today.
Publish (the ordinary entry) axes: the canonical key `k` (ordinary,
reserved prefix; raw input bare or padded); the publish intent; the existing
`team-task-publish` checks (rationale, rights, ordinary key replay or
mismatch, stale base); the observed draft identity against the stored
linked draft; the command's submitted base; the linked handoff's state.
The submitted base (the numeric `baseRevision` of the typed WS command;
an owner's `task_amend` keeps its existing optional base) and the stored
draft's base are independent observations: U7 reads only the stored
facts, an ordinary write compares the submitted base with the task's
revision (T-stale or H44) and ignores the draft, and a draft write
compares it with the stored draft's base (H38m), then the stored base
with the task's (H38s). Order: reserved prefix (after team scope, before
the WS rationale guard), then the existing rationale and right checks,
then the key replay or mismatch, then, for a draft write, the observed
identity and stored link, the submitted base against the stored draft's,
and the stored base against the task's (inside the publish transaction,
before the draft discard), then the linked state; for an ordinary write,
the submitted base against the task's.

| Id | First failing check, or the accepted case | Result |
| --- | --- | --- |
| H36 | load by an agent | refused: drafts are the human's |
| H37 | load of a handoff not `open` (stale or ended) | refused naming the state; draft unchanged |
| H18 | load with a draft and `replace` false | refused; draft and handoff unchanged |
| H19 | load accepted | draft holds the prepared fields with `handoff_id`, base = the handoff's base revision and a fresh server-owned draft identity; handoff `open` |
| H43 | save, rebase or draft publish (`fromDraft: true`) whose observed identity does not match the stored linked draft's (an old form from before a re-load, or a form editing an earlier ordinary draft, sending no identity) | refused until the form refreshes; the stored replacement draft, its link and the handoff unchanged; the form keeps its unsaved text |
| H42 | save or rebase by the observed linked draft that moves its base | saved; text kept; link and identity detached; handoff unchanged |
| H41 | save by the observed linked draft at the same base | saved; identity and link kept; handoff unchanged |
| H33d | publish linked draft whose canonical key `k` starts with `handoff:` (bare or padded raw input) | refused before the rationale guard and before the draft or handoff is read; no revision; draft and handoff unchanged (H stays `open`) |
| H17r | publish linked draft, the same ordinary key and payload already name its revision (a resend, also after its own draft was discarded) | that revision returned as today; nothing written; handoff unchanged |
| H17m | publish linked draft, the ordinary key names a revision with a different payload or a different linked handoff | refused naming the first differing field, as today; nothing written |
| H38m | publish linked draft, observed identity and link verified, submitted base differs from the stored draft's base | refused until the form refreshes, naming both bases; nothing written; the draft, its link and the handoff unchanged |
| H38s | publish linked draft, submitted base equal to the stored draft's, which is no longer current (including after a prepared publish of the same handoff) | refused by the existing stale-base check; no second revision; handoff unchanged |
| H17 | publish linked draft, observed identity and link verified, submitted and stored bases current, handoff `open` | revision N+1 with the edited fields and `handoff_id`; handoff `published` as edited with both hashes; one wakeup |
| H38 | publish linked draft, submitted and stored bases current, handoff declined, withdrawn, superseded or closed | published as an ordinary revision with no association; the ended handoff is unchanged (a superseding `open` handoff turns `stale` by D4) |
| H44 | explicit ordinary publication (`fromDraft: false` chosen by the operator, or an owner's `task_amend`) at the current submitted base while a linked draft exists, whatever the stored draft's base | published as today; the pending handoff turns `stale` (H20); the replacement draft is kept, not discarded |

Declared products (the completeness test, U7). Load: caller × state ×
draft × `replace` = 56 tuples, no claim (H36 28, H37 24, H18 1, H19 3).
Save and rebase observe the stored linked draft as U7 reads it: command
(save, rebase) × observed identity × base × the draft's base against the
handoff's (same, differs) × against the task's revision (current,
behind) × the linked state = 336; U7 excludes 192, and H43 96, H42 24,
H41 24 (a rebase onto the base it already has keeps the link, as a
same-base save). Publish: key × raw × intent × rationale × right ×
replay (new, same, different) × observed identity × the two U7 bases ×
the submitted base × state = 24192. The submitted base takes three
representatives with the task at r2 and the stored draft at r2 (current)
or r1 (behind): r2, r1 and r3, which realise every pair of its two
relations (equal to the task's revision, equal to the stored draft's
base) under each stored base. U7 excludes 13824 whatever the key or the
submitted base, and 10368 are healthy: H44 72, T-stale 144, H43 144,
H38m 48, H38s 14, H17 2, H38 8. Paired witnesses on one snapshot (H
loaded at r1, then an explicit ordinary r2: H stale, the r1 draft kept)
hold the payload, the stored draft and the intent fixed: ordinary at r1
is T-stale and at r2 is H44 (r3; the draft, its link and H unchanged);
draft at r1 is H38s and at r2 is H38m, each writing nothing. Reading the
stored draft's base as the command's would call the second H44 T-stale
and the H38m H38s. Rows the table names but does not number are the
existing `team-task-publish` outcomes as today: the rationale guard, the
right check, the ordinary replay and mismatch for `fromDraft: false`,
and its stale base.

Readouts and controls: each H-DRAFT row is driven through the real WS
commands (`team-task-draft` save and rebase, `team-task-handoff-load-draft`,
`team-task-publish`) and read back as the stored draft (text, base,
identity, link), the handoff row and the revisions; the client test drives
the form so that it sends the observed identity it loaded. Traces: load,
edit, save (H41), publish (H17), resend after the discard (H17r); load,
another revision makes H `stale` (H20), rebase (H42), publish → an
ordinary revision with no association, H stays `stale` (H21);
form A loads H, H is re-loaded with `replace` in form B, form A saves or
publishes → H43; form B's linked publish → H17. Paired WS witnesses on
one snapshot (same task, stored linked draft, base and fields; form A was
editing an earlier ordinary draft and sends no identity): A's draft
publish (`fromDraft: true`) → H43, nothing written; the same values sent
as an explicit ordinary publication (`fromDraft: false`) → H44. Client
trace: form A starts editing the ordinary draft, the replacement draft
snapshot arrives, and A's publish still carries `fromDraft: true` and no
identity (its original intent), so the server answers H43 and the form
keeps its text.

The replay of an already committed linked or ordinary publication (H17r)
is decided before these new-write checks, after the right checks, so it
is never refused by H43.

**H-OTHER — a publication not from this handoff** (any author, the
ordinary entry with no linked draft, or another handoff's publication).
Axes: the canonical key `k` (ordinary, reserved prefix), each with the
raw input bare or padded with leading or trailing whitespace (space, tab,
newline); the task's pending handoff state.

| Id | Case | Result |
| --- | --- | --- |
| H33 | canonical key `k` starts with `handoff:` (bare or padded raw input) | refused after team scope and before the WS rationale guard or any addressed read; nothing written; after a restart the handoff is as before (H29: an `open` one stays `open`) |
| H20 | ordinary, pending handoff `open` | revision published as today; handoff `stale` naming it; one wakeup `stale` |
| H21 | ordinary, pending handoff `stale` | revision published; handoff stays `stale`, newest revision shown; no second wakeup |
| H39 | ordinary, no pending handoff | revision published as today (a padded key is stored trimmed, as today); no handoff row changes |

Mixed-error rows: a reserved key together with a blank rationale, an
unknown or foreign task id, a stale base, or a caller without the
publication right reads H33 (H33d with a linked draft), never the other
refusal. Other paths: the pause resolution's Adapt, which publishes
through the store under its `pause:` key, reads H20 or H21.

**H-SETTLE — decline and withdraw.** Axes: action; right (decline: human
or owner; withdraw: requester or its group); reason (given, empty);
state. Order: team/id, right, reason, state.

| Id | First failing check, or the accepted case | Result |
| --- | --- | --- |
| H23 | right missing | refused; unchanged |
| H23b | reason empty | refused; unchanged |
| H26 | state not pending | refused naming the state |
| H22 | decline accepted | `declined` with reason and actor; one wakeup `declined` |
| H24 | withdraw accepted | `withdrawn` with reason and actor; no wakeup |

**H-CLOSE — the task moves to `done` or `cancelled`** through any
authorized path, including Kawai's closing and an override's cancellation
of an earlier fix task (`prepareOverrideFix`).

| Id | Handoff state | Result |
| --- | --- | --- |
| H27 | open or stale | `closed` in the status transaction; one wakeup `closed` |
| H40 | published or ended | unchanged (a published handoff's follow-up ends by W5) |

Both orders are traces: publish then close → `published` (H12, then H40),
one `published` wakeup only; close then prepared publish → `closed` (H27),
then H15 naming `closed`, one `closed` wakeup only. The close rows run
through `setStatus`, `prepareStatus().commit` and the real override path.

**H-NEUTRAL — events that grant nothing.** A decision answer, own call,
or an override that does not close the handoff's task; a journal note;
mail; elapsed time; archival or exhaustion of the requester, the owner or
the holder; a notice retry; an acknowledgement.

| Id | Case | Result |
| --- | --- | --- |
| H28 | any neutral event, any state | every handoff row and the task's revision unchanged |
| H28b | an override that also cancels the handoff's task | H27 applies through the close; the decision itself changes nothing else on the handoff |

**H-RESTART — startup sweep.** Five declared observations per pending
handoff H of task T, all read from one consistent pre-sweep snapshot of
T's revisions and H's row before any repair, never from a caller's raw
key, a past refusal or prose:

| Observation | Values | Source |
| --- | --- | --- |
| `associationPresent` | true, false | a revision of T whose server-written `handoff_id` is H.id, whatever its request key (the same fact H-PUB reads) |
| `unassociatedReservedKeyPresent` | true, false | a revision of T whose stored `request_key` is exactly `handoff:<H.id>` (the prepared entry's canonical key, resolved by (`task_id`, `request_key`) as `taskStore.ts` does today) and whose `handoff_id` is not H.id, null included |
| task status | open, closed | T's status |
| base relation | current, behind | T's revision against H's `base_revision` |
| state | open, stale | H's row |

The two revision facts are independent: both can be true in one
defensive snapshot (an associated revision plus a separate orphan
reserved key), so neither is inferred from the other. They are H-PUB's
revision facts R projected onto two booleans: R0 (false, false), R1
(false, true), R2 and R3 (true, false), R4 (true, true). An orphan key
never proves publication.

| Id | Case | Result |
| --- | --- | --- |
| H29 | `associationPresent` false, `unassociatedReservedKeyPresent` false, task open, and `open` with current base or `stale` | unchanged; no mail |

H29 holds three tuples: (`open`, current), (`stale`, behind) and
(`stale`, current). The first two are what legal histories produce. The
third is a tolerated no-op that no legal history produces (`stale` is
entered only by a revision past the base, and revisions never go back);
its reason set is empty because no U-claim names it, and the sweep
neither rewrites it nor sends a wakeup for it. The completeness test
marks it apart from the two produced tuples, and P4's generated histories
never reach it.

Paired witnesses (asserted on the classification before the restart
runs, since both restarts are no-ops): (1) both revision facts false,
task open, base current, `open` → reason set empty, exactly H29; (2) the
same snapshot with `unassociatedReservedKeyPresent` true (DF4a) →
`{U6}`, zero H rows, one excluded classification; the sweep still
changes nothing and sends nothing.

Unreachable, with reasons:

- U1: `published` without an associated revision, or the reverse — D3
  writes both in one transaction.
- U2: two pending handoffs on one task — the partial unique index refuses
  the second insert; H8 supersedes in the inserting transaction.
- U3: an `open` handoff whose base is not current — D4 makes it `stale` in
  the transaction that advanced the revision.
- U4: an ended handoff changing state — every transition's `UPDATE` is
  guarded by `state IN ('open','stale')`.
- U5: a pending handoff on a closed task — D4 closes it in the status
  transaction.
- U6: a revision holding `handoff:<id>` without that handoff's
  association (H-RESTART's `unassociatedReservedKeyPresent`, H-PUB's key
  axis) — the ordinary entry refuses the prefix (H33, H33d), the
  prepared entry writes the association with its key, and before this
  change no handoff id existed to collide with (ids are server-generated).
- U7: a linked draft (link present) whose base differs from its
  handoff's base revision, or is current while its handoff is `stale` or
  `published` — a load writes the handoff's base (H19), only a same-base
  save of the observed linked draft keeps the link (H41), any base change
  or rebase detaches it (H42), a foreign form cannot write over it (H43),
  and `stale` and `published` are entered only by a revision past that
  base (D4, D3); so H38s catches every linked publish of such a handoff
  first.

Each U predicate reads only declared observations of the partitions that
evaluate it, so no reason is read from undeclared state or dropped by a
prefilter:

| Claim | Evaluated in | Declared observations it reads |
| --- | --- | --- |
| U1 | H-PUB, H-RESTART | the task-scoped association (any key) × state, in both: H-PUB's R (R2, R3, R4 present) and H-RESTART's `associationPresent`; never the prepared-key row alone |
| U2 | H-REQ | pending handoff on the task (the partial unique index; a second pending row is not a declared value, so U2 is proved by the migration test, not enumerated) |
| U3 | H-RESTART | state × base relation |
| U4 | none enumerated | an ended state is a declared value whose commands have rows (H26, H40, H15, H37); the claim that its row never changes is proved by task 2.2's guarded-`UPDATE` rows |
| U5 | H-RESTART, table W (W-U1) | state (pending) × task status |
| U6 | H-PUB, H-RESTART | the prepared-key row without H's association: H-PUB's R (R1, R4) and H-RESTART's `unassociatedReservedKeyPresent` |
| U7 | H-DRAFT | link present × draft base against the handoff's base and the task's revision × linked handoff state, over the load, save, rebase and publish rows (H19, H41–H43) |

Completeness claim (findings-7c473fea F4: exclusion is one
classification with a set of reasons). The completeness test enumerates
every partition's FULL declared axis product, with no tuple prefiltered.
For each tuple it computes `U_reasons`, the set of every U-claim the
tuple satisfies. If `U_reasons` is empty, exactly one healthy H row
matches (the rows follow the partition's check order and the last row is
the accepted case). If it is nonempty, zero H rows match and the tuple
gets one excluded classification that retains every reason in the set;
several reasons at once (for example `{U1, U3, U5}`) are valid, never an
error. The test fails on a tuple with an empty reason set and no row or
several rows, and on a tuple with a nonempty reason set that some H row
also matches (an H/U overlap).

### Table DF — defensive fixtures

A separate domain: states the U-claims say the system cannot produce,
seeded directly into the database (as an older build, a manual edit or a
future bug could leave them), each to prove the defensive code fails
closed. Each fixture is first classified by the completeness test's
classifier, which must return excluded with exactly the listed reason set
(a multiple-reason set is a positive control) and no H row; then the
command runs and its result is asserted. Repair precedence is association,
then task closed, then base advanced.

| Id | Seeded state | U_reasons | Command | Result |
| --- | --- | --- | --- | --- |
| DF1 | pending handoff with an associated revision | {U1} | startup sweep | `published` with that revision; its wakeup if unsent |
| DF2 | `open` handoff on a closed task, its requester context-exhausted, its group worktree-scoped | {U5} | startup sweep through the real composition | `closed`; one `closed` wakeup as group mail delivered to an eligible live member of the group despite task-close filtering; no task assignment created; the exhausted requester not restored |
| DF3 | `open` handoff, task revision past its base | {U3} | startup sweep | `stale` naming the newest revision; its wakeup |
| DF4a | orphan reserved key (`unassociatedReservedKeyPresent` true), no association, task open, base current, `open` — witness (1)'s snapshot plus the orphan row | {U6} | startup sweep | never `published`; stays `open`; no mail; the orphan revision is kept |
| DF4b | orphan reserved key, no association, task open, base behind (the task advanced), `open` | {U3, U6} | startup sweep, then a second restart | first: never `published`, `stale` only because the task advanced, one `stale` wakeup; second: still excluded as `{U6}` (now `stale`), writes and sends nothing, the orphan revision is kept |
| DF5 | `open` handoff with an associated revision on a closed task, base behind | {U1, U3, U5} | startup sweep | `published` once (association first), one `published` wakeup, no `closed` or `stale` |
| DF5o | DF5's snapshot plus a separate orphan reserved-key revision | {U1, U3, U5, U6} | startup sweep, seeded twice: with the requester live, and through the real composition with the requester archived | as DF5: `published` with the associated revision (never the orphan), one `published` wakeup; the orphan revision is kept; with the requester archived the wakeup is group mail to a live member of its group, none to the archived session |
| DF6 | revision holding `handoff:<id>` with no association (R1), handoff `open` | {U6} | Publish prepared revision | refused naming that revision; handoff unchanged; never `published` |
| DF6p | R4: the handoff `published` through its linked revision, plus an orphan `handoff:<id>` row | {U6} | Publish prepared revision | refused; the orphan is never returned as the fulfilling revision; nothing written |

### Table W — attention for a handoff

Pending handoffs:

| Id | State | Task owner | Requester | Item | Owner | Needs human | Next action |
| --- | --- | --- | --- | --- | --- | --- | --- |
| W1 | open | live agent | * | publication-handoff | owner session | no | Publish prepared revision |
| W2 | open | none or gone | * | publication-handoff | human | yes | Publish prepared revision |
| W3 | stale | * | live | publication-handoff | requester session | no | Re-prepare or withdraw |
| W4 | stale | * | gone | publication-handoff | requester group | no | Re-prepare or withdraw |

Published handoffs, by `handoffPhase` (D5, first match wins):

| Id | Phase | Execution owns | Item | Owner | Needs human | Next action |
| --- | --- | --- | --- | --- | --- | --- |
| W5 | task-closed | * | none | — | — | — |
| W6 | acknowledged (even after a failed or uncertain notice) | * | none | — | — | — |
| W7 | no-holder | yes | publication-follow-up | Kawai | no | Wait for Kawai |
| W8 | no-holder | no | publication-follow-up | human | yes | Hand off the task |
| W12d | delivered-awaiting-ack (even after a failed notice) | * | publication-follow-up | holder session | no | Wait for acknowledgement, naming the delivered and acknowledged revisions |
| W9 | notice-uncertain (not delivered) | * | publication-follow-up | human | yes | Resolve in the Mailbox (Retry or Discard), linked to the message |
| W12 | notice-queued | * | publication-follow-up | holder session | no | Wait for acknowledgement |
| W10 | notice-failed (not delivered, none queued or uncertain) | * | publication-follow-up | human | yes | Retry notification |
| W11 | not-notified (not delivered, no notice) | * | publication-follow-up | human | yes | Notify |

Ended handoffs (declined, withdrawn, superseded, closed): W13, no item.
Unreachable: W-U1, a pending handoff on a closed task (U5). Completeness:
the pending rows partition (state × owner liveness × requester liveness),
the published rows are `handoffPhase`'s total order, and W13 covers every
ended state; the test expands these axes.

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
| S1 | yes | no | no | owner-publication (next actor per W1–W4) | none | handoff item only |
| S2 | yes | yes | no | the other wait; owner-publication also applying | none | handoff item and the other wait's item |
| S3 | yes | * | yes | convergence stall (unchanged precedence) | convergence | handoff item only (no **Publish a task revision**) |
| S4 | no | * | yes | convergence stall | convergence | **Publish a task revision** (unchanged) |
| S5 | no | no | no, holder gone, no progress past deadline | no-progress stall | no-progress, holder named gone | Lead role's **Unblock the holder** naming the holder archived |
| S6 | * | * | no, repeating failure | repeating-failure stall (unchanged precedence) | repeating-failure | stall item as today |

Transitions (each its own row, observed on the supervision read and the
dispatched mail):

| Id | From | Event | Result |
| --- | --- | --- | --- |
| S7 | S1 | the handoff is published | no owner-publication wait; the publication is not meaningful progress; no stall alert raised by the transition |
| S8 | S3 | the handoff is published as revision N | the diagnosis closes, exactly one fix attempt is dispatched against revision N, the revision actually published (as the diagnosis stage reads it), the backstop reads zero, and no **Publish a task revision** item appears |
| S9 | S1 | the handoff becomes stale | still owner-publication, next actor the requester side (W3/W4) |
| S10 | S1 | the handoff ends (declined, withdrawn, closed) | no owner-publication wait; the change's other waits or stall rules apply as today |

### Properties

Each runs through `propertyCases(CASES)` on a fresh `freshTestDatabase`
with the real `TaskStore`, `TaskService`, `TeamMailbox` and workspace read;
generators use the existing `mulberry32` helper (`src/shared/__tests__/contractFixtures.ts`), no new dependency.

- **P1 exactly once.** Seeded command sequences over request, re-request,
  publish-prepared (1–3 duplicates, some concurrent through
  `Promise.all`), edit-and-publish (with same-base saves, rebases and
  stale-form saves of the linked draft), other publication (including the
  Adapt path), decline, withdraw, close (before and after a publication),
  ownership transfer, neutral events, ordinary publications (including
  plain and linked-draft ones that try the reserved prefix), and restart. Invariant: per handoff at most one
  revision whose `handoff_id` is it; `published` iff exactly one such
  revision; no revision outside the handoff path holds a `handoff:` key;
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
  reopening the database and running startup reconciliation through
  `SessionMailbox.start()`. Command sequences produce only states with an
  empty reason set (DF snapshots are seeded separately by Table DF; the
  completeness test, not P4, covers the full axis product). Sequences
  include ordinary publications, plain and from the linked draft,
  attempted with the handoff's derived key before the crash (the
  reviewers' collision traces): each is refused (H33, H33d) and writes
  nothing, and after restart the handoff is exactly as the model holds it
  — an `open` handoff with a current base stays `open` (H29), never
  `published` and never `stale` from the refused attempt. The linked
  variants load a real linked draft first (H19) and also publish it
  (H17, H38, H38s), and the draft load is a boundary too. The model is
  independent of the source: each handoff's event history, the revisions
  by key and association, the durable wakeup rows with their one mail to
  the requester, and the stored linked draft. After every command the
  stored facts equal it, every pending handoff still classifies healthy
  and the linked draft has no U7; every reopen writes nothing (a healthy
  sweep makes no writes: a fault armed on every sweep write never fires,
  and a crash after the sweep's commit reboots to the same rows). Each
  boundary crashes by both kinds on a command that writes. The sweep's
  own faults run on the repairable DF fixtures apart from P4 (DF1, DF2,
  DF3, DF5): a fault at the state write, event, wakeup row or mail rolls
  the repair back whole; the next boot repairs once with one wakeup and
  mail; a boot after the committed repair writes nothing. Seed
  `0x0A11CE04`, 200 cases.
- **P5 limits unchanged.** Seeded plans with parallel limits, dependencies
  and a landing slot, run through the supervision derivation and the
  scheduler's admission with and without random handoffs on running
  changes' tasks: admitted changes, parallel counts, dependency waits and
  the slot holder are identical. Seed `0x0A11CE05`, 200 cases.
- **P6 one derivation.** For random handoff and publication states,
  each reader reports its own projection over one derivation. A pending
  handoff (open or stale, owner and requester live or gone) has the same
  state and next actor in attention, the supervision loader's
  `owner-publication` wait and `task_get`. A published handoff (random
  notices, deliveries, acknowledgements, holder and task closure) has
  `task_get`'s `handoffPhase` and the Attention item, actor and action
  (or its suppression) of the one table W row an independent model
  matches; the loader shows no `owner-publication` wait for it, in
  neither the cause nor the waits also applying (S7). Seed `0x0A11CE06`,
  200 cases.
- **P7 notice actions.** Random histories for one published revision:
  publication with or without notify; notices (none to three, each
  queued, delivered, uncertain or failed, at that revision or a later
  one); ordinary task mail carrying that revision or a later one,
  delivered or not; the claimant live or gone; the task open or closed;
  acknowledgements through `task_acknowledge` with or without any
  delivery. Two invariants, both over every generated history (none is
  filtered out):
  - **P7a suppression.** When the task is closed, or the current
    claimant's acknowledged revision is at least the published one, the
    phase is `task-closed` or `acknowledged` and no follow-up item or
    notice action exists, even where `notify` with a fresh key would
    write. The trace publish without notify → `task_get` →
    acknowledge without delivery is always generated and asserts this.
  - **P7b parity.** Only for an open task with a live current claimant
    whose acknowledged revision is below the published one: run the real
    `TaskNotices.notify` on a copy of the database with a fresh command
    key and count the NEW notification rows it writes (never the
    replay return value). **Notify** or **Retry notification** is offered
    exactly when that count is at least one; confirmed delivery reads
    `delivered-awaiting-ack`, an uncertain notice reads
    `notice-uncertain`, a queued one `notice-queued`, and none of them
    offers either action. The generated histories include a confirmed
    delivery, a queued notice or an uncertain notice at or above the
    published revision followed by a later failed notice: the real
    `notify` writes nothing there, and nothing is offered.
  Seed `0x0A11CE07`, 200 cases.

### Mutation controls

Each named mutant must make at least one cited oracle fail; tasks name
which.

- MU1 the publish key is random instead of `handoff:<id>` (H14, P1).
- MU1b fulfillment and the sweep read the request key instead of
  `handoff_id` (DF4a, DF4b, DF6).
- MU1c the reserved-prefix check is removed (H33, H33d, P4's collision
  traces).
- MU1d the ordinary entry exempts a call whose linked draft carries a
  `handoffId` from the prefix check (H33d: the edited revision is stored
  under `handoff:<id>`, and the later prepared publish then replays it
  through H14 instead of reading H16b).
- MU1e the linked-draft publish writes the derived `handoff:<id>` key
  instead of the caller's ordinary key (H16b, H17r).
- MU2 the stale transition is removed from `TaskStore.publish` (H20, P2).
- MU3 the handoff transition runs after the publish commit (P4).
- MU4 the publisher check accepts any agent of the team (H13).
- MU5 deciding a card that mentions a handoff publishes it (H28, P3).
- MU6 the attention source keeps only `open` (W3, W4).
- MU7 liveness always reads live (W2, F2–F5, D6 recipient rows, DF2's
  exhausted-requester route).
- MU8 `owner-publication` is not appended in `stageWaits` (S1).
- MU9 the request tool is not registered in the team tool server, and
  separately the publish command is missing from the WS whitelist (CP1).
- MU10 the wakeup primary key is dropped (the direct second-write row of
  `taskHandoffWakeups.test.ts`, "a second write of a transition is a
  no-op: no second row and no second message"; P1 keeps its histories
  but cannot reach it, since no healthy path writes a transition twice).
- MU11 the supervision wait frees the change's parallel slot (P5).
- MU12 `amendItems` is not suppressed for a pending handoff (S3).
- MU13 the close hook is missing from the status transaction (H27), and
  separately from `prepareStatus` (H28b, the override cancellation).
- MU15 `handoffPhase` puts `notice-failed` before `acknowledged`, or
  omits `task-closed` (W5, W6).
- MU16 an uncertain notice reads as failed (W9: the item offers Retry
  notification instead of the Mailbox).
- MU15b `delivered-awaiting-ack` is placed after `notice-failed`
  (W12d, P7b: Retry notification is offered and `notify` writes nothing).
- MU15c notice parity is applied before the suppression phases, so an
  acknowledgement without delivery offers **Notify** (P7a, W6).
- MU16b the notice phases read only the newest notice instead of every
  notice at that revision or later (P7b: an older uncertain or queued
  notice behind a newer failed one offers a Retry that sends nothing).
- MU1f the reserved-prefix check reads the raw `requestKey` instead of
  the canonical trimmed key (H33 and H33d whitespace variants: ` handoff:H`
  is accepted, stored as `handoff:H`, and the later prepared publish
  replays it through H14).
- MU19 DF3's seeded tuple is added as an H-RESTART row (negative control:
  the completeness test fails on a tuple whose reason set `{U3}` is
  nonempty and that an H row matches); separately, the classifier keeps
  only the first matching U reason (positive control fails: DF5's set
  reads `{U1}` instead of `{U1, U3, U5}`, DF4b's `{U6}` instead of
  `{U3, U6}`).
- MU21 association is read as "the prepared-key row carries this
  handoff's association" instead of the task-scoped any-key fact: the R3
  and R0 `published` witnesses collapse (R3 reads `{U1}`), so H16b's
  classification assertion fails (H-PUB witnesses, U fact table).
- MU20 the classifier drops `unassociatedReservedKeyPresent` (or H29
  ignores it): paired witnesses (1) and (2) collapse onto one tuple, so
  either the H29/U6 overlap or a missing `{U6}` fails the classification
  assertion, although both restarts are no-ops (H29, DF4a, DF4b's second
  restart, DF5o).
- MU17 the sweep's call is removed from `SessionMailbox.start()` (CP3).
- MU18 the migration is added to the baseline instead of `MIGRATIONS`
  (the migration rows of task 2.1).
- MU14 the replay check compares only the unique key, not the surrounding
  rows (H10/H14 snapshot rows; oracle hazard "An idempotence oracle
  observing only the uniquely constrained row").

Further controls without their own id (each applied once in the task that
names it, with the oracle it must fail): replay looked up before the
publisher right (the H13 former-owner trace returns the revision); request
replay before the requester right or ignoring the requester side (H11s,
the loss-of-eligibility ruling); the reserved-prefix check placed after the
WS rationale guard (the blank-rationale mixed-error row reads the
rationale refusal); size limits checked after the contract parse (H7's
combined ruling); a same-base save dropping the link (H41); a rebase
keeping it (H42, U7); the lineage check skipped or run outside the publish
transaction (H43); the publish intent re-read from the latest draft
snapshot or inferred from a missing identity (the paired H43/H44
witnesses and the client intent trace); an ordinary publication
discarding a replacement linked draft (H44); the wakeup carrying a task attachment (DF2's closure route);
the recipient reselected at boot (CP3's queued wakeup).

### Production-composition checkpoints

- **CP1** (before expanding beyond the request and publish path): through
  the real chat-session composition's `kawai-team` tool server, a Lead
  session calls `task_request_publication` on a Kawai-created task; the
  team workspace snapshot over the real WS connection shows W2, so the
  minimal W2 attention source (pending `open` handoff on an ownerless
  task only) is wired into `workspaceRead.ts` in this checkpoint; the
  human's `team-task-handoff-publish` over the same connection publishes
  revision 2, queues one notice to the claimed holder and one message to
  the requester, and the next snapshot no longer lists W2; a resent
  command replays. Failure paths: a stale-base request is refused through
  the same tool server, and an ordinary `team-task-publish` with a
  `handoff:` key is refused (H33), as is the same key on a linked-draft
  publish (H33d), each leaving W2 listed. Mutants: MU9, and removing the W2
  source's registration fails the snapshot assertion. The remaining W
  rows, F and S3 land in group 8.
- **CP3** (with the reconciliation): boot the production composition
  (`ChatSessionManager` starting `teamMail`) over a database seeded with
  DF3's fixture (an `open` handoff whose task revision is past its base,
  as an older build or a manual edit could leave it) beside a healthy
  `open` handoff with a current base on another task; after start the
  first reads `stale` and one wakeup mail is queued and dispatched, and
  the second stays `open` with no mail (H29). The same boot also carries
  a `published` wakeup that was committed and queued before a crash, with
  its requester's chat record restored live: it is dispatched once by its
  original message id, without reselecting the recipient, and a second
  boot sends no further message. A DF5o fixture whose requester is
  archived reads `published` with one group wakeup through the current
  group routing, and DF2 with a context-exhausted requester in a
  worktree-scoped group delivers its `closed` wakeup to an eligible live
  member, with no task assignment and no restore of the requester.
  Mutants: MU17 (the sweep's call removed) leaves the first `open` with no
  mail; attaching the wakeup to the task as task mail makes DF2's closure
  wakeup dead-letter; reselecting the recipient at boot fails the queued
  wakeup row.
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
  is used only where a running execution owns the next dispatch (W7, F3),
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

Deploy: the numbered migration (D1) runs at the first start of the new
build, after the runner's `pre-migration-<n>` backup, with `up` and its
version row in one transaction; a failure rolls back and leaves the
database at the previous version. Additive tables and nullable columns
only; no existing row changes and nothing is backfilled.

Rollback: an older build refuses to start against the migrated database
(the database-safety startup refusal: a database newer than the build).
To go back, restore the `pre-migration-<n>` backup of this migration as
`docs/operations/database-backups.md` describes; handoffs and anything
written after the upgrade are lost with that restore, which the same page
states. There is no in-place downgrade.

## Implementation contract

### Acceptance
- A1: `task_request_publication` records one `open` handoff per H-REQ (H1–H11) with exact task, base revision and contract identity, requester, payload hash, base commit and evidence, and no revision, notice, publication fact or mail. Scope and current requester rights precede replay. Keep per-task key uniqueness and return exact replays only to the still-eligible original requester or its recorded group. Preserve their replay after a stale or closed transition. Refuse a different requester side or payload without returning the earlier handoff or writing.
- A2: **Publish prepared revision** publishes exactly one revision with the prepared fields, notices per notify, and a server-written `handoff_id`. Scope and current publisher rights precede rejection of prepared payload overrides, replay and state checks (H-PUB, 140 tuples, 32 admitted). Fulfillment is the task-scoped any-key association, independent of prepared-key lookup. Only an authorized associated prepared replay returns that revision. DF6/DF6p refuse an orphan key. Ordinary publication trims its key once and refuses the reserved `handoff:` prefix before the WS rationale guard, addressed task/draft reads, lookups or writes, with no linked-draft exemption. Its key namespace stays disjoint from prepared publication. Keep ordinary same-payload replay and differing-field refusal.
- A3: Every publication not from a pending handoff makes it `stale`, every task close (including `prepareStatus` and override cancellations) makes it `closed`, decline and withdraw end it with reason and actor, and neutral events change nothing, per H-OTHER, H-SETTLE, H-CLOSE and H-NEUTRAL (H20–H28b, H39, H40).
- A4: The schema is one numbered migration appended to `MIGRATIONS` (never the baseline or a constructor), and startup reconciliation runs from `SessionMailbox.start()` before dispatch release, changing nothing in the healthy domain (H29, which requires neither an associated revision nor an orphan reserved key in one pre-sweep snapshot) and applying DF1–DF5o once to seeded defensive fixtures (CP3), with its row in `docs/recovery-matrix.md`.
- A5: Each `published`, `declined`, `stale` and `closed` transition enqueues exactly one system notification in its transaction, to the live requester or its group. It carries task and handoff identity without attaching task work. The real scoped-group route delivers closure mail despite task-close filtering. A committed queued wakeup is dispatched after restart by its original identity, and a failed delivery does not undo the transition.
- A6: The workspace attention snapshot matches tables W (W1–W13 with W12d, in `handoffPhase`'s order: closed, acknowledged, no holder, delivered awaiting acknowledgement, uncertain, queued, failed, not notified) and F; a closed task or the current claimant's acknowledgement of the published revision suppresses every follow-up item and notice action even where `notify` could still write (P7a), and only for an open task with a live claimant below that acknowledgement are **Retry notification** and **Notify** offered exactly when `TaskNotices.notify` with a fresh key writes a new notice (P7b); and the post-Amend item is suppressed per S3.
- A7: Supervision lists `owner-publication` per S1–S2, keeps S6's precedence, names a gone holder per S5, and follows transitions S7–S10, with parallel counts, dependencies and landing slot unchanged (P5).
- A8: `task_get` shows handoff rows and one handoff whole, team-scoped; delivered task context names a pending handoff without using its text as the direction.
- A9: The task detail shows the handoff panel with diff, provenance and the three actions; the agent guidance names `task_request_publication` and states that a card answer publishes nothing.
- A10: Saving the same observed linked draft at the same base preserves its server-owned association; moving the base keeps the text and detaches it. For a new save or publication using the linked draft, verify the observed draft identity, stored link and base before writing or discarding. A stale form encountering a replacement linked draft is refused without mutation. A legitimate edit publishes the linked revision once, a matching resend works after draft discard, and a reused key for a different linked intent is refused. Explicit ordinary publication leaves a replacement draft intact and retains existing stale, ended-handoff and replay behavior.

### Invariants
- I1: Only the human or the current live task owner publishes or declines. Withdraw and supersede keep requester-side rights. Task closure and D7 reconciliation reflect authorized persisted facts. A card answer, mail, note, elapsed time, ordinary restart or archival never publishes or settles a handoff.
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
- `src/server/team/sessionMailbox.ts`
- `src/server/dbSafety/migrations.ts`
- `src/server/plans/decisions/fixTasks.ts`
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
- V1: Tables H (every partition), W, F and S (rows and transitions S7–S10) are committed verbatim as table-driven tests beside the code they cover, with H's completeness test enumerating each partition's full axis product against its rows and U1–U7 (an empty reason set matches exactly one row; a nonempty set, possibly of several reasons, matches no row and is kept whole), the DF fixtures in their own test classified with their complete reason sets before their repair is asserted, and W's completeness against W1–W13 with W12d.
- V2: P1–P7 run with the stated seeds and case counts through `propertyCases`; P4 runs the H table as the reference model with a crash at each named transaction boundary.
- V3: Each mutant MU1–MU21 (with MU1b–MU1f, MU15b, MU15c, MU16b) is applied once and makes its cited oracle fail; the result maps each oracle id to a test title and a killed mutant.
- V4: CP1, CP2 and CP3 pass through the production composition before the work expands past them, with their failure paths and omission mutants.
- V5: The inputs-only commit, cross-model blind output, sealed author outputs and comparisons are journaled. The Lead binds the exact resolved OpenSpec artifact commit before any production code.
- V6: `bun run check` passes on the clean committed head with the pinned Bun, and `scripts/verify-result.ts` runs on the submitted commit; UI changes are verified in a real browser against a disposable server and database. The migration is covered by `src/server/__tests__/schemaMigrations.test.ts` and a new migration test (fresh database, a database at the previous version, a failing `up` rolling back with its backup).

### Excluded
- X1: No change to who may publish, approve, Stop, Retry or accept; no Lead publication right for unowned tasks.
- X2: No backfill from existing cards, notes, receipts or private evidence, and no amendment of existing tasks or plans.
- X3: No parsing of decision answers, notes or mail into publications.
- X4: No change to scheduler admission, parallel limits, dependencies or the landing slot.
- X5: No main-spec sync or archive in the implementation task; that is the archive step's.

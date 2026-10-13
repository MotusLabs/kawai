# Design

## Context

Direction lives in immutable `team_task_revisions` rows; `team_tasks.revision` names the current one, and `TaskStore.amend` bumps it and inserts the row in one transaction. `TaskService.amend` is reached from the agent tool `task_amend` (`taskTools.ts`, creator-only) and from the UI's `team-task-amend` (`taskConnections.ts` `act`, human caller); `TeamTaskDetail.tsx` offers one **Save as revision N** button. So there is no draft, no rationale, and no notification: an agent learns of a change only when some later task mail is pushed, because `buildTaskContext` builds the header at push time (`dispatcher.ts`, `TeamMailbox.deliverOnSend`).

`team-message-threads` (merged) records the revision the pushed context carried — `markPushed(id, now, task?.revision)` writes `team_messages.task_revision` — and keeps an append-only `team_message_events` history; its D6 names this change as the consumer of that column. `task-assignment` (specified, implementation in flight) adds `team_task_assignments`: one row per dispatch, the *outstanding* assignment per task (newest, not superseded, not failed), `claimed_by` copied from the instruction mail's claim and cleared on release/requeue, derived state from the mail, human-originated mail (`from_kind: 'human'`), and request-key idempotency (`INSERT OR IGNORE` by key, compare normalized payload, replay returns the prior row).

The approved strategy (revision 2) makes owner overrides forward fixes and never blocks execution on the owner (P2, P3). That rules out anything here that stops agents; a change of direction must instead *reach* executors traceably.

## Goals / Non-Goals

**Goals:** drafts that are inert; publication that is exactly-once per intent and carries a rationale; notices that ride the existing mailbox (claims, receipts, uncertainty, events) bound to assignments; Queued / Delivered / Acknowledged derived from facts Kawai already records plus one new acknowledgement fact; idempotent notify/retry; a revision-published fact for `task-results-handoffs`.

**Non-Goals:** everything in the proposal's non-goals, in particular all of Wave C `revision-control` (Impact Holds, checkpoints, writer stop/fencing, barriers, Pause/Continue/Adapt/Restart, compatibility and materiality decisions). Also no change to delivery, claim, routing, or staffing rules: a notice is ordinary direct task mail.

## Decisions

### D1. Drafts: one human draft per task, CAS on its base revision

```sql
team_task_drafts (
  task_id TEXT PRIMARY KEY,
  base_revision INTEGER NOT NULL,   -- the published revision it edits
  direction TEXT NOT NULL,
  acceptance TEXT,
  rationale TEXT,
  updated_at TEXT NOT NULL
);
```

The owner is the only human (strategy boundary "Multi-user team supervision is out of scope"), so one draft per task suffices; saving overwrites it. A draft is read only by the human paths (`team-task-detail` gains `draft`); `TaskStore.get/list/detail` as used by agent tools and `buildTaskContext` never join it, so it cannot leak into a header or `task_get`. Saving a draft republishes the task detail to subscribed UI clients (metadata refresh) but does not touch `team_tasks.updated_at`, emits no store listener event that `TaskConnections` would treat as a task change for agents, and writes no mail. When another revision is published, the draft stays with its old `base_revision`; the UI shows "based on revision N; current is M" and **Rebase onto revision M** updates only `base_revision` (keeping the text) after the human has looked at the newer revision. *Alternative:* per-author drafts as in `strategy_drafts` — rejected: agents get no drafts (D7) and there is one human.

### D2. Publication extends `team_task_revisions`; base-revision CAS plus a command key

`team_task_revisions` gains nullable `rationale TEXT`, `request_key TEXT`, and `notify INTEGER` (0/1; NULL for rows that predate this change), with `UNIQUE (task_id, request_key)` where the key is set. `TaskStore.amend` becomes `TaskStore.publish(id, {direction?, acceptance?, rationale?, baseRevision?, requestKey?, notify}, author)`; in one transaction it (1) looks up an existing row by `(task_id, request_key)` and, if found, compares the normalized payload — equal returns that revision, different refuses "request key reused" naming the field; (2) refuses `stale: revision M was published since revision N` when `baseRevision` is given and differs from `team_tasks.revision`; (3) inserts revision N+1, bumps `team_tasks.revision`, deletes the draft when the publication came from it, journals nothing extra (the revision row is the record); (4) for notify, writes the notices (D3). The human UI always sends `baseRevision` and a client-minted key (minted when the Publish dialog arms, reused on every resend, like `task-assignment` D4); the agent tool sends neither, so agents keep today's last-writer-wins semantics, which is safe because an agent call is a single synchronous request. Rationale is optional at the store (agents and legacy rows); the UI form requires it for **Publish** and **Publish and notify**.

*Why columns, not a separate publications table:* a revision *is* the publication; one row keeps "immutable revision with rationale" a single fact and keeps `TaskRevision` the type everything already reads.

### D3. Notices: direct task mail bound to (assignment, revision), written in the publication transaction

```sql
team_task_notifications (
  id TEXT PRIMARY KEY,              -- 'notice-<uuid>'
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL,        -- the revision announced
  assignment_id TEXT NOT NULL,      -- task-assignment's row
  recipient_session TEXT NOT NULL,  -- the claimant at notify time
  message_id TEXT NOT NULL,         -- the team_messages row
  request_key TEXT NOT NULL,        -- the publish or notify command key
  created_by_kind TEXT NOT NULL, created_by_session TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX team_task_notifications_key ON team_task_notifications (task_id, request_key, assignment_id);
```

Recipients are computed inside the transaction from `task-assignment`'s outstanding assignment: if it has a `claimed_by`, one notice to that session; otherwise none (a queued group instruction is built at push, so it already carries the newest revision — the one-member group dispatch rule is never bypassed). The mail is an ordinary `team_messages` row: `to_kind 'session'`, normal priority, `task_id` set, tag `task-revision`, sender = the publisher (human per `team-message-threads` D4, or the creating agent), and a new nullable `revision_notice` JSON column `{revision, previousRevision, assignmentId, rationale}` that `messageEnvelope` copies into the envelope as `revisionNotice` and `parseEnvelope` accepts additively (older envelopes parse unchanged). The body is fixed text: "Task <title> revision N published by <publisher>: <rationale>. Read the direction above and call task_acknowledge(task_id, <revision in the header>) when you are working from it." Enqueuing goes through `MailboxStore.enqueue` inside the same SQLite transaction as the revision — both stores share the database handle — so there is never a published notify-revision without its notices nor a notice without its revision. Direct mail to an archived claimant restores it (existing `agent-mailbox` rule); to a killed claimant it is dead-lettered at enqueue, which the detail shows as Failed. The existing hop limit, receipts, uncertain holds, and `team_message_events` apply unchanged.

*Why normal priority only:* urgent delivery interrupts a turn, which is the Wave C pause/stop territory; P2 says execution is not blocked on the owner. The human can still send urgent mail through the composer.

### D4. Notify and retry are one idempotent command

`team-task-notify {taskId, revision, requestKey}` (UI) recomputes recipients for a published revision and sends a notice to each outstanding-assignment claimant that (a) has not been delivered task mail for this task carrying `task_revision >= revision` and (b) has no notice for this revision whose mail is still pending (queued/claimed/pushed/spawning/awaiting-request). It is used both for **Notify** after a plain publish and for **Retry notification** after a Failed notice; a notice that was superseded by a newer revision is not re-sent for the old one (the newer revision's notice covers it). Rows are written with the command's key, so a replay finds `(task_id, request_key, assignment_id)` present and returns the prior outcome without enqueuing. It never touches `team_task_revisions`. Uncertain notices are resolved through the mailbox's existing Retry/Discard (possible-duplicate notice on retry), not duplicated here; the publication detail links to them. Failure never rolls back the revision because publication committed first and notify is separately keyed.

### D5. Delivered and acknowledged are derived, never stored as state

Per outstanding assignment holder and per published revision R, `publicationRecipients(taskId, R)` derives:

- **Notice state** from the newest notice for R to that holder: none → *Not notified*; mail queued/claimed/pushed/spawning/awaiting-request → *Queued*; delivered → *Delivered*; dead/cancelled/discarded → *Failed* with the mail's reason; held-uncertain → *Uncertain*.
- **Delivered revision** = `MAX(task_revision)` over `team_messages` with this `task_id`, state `delivered`, and recipient (direct `to_session` or claimant) = the holder. Any delivered task mail counts, not only notices, because what matters is which direction the agent has been shown; this is the revision-at-push column `team-message-threads` D6 records.
- **Acknowledged revision** = the holder's highest acknowledged revision (D6).

The UI never collapses these: "Delivered rev 2 · Acknowledged rev 1" is a normal display. Status pushes reuse the existing task-mail republish path (`TaskStore.touch` on task-mail changes) plus a touch on acknowledgement.

### D6. Acknowledgement: `task_acknowledge`, keyed by session, read through the current claimant

```sql
team_task_acknowledgements (
  task_id TEXT NOT NULL, session_id TEXT NOT NULL, revision INTEGER NOT NULL,
  assignment_id TEXT,               -- the session's outstanding assignment then, if any
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, session_id, revision)
);
```

`task_acknowledge(task_id, revision)` joins `TASK_TOOL_NAMES` (no approval card, like the other task tools), is identity-bound, refuses another team's task and any revision greater than `team_tasks.revision` (so a draft can never be acknowledged), and `INSERT OR IGNORE`s. Acknowledging an older revision is allowed and recorded (it is true information) but the detail shows it against the current one. Any team session may acknowledge — work handed out by `send_message` with a `task_id` and no assignment record still gets a durable ack — but only an assignment's **current claimant's** acknowledgements are shown on that assignment. Because `claimed_by` changes on reassignment (new row), on release/requeue to another member, and on forwarding (the successor message's claimant), a replacement session starts with no acknowledged revision and must acknowledge current inputs; earlier claimants' rows stay in the table and in the detail's history. The team prompt's task note (`teamPrompt.ts`) gains one line: when you start or take over work on a task, or receive a revision notice, call `task_acknowledge` with the revision in the task header once you are working from it. *Alternative:* acknowledgement by replying to the notice — rejected: replies are free text in a thread, would need parsing, and an agent taking over without a notice has nothing to reply to.

### D7. Agents: `task_amend` publishes, gains `rationale` and `notify`, no drafts

Creator rights are unchanged (`TaskService.amend`'s check stays). `task_amend` keeps publishing immediately — an agent drafting in its own context is already a draft, and a server-side agent draft would be state no one reviews. It gains optional `rationale` and `notify` (default false), mapping to Publish revision / Publish and notify with the agent as author and notice sender. The tool description and the team prompt line for `task_amend` are updated accordingly. The human's `team-task-amend` message is replaced by `team-task-draft`, `team-task-publish`, and `team-task-notify`; `team-task-amend` is removed from the client and from the chat-connection message whitelist (`src/server/chat/chatConnectionTypes.ts`, which `ws/messageRouter.ts` consults) in the same change, with the new types added there, since only this repository's client speaks it.

### D8. The revision-published contract for `task-results-handoffs`

The durable fact is the `team_task_revisions` row (task, revision, previous = revision − 1, author, rationale, `created_at`); ordering is the revision number, and `team_tasks.revision` names the current one. Consumers compare against these rows at read time — `task-results-handoffs` derives Needs re-evaluation from `result.task_revision < team_tasks.revision` and stores no marks. Optionally, for in-process consumers that want a push, `TaskService` gains `onRevisionPublished(listener)` fired once after the publication transaction commits, with `{teamId, taskId, revision, previousRevision, author, rationale, publishedAt}`; a replayed command does not fire it again, and drafts, notices, retries, and acknowledgements never fire it. The event carries nothing the rows lack, so no consumer needs it for correctness. What happens to earlier results — the Needs re-evaluation label and its rules — is `task-results-handoffs`' to specify; this change neither labels results nor blocks on them.

### D9. Historical rows are facts at push time

Nothing here updates `team_messages.task_revision` or rewrites a transcript. Peer rows (`ChatMessages.tsx` `peer-task` summary) render the envelope as delivered; thread rows show `task_revision`. A notice queued for revision 2 and pushed after revision 3 was published carries revision 3 in its context (built at push) and `revisionNotice.revision = 2`; the peer row shows "Revision 2 published" with the header's revision 3, and its delivered revision counts as 3 (D5).

## Risks / Trade-offs

- [Implements after `task-assignment`; until then there are no assignment holders] → sequencing: this change implements once `team_task_assignments` lands. Acknowledgements are still recorded for unassigned work (D6).
- [Notices reach only the outstanding assignment's claimant, not every session that touched the task] → deliberate: the executor is the assignment holder (UX §7). Others see the new revision on their next task mail; the human can message them through the composer.
- [Normal-priority notices wait for a busy agent's turn to end] → accepted; interrupting is Wave C. The detail shows Queued meanwhile.
- [Agent amendments stay last-writer-wins] → an agent call is one synchronous request with no reconnect replay; the human path, where replays happen, is keyed and CAS-guarded.
- [Draft text can go stale against a newer revision] → publication refuses it; rebasing is an explicit step.

## Migration Plan

Additive only, via the `migrateTable` PRAGMA-check pattern: create `team_task_drafts`, `team_task_notifications`, `team_task_acknowledgements`; add `rationale`, `request_key`, `notify` to `team_task_revisions` with the partial unique index; add nullable `revision_notice` to `team_messages`. Existing revisions read with no rationale and `notify` NULL (shown as "published before notifications"). Rollback drops the new tables and columns; delivered history is untouched.

## Decisions (made by the lead's delegation, 2026-10-14)

- **Q1 — Agent semantics:** agents publish (no draft tool) with optional `rationale`/`notify`; creator rights unchanged (D7). *Rationale:* drafts exist so the human can work without publishing; an agent's working context already is that.
- **Q2 — Recipients:** the claimed agent of the outstanding assignment only; unclaimed group assignments get no notice (D3). *Rationale:* matches UX §7 "affected executor through a direct envelope bound to its assignment" and keeps group mail one-member dispatch.
- **Q3 — Priority:** notices are normal priority, never urgent (D3). *Rationale:* strategy P2 — never block or interrupt execution for the owner; interruption belongs to Wave C pausing.
- **Q4 — Acknowledgement protocol:** an explicit `task_acknowledge` tool keyed by session, displayed through the current claimant (D6). *Rationale:* explicit, structured, and gives replacement sessions a clean "must acknowledge" state.
- **Q5 — Delivered revision:** derived from any delivered task mail's recorded `task_revision`, not only notices (D5). *Rationale:* the question is what the agent was shown; revision-at-push already records it.
- **Q6 — Rationale:** required by the human publish form, optional for agents and legacy rows (D2). *Rationale:* keeps `task_amend` callers working while every human direction change is explained.
- **Q7 — Draft visibility and count:** one human draft per task, never visible to agents (D1).
- **Q8 — Archived claimants:** notices follow existing direct-mail rules and restore an archived claimant (D3). *Rationale:* an outstanding assignment is still that agent's responsibility; a special case would diverge from `agent-mailbox`.

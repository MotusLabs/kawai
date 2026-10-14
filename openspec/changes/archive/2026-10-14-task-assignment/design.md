# Design

## Context

`team-tasks` stores the work (`team_tasks` + revisions + journal in `TaskStore`) and `agent-teams`/`agent-mailbox` deliver it (`team_messages` in `MailboxStore`, claimed atomically by `MailDispatcher`, spawned members reserved by `WorktreeStaffing`). What is missing is the link between them that names an owner: today a human or lead composes mail by hand with a pasted task id, and nothing records "assigned to group X with role Y, claimed by session Z". Participants are derived (`TaskStore.summary`: creator + `chat_sessions.task_id` + mail senders/claimants + journal authors) — an association trail, not accountability. `chat_sessions.task_id` is a session's *current working task*, overwritten by later task mail and pinned for spawned members; it cannot serve as an assignment record.

Dispatch should reuse the mailbox rather than parallel it: atomic claims, idle-gated delivery, worktree filtering (`MailDispatcher.inWorktree`), bounded spawning, and transcript-confirmed receipts already exist and are specified in `agent-mailbox` / `team-worktree-staffing`. The new pieces are the record, the human as sender, and idempotency.

The human mail-actor plumbing is owned by `team-message-threads` (its design D4/D5, `agent-mailbox` delta), which ships first: its guarded `team_messages` rebuild makes `from_session` nullable and adds `from_kind` (`'agent' | 'human'`, `TaskActor`'s vocabulary) and `to_kind: 'human'`, and its envelope gains `senderKind` with a nullable `senderSession`. This change is sequenced after it and only *produces* human-originated rows; it defines no sender schema of its own. (Ruled 2026-10-13: `from_kind` is an actor discriminator and `to_kind` a routing discriminator — deliberately different vocabularies, per `team-message-threads` D4.)

## Goals / Non-Goals

**Goals:** one durable assignment record per dispatch with visible history; dispatch driven by the human from create-form and task detail; exactly-once task creation and instruction dispatch per user intent across reconnects and double clicks; previews computed from the same state the dispatcher uses; pickers fed by the same validators that gate creation.

**Non-Goals** (beyond the proposal's): changing any delivery, claim, routing, or staffing rule — assignment dispatch is an ordinary producer of task mail; automatic task-status transitions on dispatch; any human reply or composer surface (`team-message-threads` owns it); assignment tooling for agents.

## Decisions

### D1. A new `team_task_assignments` table, not columns on `team_tasks`

One row per dispatch, append-only like the rest of the task schema:

```sql
team_task_assignments (
  id TEXT PRIMARY KEY,            -- 'assignment-<uuid>'
  team_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  request_key TEXT NOT NULL,      -- the dispatch identity (D4)
  target_kind TEXT NOT NULL,      -- 'group' | 'session'
  target_id TEXT NOT NULL,        -- group id, or session id
  role TEXT,                      -- the requested role: the group id (both kinds
                                  -- when known; null for a groupless session)
  instruction TEXT NOT NULL,      -- the initial instruction, kept verbatim
  created_by_kind TEXT NOT NULL,  -- 'human' in this change
  created_by_session TEXT,
  message_id TEXT,                -- the enqueued instruction mail (D3)
  claimed_by TEXT, claimed_at TEXT,  -- copied from the mail's claim (D5)
  superseded_by TEXT,             -- the assignment that replaced this one
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX team_task_assignments_key ON team_task_assignments (team_id, request_key);
CREATE INDEX team_task_assignments_task ON team_task_assignments (task_id, created_at);
```

Actor columns use the one shared vocabulary `team-message-threads` D4 introduces (`TeamActor`, of which `TaskActor` becomes an alias), so `created_by_kind` stays aligned with `team_tasks.creator_kind` and `team_messages.from_kind` rather than becoming a third copy.

The **outstanding** assignment is the newest row for the task whose `superseded_by` is NULL and whose derived state (D5) is not `failed`. Delivered, parked, forwarded, and uncertain assignments stay outstanding — reassignment onto them still prompts for notify/stop — while a dead-lettered instruction ends its assignment's standing. ("Settled" is deliberately not used here: `team-message-threads` D5 spends it on human-directed mail delivered on send.)

*Why a table:* assignment is a series of events over a task's life (assign, claim, supersede, fail), so any column-on-`team_tasks` design degenerates into a single mutable slot that destroys history the first time work is reassigned. A table gives "assigned to group X with role Y, claimed by session Z" as a queryable fact without assuming a Plan exists, keeps the record independent of `chat_sessions.task_id` (which stays a session's current working task, untouched), and follows the house pattern of immutable task tables. *Alternative:* `assigned_*` columns on `team_tasks` — rejected: no history, and Wave B2 (results, revision publication) needs to reference "the assignment affected".

`TeamTaskSummary` gains `assignment` (target, role, state, claimedBy) and `TeamTaskDetail` gains `assignments` oldest-first. A task with no rows is unassigned. Association still happens the existing way: delivering the instruction mail calls `associateTask`, so the recipient's header/task badge works unchanged — the assignment is accountability, the association is context.

### D2. Human-originated mail rides `team-message-threads`' actor model

The instruction is a normal `team_messages` row so everything downstream applies unchanged. Its sender is the human exactly as `team-message-threads` specifies and ships first: `from_kind: 'human'`, `from_session` NULL (the relaxed column its rebuild provides), `from_group` NULL, and `origin_path` = the team's main checkout root — stable regardless of which chat's panel dispatched. The envelope's `senderKind` and the peer row's Human label are that change's; dispatch instructions just carry them. An agent's reply in the human-started thread reaches the human (`to_kind: 'human'`, settled on send, toast to connected clients, thread row) per its D5 and `agent-mailbox` delta — this change adds nothing to those rules and must not disagree with them. The task journal stays what it already was: a complementary, always-visible record on the task itself, not the destination replies are redirected to. One participant derivation depends on the sibling too: `taskStore.summary`'s participants query must skip human senders (`from_session IS NOT NULL`, `team-message-threads` design D3) or the instruction's human sender surfaces as a null participant; this change depends on that fix and does not re-specify it. *Rejected alternative (ruled out 2026-10-13):* refusing replies to human-originated mail and steering to `task_note` — a thread the human can never get an answer in is broken. *Rejected alternative:* carrying an additive `from_kind` column with a sentinel `'human'` sender session — a design that exists only to avoid a migration the other change requires anyway; it would leave the sentinel for the rebuild to clean up.

### D3. Dispatch is one transaction: assignment row + instruction mail

`AssignmentService.dispatch(taskId, target, instruction, requestKey)` validates (task of the caller's team; group exists in the team catalog; session target is live, non-archived, same team; instruction non-empty), then in one SQLite transaction inserts the `team_task_assignments` row (whose derived state, D5, starts as `queued`) and enqueues the instruction mail (normal priority, `task_id` set, sender = human per D2). Because both rows commit together, there is no durable state where the assignment exists but the instruction was never sent — an accepted dispatch always has its mail, and the failure modes collapse to *validation refusal* (nothing written; draft stays client-side; E02) or *accepted* (queued, owned by the dispatcher). "Create and assign" runs `TaskService.create` then `dispatch`; the create commits first, so a dispatch refusal provably leaves the task behind with the draft retained.

Group targets ride existing semantics untouched: group mail routes to one eligible member (`agent-mailbox` "Group messages are handled by exactly one member"), worktree tasks filter and may spawn (`team-worktree-staffing`), receipts confirm delivery. Direct-to-session assignment also produces group-free direct mail; both carry the task header (`buildTaskContext`) above the human's instruction text.

### D4. Request identity: a client-generated key, unique per team, on both tables

`team_tasks` gains nullable `request_key` (unique per team); `team_task_assignments.request_key` is NOT NULL with the same composite uniqueness. One key names one user intent: the client mints it when a **Create and assign** (or **Assign / send task**, or plain **Create task**) action is first armed and reuses it for every retry of that action; a *new* assignment (a reassignment) gets a fresh key. The write path is insert-then-read: `INSERT OR IGNORE` by key, re-read the row, and if it exists compare payloads — same payload returns the prior row as the outcome, different payload refuses with "request key reused". Payload identity covers the *request* fields only: title, direction, acceptance, parent, worktree, and change for create; target and instruction for dispatch. Post-create mutations (status, later revisions) and the reassignment `handling` flag are never payload differences, so a replay after the human marked the task active still returns the prior row. Because both replay paths resolve inside SQLite against committed rows, a reconnect resend, a double click, or a crash-then-retry cannot add a second task or instruction (E01). Payload comparison is on the normalized fields the server would store, not a hash of raw input, so refusals can name the differing field. *Alternative:* server-minted keys with a client echo — rejected: the client must generate the key *before* the first send for a reconnect during submission to reattach to the same intent.

### D5. Assignment state is derived from the mail at read time

Nothing duplicates the mail state machine. `assignmentState(row, message)` maps every `MessageState`: `queued` while the mail is queued/spawning/awaiting-request (a queued group assignment shows `role` with `claimed_by` NULL), `claimed` once claimed, `delivered` once the receipt is confirmed, `failed` when the mail settles dead/cancelled/discarded (reason shown), `superseded` when `superseded_by` is set regardless of the mail, and the three post-delivery limit states keep their own names so nothing falls through: `parked` (held on its agent after a provider limit, resume scheduled), `forwarded` (the mail's reason names the successor message carrying the work), and `uncertain` (held for human resolution after an unverifiable receipt). `claimed_by`/`claimed_at` are copied from the mail when the dispatcher claims (the existing `claimed` hook) and cleared again when the mail's claim is cleared by release or requeue, so a released assignment derives `queued` with no claimant — past claimants remain in the mail's append-only event history (`team-message-threads` D2). Spawn reservation shows as queued/"starting" — the *reason* a queued assignment waits (idle member, caps, occupied worktree) belongs to `team-waiting-reasons` and is deliberately not taxonomized here.

### D6. Preview: read-only, from the same sources the dispatcher uses

`team-task-preview` answers for a `{worktree?, target}` pair without writing anything: the target worktree (resolved via `TeamWorktrees.resolveTarget`), the group's role label and its `profiles`/`approval` (`GroupDefinition`), the effective profile — a session target's `claudeProfileId`, or for a group target with no member yet the profile a spawn would use (first allowed by the group's strategy and caps, via `buildCandidates`/`WorktreeStaffing` counts re-exposed as a pure preview helper, never `spawnFor`), and staffing availability (idle matching members, spawn slot open / which cap blocks). For a session target the preview also reports the session's resolved worktree (`worktreeRootOf`) and warns when it differs from the task's worktree; dispatch stays allowed (ruled 2026-10-13: warn but allow). Preview is advisory; `dispatch` revalidates every constraint, so a stale preview can mislead but cannot misroute.

### D7. Reassignment supersedes; only stop cancels undelivered mail

Dispatch onto a task with an outstanding assignment requires `handling: 'notify' | 'stop'` from the client. Everything the reassignment writes — the old row's `superseded_by`, the new assignment row, its instruction mail, the cancel-on-stop, and the notify note — commits in the same single transaction as D3's pair, so a crash cannot leave two non-superseded rows or silently drop the note, and a same-key retry returns the completed prior outcome. **Stop** cancels the old instruction through the existing cancel path, which accepts exactly `queued` and `awaiting-request` (the same states the human's mailbox cancel uses): a claimed or delivered instruction is left alone, so the previous recipient's session and work are never touched (killing/archiving a session is `task-results-handoffs` "Release worktree" territory), and an instruction reserved for a spawn (`spawning`) is equally not cancellable here — it is left to staffing's own lifecycle, where a failed spawn requeues it (cancellable by a later stop) and a successful spawn delivers it with the supersession standing and nobody interrupted. **Notify** sends the previous `claimed_by` (when one exists) a normal-priority direct human-originated note naming the reassignment; with no claimed agent, notify degrades to a plain supersede. The requirement that the human choose is enforced server-side: dispatch without `handling` onto an outstanding assignment is refused with the outstanding assignment's target and state in the error.

### D8. Pickers: one request/response over the chat WebSocket

`team-task-targets` (scoped by the session's team, like every task request in `taskConnections.ts`) answers `{worktrees: [{root, branch?}], changes: [{name, locations: [...]}]}`: worktrees from `TeamWorktrees.list` with branches from the existing porcelain parser; changes from the `openspec/changes/<name>` directories (excluding `archive`) under the team's main checkout root and each listed worktree — exactly the roots `TaskService.validateChange` accepts, so a listed choice always validates. The client re-requests when the picker opens or regains focus; no subscription (worktree sets change rarely and the TTL-cached listing is cheap). The picker component is a filter-as-you-type combobox with an advanced manual-entry mode that submits the typed value through the same server validation; its create-worktree link opens the existing `CreateWorktreeModal` / `create-change-worktree` flow and preselects the new root on return. Manual entry is how cross-session pasted paths keep working; it is not a second validation path.

### D9. No dispatch side effects on task state

Dispatch writes the assignment, the mail, a journal entry ("assigned to <target> by human"), and nothing else. Task status stays under the existing rules (`team-tasks` "Task status and closing") — no automatic `open → active`, ruled 2026-10-13. The assignment record, not a status value, is what shows responsibility; conflating them would make a queued assignment indistinguishable from a stuck task.

## Risks / Trade-offs

- [This change cannot implement before `team-message-threads` lands its rebuild] → sequencing is ruled: threads ships first; its `agent-mailbox` delta already specifies the sender and reply behavior this change rides, so no interim shape is needed.
- [Preview and dispatch race (member goes busy, cap fills)] → preview is explicitly informational; dispatch revalidates and refuses or queues as its outcome, which is then visible as the assignment state.
- [Group assignment queues indefinitely when nobody is eligible and staffing cannot spawn (main-checkout tasks never spawn)] → correct per current staffing rules; visibility of *why* it waits is `team-waiting-reasons`, and the human can reassign or stop.
- [Instruction text is stored twice (assignment row + mail body)] → deliberate: the assignment row is the durable historical record of what was sent; the mail row is the delivery vehicle.

## Migration Plan

Additive only, and only what this change owns: create `team_task_assignments` and `ALTER TABLE team_tasks ADD COLUMN request_key TEXT` with its unique-per-team index (the `mailboxStore.migrateTable` PRAGMA-check pattern). The `team_messages` rebuild (nullable `from_session`, `from_kind`, `to_kind: 'human'`) belongs to `team-message-threads` and has already landed when this change implements. Existing rows are keyless tasks; rollback is dropping the new table/column.

## Decisions (human rulings, 2026-10-13)

- **Q1 — dispatch and task status: no automatic change** (D9). Dispatch never rewrites task status; the assignment record carries responsibility.
- **Q2 — reassignment notify: a fixed normal-priority direct note** — "Task <title> was reassigned to <target>; your work is not cancelled — report status with a journal note if still relevant." Not configurable.
- **Q3 — direct assignment to a session outside the task's worktree: preview warns, dispatch allows** (D6). Manual sessions move; the human's choice is explicit.
- **Q4 — no agent-side assignment tool in this change.** Agents keep `send_message` with `task_id`; revisit at Wave B2 result handoffs.
- **Q5 — plain Create task also takes a request key.** Falls out of D4 and kills duplicate tasks on reconnect or double click.
- **Human mail actor and sequencing: `team-message-threads` owns the migration and ships first; replies in human-started threads are allowed** (settled on send, toast, thread row). Recorded in the Context and D2 above.

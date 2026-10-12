# Design

## Context

`team-tasks` stores the work (`team_tasks` + revisions + journal in `TaskStore`) and `agent-teams`/`agent-mailbox` deliver it (`team_messages` in `MailboxStore`, claimed atomically by `MailDispatcher`, spawned members reserved by `WorktreeStaffing`). What is missing is the link between them that names an owner: today a human or lead composes mail by hand with a pasted task id, and nothing records "assigned to group X with role Y, claimed by session Z". Participants are derived (`TaskStore.summary`: creator + `chat_sessions.task_id` + mail senders/claimants + journal authors) — an association trail, not accountability. `chat_sessions.task_id` is a session's *current working task*, overwritten by later task mail and pinned for spawned members; it cannot serve as an assignment record.

Dispatch should reuse the mailbox rather than parallel it: atomic claims, idle-gated delivery, worktree filtering (`MailDispatcher.inWorktree`), bounded spawning, and transcript-confirmed receipts already exist and are specified in `agent-mailbox` / `team-worktree-staffing`. The new pieces are the record, the human as sender, and idempotency.

## Goals / Non-Goals

**Goals:** one durable assignment record per dispatch with visible history; dispatch driven by the human from create-form and task detail; exactly-once task creation and instruction dispatch per user intent across reconnects and double clicks; previews computed from the same state the dispatcher uses; pickers fed by the same validators that gate creation.

**Non-Goals** (beyond the proposal's): changing any delivery, claim, routing, or staffing rule — assignment dispatch is an ordinary producer of task mail; automatic task-status transitions on dispatch; a human reply surface (refusal + journal guidance only, until `team-message-threads`); assignment tooling for agents.

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

*Why a table:* assignment is a series of events over a task's life (assign, claim, supersede, fail), so any column-on-`team_tasks` design degenerates into a single mutable slot that destroys history the first time work is reassigned. A table gives "assigned to group X with role Y, claimed by session Z" as a queryable fact without assuming a Plan exists, keeps the record independent of `chat_sessions.task_id` (which stays a session's current working task, untouched), and follows the house pattern of immutable task tables. *Alternative:* `assigned_*` columns on `team_tasks` — rejected: no history, and Wave B2 (results, revision publication) needs to reference "the assignment affected".

The outstanding assignment is the newest row for the task that is neither superseded nor settled; `TeamTaskSummary` gains `assignment` (target, role, state, claimedBy) and `TeamTaskDetail` gains `assignments` oldest-first. A task with no rows is unassigned. Association still happens the existing way: delivering the instruction mail calls `associateTask`, so the recipient's header/task badge works unchanged — the assignment is accountability, the association is context.

### D2. Human-originated mail: `from_kind` on `team_messages`, no sender session

The instruction is a normal `team_messages` row so everything downstream applies unchanged. `team_messages` gains `from_kind TEXT NOT NULL DEFAULT 'agent'`; human rows store the sentinel `'human'` in the NOT NULL `from_session` (session ids are `chat-<uuid>`, so no collision), `from_group` NULL, and `origin_path` = the team's main checkout root — stable regardless of which chat's panel dispatched. The envelope (`messageEnvelope`) gains optional `senderKind: 'human'` (absent = agent, like `task`), so `ChatMessages` renders "Human" and old transcripts still parse; `parseEnvelope` accepts the optional field. `TeamMailbox.reply` refuses replies to human-originated mail with an error pointing at `task_note` and the task detail — without this the reply would dead-letter against a nonexistent sender session. *Alternative:* rebuilding `team_messages` to make `from_session` nullable — rejected for this change: a table rebuild is a heavier migration than one additive column, and the sentinel plus `from_kind` is unambiguous. *Alternative:* routing replies into the human's own chat session — rejected: that session is an agent conversation, not the human's inbox (`team-message-threads` owns that surface).

### D3. Dispatch is one transaction: assignment row + instruction mail

`AssignmentService.dispatch(taskId, target, instruction, requestKey)` validates (task of the caller's team; group exists in the team catalog; session target is live, non-archived, same team; instruction non-empty), then in one SQLite transaction inserts the `team_task_assignments` row (state queued) and enqueues the instruction mail (normal priority, `task_id` set, sender = human per D2). Because both rows commit together, there is no durable state where the assignment exists but the instruction was never sent — an accepted dispatch always has its mail, and the failure modes collapse to *validation refusal* (nothing written; draft stays client-side; E02) or *accepted* (queued, owned by the dispatcher). "Create and assign" runs `TaskService.create` then `dispatch`; the create commits first, so a dispatch refusal provably leaves the task behind with the draft retained.

Group targets ride existing semantics untouched: group mail routes to one eligible member (`agent-mailbox` "Group messages are handled by exactly one member"), worktree tasks filter and may spawn (`team-worktree-staffing`), receipts confirm delivery. Direct-to-session assignment also produces group-free direct mail; both carry the task header (`buildTaskContext`) above the human's instruction text.

### D4. Request identity: a client-generated key, unique per team, on both tables

`team_tasks` gains nullable `request_key` (unique per team); `team_task_assignments.request_key` is NOT NULL with the same composite uniqueness. One key names one user intent: the client mints it when a **Create and assign** (or **Assign / send task**, or plain **Create task**) action is first armed and reuses it for every retry of that action; a *new* assignment (a reassignment) gets a fresh key. The write path is insert-then-read: `INSERT OR IGNORE` by key, re-read the row, and if it exists compare payloads (task fields for create; task + target + instruction for dispatch) — same payload returns the prior row as the outcome, different payload refuses with "request key reused". Because both replay paths resolve inside SQLite against committed rows, a reconnect resend, a double click, or a crash-then-retry cannot add a second task or instruction (E01). Payload comparison is on the normalized fields the server would store, not a hash of raw input, so refusals can name the differing field. *Alternative:* server-minted keys with a client echo — rejected: the client must generate the key *before* the first send for a reconnect during submission to reattach to the same intent.

### D5. Assignment state is derived from the mail at read time

Nothing duplicates the mail state machine. `assignmentState(row, message)`: `queued` while the mail is queued/spawning/awaiting-request (a queued group assignment shows `role` with `claimed_by` NULL), `claimed` once claimed, `delivered` once the receipt is confirmed, `failed` when the mail settles dead/cancelled/discarded (reason shown), and `superseded` when `superseded_by` is set regardless of the mail. `claimed_by`/`claimed_at` are copied from the mail when the dispatcher claims (the existing `claimed` hook) so the record stays queryable even if mail rows are ever pruned. Spawn reservation shows as queued/"starting" — the *reason* a queued assignment waits (idle member, caps, occupied worktree) belongs to `team-waiting-reasons` and is deliberately not taxonomized here.

### D6. Preview: read-only, from the same sources the dispatcher uses

`team-task-preview` answers for a `{worktree?, target}` pair without writing anything: the target worktree (resolved via `TeamWorktrees.resolveTarget`), the group's role label and its `profiles`/`approval` (`GroupDefinition`), the effective profile — a session target's `claudeProfileId`, or for a group target with no member yet the profile a spawn would use (first allowed by the group's strategy and caps, via `buildCandidates`/`WorktreeStaffing` counts re-exposed as a pure preview helper, never `spawnFor`), and staffing availability (idle matching members, spawn slot open / which cap blocks). For a session target the preview also reports the session's resolved worktree (`worktreeRootOf`) and warns when it differs from the task's worktree; dispatch stays allowed (the human may intend it — open question Q3). Preview is advisory; `dispatch` revalidates every constraint, so a stale preview can mislead but cannot misroute.

### D7. Reassignment supersedes; only stop cancels undelivered mail

Dispatch onto a task with an outstanding assignment requires `handling: 'notify' | 'stop'` from the client. Both set the old row's `superseded_by` and journal the supersession. **Stop** additionally cancels the old instruction mail through the existing cancel path, but only while it is still queued/spawning — a claimed or delivered instruction is left alone, so the previous recipient's session and work are never touched (killing/archiving a session is `task-results-handoffs` "Release worktree" territory). **Notify** sends the previous `claimed_by` (when one exists) a normal-priority direct human-originated note naming the reassignment; with no claimed agent, notify degrades to a plain supersede. The requirement that the human choose is enforced server-side: dispatch without `handling` onto an outstanding assignment is refused with the outstanding assignment's target and state in the error.

### D8. Pickers: one request/response over the chat WebSocket

`team-task-targets` (scoped by the session's team, like every task request in `taskConnections.ts`) answers `{worktrees: [{root, branch?}], changes: [{name, locations: [...]}]}`: worktrees from `TeamWorktrees.list` with branches from the existing porcelain parser; changes from the `openspec/changes/<name>` directories (excluding `archive`) under the team's main checkout root and each listed worktree — exactly the roots `TaskService.validateChange` accepts, so a listed choice always validates. The client re-requests when the picker opens or regains focus; no subscription (worktree sets change rarely and the TTL-cached listing is cheap). The picker component is a filter-as-you-type combobox with an advanced manual-entry mode that submits the typed value through the same server validation; its create-worktree link opens the existing `CreateWorktreeModal` / `create-change-worktree` flow and preselects the new root on return. Manual entry is how cross-session pasted paths keep working; it is not a second validation path.

### D9. No dispatch side effects on task state

Dispatch writes the assignment, the mail, a journal entry ("assigned to <target> by human"), and nothing else. Task status stays under the existing rules (`team-tasks` "Task status and closing") — no automatic `open → active`. The assignment record, not a status value, is what shows responsibility; conflating them would make a queued assignment indistinguishable from a stuck task. (Q1 holds the alternative for the human to decide.)

## Risks / Trade-offs

- [Sentinel `'human'` in `from_session`] → disambiguated by `from_kind`, unreachable by real session ids (`chat-<uuid>`); every sender resolution already tolerates a missing session. If it ever grates, a later rebuild migration can null the column without behavior change.
- [Preview and dispatch race (member goes busy, cap fills)] → preview is explicitly informational; dispatch revalidates and refuses or queues as its outcome, which is then visible as the assignment state.
- [Group assignment queues indefinitely when nobody is eligible and staffing cannot spawn (main-checkout tasks never spawn)] → correct per current staffing rules; visibility of *why* it waits is `team-waiting-reasons`, and the human can reassign or stop.
- [Instruction text is stored twice (assignment row + mail body)] → deliberate: the assignment row is the durable historical record of what was sent; the mail row is the delivery vehicle.
- [Dispatch adds human-originated mail before `team-message-threads` ships its surfaces] → reply refusal (D2) keeps agents from dead-lettering; peer rows already render the human sender; thread history arrives with the sibling change.

## Migration Plan

Additive only: create `team_task_assignments`, `ALTER TABLE team_tasks ADD COLUMN request_key TEXT` + unique index, `ALTER TABLE team_messages ADD COLUMN from_kind TEXT NOT NULL DEFAULT 'agent'` (following `mailboxStore.migrateTable`'s PRAGMA-check pattern). Existing rows default to agent senders and keyless tasks. Rollback is dropping the new table/columns; no existing behavior reads them.

## Open Questions

- **Q1 — dispatch and task status.** Default: no automatic status change (D9). Alternative: a successful dispatch sets `open → active` with a journal note. Recommend the default; status stays human/member-owned.
- **Q2 — reassignment notify wording/priority.** Default: a normal-priority direct note ("Task <title> was reassigned to <target>; your work is not cancelled — report status with a journal note if still relevant"). Alternative: make it configurable. Recommend the default.
- **Q3 — direct assignment to a session outside the task's worktree.** Default: preview warns, dispatch allows (D6). Alternative: refuse when the task targets a worktree and the session is resolved elsewhere. Recommend warn-but-allow — manual sessions move, and the human's choice is explicit.
- **Q4 — may agents create assignment records via a tool later?** Default: not in this change; agents keep `send_message` with `task_id` (their dispatches remain ordinary task mail, participants-only). Revisit when Wave B2 result handoffs need machine-written assignments. Recommend deferring.
- **Q5 — should plain **Create task** also accept a request key?** Default: yes, it already falls out of D4 (same mechanism, prevents duplicate tasks on reconnect/double click of the create button). Listed only because it widens `team-task-create` beyond assignment.

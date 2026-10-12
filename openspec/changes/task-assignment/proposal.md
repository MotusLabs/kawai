# Proposal

## Why

Tasks record what must happen and mail delivers work, but nothing names who is responsible for a task. Today the human (or a lead acting by hand) creates a worktree, picks a session, and composes mail with a pasted task id — and a reconnect or a repeated click during that manual flow can silently duplicate instructions. Multi-agent work needs an accountable owner per task, recorded durably and separately from the participant list, plus a dispatch path the human can drive without typed paths or raw session ids.

Depends on `team-tasks` (and the `agent-teams` / `agent-mailbox` machinery beneath it).

## What Changes

- **Assignment record.** A durable assignment per dispatch, kept separate from the derived participant list: target (a group — its role — or a specific session), the initial instruction, the dispatcher, the request identity, the claim, and supersession. Assignment history stays visible; a queued group assignment shows the requested role with no claimed agent yet, and the owner becomes visible once claimed.
- **Create task / Create and assign.** The form keeps title, direction, acceptance, and optional parent; typed worktree and OpenSpec inputs are replaced by searchable pickers scoped to the team (worktree path and branch; change name and location), with advanced manual entry still validated by the same server rules. Assignment chooses a group or a session plus the initial instruction; the UI states that group dispatch selects one eligible member.
- **Dispatch preview.** Before sending: target worktree, role, effective profile, approval policy, and whether staffing is available. Informational — dispatch revalidates.
- **Idempotent dispatch.** Create and dispatch carry a stable client request key; a reconnect, a repeated click, or a replay of the same key returns the prior outcome and never duplicates a task or an instruction. The same key with a different payload is refused.
- **Retry assignment.** When creation succeeds and dispatch fails, the task and the assignment draft are kept, the error shows inline, and **Retry assignment** reuses the existing task. A refusal never silently erases form input.
- **Assign from detail; explicit reassignment.** **Assign / send task** in the task detail dispatches to a group or session. Reassignment supersedes the outstanding assignment after the human chooses **notify** or **stop**: an undelivered instruction is cancelled only on stop, a previous recipient's delivered work is never auto-cancelled, and notify sends the previous assignee a direct note. Neither choice kills or archives anyone.
- **Worktree routing through assignment.** A group assignment whose task targets a worktree reaches only members whose resolved worktree matches (existing staffing rules, caps, and bounded spawning); an idle developer in the main checkout never takes it. Kawai still never creates a worktree because mail was sent — the picker links into the existing worktree-creation flow and returns.
- **Human-originated mail.** The instruction is an ordinary `team_messages` row so claims, receipts, routing, and spawning all apply; its sender is the human (additive `from_kind`; peer rows show the human as sender; replies to human-originated mail are refused with guidance to append a task journal note, which the human reads in the task detail).
- **No automatic status change.** A task starts unassigned; dispatch does not rewrite task status — assignment state is its own record.

Non-goals: waiting-reason taxonomy and Starting-agent rows (`team-waiting-reasons`); delivered history, threads, and a human message composer (`team-message-threads`); Team view and attention queue, results/review/QA handoffs, Accept result, Release worktree, revision publication (Wave B2); Plans and Task Execution objects (`durable-plans`, Wave C); replacing the lead/devs role prompts; grants/leases; dependency graphs; on-demand worktree creation; urgent dispatch; agent-side assignment tooling (agents keep `send_message` with `task_id`).

## Capabilities

### New Capabilities

- `task-assignment`: the durable assignment record and its history; create-and-assign and assign-from-detail dispatch with a stable request identity and retry; dispatch preview; reassignment as an explicit handoff; team-scoped searchable pickers for worktrees and OpenSpec changes; and worktree-correct routing of dispatched instructions.

### Modified Capabilities

- `agent-mailbox`: messages may originate from the human (task dispatch) with a human sender identity that cannot be forged; replies to human-originated messages are refused with journal guidance until a human reply surface exists.

## Impact

- Server: `src/server/team/` — a new assignment store beside `taskStore.ts` and dispatch/preview methods on `TaskService.ts` (`request_key` idempotency, reassignment, cancel-on-stop); `mailboxStore.ts` (additive `from_kind`, human-sender rows), `TeamMailbox.ts` (reply refusal for human-originated mail), `envelope.ts` and `src/shared/chat.ts` (optional `senderKind`), `taskConnections.ts` (`team-task-assign`/`team-task-preview`/`team-task-targets` actions; snapshots and details carry assignments), preview counts reusing `staffing.ts` and `worktreeRoots.ts` read-only, wiring in `ChatSessionManager.ts`.
- Shared: `teamTasks.ts` (assignment types on summaries/details), `team.ts` (`fromKind`), `types.ts` (new client/server messages, `requestKey` on create).
- Client: `TeamTasksPanel.tsx` (pickers, Create and assign), `TeamTaskDetail.tsx` (Assign / send task, outstanding assignment, history, reassignment choice), a new searchable-picker component, `teamTaskStore.ts` (assignment draft and request keys across reconnects), `ChatMessages.tsx` (Human sender label); the picker's create-worktree link reuses `CreateWorktreeModal.tsx` / `create-change-worktree`.
- Data: additive SQLite migration — `team_task_assignments` table, nullable `team_tasks.request_key`, `team_messages.from_kind`.
- Docs: How It Works (CLAUDE.md) bullets for assignment records, dispatch idempotency, and pickers.
- Tests: unit coverage beside the existing `src/server/__tests__/team*` suites; E01–E03 browser coverage extending `tests/e2e/chat-teams.spec.ts` patterns.

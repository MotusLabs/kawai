# Proposal

## Why

With `agent-teams`, agents can message each other, but every message has to restate what the work is, and the original intent erodes with each hop and handoff. Multi-agent work needs one durable record of a feature or request — its direction, acceptance criteria, and what has happened so far — that every participating agent follows. Work aimed at a worktree also needs an agent that actually runs there, which today requires the human to create one.

Depends on `agent-teams`.

## What Changes

- **Task entity.** A kawai-owned task per feature or request: title, direction, acceptance criteria, creator (human or agent), optional parent task, optional target worktree, optional linked OpenSpec change, status (`open`, `active`, `blocked`, `done`, `cancelled`), and an append-only journal.
- **Direction belongs to the creator.** Only the creator or the human can amend a task's direction or acceptance criteria; every amendment is versioned. Other agents contribute by appending journal entries and messaging.
- **Shared, not claimed.** Several agents work under one task at once; work units are messages (which `agent-teams` already claims atomically).
- **Who creates and closes.** The human always; agents only if their group sets `canCreateTasks: true`. Only the creator closes a task; the human can close or reopen any task.
- **Messages reference tasks.** `send_message`, `reply`, and `schedule_message` accept an optional `task_id`. On delivery, kawai adds a task header (title, direction, status, latest journal entries, linked change) so the recipient never acts without the task in view.
- **OpenSpec link.** A task linked to an OpenSpec change tells agents to treat its proposal, design, and tasks as the authoritative direction.
- **Worktree staffing.** A group message whose task targets a worktree goes only to an idle group member running in that worktree. If none exists, kawai spawns a new member there — bounded by the group's `max`, a per-team cap, and at most one spawned writer per worktree; otherwise the message waits. The worktree must be one of the team repository's worktrees. Spawned members take the group's `profile` and `approval` frontmatter.
- **Tools.** `task_create`, `task_get`, `task_note`, `task_update_status`, `task_amend` (creator only), `task_list`.
- **UI.** A per-team task list and task detail (direction with version history, journal, participants, messages, status controls for the human); spawned sessions show their task; a spawned session waiting on the human is flagged in the navigator.

Non-goals: profile-aware routing and limit handling (`profile-routing`), creating worktrees on demand, task dependencies/scheduling beyond parent links, syncing task status into OpenSpec `tasks.md`.

## Capabilities

### New Capabilities

- `team-tasks`: task records, direction ownership and versioning, journal, creation and closing rights, OpenSpec linking, task context on delivered messages, and task inspection in the UI.
- `team-worktree-staffing`: routing task messages to a worktree's members and spawning bounded members in a worktree when none is free.

### Modified Capabilities

None in main specs. Extends `agent-teams` group frontmatter (`canCreateTasks`, `max`, `profile`, `approval`) and `agent-mailbox` tool inputs (`task_id`) once those land; their behavior is additive and specified here.

## Impact

- Server: `src/server/team/` (task store, task tools, worktree validation via `git worktree list`, staffing in the dispatcher), `ChatSessionManager.ts` (programmatic create with group/profile/approval/task), `db.ts` (`team_tasks`, `team_task_journal`, `team_task_revisions`; `task_id` on `team_messages` and `chat_sessions`).
- Shared: task types, `team-tasks` push messages, task header on peer-message events.
- Client: task list/detail views, task badge on sessions, needs-attention flag for spawned sessions.
- Cost: auto-spawn starts agents without a human present; caps and the needs-attention flag bound it.

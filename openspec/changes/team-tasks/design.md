# Design

## Context

Builds on `agent-teams` (see its design): kawai-owned `team_messages` with atomic claims, a dispatcher woken by session idleness, an in-process `kawai-team` MCP server per driver, and group files in `.kawai/groups/`. Chat sessions are fixed to their project directory at spawn, and Claude Code stores transcripts per working directory, so an existing session cannot be moved into another worktree — work aimed at a worktree must be done by a session started there.

## Goals / Non-Goals

**Goals:** one authoritative direction per task that agents cannot silently rewrite; task context on every task-related delivery; worktree work staffed automatically within hard limits.

**Non-Goals:** task-level assignment/claiming (messages are the unit of work); writing task state into OpenSpec files; on-demand worktree creation; human approval of each spawn.

## Decisions

### D1. Tasks in SQLite, not files
`team_tasks(id, team_id, title, status, creator_kind, creator_session, parent_id, worktree, openspec_change, revision, created_at, updated_at)`, `team_task_revisions(task_id, revision, direction, acceptance, author, created_at)`, `team_task_journal(id, task_id, author_kind, author_session, text, created_at)`. *Alternative:* markdown in `.kawai/tasks/` — agent-writable, so direction could drift without the creator; concurrent appends across worktrees conflict.

### D2. Authorization by the calling session
Task tools close over the session id (as in `agent-teams` D2). Creator checks compare against `creator_session`; `canCreateTasks` is read from the caller's group file at call time. The human acts through authenticated UI routes, not tools.

### D3. Task header built at delivery
The envelope from `agent-teams` D3 gains a task section rendered at delivery time (not at send time), so it always shows the latest revision and journal. Journal entries are capped (last 5, truncated) to bound prompt size; `task_get` returns the full record.

### D4. Staffing inside the dispatcher
For a group message with a worktree task, candidate members are filtered by `realpath(projectPath) == realpath(task.worktree)`. If none is idle, the dispatcher checks caps in the same transaction that inserts a placeholder `spawning` claim, then calls the manager's programmatic create (group, profile, approval, task id, project path) and delivers the message as the first turn. A failed spawn releases the claim and re-queues the message.

### D5. Worktree validation
`git worktree list --porcelain` from the team's main working tree, cached briefly and refreshed on miss. Validation happens at task create/amend and before spawning.

### D6. Caps configuration
Per-group `max` in group frontmatter (default 1); per-team spawn cap in user-level `~/.kawai/teams.json` (default 5) — user-level because it bounds cost and must not be raised by agent-writable project files.

### D7. Needs-attention signal
A spawned session in `permission` status (or with a pending question) sets a navigator flag and triggers the existing notification path. No new status value is added.

## Risks / Trade-offs

- [Auto-spawn spends tokens unattended] → defaults are conservative (group max 1, team cap 5); spawned sessions are visibly marked; manual approval by default.
- [Spawned sessions accumulate] → they are ordinary sessions; no auto-archive in this change.
- [Task header bloats prompts] → bounded journal excerpt; full detail via `task_get`.
- [Creator-only closing leaves tasks open when a creator is killed] → the human can always close; the UI lists tasks whose creator is gone.

## Migration Plan

Additive tables and nullable `task_id` columns on `team_messages` and `chat_sessions`. No change for teams that never create tasks.

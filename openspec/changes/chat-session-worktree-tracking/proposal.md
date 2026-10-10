# Proposal

## Why

A Claude Code Chat session's navigator placement is frozen at its creation-time
project path. When the agent later switches into a Git worktree — via
`EnterWorktree`, a shell `cd`, or any other cwd change Claude Code records —
the left menu keeps the session in the old section (main worktree or
`Workspace`) and its project badge keeps showing the old leaf. The same gap
shows up for a session that is started in a worktree: the menu never reliably
reflects which worktree the chat is actually working in. Terminal sessions
already move when a tmux pane's path changes; chats do not, so the navigator
lies about where the work is happening.

## What Changes

- Track a chat session's current working directory as the agent moves, and keep
  the session's associated path in sync with it (creation path remains the
  starting point; later cwd changes replace it).
- Place live chat sessions in the left menu by that current path, so a session
  in `.worktrees/<change>` (or any other discovered worktree, including
  Claude Code's own `.claude/worktrees/...`) sits under that worktree or change
  section rather than `Workspace`.
- Move the session's section when the agent enters or leaves a worktree, and
  keep the project badge, project filters, and workspace-discovery seeds
  consistent with the new path.
- Cover the started-in-a-worktree case explicitly: a chat created with a
  worktree as its project path appears under that worktree's section.
- Leave terminal (tmux) path refresh and all lifecycle, approval, and naming
  behavior unchanged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chat-sessions`: adds a requirement that a chat session's associated project
  path follows the agent's working directory after creation.
- `workspace-navigation`: extends session-to-worktree grouping and the
  directory-change behavior to chat sessions, not only live tmux panes.

## Impact

- `src/server/chat/ChatSessionDriver.ts` — observe cwd changes from the agent
  (SDK `CwdChanged` hook and/or worktree tool results) and report them.
- `src/server/chat/ChatSessionManager.ts` — persist the updated path and
  re-publish the session so the navigator sees it.
- `src/server/db.ts` — `chat_sessions.project_path` is updated in place when the
  agent's cwd changes.
- `src/server/index.ts` — workspace seeds and any path-keyed lookups follow the
  updated path; a path change triggers a workspace refresh for the new tree.
- `src/client/utils/workspaceView.ts` — no algorithmic change expected; it
  already groups by `session.projectPath`, which becomes current.
- `src/shared/types.ts` — may gain an explicit current-directory signal if the
  design keeps the creation path separate from the live one.
- `src/client/components/SessionRow.tsx` — project badge automatically reflects
  the updated path.

No new dependencies. Resume, archive, `/new`, and approval policy are unchanged
except that they operate on whatever directory the session currently has.

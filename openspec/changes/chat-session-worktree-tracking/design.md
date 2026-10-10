# Design

## Context

See `proposal.md` — Why. Two constraints shape the approach:

1. The navigator already groups by `session.projectPath` with
   `deepestPathMatch` (`src/client/utils/workspaceView.ts`). Terminal sessions
   stay correct because tmux discovery re-reads each pane's path on every
   refresh (`SessionManager` → `normalizeProjectPath(window.path)`). Chat
   sessions never re-read anything: `ChatSessionManager.toSession` copies
   `record.projectPath`, which is set once in `createAvailableSession` /
   `createSession` and never touched again.
2. Claude Code's session cwd is not frozen at spawn. Transcripts record a `cwd`
   (and `attachment.snapshot.workingDirectory`) on every row, and we have
   observed that value change mid-session — after `EnterWorktree` and after a
   foreground shell `cd` into `.worktrees/...`. The SDK exposes this as a
   `CwdChanged` hook (`old_cwd` / `new_cwd`).

`chat_sessions.project_path` is already the field every consumer reads
(grouping, `ProjectBadge`, project filters, workspace seeds in
`collectWorkspaceSeeds`, spawn/resume cwd, profile catalog, tool-path
relativization). There is no separate "display path".

## Goals / Non-Goals

**Goals:**

- A chat session's associated path is the agent's current working directory.
- The left menu places and moves the session using that path, including when
  the session is created inside a worktree.
- The update is live (no reload) and survives server restart.

**Non-Goals:**

- Changing terminal (tmux) path refresh — it already works.
- Worktree creation/removal, branch management, or any Git write from the
  navigator.
- Tracking subagent working directories; only the main chat session moves.
- A separate "original project" concept for display. `/new` keeps meaning
  "same directory as this session", which is then the current one.

## Decisions

### D1. Detect cwd changes with the SDK `CwdChanged` hook

Register `hooks.CwdChanged` on the existing `query()` options in
`ChatSessionDriver.spawnQuery`. The hook fires for every session cwd change
(`EnterWorktree`, `ExitWorktree`, foreground shell `cd`, and anything else
Claude Code treats as a cwd change), so we do not have to special-case
individual tools.

- **Why not track `EnterWorktree`/`ExitWorktree` tool results only?** Misses
  the `cd`-into-worktree case we already see in real transcripts, and couples
  us to tool names.
- **Why not poll the transcript?** Higher latency and extra I/O; the hook is
  the live signal. The transcript remains the recovery path (D3).
- The hook callback is observational only: it reports the new cwd and returns
  `{ continue: true }`. It MUST NOT block or alter the agent.

Ignore hook firings that are not the main session (subagent frames carry
`parent_tool_use_id`); only the top-level session's cwd moves the chat row.

### D2. Overwrite `chat_sessions.project_path` in place

On a cwd change, persist the new directory as `project_path` and re-publish
the session through the existing registry (`setChatSession` → `sessions`
broadcast). No new column.

- **Why overwrite rather than add `working_directory`?** Every consumer already
  reads `projectPath`. A second field would need a coordinated cutover and
  would leave restart/`/new`/profile-catalog disagreeing with the navigator.
  Terminal sessions treat `projectPath` as "current path"; chats should match.
- Consequences we accept: resume and `/new` follow the worktree once the agent
  has moved; tool-path relativization and the profile catalog use the new
  directory. All of those are the directory the work is actually in.

After a successful update, request a scoped `workspaceCoordinator.requestRefresh(newPath)`
so a worktree that was not previously a seed becomes discovered without a
reload. Debounce refreshes briefly so a fast `cd` chain does not thrash Git
discovery.

### D3. Recover the cwd on restore and replay

`CwdChanged` only sees live changes. On `restorePersisted` and when replaying
a transcript, read the newest `cwd` (falling back to
`attachment.snapshot.workingDirectory`) from the transcript JSONL and sync
`project_path` when it differs. `transcriptReplay.ts` already walks every
record; capturing the last non-empty cwd is a few lines and does not change
emitted `ChatEvent`s.

This is what makes "Update survives restart" true even if the process died
after the hook fired but before the row was written — the transcript is
written by Claude Code itself and is the durable record.

### D4. Client needs no grouping change

`buildWorkspaceView` already places live sessions with
`deepestPathMatch(session.projectPath, worktreePaths)`. Once `projectPath` is
current, the section, `ProjectBadge`, project filter, and keyboard order all
follow. Session rows are memoized on `projectPath`, so a change re-renders
naturally.

Verify (do not assume) the started-in-a-worktree path end-to-end: create with
the worktree as `projectPath`, confirm the row lands in that worktree's
section rather than `Workspace`. If the row is misplaced despite a correct
`projectPath`, the bug is in seeding or snapshot matching and belongs in
`workspaceSnapshot` / `repositoryResolution`, not in the chat driver.

## Risks / Trade-offs

- **`CwdChanged` missing on older CLIs** → treat the hook as best-effort; D3
  transcript sync still corrects the path on attach/restore. Version check
  already gates creation (`claude-executable`).
- **Hook fires more often than worktree switches** (any `cd`) → acceptable:
  the navigator is supposed to follow the current path, same as tmux. Debounce
  workspace refresh, not the session update itself.
- **Overwriting `project_path` loses the creation path** → accepted (D2). If a
  future need for "home project" appears, it can be derived from the first
  transcript record; do not add it now.
- **Rapid worktree hops leave a stale section for one frame** → same latency
  as terminal refresh; not user-visible in practice.
- **Transcripts without a `cwd` field** (very old) → leave `project_path`
  unchanged; behavior is then identical to today.

## Migration Plan

No schema migration: `project_path` already exists and stores a plain path.
Old rows keep their creation path until the agent next changes directory or
the transcript is replayed. Rollback is the previous code path (static
`project_path`); no data rewrite to undo.

## Open Questions

- Whether Claude Code re-homes the transcript to a worktree-encoded projects
  directory on `EnterWorktree` (we have seen that on disk). `findTranscriptPath`
  already searches by session id, so this is not blocking; only worth a comment
  if resume ever misses a file.

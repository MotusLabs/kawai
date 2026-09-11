## Why

Agentboard treats tmux windows as a flat list of project paths, which makes parallel work across Git branches and worktrees difficult to understand and navigate. Developers using OpenSpec also have to leave the app to see which changes exist and how far they have progressed.

## What Changes

- Add a repository-aware workspace navigator that visually groups live, hibernating, and historical sessions by local Git worktree and displays each worktree's checked-out branch and state.
- Discover branches that do not currently have a worktree and allow users to create a local worktree for a selected branch.
- Allow users to start a tmux session directly within an existing or newly created worktree.
- Display active OpenSpec changes and their progress within the worktree whose filesystem contains them.
- Automatically refresh worktree, branch, repository, and OpenSpec information when relevant filesystem or Git state changes, with reconciliation for missed events.
- Preserve explicit fallback groups for local sessions outside a recognized Git worktree and for remote sessions whose repository context cannot be resolved locally.
- Defer worktree removal, pruning, branch deletion, and other destructive Git operations.

## Capabilities

### New Capabilities

- `workspace-navigation`: Discover repositories, worktrees, and branches; group sessions by worktree; create worktrees; and launch sessions in them.
- `openspec-visibility`: Show per-worktree OpenSpec changes and progress and keep that information synchronized with filesystem changes.

### Modified Capabilities

None.

## Impact

- Extends shared WebSocket message and workspace metadata types.
- Adds server-side Git/OpenSpec discovery, change watching, validation, and worktree-creation handling.
- Changes the desktop and mobile session navigator, new-session flow, state management, filtering, sorting, and keyboard/drag behavior.
- Adds focused server, shared, component, store, and end-to-end coverage for workspace discovery and operations.
- Uses installed `git` and `openspec` commands; no new runtime service is required.

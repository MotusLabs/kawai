## Why

Agentboard treats tmux windows as a flat list of project paths, which makes parallel work across Git branches and worktrees difficult to understand and navigate. Developers using OpenSpec also have to leave the app to see which changes exist and how far they have progressed.

## What Changes

Phase 1 — change-centric navigator:

- Group live, hibernating, and historical sessions in the left panel under collapsible sections for unarchived OpenSpec changes.
- Match each change to the repository-local worktree at `.worktrees/<change-name>`; worktrees without a matching change (including the main worktree) get their own sections, and local sessions outside any worktree fall under a `Workspace` section.
- Put a new-session action (`[+]`) on every section header. For a change whose worktree does not exist, the action creates it first — branch `<change-name>` (existing local branch if present, otherwise a new branch from HEAD), copies `openspec/changes/<change-name>/` from the main worktree into it, and commits the copy there — then opens the session form with the worktree path prefilled.
- Offer, in the session form, to auto-start the conversation with the change's apply command (`/opsx:apply <change>` for Claude, the equivalent for Codex), injected once the agent first becomes idle.
- List changes from each discovered repository's main worktree OpenSpec root; once a change's worktree exists, that worktree's copy is canonical for its status and progress.
- Refresh workspace metadata by periodic reconciliation; preserve explicit fallback sections for local sessions outside Git and for remote sessions without local repository context.

Phase 2 — parked follow-ups:

- Branch browser for unassigned local branches and a general create-worktree form.
- Filesystem-watch-driven refresh with debounced reconciliation.
- Checked-out branch and working-tree state in unmatched-worktree section headers.

Deferred entirely: worktree removal, pruning, branch deletion, and other destructive Git operations.

## Capabilities

### New Capabilities

- `workspace-navigation`: Discover repositories and worktrees; group sessions by OpenSpec change and worktree sections; create seeded change worktrees; and launch sessions in them with an optional auto-started apply command.
- `openspec-visibility`: Maintain the per-repository active-change registry and show each change's progress from its canonical worktree copy, kept current with reconciliation.

### Modified Capabilities

None.

## Impact

- Extends shared WebSocket message and workspace metadata types.
- Adds server-side Git/OpenSpec discovery, validation, seeded change-worktree creation (including a commit on the new branch and a `.gitignore` entry), and pending auto-start prompt handling.
- Changes the desktop and mobile session navigator, new-session flow, state management, filtering, sorting, and keyboard/drag behavior.
- Adds focused server, shared, component, store, and end-to-end coverage for workspace discovery and operations.
- Uses installed `git` and `openspec` commands; no new runtime service is required.

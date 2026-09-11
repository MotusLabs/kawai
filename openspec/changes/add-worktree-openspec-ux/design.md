## Context

See `proposal.md` for motivation and the capability specs for observable behavior. Today the server discovers tmux windows on a periodic worker refresh and records only each pane's current project path. The client renders active sessions as one sortable list and hibernating/history sessions as separate flat sections. New sessions already accept an arbitrary project path.

Repository metadata is absent from the shared model. Agent history can provide paths after a tmux window exits, and paths can point below a worktree root. Git worktree metadata is shared through a common Git directory, while OpenSpec contents belong to each worktree's filesystem snapshot. Remote sessions do not currently supply enough repository metadata to perform equivalent discovery safely.

## Goals / Non-Goals

**Goals:**

- Establish one authoritative server-side model for repositories, worktrees, local branches, and per-worktree OpenSpec changes.
- Keep repository discovery independent from high-frequency terminal status inference.
- Preserve existing session lifecycle behavior while introducing hierarchical presentation.
- Make create-worktree and create-session operations race-safe, validated, and non-destructive.
- Recover automatically when filesystem watches miss events or tools temporarily fail.

**Non-Goals:**

- Mutating or deleting existing worktrees or branches.
- Creating new branches, checking out remote-only branches, merging, rebasing, committing, or resolving conflicts.
- Inferring local repository state for remote sessions.
- Editing OpenSpec artifacts or running OpenSpec workflows from the navigator.
- Recursively scanning arbitrary directory trees for every Git repository on the machine.

## Decisions

### Add a separate workspace-context protocol

Introduce shared repository/worktree/branch/OpenSpec snapshot types and dedicated server messages for a full workspace snapshot and operation results. Keep `Session.projectPath` as the live pane path and associate sessions to worktrees by stable worktree identifiers derived from canonical repository identity plus canonical worktree path.

The workspace snapshot is separate from the existing session snapshot because Git and OpenSpec discovery are slower and change less often than tmux status. This also prevents a transient Git/OpenSpec failure from disrupting terminal refreshes. The client store keeps the latest successful workspace snapshot and its per-worktree stale/error state.

Alternative considered: add branch and OpenSpec fields directly to every `Session`. This duplicates metadata, cannot represent empty worktrees or branches without worktrees, and causes unrelated session updates whenever repository metadata changes.

### Discover repositories from known project paths

Seed repository discovery from local live-session paths and persisted active, hibernating, and recent-history agent paths. Resolve each seed with Git to its containing worktree and common repository directory, deduplicate repositories by canonical common-directory identity, then enumerate all worktrees and local branches for each repository.

Do not recursively scan the configured project directory. A repository becomes known when Agentboard has a local session/history path within it; selecting a path in the new-session flow can request an on-demand preview and adds it after session creation. This bounds I/O and matches the app's existing project discovery semantics.

Alternative considered: recursively scan the default project directory. This is expensive, encounters permission and mount boundaries, and makes update guarantees difficult.

### Use Git porcelain as the source of truth

Run Git with argument arrays and an explicit working directory. Parse `git worktree list --porcelain`, `git for-each-ref`, and `git status --porcelain` output into internal results. Normalize and canonicalize paths before matching, and assign a session to the deepest containing worktree path so nested repository/worktree paths resolve predictably.

Branch listings are local branches only in this change. Branches already attached to a worktree remain visible with their location but cannot be selected for creation. Detached worktrees use their HEAD revision as the display identity.

Alternative considered: parse `.git` files and refs directly. Git commands handle linked worktrees, packed refs, and version-specific layouts more reliably.

### Discover OpenSpec independently per worktree

For each worktree, run `openspec list --json` with that worktree as the working directory and parse supported fields defensively. A missing OpenSpec root produces an empty, non-error result. A genuine command or parse error marks only that worktree's OpenSpec data stale while retaining its last successful values.

OpenSpec discovery is intentionally not inferred from the main worktree or copied across branches: artifacts and task completion can differ between worktrees.

Alternative considered: read `openspec/changes` files directly. The CLI is the contract for workflow status and supports schema evolution better than duplicating its rules.

### Combine debounced watches with periodic reconciliation

Maintain a workspace discovery coordinator outside the tmux refresh worker. Watch the safe, existing ancestors of relevant Git common directories, worktree Git metadata, and OpenSpec roots. Coalesce bursts into repository-scoped refreshes, and periodically run a full reconciliation to cover Linux recursive-watch limitations, new directories, and external worktree changes.

Only broadcast structurally changed snapshots. Limit concurrent subprocesses and cache unchanged repository results so multiple sessions in one repository do not multiply Git/OpenSpec work. Shut down watchers and timers with the existing server lifecycle.

Alternative considered: attach workspace discovery to every session refresh. That would invoke several subprocesses every two seconds and couple terminal responsiveness to repository size and tool latency.

### Render a hierarchy while retaining a flattened navigation model

Build a derived client view model that partitions sessions by deepest worktree path and creates explicit local-ungrouped and remote sections. Render collapsible repository/worktree sections, but separately compute the flattened list of visible sessions for keyboard navigation and terminal next/previous behavior.

Manual drag reordering remains within a worktree group. Cross-group dragging is not a request to move a tmux process or change its working directory and is therefore rejected visually. Persist collapse state by stable worktree identifier. Project/host filters affect session rows; repository and OpenSpec context remains visible so an empty filtered group is still understandable.

Alternative considered: replace project filtering and manual ordering wholesale. Preserving those behaviors minimizes migration cost and avoids surprising existing users.

### Extend the session modal and add contextual actions

The worktree header's new-session action opens the existing modal with the worktree root preselected. The modal adds a compact picker for discovered worktrees while retaining free-form paths and the directory browser.

The repository branch browser lists local branches and opens a create-worktree form. Suggest a collision-resistant sibling destination based on repository and sanitized branch names, but require an absolute editable path and show the exact branch/path before confirmation. The server revalidates repository identity, branch availability, destination nonexistence, and containment policies immediately before executing non-forced `git worktree add`.

After success, refresh the repository snapshot. If launch was requested, feed the created root into the normal session flow rather than duplicating tmux creation logic.

Alternative considered: automatically launch a default agent immediately after every worktree creation. Keeping launch explicit respects command presets and avoids starting unintended processes.

## Risks / Trade-offs

- [Many known worktrees can create subprocess load] -> Debounce per repository, cap discovery concurrency, cache unchanged results, and reconcile on a slower interval than tmux sessions.
- [Filesystem watchers are unreliable for newly created directories on Linux] -> Treat watches as latency optimization and polling reconciliation as correctness.
- [Paths can involve symlinks, nested repositories, deleted directories, or platform-specific casing] -> Canonicalize existing paths, retain display paths separately, use deepest-prefix matching, and fall back to ungrouped sessions.
- [Git/OpenSpec commands can hang or emit unexpected output] -> Apply timeouts, argument-array invocation, defensive parsing, bounded output, and per-worktree stale/error states.
- [Branch availability can change between render and submit] -> Re-read repository state immediately before `git worktree add` and never use force flags.
- [Grouping changes current drag-and-drop semantics] -> Limit manual reorder to the originating group and cover keyboard, filters, animations, and accessibility with regression tests.
- [Existing clients do not know workspace messages] -> Additive message variants allow older clients to ignore new snapshots; retain existing session messages and fields.

## Migration Plan

1. Add the discovery model and additive protocol while retaining the flat session UI.
2. Populate the client workspace store and introduce grouped rendering behind the availability of a successful workspace snapshot; fall back to the current ungrouped presentation if none is available.
3. Add worktree-aware session creation, then enable branch browsing and worktree creation.
4. Add watchers and reconciliation after deterministic discovery and operation tests exist.
5. Rollback can remove the grouped renderer and workspace coordinator without migrating persisted session data; unknown collapse-state keys are harmless.

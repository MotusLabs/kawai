## Context

See `proposal.md` for motivation and the capability specs for observable behavior. Today the server discovers tmux windows on a periodic worker refresh and records only each pane's current project path. The client renders active sessions as one sortable list and hibernating/history sessions as separate flat sections. New sessions already accept an arbitrary project path.

Repository metadata is absent from the shared model. Agent history can provide paths after a tmux window exits, and paths can point below a worktree root. Git worktree metadata is shared through a common Git directory, while OpenSpec contents belong to each worktree's filesystem snapshot. Remote sessions do not currently supply enough repository metadata to perform equivalent discovery safely.

## Goals / Non-Goals

**Goals:**

- Establish one authoritative server-side model for repositories, worktrees, local branches, and per-worktree OpenSpec changes.
- Make the unarchived OpenSpec change the primary navigation unit; derive worktree, branch, and apply command from its name.
- Keep repository discovery independent from high-frequency terminal status inference.
- Preserve existing session lifecycle behavior while introducing hierarchical presentation.
- Make create-worktree and create-session operations race-safe, validated, and non-destructive.
- Recover automatically when reconciliation misses state or tools temporarily fail.

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

### Group by OpenSpec change section with a `.worktrees/` naming convention

Each discovered repository contributes sections from the active changes listed in its main worktree's OpenSpec root. A change's section exists whether or not its worktree does; the worktree is the repository-local path `.worktrees/<change-name>`. Section order: change sections (with or without worktrees), then worktrees with no matching change (the main worktree included), then `Workspace` for local sessions outside any worktree, then the existing remote section. Build a derived client view model that partitions sessions by deepest worktree path and derives each session's section from that worktree, but separately compute the flattened list of visible sessions for keyboard navigation and terminal next/previous behavior.

Manual drag reordering remains within a section. Cross-section dragging is not a request to move a tmux process or change its working directory and is therefore rejected visually. Persist collapse state by stable section identity. Project/host filters affect session rows; repository and OpenSpec context remains visible so an empty filtered section is still understandable.

Once a change's worktree exists, that worktree's OpenSpec copy is canonical for status and progress; the main-worktree listing only seeds changes that have no worktree yet. A worktree that lacks its change (for example created externally) still shows the section from the registry with a missing-in-worktree indication.

Alternative considered: repository/worktree as the primary axis with OpenSpec changes nested inside. The change is the unit of work the user thinks in, and every other piece — worktree, branch, apply command — derives from its name.

### Seed change worktrees with copy-and-commit

The `[+]` action on a change section creates the missing worktree before opening the session form: resolve the branch (existing local branch `<change-name>` if present, otherwise `git worktree add -b <change-name>` from the repository's current HEAD), copy `openspec/changes/<change-name>/` from the main worktree into the new worktree, and commit the copy on the new branch there. The main worktree's uncommitted copy is left untouched; it stops mattering because the worktree copy is canonical. Append `.worktrees/` to the repository's `.gitignore` when absent.

The server revalidates repository identity, destination nonexistence, and branch unassignment immediately before executing non-forced `git worktree add`. After success the snapshot refreshes and the session form opens with the worktree root prefilled. Multiple sessions per worktree are ordinary; `[+]` on an existing worktree skips creation entirely.

Alternative considered: commit artifacts in the main worktree first and branch from that commit. That mutates whatever the main worktree has checked out; copy-and-commit confines all writes to the freshly created branch.

### Auto-start apply with a status-gated, server-held prompt

The session form gains an auto-start option, checked by default only when opened from a change section's `[+]`. The chosen string maps by agent type (Claude: `/opsx:apply <change>`; Codex: its apply equivalent) and travels with the create-session message. The server stores it as a pending initial prompt keyed to the new session and injects it — command text plus Enter — through the same path terminal input uses, the first time the session's status becomes `waiting` after creation. Holding the prompt server-side survives client reloads in the gap between creation and agent readiness; a fixed delay would type into a booting shell. If the session never reaches `waiting`, the prompt stays pending and is discarded with the session.

Alternative considered: client-side injection after observing `waiting`. A reload in the seconds between creation and first idle loses the prompt.

## Risks / Trade-offs

- [Many known worktrees can create subprocess load] -> Cache unchanged results, cap discovery concurrency, and reconcile on a slower interval than tmux sessions; add debounced watches in phase 2.
- [Paths can involve symlinks, nested repositories, deleted directories, or platform-specific casing] -> Canonicalize existing paths, retain display paths separately, use deepest-prefix matching, and fall back to ungrouped sections.
- [Git/OpenSpec commands can hang or emit unexpected output] -> Apply timeouts, argument-array invocation, defensive parsing, bounded output, and per-worktree stale/error states.
- [Branch availability can change between render and submit] -> Re-read repository state immediately before `git worktree add` and never use force flags.
- [Copy-and-commit writes a commit the user did not author by hand] -> Confine writes to the freshly created branch, surface the commit in the operation result, and never touch the main worktree's checkout or index.
- [Auto-start injects text into a live agent session] -> Gate on the first `waiting` status after creation, inject exactly once per session, and map by agent type so unrecognized agents receive nothing.
- [Grouping changes current drag-and-drop semantics] -> Limit manual reorder to the originating section and cover keyboard, filters, animations, and accessibility with regression tests.
- [Existing clients do not know workspace messages] -> Additive message variants allow older clients to ignore new snapshots; retain existing session messages and fields.

## Migration Plan

1. Add the discovery model, change registry, and additive protocol while retaining the flat session UI.
2. Populate the client workspace store and introduce change-section rendering behind the availability of a successful workspace snapshot; fall back to the current ungrouped presentation if none is available.
3. Add the `[+]` worktree-creation-and-seeding operation and the prefilled session form.
4. Add auto-start injection with its status gate.
5. Phase 2 adds branch browsing, general worktree creation, and watch-driven refresh. Rollback can remove the grouped renderer, workspace coordinator, and pending-prompt handling without migrating persisted session data; unknown collapse-state keys are harmless.

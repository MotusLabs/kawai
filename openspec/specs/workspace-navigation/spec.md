# workspace-navigation Specification

## Purpose

Provide a repository-aware navigator for understanding Git worktrees and branches and for running Agentboard tmux sessions in the intended checkout.

## Requirements

### Requirement: Discover repository workspaces
The system SHALL discover the Git repository and worktree containing each known local project path and SHALL expose every worktree belonging to each discovered repository. Each worktree SHALL include its absolute path, checked-out local branch when present, HEAD revision, main-worktree identity, detached state, and working-tree change state.

#### Scenario: Session is inside a linked worktree
- **WHEN** a local session's current project path is the worktree root or any directory beneath it
- **THEN** the system associates the session with that worktree using the deepest matching worktree path

#### Scenario: Repository has worktrees without sessions
- **WHEN** a repository is discovered from a known local project path and that repository has additional worktrees with no sessions
- **THEN** the navigator displays those additional worktrees

#### Scenario: Worktree has a detached HEAD
- **WHEN** a discovered worktree is not attached to a local branch
- **THEN** the navigator identifies it as detached and displays a shortened HEAD revision instead of a branch name

### Requirement: Group sessions by OpenSpec change section
The system SHALL visually group active, hibernating, and historical sessions under collapsible sections for unarchived OpenSpec changes listed by each discovered repository, while preserving their existing lifecycle controls and status indicators. A change's sessions are those whose resolved worktree is the repository-local path `.worktrees/<change-name>`. Sections SHALL be ordered: change sections first (with or without worktrees), then worktrees with no matching change (including the main worktree), then `Workspace` for local sessions outside any worktree, then the remote section.

#### Scenario: Change has a matching worktree with multiple sessions
- **WHEN** multiple sessions have project paths within `.worktrees/<change-name>` of a repository listing that change
- **THEN** the navigator displays them within one change section

#### Scenario: Change has no worktree yet
- **WHEN** a repository lists an unarchived change and `.worktrees/<change-name>` does not exist
- **THEN** the navigator still displays the change section with its registry data and a create affordance, and with no sessions

#### Scenario: Worktree has no matching change
- **WHEN** a worktree (including the main worktree) exists whose basename does not match any unarchived change of its repository
- **THEN** the navigator displays it in its own section ordered after change sections

#### Scenario: Session changes directory across worktrees
- **WHEN** a live tmux pane's current path changes from one discovered worktree to another
- **THEN** the next successful refresh moves the session to the section derived from the matching worktree

#### Scenario: Local session is outside Git
- **WHEN** a local session path cannot be associated with a Git worktree
- **THEN** the navigator displays it in the `Workspace` section

#### Scenario: Remote repository context is unavailable
- **WHEN** a remote session does not have repository metadata supplied by its host
- **THEN** the navigator retains it in an explicit remote section without assigning local Git metadata

### Requirement: Navigate workspace sections
The system SHALL provide collapsible sections whose headers identify the change name and progress for change sections, the worktree name and checked-out branch or detached revision when available for other worktree sections, and the fixed label for the `Workspace` and `Remote` sections. Every displayed section, including `Workspace` and `Remote`, SHALL expose the same collapse affordance, expansion state, and session count on its header. Collapsed state SHALL be retained locally across reloads by stable section identity, and the identities of the `Workspace` and `Remote` sections MUST NOT collide with any change or worktree section identity.

#### Scenario: User collapses a section
- **WHEN** the user collapses a change or worktree section
- **THEN** its session and OpenSpec rows are hidden while its identifying header and attention indicators remain visible

#### Scenario: User collapses the Remote section
- **WHEN** the user collapses the `Remote` section
- **THEN** its session rows are hidden, its header with label, count, and attention indicators remains visible, and the state is retained across reloads

#### Scenario: Hidden session needs permission
- **WHEN** a collapsed or filtered section contains a session waiting for permission
- **THEN** the section header indicates that hidden attention is required

#### Scenario: Mobile navigation
- **WHEN** the workspace navigator is opened on a mobile layout
- **THEN** it presents the same grouping, selection, section actions, collapse state, and section sizing available in the desktop sidebar

### Requirement: Preserve filtering, ordering, and selection
The system SHALL keep session selection, project and host filtering, keyboard navigation, and session ordering functional when sessions are rendered in worktree groups.

#### Scenario: Filters hide section contents
- **WHEN** active filters exclude every session in a section
- **THEN** the navigator hides the empty session portion without losing the section's repository context or OpenSpec information

#### Scenario: Keyboard navigation crosses sections
- **WHEN** the user navigates to the next or previous visible session by keyboard
- **THEN** selection follows the flattened visible session order across expanded sections

#### Scenario: Manual reorder within a section
- **WHEN** manual sorting is enabled and a user reorders a session
- **THEN** the new order is applied within that session's section and does not reassign the session to another worktree

### Requirement: Start sessions in worktrees
The system SHALL allow a user to start a managed tmux session in any discovered local worktree from both the section header's new-session action and the new-session flow.

#### Scenario: Quick-create from a section
- **WHEN** the user invokes the new-session action on a section whose worktree already exists
- **THEN** the session form uses that worktree root as its initial project path, offers the auto-start option, and retains command preset and optional name controls

#### Scenario: Select worktree in new-session flow
- **WHEN** the user selects a discovered worktree in the new-session flow and submits valid session options
- **THEN** the system creates the tmux window with that worktree as its working directory

#### Scenario: Worktree disappears before session creation
- **WHEN** the selected worktree directory no longer exists at submission time
- **THEN** the system rejects creation with an actionable error and refreshes workspace metadata

### Requirement: Create a change worktree from its section
The system SHALL, when the user invokes the new-session action on a change section whose worktree does not exist, create the worktree before opening the session form: on branch `<change-name>` — the existing local branch when present, otherwise a new branch from the repository's current HEAD — copying `openspec/changes/<change-name>/` from the main worktree into it and committing the copy on the new branch. The system MUST NOT overwrite an existing path, check out a branch already assigned elsewhere, or modify the main worktree's checkout or index.

#### Scenario: Successful seeded creation
- **WHEN** the user invokes the new-session action on a change section without a worktree
- **THEN** the system creates `.worktrees/<change-name>` on branch `<change-name>`, copies and commits the change artifacts there, refreshes the navigator, and opens the session form with the worktree root prefilled

#### Scenario: Existing branch with the change name
- **WHEN** a local branch named `<change-name>` exists and is not checked out elsewhere
- **THEN** the created worktree checks out that branch and the artifacts are committed onto it

#### Scenario: Destination already exists
- **WHEN** `.worktrees/<change-name>` already exists on disk
- **THEN** creation is rejected without modifying that path and the user receives an actionable error

#### Scenario: Branch becomes assigned concurrently
- **WHEN** branch `<change-name>` is checked out by another worktree before creation completes
- **THEN** creation is rejected, no forced Git operation is attempted, and workspace metadata is refreshed

#### Scenario: Ignore entry is missing
- **WHEN** the repository's `.gitignore` does not exclude `.worktrees/`
- **THEN** the creation operation appends the entry and reports it in the operation result

### Requirement: Auto-start the change's apply command
The system SHALL offer, in the session form opened from a change section, to send the change's apply command — selected by agent type, `/opsx:apply <change>` for Claude and the equivalent for Codex — as the session's first user input, and SHALL inject it exactly once, the first time the session reports an idle status after creation. The pending command SHALL be held server-side so it survives client reloads, and nothing SHALL be sent when the option is off or the agent type is unrecognized.

#### Scenario: Auto-start enabled
- **WHEN** the user submits the session form with the auto-start option enabled for a recognized agent type
- **THEN** the system creates the session and injects the mapped apply command as terminal input once, at the first idle status after creation

#### Scenario: Client reloads before the agent is ready
- **WHEN** the client reloads between session creation and the first idle status
- **THEN** the pending apply command is still injected when the session first becomes idle

#### Scenario: Auto-start disabled or agent unrecognized
- **WHEN** the option is off or the selected command preset has no mapped apply command
- **THEN** no text is injected into the session

### Requirement: Browse branches not assigned to worktrees
For each discovered repository, the system SHALL list local branches that are not checked out by any worktree and SHALL distinguish them from branches already assigned to a worktree.

#### Scenario: Local branch has no worktree
- **WHEN** a local branch exists and is not checked out in any discovered worktree
- **THEN** it is available in the repository's branch browser as a candidate for worktree creation

#### Scenario: Branch is already checked out
- **WHEN** a local branch is checked out in a worktree
- **THEN** the branch browser identifies its worktree and does not offer a duplicate creation action

### Requirement: Create a worktree from a branch
The system SHALL allow a user to create a local worktree for an existing unassigned local branch at an editable absolute destination and SHALL offer to start a session there after creation. The system MUST NOT overwrite an existing path or create a second worktree for a branch already checked out elsewhere.

#### Scenario: Successful worktree creation
- **WHEN** the user selects an unassigned local branch, accepts or edits the proposed destination, and confirms creation
- **THEN** the system creates the worktree, refreshes the repository navigator, and makes the new worktree available for session launch

#### Scenario: Create and launch
- **WHEN** the user requests session launch as part of successful worktree creation
- **THEN** the system opens the normal session options for the new worktree or creates the session using options already confirmed by the user

#### Scenario: Destination already exists
- **WHEN** the requested destination already exists
- **THEN** creation is rejected without modifying that destination and the user receives an actionable error

#### Scenario: Branch becomes assigned concurrently
- **WHEN** the selected branch is checked out by another worktree before creation completes
- **THEN** creation is rejected, no forced Git operation is attempted, and workspace metadata is refreshed

### Requirement: Exclude destructive Git operations
The workspace UI MUST NOT expose worktree removal, worktree pruning, branch deletion, forced checkout, or forced worktree creation as part of this capability.

#### Scenario: Dirty worktree is displayed
- **WHEN** a discovered worktree contains tracked or untracked changes
- **THEN** the navigator reports the dirty state but does not offer an operation that discards or removes those changes

### Requirement: Automatically synchronize workspace metadata
The system SHALL automatically publish updated repository, branch, and worktree metadata after relevant Git or filesystem changes and SHALL periodically reconcile state to recover from missed watch events.

#### Scenario: External worktree is added
- **WHEN** a worktree is created outside Agentboard for a discovered repository
- **THEN** it appears without requiring a page reload or manual refresh

#### Scenario: External branch or checkout changes
- **WHEN** branch refs or a worktree's checked-out revision changes outside Agentboard
- **THEN** the affected repository snapshot is updated automatically

#### Scenario: Discovery temporarily fails
- **WHEN** Git discovery fails transiently for a previously discovered repository
- **THEN** the last successful snapshot remains visible with a stale or error indication and later reconciliation retries discovery

### Requirement: Size the Workspace and Remote sections independently
The system SHALL display the `Workspace` and `Remote` sections as panes docked at the bottom of the workspace navigator, each occupying a user-adjustable share of the navigator's height and scrolling its own rows independently of the change and worktree sections above it. Each pane SHALL default to 25% of the navigator height. The change and worktree sections SHALL keep a minimum visible height, and when the navigator is too short to honor every default the panes SHALL be reduced proportionally rather than displacing that minimum. A section with no rows SHALL NOT be displayed and SHALL NOT reserve height.

#### Scenario: Default sizing
- **WHEN** the navigator is displayed with no stored pane sizes and both fallback sections have rows
- **THEN** the `Remote` pane occupies the bottom 25% of the navigator height and the `Workspace` pane the 25% above it

#### Scenario: Pane scrolls independently
- **WHEN** a pane contains more rows than its height shows
- **THEN** those rows scroll within the pane while the change and worktree sections above keep their own scroll position

#### Scenario: Navigator is too short for the defaults
- **WHEN** the navigator height cannot fit both default pane sizes plus the minimum height of the change and worktree region
- **THEN** the panes are reduced proportionally and the change and worktree region retains its minimum height

#### Scenario: Section has no rows
- **WHEN** no session belongs to the `Remote` section
- **THEN** neither its header nor a pane is displayed and the other sections use the full navigator height

### Requirement: Resize the Workspace and Remote panes
The system SHALL provide a resize control on the top edge of each displayed `Workspace` and `Remote` pane that adjusts that pane's height by pointer drag and by keyboard when the control is focused. A pane MUST NOT be resized below the height of its own header nor above a size that would take the change and worktree region below its minimum height. Resulting sizes SHALL be stored as a share of the navigator height, retained locally across reloads, and applied to both the desktop sidebar and the mobile navigator.

#### Scenario: Drag to resize
- **WHEN** the user drags a pane's resize control upward or downward
- **THEN** that pane's height follows the pointer within the allowed range and the region above it absorbs the difference

#### Scenario: Keyboard resize
- **WHEN** the resize control has keyboard focus and the user presses an arrow key
- **THEN** the pane height changes by a fixed step in that direction, within the same allowed range

#### Scenario: Drag past a limit
- **WHEN** the user drags a resize control beyond the pane's minimum or maximum height
- **THEN** the pane stops at that limit and no other section is reduced below its own minimum

#### Scenario: Size persists across reloads
- **WHEN** the user resizes a pane and later reloads the application
- **THEN** the pane is restored at the same share of the navigator height

#### Scenario: Size is shared with the mobile navigator
- **WHEN** a pane was resized in the desktop sidebar and the navigator is then opened on a mobile layout
- **THEN** the pane occupies the same share of the navigator height there

#### Scenario: Navigator width changes
- **WHEN** the sidebar is resized horizontally or the window height changes
- **THEN** each pane keeps its stored share of the new navigator height

### Requirement: Redistribute space freed by a collapsed pane
The system SHALL reduce a collapsed `Workspace` or `Remote` pane to its header row alone and SHALL give the height it no longer uses to the remaining expanded sections. Re-expanding the pane SHALL restore the size it had before it was collapsed. A collapsed pane SHALL NOT offer a resize control.

#### Scenario: Collapse frees space
- **WHEN** the user collapses the `Remote` pane
- **THEN** only its header remains and the freed height is taken by the change and worktree region and the `Workspace` pane

#### Scenario: Re-expand restores size
- **WHEN** the user expands a previously collapsed pane
- **THEN** it returns to the size it had before collapsing, not the default size

#### Scenario: Every pane is collapsed
- **WHEN** both the `Workspace` and `Remote` panes are collapsed
- **THEN** their headers stay docked at the bottom of the navigator and the change and worktree sections use all remaining height


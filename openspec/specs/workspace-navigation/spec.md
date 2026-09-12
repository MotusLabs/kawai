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

### Requirement: Group sessions by workspace
The system SHALL visually group active, hibernating, and historical sessions by their resolved local worktree while preserving their existing lifecycle controls and status indicators.

#### Scenario: Multiple sessions use one worktree
- **WHEN** multiple sessions have project paths within the same worktree
- **THEN** the navigator displays them within one worktree group

#### Scenario: Session changes directory across worktrees
- **WHEN** a live tmux pane's current path changes from one discovered worktree to another
- **THEN** the next successful refresh moves the session to the matching worktree group

#### Scenario: Local session is outside Git
- **WHEN** a local session path cannot be associated with a Git worktree
- **THEN** the navigator displays it in an explicit ungrouped local section

#### Scenario: Remote repository context is unavailable
- **WHEN** a remote session does not have repository metadata supplied by its host
- **THEN** the navigator retains it in an explicit remote section without assigning local Git metadata

### Requirement: Navigate worktree groups
The system SHALL provide collapsible worktree groups that identify the repository, branch or detached revision, path, session count, and working-tree state. Collapsed state SHALL be retained locally across reloads.

#### Scenario: User collapses a worktree
- **WHEN** the user collapses a worktree group
- **THEN** its session and OpenSpec rows are hidden while its identifying header and attention indicators remain visible

#### Scenario: Hidden session needs permission
- **WHEN** a collapsed or filtered worktree contains a session waiting for permission
- **THEN** the worktree header indicates that hidden attention is required

#### Scenario: Mobile navigation
- **WHEN** the workspace navigator is opened on a mobile layout
- **THEN** it presents the same grouping, selection, and worktree actions available in the desktop sidebar

### Requirement: Preserve filtering, ordering, and selection
The system SHALL keep session selection, project and host filtering, keyboard navigation, and session ordering functional when sessions are rendered in worktree groups.

#### Scenario: Filters hide worktree contents
- **WHEN** active filters exclude every session in a worktree
- **THEN** the navigator hides the empty session portion without losing the worktree's repository context or OpenSpec information

#### Scenario: Keyboard navigation crosses groups
- **WHEN** the user navigates to the next or previous visible session by keyboard
- **THEN** selection follows the flattened visible session order across expanded worktree groups

#### Scenario: Manual reorder within a group
- **WHEN** manual sorting is enabled and a user reorders a session
- **THEN** the new order is applied within that session's worktree group and does not reassign the session to another worktree

### Requirement: Start sessions in worktrees
The system SHALL allow a user to start a managed tmux session in any discovered local worktree from both the worktree group and the new-session flow.

#### Scenario: Quick-create from a worktree
- **WHEN** the user invokes the new-session action on a worktree group
- **THEN** the session form uses that worktree root as its initial project path while retaining command preset and optional name controls

#### Scenario: Select worktree in new-session flow
- **WHEN** the user selects a discovered worktree in the new-session flow and submits valid session options
- **THEN** the system creates the tmux window with that worktree as its working directory

#### Scenario: Worktree disappears before session creation
- **WHEN** the selected worktree directory no longer exists at submission time
- **THEN** the system rejects creation with an actionable error and refreshes workspace metadata

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

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
The system SHALL visually group active sessions under collapsible sections for unarchived OpenSpec changes listed by each discovered repository, while preserving their existing lifecycle controls and status indicators. Sections SHALL be ordered: change sections first (with or without worktrees), then worktrees with no matching change, then `Workspace` for local sessions outside any worktree, then the remote section, then `Archive`.

#### Scenario: Change membership and the main worktree
- **WHEN** a session's resolved worktree is the repository-local path `.worktrees/<change-name>`, or a worktree matches no listed change
- **THEN** the former session is grouped under that change's section, and the latter worktree — including the main worktree — is ordered after all change sections

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
- **WHEN** a live remote session does not have repository metadata supplied by its host
- **THEN** the navigator retains it in an explicit remote section without assigning local Git metadata

### Requirement: Group chat sessions by current working directory
The system SHALL place each live chat session in the change, worktree, or
`Workspace` section derived from that session's current working directory,
using the same deepest-path association as terminal sessions. A chat created
in a worktree SHALL appear under that worktree's section. When a chat's working
directory moves to another worktree, the next session update SHALL move the
session to the section for the new directory without a page reload.

#### Scenario: Chat started in a worktree
- **WHEN** a chat session is created with a discovered worktree as its project path
- **THEN** the navigator lists that session in the matching change or worktree section, not in `Workspace`

#### Scenario: Chat agent enters a worktree
- **WHEN** a live chat session's working directory changes from one discovered worktree to another
- **THEN** the navigator moves the session to the section derived from the new worktree

#### Scenario: Chat agent is inside a worktree subdirectory
- **WHEN** a live chat session's working directory is a directory beneath a discovered worktree root
- **THEN** the navigator associates the session with that worktree using the deepest matching path

#### Scenario: Chat leaves Git entirely
- **WHEN** a live chat session's working directory changes to a path that matches no discovered worktree
- **THEN** the navigator moves the session to the `Workspace` section

### Requirement: Navigate workspace sections
The system SHALL provide collapsible sections whose headers identify the change name and progress for change sections, the worktree name and checked-out branch or detached revision when available for other worktree sections, and the fixed label for the `Workspace`, `Remote`, and `Archive` sections. Every displayed section SHALL expose the same collapse affordance, expansion state, and session count on its header, and collapsed state SHALL be retained locally across reloads.

#### Scenario: Fixed sections keep unique stable identities
- **WHEN** the `Workspace`, `Remote`, or `Archive` section is displayed and its collapsed state is stored across reloads
- **THEN** the section exposes the same collapse affordance, expansion state, and session count as any other section, keeps its state by stable section identity, and its identity MUST NOT collide with any change or worktree section identity

#### Scenario: User collapses a section
- **WHEN** the user collapses a change or worktree section
- **THEN** its session and OpenSpec rows are hidden while its identifying header and attention indicators remain visible

#### Scenario: User collapses the Remote section
- **WHEN** the user collapses the `Remote` section
- **THEN** its session rows are hidden, its header with label, count, and attention indicators remains visible, and the state is retained across reloads

#### Scenario: User expands the Archive section
- **WHEN** the user expands the `Archive` section
- **THEN** its session rows are shown and the expanded state is retained across reloads

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
- **THEN** the session form uses that worktree root as its initial project path, offers the first-prompt selector, and retains command preset and optional name controls

#### Scenario: Select worktree in new-session flow
- **WHEN** the user selects a discovered worktree in the new-session flow and submits valid session options
- **THEN** the system creates the tmux window with that worktree as its working directory

#### Scenario: Worktree disappears before session creation
- **WHEN** the selected worktree directory no longer exists at submission time
- **THEN** the system rejects creation with an actionable error and refreshes workspace metadata

### Requirement: Create a change worktree from its section
The system SHALL, when the user invokes the new-session action on a change section whose worktree does not exist, create the worktree before opening the session form: on branch `<change-name>`, copying `openspec/changes/<change-name>/` from the main worktree into it and committing the copy on the new branch. The system MUST NOT overwrite an existing path, check out a branch already assigned elsewhere, or modify the main worktree's checkout or index.

#### Scenario: Branch selection for the new worktree
- **WHEN** the change worktree is created
- **THEN** the existing local branch `<change-name>` is used when present, otherwise a new branch is created from the repository's current HEAD

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
The system SHALL offer, in the session form opened from a change section, a selector for the change's apply command — `/opsx:apply <change>` for Claude, the equivalent for Codex, or no prompt at all — and SHALL start the session with the selected command as the agent's first prompt by passing it to the agent as a launch argument. The selector SHALL be offered for every command and every host, and SHALL show the literal prompt each option would send.

#### Scenario: Selector follows the command until an explicit choice
- **WHEN** the selector's value is initialized, or the selected command changes, before the user picks a value explicitly
- **THEN** the value is the selected command preset's declared agent type when it declares one, otherwise Claude or Codex when the command's agent token begins with `claude` or `codex`, otherwise no prompt, and an explicit user selection persists for the remainder of the form

#### Scenario: Delivery and replay of the apply command
- **WHEN** a session is started with a selected apply command, no agent is selected, or a session started this way is later resumed
- **THEN** the command is passed as a launch argument and never as terminal input, nothing is sent when no agent is selected, and resumption does not replay the command

#### Scenario: Auto-start enabled
- **WHEN** the user submits the session form with Claude or Codex selected in the first-prompt selector
- **THEN** the system creates the session with the mapped apply command passed as the agent's launch argument, and the agent begins that prompt once it is ready

#### Scenario: Client reloads before the agent is ready
- **WHEN** the client reloads between session creation and the agent becoming ready
- **THEN** the first prompt is unaffected, because it is carried in the session's launch command rather than held as pending client or server state

#### Scenario: Auto-start disabled or agent unrecognized
- **WHEN** the user submits the session form with no agent selected in the first-prompt selector
- **THEN** the session is created with an unmodified command and no prompt is delivered to it

#### Scenario: Agent starts on a trust or sign-in gate
- **WHEN** the created session's agent opens on a directory-trust or sign-in prompt before reaching its input
- **THEN** the pending first prompt is neither consumed nor answered by the gate, and the agent begins it after the user clears the gate

#### Scenario: Unrecognized command still offers the selector
- **WHEN** the form's command matches no preset declaration and its agent token begins with neither `claude` nor `codex`
- **THEN** the selector is still offered, defaults to sending no prompt, and remains selectable by the user

#### Scenario: Remote host
- **WHEN** the user submits the session form for a remote host with an agent selected
- **THEN** the remote session is created with the mapped apply command passed as the agent's launch argument

#### Scenario: Session resumed after auto-start
- **WHEN** a session created with a first prompt is later resumed
- **THEN** the resumed session carries the original launch flags without the apply command, and the apply command is not delivered again

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
The system SHALL display the `Workspace`, `Remote`, and `Archive` sections as panes docked at the bottom of the workspace navigator, in that order from top to bottom, each occupying a user-adjustable share of the navigator's height and scrolling its own rows independently of the change and worktree sections above it. Each pane SHALL default to 25% of the navigator height.

#### Scenario: Short navigators and empty panes
- **WHEN** the navigator is too short to honor every default, or a pane has no rows
- **THEN** the change and worktree sections keep a minimum visible height and the panes are reduced proportionally rather than displacing that minimum, and a section with no rows is not displayed and reserves no height

#### Scenario: Default sizing
- **WHEN** the navigator is displayed with no stored pane sizes and the `Workspace` and `Remote` sections have rows while `Archive` has none
- **THEN** the `Remote` pane occupies the bottom 25% of the navigator height and the `Workspace` pane the 25% above it

#### Scenario: Archive pane is docked last
- **WHEN** the `Archive` section has rows
- **THEN** its pane is docked at the very bottom of the navigator, below the `Workspace` and `Remote` panes

#### Scenario: Pane scrolls independently
- **WHEN** a pane contains more rows than its height shows
- **THEN** those rows scroll within the pane while the change and worktree sections above keep their own scroll position

#### Scenario: Navigator is too short for the defaults
- **WHEN** the navigator height cannot fit every default pane size plus the minimum height of the change and worktree region
- **THEN** the panes are reduced proportionally and the change and worktree region retains its minimum height

#### Scenario: Section has no rows
- **WHEN** no session belongs to the `Remote` section
- **THEN** neither its header nor a pane is displayed and the other sections use the full navigator height

### Requirement: Resize the Workspace and Remote panes
The system SHALL provide a resize control on the top edge of each displayed `Workspace`, `Remote`, and `Archive` pane that adjusts that pane's height by pointer drag and by keyboard when the control is focused. Resulting sizes SHALL be stored as a share of the navigator height, retained locally across reloads, and applied to both the desktop sidebar and the mobile navigator.

#### Scenario: Resize bounds
- **WHEN** a pane is resized by drag or keyboard
- **THEN** it is not resized below the height of its own header nor above a size that would take the change and worktree region below its minimum height

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
The system SHALL reduce a collapsed `Workspace`, `Remote`, or `Archive` pane to its header row alone and SHALL give the height it no longer uses to the remaining expanded sections. Re-expanding the pane SHALL restore the size it had before it was collapsed. A collapsed pane SHALL NOT offer a resize control.

#### Scenario: Collapse frees space
- **WHEN** the user collapses the `Remote` pane
- **THEN** only its header remains and the freed height is taken by the change and worktree region and the other expanded panes

#### Scenario: Re-expand restores size
- **WHEN** the user expands a previously collapsed pane
- **THEN** it returns to the size it had before collapsing, not the default size

#### Scenario: Every pane is collapsed
- **WHEN** the `Workspace`, `Remote`, and `Archive` panes are all collapsed
- **THEN** their headers stay docked at the bottom of the navigator and the change and worktree sections use all remaining height

### Requirement: Collect closed sessions in the Archive section
The system SHALL place hibernating and historical agent sessions and archived chat sessions in an `Archive` section instead of a change, worktree, `Workspace`, or `Remote` section. Sessions recorded by this server SHALL be treated as local regardless of the host label they carry. `Archive` rows SHALL be ordered newest first by last activity, or by archive time for archived chats.

#### Scenario: Terminal session closes
- **WHEN** a local agent session becomes hibernating or historical
- **THEN** the next refresh moves it from its change, worktree, or `Workspace` section to `Archive`

#### Scenario: Chat is archived or restored
- **WHEN** a chat session is archived
- **THEN** it moves to `Archive`, and when restored it returns to the section derived from its project path

#### Scenario: Local history is not shown as remote
- **WHEN** a hibernating or historical session was recorded by this server
- **THEN** it is shown in `Archive` and not in `Remote`

#### Scenario: Archive is collapsed on first use
- **WHEN** the navigator is displayed with no stored collapse state for `Archive`
- **THEN** `Archive` is shown collapsed, with its header, count, and attention indicators visible

#### Scenario: Hibernating and history visibility toggles live in the Archive header
- **WHEN** the expanded `Archive` section contains hibernating or historical rows
- **THEN** its header offers a hibernating toggle and a history toggle, each showing how many such rows the section holds, and toggling one shows or hides those rows within `Archive` with the choice retained across reloads; no such toggles are displayed above the change and worktree sections

### Requirement: The navigator offers chat session search
The system SHALL show a search box in the navigator's filter bar beside the host and project filters. `[modifier]+K`, using the configured shortcut modifier, SHALL focus it. Typing a searchable query SHALL search after a short pause, show the latest query's results in place of the section list, and discard responses to superseded queries. Search covers every active chat regardless of the project and host filters.

#### Scenario: Box in the filter bar
- **WHEN** the navigator is shown with the project filter, and the host filter if several hosts exist
- **THEN** the search box fills the filter bar's remaining width with the placeholder `Search chats`, and while it is empty and unfocused it shows the `[modifier]+K` hint

#### Scenario: Shortcut focuses search
- **WHEN** the user presses `[modifier]+K`
- **THEN** the navigator search box receives focus with its current text selected

#### Scenario: Results replace sections
- **WHEN** the user types `#147` into the search box
- **THEN** after a short pause the navigator shows the grouped search results instead of the change, worktree, `Workspace`, `Remote`, and `Archive` sections

#### Scenario: Superseded response ignored
- **WHEN** the user types `#14` and then `#147`, and the response for `#14` arrives after the one for `#147`
- **THEN** the navigator shows only the results for `#147`

#### Scenario: Filters do not narrow search
- **WHEN** a project filter hides chat A's project and chat A mentions `#147`
- **THEN** searching `#147` still lists chat A

#### Scenario: No results
- **WHEN** no active chat matches the query
- **THEN** the navigator states that no active chat matches

### Requirement: Clearing search restores the navigator
The system SHALL restore the section list, with its filters, collapsed state, and selection, when the search box is emptied or Escape is pressed in it. Escape SHALL clear the query. Opening a session from a result SHALL keep the query and results until the user clears them.

#### Scenario: Escape clears
- **WHEN** results are shown and the user presses Escape in the search box
- **THEN** the query is cleared and the navigator shows its sections with the same filters and collapsed sections as before the search

#### Scenario: Results stay after opening a chat
- **WHEN** the user opens a chat from a result
- **THEN** the results remain in the navigator so the user can open another match

### Requirement: Search results are navigable from the search box
While results are shown, focus SHALL stay in the search box. ↑ and ↓ SHALL move an active item through group headers and snippets in display order, stopping at either end, and SHALL scroll it into view. Enter SHALL open the active item as a click would. No item is active until the first ↓. Hovering SHALL NOT move the active item.

#### Scenario: Arrow then Enter
- **WHEN** results are shown, and the user presses ↓ twice and then Enter in the search box
- **THEN** the first group's first snippet is opened and revealed, and focus remains in the search box

#### Scenario: Enter with no active item
- **WHEN** the user presses Enter before any ↓
- **THEN** nothing is opened

#### Scenario: New results reset the active item
- **WHEN** the query changes and new results arrive
- **THEN** no item is active

### Requirement: Search results mark the open chat
The system SHALL mark the group of the currently selected chat the way the navigator marks a selected session row. The keyboard-active item SHALL have a separate, visible focus indicator.

#### Scenario: Selected chat marked
- **WHEN** chat B is the selected chat and appears in the results
- **THEN** chat B's group header carries the selected-row marking

#### Scenario: Active item distinct from selection
- **WHEN** chat B is selected and the keyboard-active item is a snippet of chat A
- **THEN** chat B's header shows the selected marking and chat A's snippet shows the focus indicator

### Requirement: Search is accessible
The search box SHALL have the accessible name `Search chats` and SHALL expose the results as a list of options, identifying the active option to assistive technology. A polite live region SHALL announce each settled outcome once: `Searching…`, `N chats match`, `No active chat matches`, or the error.

#### Scenario: Result count announced
- **WHEN** a search settles with matches in 3 chats
- **THEN** the live region announces `3 chats match` once

#### Scenario: Active option exposed
- **WHEN** the user moves to a snippet with ↓
- **THEN** the search box identifies that snippet as its active option

### Requirement: Search results fit a narrow navigator
Search results SHALL never scroll horizontally. In a group header, the chat name SHALL truncate first, then the worktree name. The match count and relative time SHALL stay whole. Snippet excerpts SHALL rewrap within their two-line clamp. Full values SHALL remain available on hover.

#### Scenario: Narrowest navigator
- **WHEN** the navigator is at its minimum width and a chat name is longer than the header
- **THEN** the name ends with an ellipsis, the count and time remain fully visible, and nothing scrolls horizontally

### Requirement: A Team entry opens the team workspace at repository level
The navigator SHALL show one **Team** entry at repository level for each discovered repository. Opening it SHALL select the team workspace for that repository's team. The entry SHALL NOT be a session row, SHALL NOT be affected by session filters, and SHALL NOT change which chat is selected.

#### Scenario: One entry per repository
- **WHEN** a repository has sessions across several worktrees
- **THEN** the navigator shows one **Team** entry for that repository, not one per worktree

#### Scenario: The entry opens the workspace
- **WHEN** the human opens the **Team** entry
- **THEN** the team workspace for that repository's team opens and the selected chat is unchanged

#### Scenario: Session filters do not hide the entry (E14)
- **WHEN** a project or host filter leaves no visible session rows
- **THEN** the **Team** entry for a repository that still has a team remains available

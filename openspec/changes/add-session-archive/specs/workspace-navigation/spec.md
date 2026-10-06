# Spec Delta

## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: Group sessions by OpenSpec change section
The system SHALL visually group active sessions under collapsible sections for unarchived OpenSpec changes listed by each discovered repository, while preserving their existing lifecycle controls and status indicators. A change's sessions are those whose resolved worktree is the repository-local path `.worktrees/<change-name>`. Sections SHALL be ordered: change sections first (with or without worktrees), then worktrees with no matching change (including the main worktree), then `Workspace` for local sessions outside any worktree, then the remote section, then `Archive`.

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

### Requirement: Navigate workspace sections
The system SHALL provide collapsible sections whose headers identify the change name and progress for change sections, the worktree name and checked-out branch or detached revision when available for other worktree sections, and the fixed label for the `Workspace`, `Remote`, and `Archive` sections. Every displayed section, including `Workspace`, `Remote`, and `Archive`, SHALL expose the same collapse affordance, expansion state, and session count on its header. Collapsed state SHALL be retained locally across reloads by stable section identity, and the identities of the `Workspace`, `Remote`, and `Archive` sections MUST NOT collide with any change or worktree section identity.

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

### Requirement: Size the Workspace and Remote sections independently
The system SHALL display the `Workspace`, `Remote`, and `Archive` sections as panes docked at the bottom of the workspace navigator, in that order from top to bottom, each occupying a user-adjustable share of the navigator's height and scrolling its own rows independently of the change and worktree sections above it. Each pane SHALL default to 25% of the navigator height. The change and worktree sections SHALL keep a minimum visible height, and when the navigator is too short to honor every default the panes SHALL be reduced proportionally rather than displacing that minimum. A section with no rows SHALL NOT be displayed and SHALL NOT reserve height.

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
The system SHALL provide a resize control on the top edge of each displayed `Workspace`, `Remote`, and `Archive` pane that adjusts that pane's height by pointer drag and by keyboard when the control is focused. A pane MUST NOT be resized below the height of its own header nor above a size that would take the change and worktree region below its minimum height. Resulting sizes SHALL be stored as a share of the navigator height, retained locally across reloads, and applied to both the desktop sidebar and the mobile navigator.

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

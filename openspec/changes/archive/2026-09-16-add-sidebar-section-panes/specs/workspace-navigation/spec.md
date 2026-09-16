## MODIFIED Requirements

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

## ADDED Requirements

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

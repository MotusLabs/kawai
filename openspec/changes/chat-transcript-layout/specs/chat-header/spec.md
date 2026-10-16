# Spec Delta

## RENAMED Requirements

- FROM: `### Requirement: The header shows the session's identity and status in two lines`
- TO: `### Requirement: The header shows the session's identity and status with wrapping metadata`

## MODIFIED Requirements

### Requirement: The header shows the session's identity and status with wrapping metadata
The chat view header SHALL show status (color and word) and the session name, which opens rename on click, in its identity row. Supporting metadata SHALL show the profile, reported model when known, and project's last path segment, with full path on hover. Metadata SHALL wrap when needed. Task and paused context SHALL have a separate wrapping row when present.

#### Scenario: Live session identity
- **WHEN** a chat view is open for a live session on profile `Default` whose agent reported model `claude-opus-5-5` in `/home/coder/kawai`
- **THEN** the identity row shows the status word and session name without a ` · Chat` suffix, and supporting metadata shows `Default`, `claude-opus-5-5`, and `kawai`, with `/home/coder/kawai` available on hover

#### Scenario: Status indicator follows the session
- **WHEN** the session's status changes from working to waiting, or the connection drops
- **THEN** the indicator's word and color change to the new status, or to the connection state while disconnected, and an archived chat shows `archived`

#### Scenario: Task and paused chips
- **WHEN** the session works on a task and is paused at a usage limit
- **THEN** a separate wrapping context row shows a task link opening that task on the Team page and the paused notice, with readable task and pause text

#### Scenario: Long metadata
- **WHEN** profile, model, project, or task labels exceed the space available on one row
- **THEN** they wrap across available rows and long unbroken values can break within their own content without forcing horizontal header scrolling

#### Scenario: Rename from the name
- **WHEN** the user clicks the session name
- **THEN** the name becomes an editable field with the existing rename behavior

### Requirement: The header compacts by its own width without clipping controls
The header SHALL adapt to its own width and chat font size. To keep identity and actions on one row, Team SHALL compact to an icon, then into the session menu as space decreases. Context usage SHALL remain visible in supporting metadata, compacting to percentage with full counts accessible when needed. Identity/actions, metadata, and task/paused context SHALL use additional rows to prevent clipping; status, visible name characters, Auto-approve, and the menu SHALL remain reachable.

#### Scenario: Full layout on a wide header
- **WHEN** the header is wide enough for every control with labels
- **THEN** Team shows its label, context shows percentage with used and threshold counts beside supporting metadata, and session identity has room apart from task context

#### Scenario: Icons on a medium header
- **WHEN** the header is too narrow for the labelled Team button but fits it as an icon
- **THEN** Team shows an icon whose accessible name and tooltip are `Team`

#### Scenario: Switcher folds into the menu
- **WHEN** the header is too narrow for the icon Team button
- **THEN** Team appears in the session menu, context shows percentage with full counts available on hover and to assistive technology, and the name, status, Auto-approve switch, and menu remain reachable inside the header

#### Scenario: Same window, narrower header
- **WHEN** the window width is unchanged but the navigator is widened so the header narrows
- **THEN** the header adapts to its new width and metadata and task context wrap instead of competing for a single line

#### Scenario: Larger chat font and narrow container
- **WHEN** the chat font grows or the header becomes too narrow for identity and actions on one row
- **THEN** controls reflow within the header without clipping, overlap, or horizontal header scrolling, and Auto-approve remains labelled and visible for live Chats

## ADDED Requirements

### Requirement: Header reflow preserves session controls and supporting information
Header reflow SHALL preserve Team and task navigation, inline rename, approval policy, context readings, lifecycle actions, and connection status. Existing usage meters and notifications SHALL remain below the header. Archived Chats SHALL retain their stored metadata and context, hide Auto-approve, and keep their Restore bar below the transcript.

#### Scenario: Existing controls remain operable
- **WHEN** the header uses any responsive layout
- **THEN** Team, task navigation, rename, Debug, Archive, and confirmed Kill retain their existing availability and keyboard behavior, and Auto-approve retains its state and amber indication

#### Scenario: Supplemental strips
- **WHEN** a session has usage readings or notices
- **THEN** existing usage meters and notifications remain available below the header with their existing reset, elapsed, and dismissal information

#### Scenario: Archived identity
- **WHEN** an archived Chat is opened
- **THEN** its stored profile, model, project, task context, and context reading remain available, Auto-approve is hidden, and Restore remains below the transcript

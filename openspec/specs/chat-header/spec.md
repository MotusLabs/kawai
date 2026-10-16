# chat-header Specification

## Purpose

Defines the chat view header: how it presents a chat session's identity and status, and how it organizes the side-panel, approval, and session-lifecycle controls so they stay legible and reachable at every header width.

## Requirements

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

### Requirement: The approval policy is a visible switch
For a live chat session the header SHALL show the approval policy as a labelled Auto-approve switch at every header width, visibly distinct (amber) while on. Toggling it SHALL switch the policy as the existing approval-policy control does. An archived chat SHALL show no switch.

#### Scenario: Switch reflects the policy
- **WHEN** a live session's policy is auto
- **THEN** the header shows the Auto-approve switch on and highlighted, and turning it off switches the session to manual for every attached client

#### Scenario: Switch survives narrow headers
- **WHEN** the header is at its narrowest layout
- **THEN** the Auto-approve switch is still shown in the header, not in a menu

#### Scenario: Archived chat has no switch
- **WHEN** an archived chat is open
- **THEN** the header shows no Auto-approve switch

### Requirement: Session actions live in a session menu
The header SHALL offer a session menu holding Rename, Debug, Archive, and Kill session. Debug SHALL toggle the debug panel in the side slot and show whether it is open. Archive SHALL follow the existing archive rules, including confirmation during a turn, and SHALL be absent for an archived chat; Kill session SHALL be styled as destructive and listed last.

#### Scenario: Menu actions for a live chat
- **WHEN** the user opens the session menu of a live chat
- **THEN** it lists Rename, Debug, Archive, and Kill session, with Kill session last and styled as destructive

#### Scenario: Debug from the menu
- **WHEN** the user chooses Debug while the debug panel is closed
- **THEN** the debug panel opens in the side slot and the menu marks Debug as on; choosing it again closes the panel

#### Scenario: Menu for an archived chat
- **WHEN** the user opens the session menu of an archived chat
- **THEN** it lists Rename, Debug, and Kill session but not Archive, and the Restore bar stays below the transcript

### Requirement: Killing a chat from the header asks for confirmation
Choosing Kill session from the chat header SHALL open a confirmation naming the session and stating that killing permanently removes the chat session, unlike Archive. Only confirming SHALL kill it; cancelling or dismissing SHALL leave the session unchanged.

#### Scenario: Confirmed kill
- **WHEN** the user chooses Kill session and confirms
- **THEN** the session is killed exactly as before this change

#### Scenario: Cancelled kill
- **WHEN** the user chooses Kill session and then cancels or presses Escape
- **THEN** the confirmation closes and the session, its conversation, and its agent are unchanged

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

### Requirement: Header controls are operable by keyboard and assistive technology
Every header control SHALL have an accessible name, including the icon-only Team button. The Auto-approve switch SHALL expose its on/off state, and the session menu SHALL open, move between items, and close with the keyboard, returning focus to its trigger.

#### Scenario: Keyboard through the session menu
- **WHEN** the user focuses the session menu trigger, presses Enter, moves with the arrow keys, and presses Escape
- **THEN** the menu opens, focus moves between its items, and Escape closes it with focus back on the trigger

#### Scenario: Icon-only entries keep their names
- **WHEN** the Team button shows an icon only
- **THEN** it is announced as `Team`

### Requirement: Team views open from one Team button
The header SHALL offer one **Team** button that opens the Team page for the chat's team, on the tab last used for that team, or on Tasks the first time. The header SHALL NOT offer Tasks, Mailbox, Messages, or Strategy panels, and those views SHALL NOT open in the chat's side slot. The button SHALL be present for archived chats and for chats whose team is a plain directory.

#### Scenario: Team opens the team's page
- **WHEN** the user chooses Team in a chat of repository `kawai` after last leaving that team's page on Mailbox
- **THEN** the Team page for `kawai`'s team opens on its Mailbox tab and the chat stays selected in the navigator

#### Scenario: First open lands on Tasks
- **WHEN** the user chooses Team for a team whose page has not been opened in this browser tab
- **THEN** the Team page opens on its Tasks tab

#### Scenario: No team panels in the side slot
- **WHEN** a chat view is open
- **THEN** the header shows no Tasks, Mailbox, Messages, or Strategy entry, and only the debug panel can occupy the side slot

#### Scenario: Plain-directory team
- **WHEN** the chat runs in a directory that is not a git repository
- **THEN** the Team button opens the Team page for that directory's team

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

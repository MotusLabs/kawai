# Spec Delta

## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: The header shows the session's identity and status in two lines
The chat view header SHALL show, on its first line, a status indicator (a color and the status word) followed by the session name, which opens rename on click. Its second line SHALL show the profile, the reported model when known, and the project's last path segment, with the full path on hover; the task link and the paused notice SHALL appear on that line as inline chips.

#### Scenario: Live session identity
- **WHEN** a chat view is open for a live session on profile `Default` whose agent reported model `claude-opus-5-5` in `/home/coder/kawai`
- **THEN** the first line shows the status word and the session name without a ` · Chat` suffix, and the second line shows `Default`, `claude-opus-5-5`, and `kawai`, with `/home/coder/kawai` available on hover

#### Scenario: Status indicator follows the session
- **WHEN** the session's status changes from working to waiting, or the connection drops
- **THEN** the indicator's word and color change to the new status, or to the connection state while disconnected, and an archived chat shows `archived`

#### Scenario: Task and paused chips
- **WHEN** the session works on a task and is paused at a usage limit
- **THEN** the second line shows a task chip that opens that task on the Team page's Tasks tab and a paused chip with the parked notice, without adding header lines

#### Scenario: Rename from the name
- **WHEN** the user clicks the session name
- **THEN** the name becomes an editable field with the existing rename behavior

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

### Requirement: The header compacts by its own width without clipping controls
The header SHALL fit its controls to its own width, independent of the viewport: when space runs short the Team button SHALL show an icon only, then move into the session menu, and the context meter SHALL show only its percentage. No control SHALL be clipped or placed outside the header, and the session name SHALL keep visible characters.

#### Scenario: Full layout on a wide header
- **WHEN** the header is wide enough for every control with labels
- **THEN** the Team button shows its label and the context meter shows its percentage with used and threshold counts

#### Scenario: Icons on a medium header
- **WHEN** the header is too narrow for the labelled Team button but fits it as an icon
- **THEN** the Team button shows an icon whose accessible name and tooltip are `Team`

#### Scenario: Switcher folds into the menu
- **WHEN** the header is too narrow for the icon Team button
- **THEN** Team appears in the session menu, the context meter shows only its percentage with the counts on hover, and the name, status, Auto-approve switch, and menu stay visible inside the header

#### Scenario: Same window, narrower header
- **WHEN** the window width is unchanged but the navigator is widened so the header narrows
- **THEN** the header moves to the compact layout that fits its new width

### Requirement: Header controls are operable by keyboard and assistive technology
Every header control SHALL have an accessible name, including the icon-only Team button. The Auto-approve switch SHALL expose its on/off state, and the session menu SHALL open, move between items, and close with the keyboard, returning focus to its trigger.

#### Scenario: Keyboard through the session menu
- **WHEN** the user focuses the session menu trigger, presses Enter, moves with the arrow keys, and presses Escape
- **THEN** the menu opens, focus moves between its items, and Escape closes it with focus back on the trigger

#### Scenario: Icon-only entries keep their names
- **WHEN** the Team button shows an icon only
- **THEN** it is announced as `Team`

## REMOVED Requirements

### Requirement: Side panels are chosen from one switcher
**Reason**: Tasks, Mailbox, Messages, and Strategy show the whole team, not the selected chat; they move to the Team page's tabs, so the chat header no longer switches between them.
**Migration**: Use the header's **Team** button or the navigator's **Team** entry and pick the tab; the task chip opens its task on the Team page.

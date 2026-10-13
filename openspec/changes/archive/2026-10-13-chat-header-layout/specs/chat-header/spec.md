# Spec Delta

## Purpose

Defines the chat view header: how it presents a chat session's identity and status, and how it organizes the side-panel, approval, and session-lifecycle controls so they stay legible and reachable at every header width.

## ADDED Requirements

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
- **THEN** the second line shows a task chip that opens that task in the Tasks panel and a paused chip with the parked notice, without adding header lines

#### Scenario: Rename from the name
- **WHEN** the user clicks the session name
- **THEN** the name becomes an editable field with the existing rename behavior

### Requirement: Side panels are chosen from one switcher
The header SHALL present the Tasks, Mailbox, Messages, and Strategy panels as one switcher whose selected entry is the panel open in the side slot. Choosing an entry SHALL open its panel and close any other; choosing the selected entry SHALL close it. Panels opened from elsewhere, such as a task chip, SHALL show as selected.

#### Scenario: Opening a panel selects it
- **WHEN** the user chooses Tasks while Mailbox is open
- **THEN** the Mailbox panel closes, the Tasks panel opens, and the switcher shows Tasks as selected and Mailbox as not selected

#### Scenario: Choosing the open panel closes it
- **WHEN** the user chooses Strategy while the Strategy panel is open
- **THEN** the panel closes and no switcher entry is selected

#### Scenario: Panel opened from the task chip
- **WHEN** the user clicks the header's task chip
- **THEN** the Tasks panel opens on that task and the switcher shows Tasks as selected

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
- **WHEN** the user chooses Debug while the Tasks panel is open
- **THEN** the Tasks panel closes, the debug panel opens, the switcher shows no entry selected, and the menu marks Debug as on

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
The header SHALL fit its controls to its own width, independent of the viewport: when space runs short the panel switcher SHALL show icons only, then move into the session menu, and the context meter SHALL show only its percentage. No control SHALL be clipped or placed outside the header, and the session name SHALL keep visible characters.

#### Scenario: Full layout on a wide header
- **WHEN** the header is wide enough for every control with labels
- **THEN** the switcher shows labelled entries and the context meter shows its percentage with used and threshold counts

#### Scenario: Icons on a medium header
- **WHEN** the header is too narrow for labelled entries but fits the switcher as icons
- **THEN** the switcher shows icons whose accessible names and tooltips are the panel names

#### Scenario: Switcher folds into the menu
- **WHEN** the header is too narrow for the icon switcher
- **THEN** the panel entries appear in the session menu with their selected state, the context meter shows only its percentage with the counts on hover, and the name, status, Auto-approve switch, and menu stay visible inside the header

#### Scenario: Same window, narrower header
- **WHEN** the window width is unchanged but the navigator is widened so the header narrows
- **THEN** the header moves to the compact layout that fits its new width

### Requirement: Header controls are operable by keyboard and assistive technology
Every header control SHALL have an accessible name, including icon-only switcher entries. The switcher SHALL expose which entry is selected, the Auto-approve switch its on/off state, and the session menu SHALL open, move between items, and close with the keyboard, returning focus to its trigger.

#### Scenario: Keyboard through the session menu
- **WHEN** the user focuses the session menu trigger, presses Enter, moves with the arrow keys, and presses Escape
- **THEN** the menu opens, focus moves between its items, and Escape closes it with focus back on the trigger

#### Scenario: Icon-only entries keep their names
- **WHEN** the switcher shows icons only
- **THEN** each entry is announced by its panel name and its selected state

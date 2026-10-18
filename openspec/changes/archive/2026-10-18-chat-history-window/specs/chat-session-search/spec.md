## MODIFIED Requirements

### Requirement: Results jump to the matched entry
The system SHALL, when the user chooses a snippet, select that chat, open its chat view, scroll the matched entry into view, and highlight it briefly. When the matched entry is a tool input or result, the system SHALL scroll to that tool's entry. When the entry is older than the loaded history, the system SHALL first load history back to it. Choosing a group's header SHALL open the chat without scrolling. If the entry is no longer in the transcript, the chat SHALL still open.

#### Scenario: Jump to a tool result
- **WHEN** the user chooses the snippet for the `gh pr create` result in chat B
- **THEN** chat B is selected, its view scrolls to that tool entry, and the entry is highlighted for a moment

#### Scenario: Jump to an entry older than the loaded window
- **WHEN** the user chooses a snippet whose entry is four days old in a chat that shows only its last 24 hours
- **THEN** the chat loads its history back to that entry, scrolls to it, and highlights it, and the load-earlier control remains offered if older history still exists

#### Scenario: Entry highlight in the chat palette
- **WHEN** the revealed entry is highlighted in the chat view's reduced-glare palette or in the light theme
- **THEN** the highlight is visible against the transcript background and fades out after about two seconds

#### Scenario: Entry no longer present
- **WHEN** the chosen entry cannot be found after the chat opens
- **THEN** the chat opens at its usual position and no error is raised

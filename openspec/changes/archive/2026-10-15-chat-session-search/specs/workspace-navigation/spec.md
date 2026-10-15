## ADDED Requirements

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

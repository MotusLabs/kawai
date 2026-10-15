## ADDED Requirements

### Requirement: The navigator offers chat session search
The system SHALL show a search box in the navigator's filter bar beside the host and project filters. `[modifier]+K`, using the configured shortcut modifier, SHALL focus it. Typing a searchable query SHALL search after a short pause, show the latest query's results in place of the section list, and discard responses to superseded queries. Search covers every active chat regardless of the project and host filters.

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

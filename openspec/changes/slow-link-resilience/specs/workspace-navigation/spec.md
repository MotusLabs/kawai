## ADDED Requirements

### Requirement: Archive loads archived chat rows on demand
The `Archive` header SHALL take its archived-chat count from the archive summary, without loading archived chat rows. Expanding `Archive` SHALL load archived chat rows in pages of 50, newest archived first, and SHALL load the next page when the user scrolls to the end of the loaded rows. Hibernating and historical agent rows SHALL keep their existing source and ordering.

#### Scenario: Collapsed Archive loads no archived rows
- **WHEN** the navigator is shown with `Archive` collapsed
- **THEN** its header shows the archived-chat count from the summary, and no archived chat rows are requested

#### Scenario: Expanding Archive loads the first page
- **WHEN** the user expands `Archive` and 771 chats are archived
- **THEN** the 50 most recently archived chats are requested and shown, newest first, with a loading state until they arrive

#### Scenario: Scrolling loads the next page
- **WHEN** the user scrolls to the end of the loaded archived rows and more remain
- **THEN** the next 50 are requested and appended, and no page is requested twice

#### Scenario: Archiving or restoring while Archive is open
- **WHEN** a chat is archived or restored while `Archive` is expanded
- **THEN** the archived chat appears at the top of the loaded rows, or the restored chat leaves `Archive` and returns to the section derived from its project path

### Requirement: Archived chats are fetched by id when referenced
Showing or opening an archived chat the client does not hold, whether referenced elsewhere in the app such as a task's assignee on the Team page or restored as the selection kept across reloads, SHALL fetch that session's row, and SHALL NOT require loading `Archive` pages first. Rows referenced together SHALL be fetched in one request.

#### Scenario: Reload with an archived chat selected
- **WHEN** the app reloads with an archived chat as the kept selection and the client does not hold its row
- **THEN** the client fetches that chat's row and opens the chat

#### Scenario: Team page references archived members
- **WHEN** the Team page shows tasks whose assignees are 12 archived chats the client does not hold, while `Archive` is collapsed
- **THEN** the client fetches those 12 rows in one request, shows them, and loads no `Archive` page

#### Scenario: The chat no longer exists
- **WHEN** the client fetches the row of a chat session the server does not know
- **THEN** the client shows that the chat was not found instead of waiting indefinitely, and clears a kept selection that named it

### Requirement: Reconnects skip an unchanged workspace snapshot
Every workspace snapshot the server sends SHALL carry a digest of its content, excluding its generation time. A connecting client SHALL name the digest of the snapshot it holds, and when it equals the digest of the server's current snapshot the server SHALL NOT send the snapshot on connect. Later snapshot changes SHALL be sent as before.

#### Scenario: Reconnect with an unchanged workspace
- **WHEN** a client reconnects naming the digest of the server's current workspace snapshot
- **THEN** the server sends no workspace snapshot on connect, and the client keeps the one it holds

#### Scenario: The workspace changed while disconnected
- **WHEN** a worktree was added while the client was disconnected
- **THEN** on reconnect the digest differs, and the server sends the current snapshot with its digest

#### Scenario: A server restart with the same workspace
- **WHEN** the server restarts and its first snapshot has the same content as the client's
- **THEN** the digests are equal, and the snapshot is not resent

#### Scenario: A first connect names no digest
- **WHEN** a client connects without naming a digest
- **THEN** the server sends its current snapshot with its digest

#### Scenario: Only the generation time differs
- **WHEN** the server regenerates a snapshot whose content equals the one the client holds
- **THEN** the digests are equal

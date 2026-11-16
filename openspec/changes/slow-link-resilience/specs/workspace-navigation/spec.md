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
- **THEN** the next 50 are requested and appended, and no page is requested twice within the current paging lifecycle

#### Scenario: Archiving or restoring while Archive is open
- **WHEN** a chat is archived or restored while `Archive` is expanded
- **THEN** the archived chat appears at the top of the loaded rows, or the restored chat leaves `Archive` and returns to the section derived from its project path

### Requirement: Archived chats are fetched by id when referenced
Showing or opening an archived chat the client does not hold, whether referenced elsewhere in the app such as a task's assignee on the Team page or restored as the selection kept across reloads, SHALL fetch that session's row, and SHALL NOT require loading `Archive` pages first. Rows referenced together SHALL be fetched in one request.

#### Scenario: Reload with an archived chat selected
- **WHEN** the app reloads with an archived chat as the kept selection and the client does not hold its row
- **THEN** the client fetches that chat's row and opens the chat even with Archive collapsed

#### Scenario: Team page references archived members
- **WHEN** the Team page shows tasks whose assignees are 12 archived chats the client does not hold, while `Archive` is collapsed
- **THEN** the client fetches those 12 rows in one request, shows them, and loads no `Archive` page

#### Scenario: The chat no longer exists
- **WHEN** the client fetches the row of a chat session the server does not know
- **THEN** the client shows that the chat was not found instead of waiting indefinitely, and clears a kept selection that named it

### Requirement: Archive requests follow current connection and lifecycle state
The first session list of each connection SHALL invalidate archive caches and older HTTP requests, refresh an expanded Archive, and resolve visible references before fallback. Later WS lifecycle mutations SHALL supersede older HTTP rows/unknown replies and clear obsolete unknown marks. Archived/pending selections SHALL survive collapsed Archive; existing live-filter, Team and hibernating fallback SHALL remain. Periodic lists SHALL NOT reset paging.

#### Scenario: A lifecycle update overtakes an HTTP reply
- **WHEN** an archive, removal, creation or restore arrives after an HTTP request was issued and before its reply
- **THEN** the newer lifecycle state wins, and the old row or unknown reply cannot resurrect a deleted/live archived row or clear the current selection

#### Scenario: Reconnect invalidates archive requests and pages
- **WHEN** a new connection receives its first session list while old archive requests or cached pages exist
- **THEN** those requests and caches are invalidated, live duplicates are excluded, expanded Archive refetches its first page, and selected/rendered references resolve before fallback

#### Scenario: A filtered live selection keeps its fallback
- **WHEN** an unarchived selection is excluded from visible navigation by the current filters
- **THEN** the existing first-visible fallback remains, with Team-page deferral and hibernating selection behavior preserved

### Requirement: Reconnects skip an unchanged workspace snapshot
Every workspace snapshot SHALL carry a content digest excluding generation time. Client and server SHALL replace snapshot and digest atomically, with digest a top-level wire field. A connecting client SHALL name its held digest; an equal current snapshot SHALL NOT be resent. If unavailable at open, only the initial comparison SHALL wait for first publication: equal suppresses, different/invalid/absent delivers. Later structural changes SHALL broadcast normally.

#### Scenario: Reconnect with an unchanged workspace
- **WHEN** a client reconnects naming the digest of the server's current workspace snapshot
- **THEN** the server sends no workspace snapshot on connect, and the client keeps the one it holds

#### Scenario: The workspace changed while disconnected
- **WHEN** a worktree was added while the client was disconnected
- **THEN** on reconnect the digest differs, and the server sends the current snapshot with its digest

#### Scenario: A server restart with the same workspace
- **WHEN** the server restarts, the client reconnects before the first snapshot is available, and that first snapshot has the same content as the client's
- **THEN** the digests are equal, and the snapshot is not resent

#### Scenario: A first connect names no digest
- **WHEN** a client connects without naming a digest
- **THEN** the server sends its current snapshot with its digest

#### Scenario: Only the generation time differs
- **WHEN** the server regenerates a snapshot whose content equals the one the client holds
- **THEN** the digests are equal

#### Scenario: Initial unavailable snapshot differs or has no valid held digest
- **WHEN** the client connects before the first snapshot exists with a different, absent or malformed digest
- **THEN** the first available snapshot is delivered with its digest, and later structural changes are delivered normally

#### Scenario: Later changes follow a suppressed initial snapshot
- **WHEN** the first snapshot after startup was suppressed because it matched the client's held digest and the workspace then changes
- **THEN** the changed snapshot and its digest are delivered normally

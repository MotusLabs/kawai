## ADDED Requirements

### Requirement: The session list leaves out archived chats
The session list the server sends on connect and in session-list broadcasts SHALL hold only sessions that are not archived chat sessions. Alongside it, the server SHALL send an archive summary holding the number of archived chat sessions.

#### Scenario: Archived chats stay off the connect payload
- **WHEN** a client connects to a server with 7 unarchived sessions and 771 archived chat sessions
- **THEN** the session list holds the 7 unarchived sessions, and the archive summary reports 771 archived chats

### Requirement: Chat session lifecycle changes are sent one session at a time
Creating, restoring, archiving or removing a chat session SHALL send connected clients a message about that one session, together with the new archive summary when the number of archived chats changed. It SHALL NOT rebroadcast the whole session list.

#### Scenario: A chat session is created
- **WHEN** a chat session is created
- **THEN** clients receive a single-session update with its row, and no session-list message is sent

#### Scenario: A chat session is archived
- **WHEN** a chat session is archived
- **THEN** clients receive a removal of that session from the session list and an archive summary whose count is one higher

#### Scenario: A chat session is restored
- **WHEN** an archived chat session is restored
- **THEN** clients receive a single-session update with its row and an archive summary whose count is one lower

#### Scenario: A chat session is removed
- **WHEN** an unarchived chat session is removed
- **THEN** clients receive a single-session removal, and no session-list message is sent

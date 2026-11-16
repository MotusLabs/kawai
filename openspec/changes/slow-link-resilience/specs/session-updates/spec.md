## ADDED Requirements

### Requirement: The session list leaves out archived chats
The session list the server sends on connect and in session-list broadcasts SHALL hold only sessions that are not archived chat sessions. Alongside it, the server SHALL send an archive summary holding the number of archived chat sessions.

#### Scenario: Archived chats stay off the connect payload
- **WHEN** a client connects to a server with 7 unarchived sessions and 771 archived chat sessions
- **THEN** the session list holds the 7 unarchived sessions, and the archive summary reports 771 archived chats

#### Scenario: A client connects before initial restoration settles
- **WHEN** a client connects while persisted archived chats are still being restored
- **THEN** initial restoration settlement sends one current archive summary to that client without reconnecting, archived row traffic, per-row boot summaries or delaying server listen

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

#### Scenario: An archived chat is registered at boot
- **WHEN** an already archived chat is registered while restoring server state
- **THEN** it contributes to the archive count but emits no live row or session-list message

#### Scenario: An archived chat is patched without restoration
- **WHEN** an archived chat receives a metadata patch and remains archived
- **THEN** no live session update or session-list message is sent

#### Scenario: Archive and restore use the patch path
- **WHEN** a chat is archived and restored through the session manager's patch path
- **THEN** clients receive the same single-session transitions and archive counts as replacement registration, without losing the open transcript or snapshot cache

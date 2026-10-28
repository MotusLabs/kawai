## ADDED Requirements

### Requirement: The server stays responsive while persisted chats restore
After a restart the system SHALL answer requests while it restores persisted chat sessions, whatever the number of sessions and the size of their transcripts. Restoring SHALL NOT read a whole transcript into memory to learn its title or working directory. Every persisted session SHALL be listed once restore completes.

#### Scenario: A very large archived transcript does not stall startup
- **WHEN** the server restarts with hundreds of archived chats, one of them holding a transcript of several hundred megabytes
- **THEN** the server answers requests throughout startup, and its memory does not grow with the transcript's size

#### Scenario: Every session is listed after restore
- **WHEN** the server restarts and restore completes
- **THEN** every persisted chat session, live or archived, is listed

### Requirement: Live chats adopt transcript facts before restore completes
When the server restores a non-archived chat session, the system SHALL adopt its transcript's current generated title and most recent working directory before restore completes. These are the same values a full read of the transcript would give.

#### Scenario: A live chat shows its newest title and path at once
- **WHEN** the server restarts and a live chat's transcript carries a later generated title and a different working directory than the stored ones
- **THEN** once restore completes, the session is listed with that title and that working directory as its project path

### Requirement: Archived chats catch up on transcript facts after restore
The system SHALL list an archived chat session at restore with its stored name and project path. Afterwards it SHALL adopt the transcript's current generated title and most recent working directory without blocking requests. It SHALL keep the session archived, and SHALL NOT overwrite a session that was renamed, restored, or otherwise changed in the meantime.

#### Scenario: An archived chat catches up after startup
- **WHEN** the server restarts and an archived chat's transcript carries a later generated title and working directory
- **THEN** the session is listed at once with its stored name, later shows the newer title and path, and stays archived

#### Scenario: A user-set name survives the catch-up
- **WHEN** an archived or live chat's name was set by the user and its transcript carries a generated title
- **THEN** the session keeps the user-set name after restore and after the catch-up

### Requirement: Transcript-missing checks see the transcript's current presence
The check that refuses to start a chat agent whose transcript is missing SHALL reflect whether the transcript exists at the time of the check. A transcript deleted since the last check SHALL be reported missing. A transcript that appears after an earlier check found none SHALL be found.

#### Scenario: A deleted transcript is reported missing
- **WHEN** a chat's transcript is deleted after the server last found it
- **THEN** the next start attempt reports that the transcript is missing

#### Scenario: A restored transcript is found
- **WHEN** a chat's transcript was missing at one check and is put back before the next
- **THEN** the next start attempt finds it

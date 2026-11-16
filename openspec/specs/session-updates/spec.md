# session-updates Specification

## Purpose

Defines how session state changes are detected, broadcast, and rendered: updates
propagate promptly for meaningful changes while steady activity churn does not
flood clients or trigger re-render storms.

## Requirements

### Requirement: Session broadcasts fire only on meaningful changes
The server SHALL detect session-list changes against activity timestamps
quantized to 30-second buckets, and SHALL NOT broadcast a session-list update
when only sub-quantum activity changed. Only change detection SHALL use
buckets; creation timestamps and invalid timestamps SHALL keep their existing
behavior.

#### Scenario: Timestamp precision is preserved
- **WHEN** activity timestamps are stored, replaced, or emitted
- **THEN** they retain full precision and never regress during replacement, creation timestamps are unaffected, and invalid timestamps retain raw comparison behavior

#### Scenario: Delayed recency with precise tie-breakers
- **WHEN** only activity recency and label updates wait for a bucket crossing
- **THEN** the delay is allowed, and emitted timestamps still preserve precise status-sort tie-breakers

#### Scenario: Sub-quantum churn produces no broadcast
- **WHEN** a window's content changes repeatedly within one 30-second bucket
  and no other field changes
- **THEN** no session-list update is broadcast for those changes

#### Scenario: Meaningful changes still broadcast
- **WHEN** a session's status, name, membership, or another non-activity field
  changes, or its activity crosses into a new bucket
- **THEN** a session-list update is broadcast

#### Scenario: Immediate working status on Enter is preserved
- **WHEN** the user presses Enter in a session
- **THEN** that session's working-status update is still delivered
  immediately, outside the quantization cadence

### Requirement: Session rows do not re-render on activity-only churn
The client SHALL NOT re-render a session row when only its activity timestamp
changes within the quantized bucket, and SHALL re-render it when status or
other displayed fields change. Relative-time labels SHALL refresh from a
periodic tick independent of broadcasts.

#### Scenario: Activity-only update skips the row
- **WHEN** a session-list update arrives whose only change for a row is its
  activity timestamp within the same bucket
- **THEN** that row is not re-rendered

#### Scenario: Status change re-renders the row
- **WHEN** a session's status changes
- **THEN** its row re-renders with the new status

#### Scenario: Labels stay fresh without broadcasts
- **WHEN** no meaningful session changes occur for several minutes
- **THEN** relative-time labels still refresh on the periodic tick

#### Scenario: Updated action callback remains current
- **WHEN** a row's action callback or optional action availability changes
- **THEN** the row uses the latest callback and displays the current actions

#### Scenario: Precise timestamps survive suppression
- **WHEN** activity changes inside a bucket without an emitted list update
- **THEN** the registry stores the precise latest timestamp and includes it
  in the next emitted payload, preserving recency ordering within that bucket

### Requirement: Terminal chrome inputs stay referentially stable
The client SHALL keep the session-derived data passed to the terminal control
strip referentially stable across renders that do not change that data, so the
strip re-renders only when its inputs change.

#### Scenario: Unrelated re-render leaves the strip alone
- **WHEN** the surrounding terminal view re-renders without session data
  changes relevant to the strip, including when a new sessions array differs
  only in activity timestamps
- **THEN** the strip does not re-render

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

# chat-debug Specification

## Purpose

Lets users inspect the raw JSON protocol exchanged between Agentboard and the
Claude Code process behind each chat session, for any session and after the
fact, to diagnose chat behavior without adding ad-hoc logging.

## Requirements

### Requirement: Chat protocol traffic is always captured
The system SHALL record, for every chat session and without user opt-in,
each line Agentboard writes to the Claude Code process and each line it
reads back, verbatim and in order, including SDK control messages. Each
frame SHALL carry its direction, a timestamp, and a per-session sequence
number that keeps increasing across process respawns and server restarts.

#### Scenario: A turn's traffic is recorded
- **WHEN** the user sends a message in a chat session and the turn completes
- **THEN** the session's frames include the outbound user message, the inbound assistant, stream, and result messages, in the order they crossed the process boundary

#### Scenario: Control traffic is recorded
- **WHEN** Claude Code asks for tool permission and the user answers the approval card
- **THEN** the frames include the inbound permission control request and the outbound control response carrying the user's decision

#### Scenario: Non-JSON output is kept
- **WHEN** the Claude Code process writes a stdout line that is not valid JSON, or writes to stderr
- **THEN** the line is recorded as raw text with its direction rather than dropped

#### Scenario: Sequence continues after respawn
- **WHEN** the agent process crashes and the next message respawns it, or the server restarts and the session resumes
- **THEN** new frames continue the session's sequence after the last recorded frame

### Requirement: Process lifecycle is recorded without secrets
The system SHALL record a lifecycle frame when a chat session's Claude Code
process is spawned (command, arguments, working directory) and when it
exits (exit code or signal). The process environment SHALL NOT be recorded,
and recording SHALL NOT alter the bytes exchanged with the process.

#### Scenario: Spawn and exit are visible
- **WHEN** a chat session's first turn spawns the agent process and the session is later killed
- **THEN** the frames include a spawn frame with command, arguments, and working directory, and an exit frame with the exit code or signal

#### Scenario: Credentials stay out of the log
- **WHEN** the server authenticates the agent with an API key or OAuth token in the environment
- **THEN** no recorded frame contains the environment or the credential value

### Requirement: Captured frames persist per session with bounded size
The system SHALL keep each chat session's frames on the server's disk so
they survive page reloads, process respawns, and server restarts. Storage per
session SHALL be bounded; when the bound is exceeded the oldest frames SHALL
be discarded first. Killing a chat session SHALL delete its frames.

#### Scenario: Frames survive a server restart
- **WHEN** the server restarts and the user opens the debug view of an existing chat session
- **THEN** the frames recorded before the restart are shown

#### Scenario: Oldest frames are dropped at the bound
- **WHEN** a session's recorded frames exceed the per-session storage bound
- **THEN** the oldest frames are discarded, the newest frames remain available, and capture continues

#### Scenario: Kill removes the frames
- **WHEN** the user kills a chat session
- **THEN** its recorded frames are deleted from disk

#### Scenario: Capture failure does not break the chat
- **WHEN** frames cannot be written (for example, the disk is full or the directory is unwritable)
- **THEN** the chat session keeps working and the failure is logged on the server

### Requirement: Users can open a debug view of a chat session
The chat view SHALL offer a Debug toggle that shows the session's recorded
frames in sequence order alongside the conversation. Each frame SHALL show
its direction, timestamp, and message type, and SHALL expand to
pretty-printed JSON (or raw text when not JSON) that can be copied verbatim.

#### Scenario: Toggle shows recent frames
- **WHEN** the user turns on Debug in a chat session that has recorded frames
- **THEN** the most recent frames are listed in sequence order with direction, timestamp, and message type

#### Scenario: Frame expands to its JSON
- **WHEN** the user expands a frame
- **THEN** its full content is shown as pretty-printed JSON, and copying it yields the original line exactly as exchanged

#### Scenario: Older frames load on demand
- **WHEN** the session has more frames than the initial page and the user asks for older frames
- **THEN** the preceding frames are added above the list without duplicates or gaps, until the oldest retained frame is reached

#### Scenario: Session without frames
- **WHEN** the user turns on Debug for a session that has never run a turn or was created before capture existed
- **THEN** the panel states that no protocol traffic has been recorded

#### Scenario: Toggle off keeps the conversation unchanged
- **WHEN** the user turns Debug off
- **THEN** the panel closes, the conversation view is unchanged, and capture continues on the server

### Requirement: Debug view streams new frames live
While a client has the debug view open, the system SHALL deliver frames to
it as they are recorded, ordered after the frames it already holds. Clients
without the debug view open SHALL NOT receive frames. Reconnecting SHALL
restore the open view without lost or duplicated frames.

#### Scenario: Frames appear during a turn
- **WHEN** the debug view is open and the agent streams a response
- **THEN** the corresponding frames appear in the panel while the turn is in progress

#### Scenario: Closed debug view receives nothing
- **WHEN** a client has a chat session open with Debug off while the agent is working
- **THEN** that client receives conversation events but no protocol frames

#### Scenario: Reconnect with debug open
- **WHEN** the connection drops and reconnects while the debug view is open and frames were recorded meanwhile
- **THEN** the panel shows every frame exactly once, in sequence order

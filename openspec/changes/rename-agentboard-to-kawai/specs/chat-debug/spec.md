## MODIFIED Requirements

### Requirement: Chat protocol traffic is always captured
The system SHALL record, for every chat session and without user opt-in,
each line Kawai writes to the Claude Code process and each line it
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

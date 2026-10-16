# Spec Delta

## ADDED Requirements

### Requirement: Chat messages show authors and local timestamps
Live and archived Chat messages SHALL display an author and local time beside each message, with full date, time, and timezone available on hover and to assistive technology. User, assistant, and peer identities SHALL remain distinguishable; peer authors SHALL retain their existing participant links. Missing or invalid historical times SHALL be omitted rather than replaced with the current time.

#### Scenario: Message metadata
- **WHEN** a user, assistant, or peer message has a valid timestamp
- **THEN** its author and local time are visible and its full date, time, and timezone are available on hover and to assistive technology

#### Scenario: Historical timestamp is unavailable
- **WHEN** a historical message has no valid recorded time
- **THEN** its author remains visible and no fabricated timestamp appears

#### Scenario: Conversation spans multiple days
- **WHEN** consecutive dated messages cross a local calendar-day boundary
- **THEN** a visible date separator distinguishes the days

#### Scenario: Undated message between days
- **WHEN** an undated historical message sits between dated messages on different local days
- **THEN** one date separator appears before the first message of the later day, and the undated message neither adds nor suppresses a separator

#### Scenario: Peer identity remains actionable
- **WHEN** a peer message previously offered navigation to its sender
- **THEN** its author retains that navigation and the message retains its sender group, priority, tags, and origin path

### Requirement: Message time remains stable during streaming and replay
A message's displayed time SHALL represent its recorded start and remain stable as its text streams and finalizes. A reconnect served from the running server SHALL keep the live start; history replay SHALL show the earliest transcript record time of that message, which may trail the live start. Times SHALL NOT be derived from the browser's render or attach time.

#### Scenario: Streaming response
- **WHEN** an assistant response receives more text and its final message
- **THEN** its displayed time remains the time of its first recorded content

#### Scenario: Reconnect to a running server
- **WHEN** a client reconnects while the server that streamed the messages is still running
- **THEN** messages keep the start times shown live, in the client's local timezone

#### Scenario: History replay
- **WHEN** a Chat's history is replayed after a server restart or opened archived
- **THEN** each message shows the earliest recorded transcript time for it in the client's local timezone, never the replay or attach time

### Requirement: Response text keeps its order around tool calls
Text an agent writes before and after a tool call within one response SHALL appear as separate transcript entries in event order, each with its own author and start time, live and after replay.

#### Scenario: Text, tool, text in one response
- **WHEN** one assistant response writes text, calls a tool, then writes more text
- **THEN** the transcript shows the first text, the tool call, then the second text, and neither text replaces the other

#### Scenario: Replayed response keeps its order
- **WHEN** the same Chat's history is replayed
- **THEN** the two texts and the tool call appear in the same order as live

### Requirement: Chat transcript aligns content responsively
Chat transcripts SHALL use an author/time gutter beside aligned message bodies when their container is wide enough. Narrow containers SHALL place author/time metadata above the body. Author changes SHALL have quiet visual separators; related same-author output SHALL use tighter spacing without merging distinct messages or hiding their timestamps.

#### Scenario: Wide transcript
- **WHEN** the transcript has room for a metadata gutter and readable message bodies
- **THEN** user, assistant, and peer bodies share a content alignment, with authors and times in the gutter

#### Scenario: Narrow transcript or larger font
- **WHEN** the transcript container narrows or the chat font grows until the gutter would crowd the body
- **THEN** metadata moves above the body and the transcript requires no horizontal scrolling except within content such as code blocks

#### Scenario: Author changes and continuations
- **WHEN** adjacent messages change author or continue the same author's response
- **THEN** author changes are visually separated and continuations are more closely spaced, while every message's identity and time remain identifiable

### Requirement: Transcript layout preserves rich event information and controls
The redesigned transcript SHALL retain all previously displayed event information and interactions in live and archived Chats. Layout grouping SHALL preserve event order, tool call/result pairing, and access to detailed content. Existing archive restrictions on interactive controls SHALL continue to apply.

#### Scenario: Tools and background activity
- **WHEN** the transcript contains tools, errors, workers, or background tasks
- **THEN** expandable inputs and outputs, failure marks, worker details, task outcomes and output tails, and eligible Stop controls remain available

#### Scenario: Peer context and notices
- **WHEN** peer messages carry task context, revision notices, duplicate warnings, threads, or handoff information
- **THEN** all previously displayed context and disclosures remain available

#### Scenario: Turn and request information
- **WHEN** a Chat contains command output, notices, errors, autonomous-turn triggers, request decisions, interruptions, or completion summaries
- **THEN** their existing information remains visible, including completion subtype, cost, and turn counts when supplied

#### Scenario: Live interaction
- **WHEN** an active Chat streams text or awaits an approval or answer
- **THEN** streaming, activity indicators, approval and question cards, and composer actions continue to work with their existing visibility rules

#### Scenario: Archived Chat
- **WHEN** the same Chat is archived
- **THEN** the transcript keeps its metadata and detail disclosures, while live request and task Stop actions remain unavailable and Restore remains available

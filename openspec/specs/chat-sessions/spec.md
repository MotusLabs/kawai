# chat-sessions Specification

## Purpose

Sessions driven by an agent SDK through a web chat interface instead of a
tmux terminal: lifecycle, streamed conversation events, permission approvals,
interruption, and event-derived status for chat sessions.

## Requirements

### Requirement: Users can start a Claude Code chat session
The system SHALL let a user start a chat session for a chosen project
directory, driven by the Claude Agent SDK, as an alternative to a terminal
(tmux) session. A chat session SHALL appear in the session list alongside
terminal sessions and SHALL NOT require a tmux window. If agent
authentication is not configured server-side, session creation SHALL be
refused with an actionable error rather than starting a session that cannot
run.

#### Scenario: Chat session created from the new-session form
- **WHEN** the user submits the new-session form with the chat kind selected and a project directory
- **THEN** a chat session is created, appears in the session list marked as a chat session, and the chat view opens for it

#### Scenario: Missing authentication is refused
- **WHEN** the user submits the new-session form with the chat kind selected and the server has no usable Claude authentication
- **THEN** no session is created and the user receives an error explaining how to configure authentication

#### Scenario: Chat sessions coexist with terminal sessions
- **WHEN** chat sessions and terminal sessions exist at the same time
- **THEN** both are listed, selectable, and killable, and terminal session behavior is unchanged

### Requirement: Conversation events stream to the chat view
The system SHALL stream conversation events for a chat session to connected
clients in order: the user's submitted turn, assistant text, tool activity,
and turn completion. The chat view SHALL render assistant text as markdown
and tool activity as compact activity entries. A client that attaches to an
existing chat session SHALL receive the session's prior conversation.

#### Scenario: Message exchange streams end to end
- **WHEN** the user submits a message in the chat view
- **THEN** the user turn appears in the transcript, assistant text and tool activity stream in as they are produced, and the turn ends with a completion event

#### Scenario: Reconnect during a turn or pending request
- **WHEN** a client reconnects while output streams or an approval/question is pending
- **THEN** it receives a snapshot containing history, unfinished output, current status, and pending requests before subsequent live events, without lost or duplicated content

#### Scenario: Multiple clients answer the same request
- **WHEN** two clients answer the same pending request
- **THEN** only the first valid answer takes effect and all attached clients remove the resolved request

#### Scenario: Reconnect replays prior conversation
- **WHEN** a client attaches to a chat session that already has history (including after a page reload)
- **THEN** the prior conversation is displayed before any new live events arrive

### Requirement: Tool approval requests surface as approval cards
When the agent requests a tool use that requires approval, the system SHALL
present an approval card in the chat view showing the tool and its
arguments, and SHALL hold the agent until the user answers. Allowing SHALL
let the tool run; denying SHALL return the denial to the agent so the turn
continues. A pending approval SHALL survive browser disconnects until answered, cancelled
by the SDK, interrupted, or killed. Server restart SHALL cancel outstanding
requests rather than restore callbacks that no longer exist. Resolution and
cancellation SHALL update every attached client; only the first valid answer
SHALL take effect.

#### Scenario: Approval card with allow and deny
- **WHEN** the agent requests a tool use that requires approval
- **THEN** an approval card with the tool name and arguments is shown, and no tool execution occurs before the user answers

#### Scenario: Allow executes the tool
- **WHEN** the user chooses Allow on a pending approval card
- **THEN** the tool use proceeds and its result streams into the conversation

#### Scenario: Deny returns the denial to the agent
- **WHEN** the user chooses Deny on a pending approval card
- **THEN** the tool use is not executed, the denial is reported to the agent, and the turn continues

### Requirement: Agent questions collect structured user answers
The system SHALL handle SDK `AskUserQuestion` requests with question forms
supporting offered options, multiple selections where requested, and free-text
answers. Validated answers SHALL be returned as updated tool input. Questions
SHALL follow the same reconnect, cancellation, and first-answer rules as approvals.

#### Scenario: User answers an agent question
- **WHEN** the agent requests user input through `AskUserQuestion`
- **THEN** the chat view displays the questions and the user's submitted answers are returned to the agent so it can continue

### Requirement: Users can interrupt an in-flight turn
The system SHALL let the user interrupt a chat session's in-flight turn.
After an interrupt, output produced so far SHALL remain in the transcript
and the session SHALL return to an idle state.

#### Scenario: Stop cancels pending requests
- **WHEN** the user activates stop while an approval or question is pending
- **THEN** outstanding callbacks settle, queued unsent messages are discarded, all clients remove cancelled requests, and the session becomes waiting

#### Scenario: Approval resolution updates status
- **WHEN** a pending request is resolved
- **THEN** status remains permission while another request is pending, becomes working if the turn continues with none pending, and becomes waiting when idle

#### Scenario: Stop button aborts a working turn
- **WHEN** the user activates stop while a turn is streaming
- **THEN** the turn is aborted, previously streamed content stays in the transcript, and the session becomes idle

### Requirement: Chat session status derives from conversation events
The system SHALL derive a chat session's status directly from its
conversation events: working while a turn is in flight, permission while an
approval is pending, and waiting when idle — without parsing agent log
files. Status changes SHALL be broadcast through the existing session-update
mechanism.

#### Scenario: Turn in flight reports working
- **WHEN** a chat session's turn starts producing events
- **THEN** the session is reported as working in the session list

#### Scenario: Pending approval reports permission
- **WHEN** a chat session has an unanswered approval card
- **THEN** the session is reported as permission in the session list

#### Scenario: Idle session reports waiting
- **WHEN** a chat session's turn completes with no pending approval
- **THEN** the session is reported as waiting in the session list

### Requirement: Chat sessions persist across server restarts
When its SDK transcript remains available, the system SHALL keep a chat session usable across server restarts: after a
restart the session SHALL be listed with its prior conversation, and the
next user message SHALL continue the same underlying agent conversation.

#### Scenario: Restart continues the conversation
- **WHEN** the server restarts while a chat session exists and the user then sends a message
- **THEN** the message continues the same conversation, with prior history intact

#### Scenario: Resume history is unavailable
- **WHEN** a stored SDK session transcript is missing or the SDK cannot resume it
- **THEN** the stored session and SDK id remain intact, the user receives an actionable error to restore the transcript or explicitly create a new session, and no fresh conversation is started implicitly

#### Scenario: Restart while a request is pending
- **WHEN** the server restarts with an unanswered approval or question
- **THEN** the previous request is marked cancelled and any request produced on resume has a new request id

#### Scenario: Kill removes the session
- **WHEN** the user kills a chat session
- **THEN** the underlying agent process is terminated and the session leaves the session list

### Requirement: Chat transcripts are not double-counted as sessions
Chat sessions' agent transcripts SHALL NOT be discovered and listed as
separate sessions by the server's agent-log discovery, so one chat session
appears exactly once in the UI.

#### Scenario: Transcript file does not spawn a duplicate session
- **WHEN** a chat session produces an agent transcript on disk
- **THEN** log discovery does not surface that transcript as an additional active or external session

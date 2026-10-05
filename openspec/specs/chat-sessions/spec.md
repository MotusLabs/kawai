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
run. The project path SHALL be resolved as for terminal sessions (`~`
expanded, made absolute), and creation SHALL be refused unless it names an
existing directory.

#### Scenario: Chat session created from the new-session form
- **WHEN** the user submits the new-session form with the chat kind selected and a project directory
- **THEN** a chat session is created, appears in the session list marked as a chat session, and the chat view opens for it

#### Scenario: Missing authentication is refused
- **WHEN** the user submits the new-session form with the chat kind selected and the server has no usable Claude authentication
- **THEN** no session is created and the user receives an error explaining how to configure authentication

#### Scenario: Chat sessions coexist with terminal sessions
- **WHEN** chat sessions and terminal sessions exist at the same time
- **THEN** both are listed, selectable, and killable, and terminal session behavior is unchanged

#### Scenario: Nonexistent project directory is refused
- **WHEN** the user submits the new-session form with the chat kind selected and a project path that does not exist, is not a directory, or carries tmux's ` (deleted)` suffix for a removed directory
- **THEN** no session is created and the user receives an error naming the path and saying it is not an existing directory

#### Scenario: Home-relative project path is resolved
- **WHEN** the user creates a chat session with a project path such as `~/work/app` that names an existing directory
- **THEN** the session is created with the absolute path of that directory as its project directory

#### Scenario: Project directory removed after creation
- **WHEN** the user sends a message to a chat session whose project directory no longer exists
- **THEN** no agent process is started, the message is refused with an error saying the project directory is missing and suggesting a new session in an existing directory, and the session and its history remain available

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

### Requirement: Chat sessions run against a configurable provider
The system SHALL let an operator define a provider environment — a set of
environment-variable overrides such as an API base URL and model names — that
is applied to every Claude Agent SDK process spawned for chat sessions,
including the availability check. When no provider environment is configured,
the SDK process SHALL inherit the server environment unchanged.

#### Scenario: Provider overrides reach the SDK process
- **WHEN** the operator configures a provider environment containing a base URL and model overrides and a user sends a message in a chat session
- **THEN** the SDK process for that session runs with the server environment plus those overrides, with the overrides taking precedence

#### Scenario: Nothing configured
- **WHEN** no provider environment is configured
- **THEN** chat sessions spawn the SDK process with the server environment exactly as before

#### Scenario: Availability is re-checked for a changed or failed provider
- **WHEN** the SDK availability check failed, or the provider environment changed since it last succeeded, and the user creates a chat session
- **THEN** the availability check runs again under the current provider environment instead of reusing the earlier result

### Requirement: Provider overrides do not reach terminal sessions
The provider environment SHALL apply only to chat sessions and SHALL NOT change
the environment of terminal (tmux) sessions.

#### Scenario: Terminal sessions are unaffected
- **WHEN** a provider environment is configured and the user starts a terminal session
- **THEN** the terminal session's environment does not contain the provider overrides

### Requirement: Chat authentication is checked against the provider environment
The chat authentication check SHALL evaluate credentials against the same
effective environment the SDK process receives: the server environment plus
the provider overrides.

#### Scenario: Credential supplied through the provider environment
- **WHEN** the server environment has no Claude credentials and the provider environment supplies an API key or auth token
- **THEN** chat session creation is allowed

### Requirement: Operators configure the chat provider from Settings
The system SHALL seed the provider environment from the `AGENTBOARD_CHAT_ENV`
server variable and SHALL let the user override it from the Settings modal.
A Settings override SHALL persist across server restarts and SHALL apply to
the next SDK process spawned, without a server restart. Clearing the override
SHALL restore the server-variable default.

#### Scenario: Settings override applies to the next spawn
- **WHEN** the user saves provider overrides in Settings and then starts a new chat session
- **THEN** the new session's SDK process receives the saved overrides

#### Scenario: Clearing the override restores the default
- **WHEN** the user clears the provider overrides in Settings
- **THEN** the persisted override is removed and the provider environment falls back to `AGENTBOARD_CHAT_ENV`

### Requirement: Invalid provider entries are refused
The system SHALL refuse a Settings save containing an invalid entry with an
error rather than silently dropping the entry.

#### Scenario: Invalid entry refused
- **WHEN** the user saves an entry whose name is not a valid environment variable name
- **THEN** nothing is saved and Settings shows why

### Requirement: Provider credentials are not sent to the browser
Values of credential-like provider variables SHALL NOT be sent to the browser.
Saving without re-entering such a value SHALL keep the stored value.

#### Scenario: Credentials are not sent to the browser
- **WHEN** the provider environment contains a credential such as `ANTHROPIC_AUTH_TOKEN` and the user opens Settings
- **THEN** the variable is listed without its value, and saving other edits keeps the stored credential

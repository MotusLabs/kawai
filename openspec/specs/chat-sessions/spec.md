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

### Requirement: Users can archive a chat session
The system SHALL let a user archive a chat session from the chat view header and from the session's row in the navigator. Archiving SHALL stop the session's agent process and keep the session record, its conversation ID, its transcript, and its protocol log. Archiving SHALL be recorded durably and SHALL survive server restarts. Every attached client SHALL see the change.

#### Scenario: Archive an idle chat
- **WHEN** the user archives a chat session that has no turn in flight
- **THEN** the agent process is stopped, the session is marked archived for every attached client, and its conversation remains available

#### Scenario: Archive during a turn asks first
- **WHEN** the user archives a chat session while a turn is in flight
- **THEN** the system asks for confirmation, and on confirmation interrupts the turn, cancels pending approvals and questions for every attached client, and archives the session

#### Scenario: Archive is cancelled
- **WHEN** the user declines the confirmation for archiving a chat with a turn in flight
- **THEN** the turn continues and the session is not archived

#### Scenario: Archived state survives a restart
- **WHEN** the server restarts while a chat session is archived
- **THEN** the session is still listed as archived and no agent process is started for it

### Requirement: Archived chats open read-only without starting an agent
The system SHALL display an archived chat session's prior conversation read-only, with a Restore action and without a message composer, stop control, or pending-request actions. Opening, attaching to, or reconnecting to an archived chat session MUST NOT start an agent process. Messages sent to an archived chat session SHALL be refused with an error.

#### Scenario: Open an archived chat
- **WHEN** the user selects an archived chat session
- **THEN** its prior conversation is displayed with a Restore action, no composer is offered, and no agent process is started

#### Scenario: Message sent to an archived chat
- **WHEN** a client sends a message to an archived chat session
- **THEN** no agent process is started and the client receives an error saying the session is archived

### Requirement: Users can restore an archived chat session
The system SHALL let a user restore an archived chat session from the read-only chat view and from the session's row in the navigator. A restored session SHALL behave as before it was archived: the next message continues the same conversation.

#### Scenario: Restore and continue
- **WHEN** the user restores an archived chat session and then sends a message
- **THEN** the session is no longer archived for every attached client, the composer is offered, and the message continues the same conversation with prior history intact

### Requirement: Archived chats are kept until restored or killed
Archived chat sessions SHALL NOT be hidden or removed by the history lookback window. Kill SHALL remain available for archived chat sessions and SHALL remain the only action that permanently removes a chat session.

#### Scenario: Archived chat older than the lookback window
- **WHEN** a chat session was archived longer ago than the configured history lookback
- **THEN** it is still listed among archived sessions

#### Scenario: Kill an archived chat
- **WHEN** the user kills an archived chat session
- **THEN** the session, its record, and its protocol log are removed and it leaves the session list

### Requirement: Assistant markdown renders with visible formatting
The chat view SHALL render assistant text as formatted content, not as plain
text. Block and inline markdown elements and GitHub-flavored markdown
extensions SHALL each be visually distinct from body text. Single line breaks
inside a paragraph SHALL be preserved. Raw HTML in assistant text SHALL NOT be
rendered or executed. User messages SHALL keep their literal text.

#### Scenario: Block elements are formatted
- **WHEN** assistant text contains a heading, a bulleted list, a numbered list, a blockquote, a horizontal rule and a fenced code block
- **THEN** the heading is larger or bolder than body text, list items show bullets or numbers and are indented, the blockquote is visually set off, the rule is visible, and the code block appears in a monospace block whose whitespace is preserved and whose wide lines scroll horizontally instead of overflowing the transcript

#### Scenario: Inline elements are formatted
- **WHEN** assistant text contains bold, italic, inline code and a link
- **THEN** bold and italic are visibly emphasized, inline code is visually distinct from surrounding text, and the link is visibly a link that opens in a new browser tab without giving the opened page access to the chat window

#### Scenario: GitHub-flavored markdown is supported
- **WHEN** assistant text contains a pipe table, `~~strikethrough~~`, a task list and a bare URL
- **THEN** the table renders as a bordered table with a header row, the strikethrough text is struck through, task list items show checkboxes, the bare URL is a link, and no raw `|` or `~~` syntax is visible

#### Scenario: Single line breaks are kept
- **WHEN** assistant text contains two lines separated by a single newline
- **THEN** they render on separate lines

#### Scenario: Raw HTML stays inert
- **WHEN** assistant text contains raw HTML such as a `<script>` tag
- **THEN** no script runs and no element is created from that HTML

#### Scenario: User messages are not reformatted
- **WHEN** the user sends a message that contains markdown syntax
- **THEN** the user's turn shows the literal text with its whitespace preserved

#### Scenario: Chat and session preview render markdown the same way
- **WHEN** the same markdown text appears as an assistant message in the chat view and in the session log preview
- **THEN** both render the same elements with the same styling in proportion to their base text size, so the chat follows the chat font size while the preview keeps its own size

### Requirement: Chat view uses a reduced-glare dark palette
In the dark theme, the chat view SHALL render on a lifted dark-gray background
with off-white text instead of the app's near-black palette. Primary message
text SHALL have a contrast ratio between 7:1 and 10:1 against the chat
background. Secondary text SHALL have at least 4.5:1 against every chat
surface it appears on. The light theme and views outside the chat view SHALL
be unchanged.

#### Scenario: Assistant and user messages in the dark theme
- **WHEN** the dark theme is active and the chat view shows user and assistant messages
- **THEN** the transcript background is a dark gray rather than near-black, and message text measures between 7:1 and 10:1 contrast against it

#### Scenario: Secondary text stays readable on every chat surface
- **WHEN** role labels, tool-activity summaries, notices or the session header details appear on the chat background, inside the user-message bubble, or on an approval or question card
- **THEN** that text measures at least 4.5:1 contrast against the surface behind it

#### Scenario: Status and error colors follow the palette
- **WHEN** the chat view shows an error, or the Debug panel lists outgoing, incoming, stderr and lifecycle frames
- **THEN** each of these colors comes from the chat palette, stays distinguishable from the others, and measures at least 4.5:1 contrast against the chat background

#### Scenario: Primary actions remain legible
- **WHEN** the chat view shows a primary button such as Send, Allow, Submit answers or Restore
- **THEN** its label measures at least 4.5:1 contrast against the button background

#### Scenario: Rest of the app keeps its dark palette
- **WHEN** the dark theme is active and the user looks at the session navigator, a terminal session or a modal while a chat session is open
- **THEN** those areas keep the app's existing dark colors

#### Scenario: Light theme is unchanged
- **WHEN** the light theme is active and the user opens a chat session
- **THEN** the chat view uses the app's existing light colors

### Requirement: Chat text uses a readable, adjustable size
The chat view SHALL size its text from a chat font size independent of the
terminal font size and the rest of the app. The chat font size SHALL default
to 15px and be adjustable from Settings between 12px and 20px. Message bodies
SHALL render at the chat font size, and secondary text SHALL render at no less
than 0.8 of it. The setting SHALL persist across reloads.

#### Scenario: Default size is readable
- **WHEN** a user who has never changed the chat font size opens a chat session
- **THEN** user and assistant message bodies render at 15px and role labels, tool calls, notices and the turn footer render at 12px or larger

#### Scenario: User changes the chat font size
- **WHEN** the user sets the chat font size to 18px in Settings and saves
- **THEN** chat message bodies, formatted assistant markdown, approval and question cards, and the composer scale to the new size, and the setting is still 18px after a page reload

#### Scenario: Chat and terminal sizes are independent
- **WHEN** the user changes the chat font size
- **THEN** the terminal font size, terminal rendering and the session log preview are unchanged, and changing the terminal font size leaves chat text unchanged

#### Scenario: Out-of-range values are clamped
- **WHEN** the user tries to go below 12px or above 20px, or the stored value is out of range or not a number
- **THEN** the chat font size is limited to 12–20px, and a non-numeric stored value falls back to 15px

#### Scenario: Composer does not trigger mobile zoom
- **WHEN** the chat font size is below 16px and the user focuses the composer on a touch device
- **THEN** the composer text is at least 16px, so the browser does not zoom the page

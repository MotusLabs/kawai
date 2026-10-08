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
When the agent requests a tool use that requires approval and the session's
approval policy is manual, the system SHALL present an approval card in the
chat view showing the tool and its arguments, and SHALL hold the agent until
the user answers. Allowing SHALL
let the tool run; denying SHALL return the denial to the agent so the turn
continues. A pending approval SHALL survive browser disconnects until answered, cancelled
by the SDK, interrupted, granted by switching the session to the auto policy,
or killed. Server restart SHALL cancel outstanding
requests rather than restore callbacks that no longer exist. Resolution and
cancellation SHALL update every attached client; only the first valid answer
SHALL take effect.

#### Scenario: Approval card with allow and deny
- **WHEN** the agent requests a tool use that requires approval in a session with the manual policy
- **THEN** an approval card with the tool name and arguments is shown, and no tool execution occurs before the user answers

#### Scenario: Allow executes the tool
- **WHEN** the user chooses Allow on a pending approval card
- **THEN** the tool use proceeds and its result streams into the conversation

#### Scenario: Deny returns the denial to the agent
- **WHEN** the user chooses Deny on a pending approval card
- **THEN** the tool use is not executed, the denial is reported to the agent, and the turn continues

### Requirement: Chat sessions have a per-session approval policy
Each chat session SHALL have an approval policy of either manual or auto.
Every new chat session SHALL start with the manual policy, and there SHALL be
no global or per-profile default. The policy SHALL be stored with the session
and SHALL be kept across server restarts, conversation resume, archive, and
restore. Sessions created before this feature SHALL behave as manual.

#### Scenario: New chat starts manual
- **WHEN** a user creates a chat session with any profile
- **THEN** the session's approval policy is manual and tool approvals show approval cards

#### Scenario: Policy survives restart
- **WHEN** a chat session's policy is auto and the server restarts
- **THEN** the session is listed with the auto policy and its next tool approval is granted without a card

#### Scenario: Policy survives archive and restore
- **WHEN** a chat session with the auto policy is archived and later restored
- **THEN** the restored session still has the auto policy

#### Scenario: Legacy session defaults to manual
- **WHEN** the server loads a chat session stored before approval policies existed
- **THEN** the session's approval policy is manual

### Requirement: Auto policy grants tool approvals without a card
While a chat session's policy is auto, the system SHALL grant each tool
approval request immediately without showing an approval card, and the
session SHALL NOT enter the permission status for it. Agent questions SHALL
NOT be answered by the policy: they SHALL always be shown as question forms.
Tool uses denied by the user's Claude Code permission settings SHALL remain
denied.

#### Scenario: Tool runs without a card
- **WHEN** the agent requests a tool use that requires approval in a session with the auto policy
- **THEN** no approval card is shown, the tool runs, and the session stays working rather than permission

#### Scenario: Questions still reach the user
- **WHEN** the agent asks a question in a session with the auto policy
- **THEN** the question form is shown, the session reports permission, and the agent waits for the user's answer

#### Scenario: Settings deny rules still apply
- **WHEN** the user's Claude Code settings deny a tool and the agent attempts it in a session with the auto policy
- **THEN** the tool use is denied as it would be under the manual policy

### Requirement: Users switch the approval policy from the chat view
The chat view SHALL let the user switch a live chat session between manual
and auto. The switch SHALL take effect for the next request without
restarting the agent, and every attached client SHALL see the new policy.
Switching to auto SHALL grant that session's pending approval cards; pending
questions SHALL stay open. Switching to manual SHALL affect only later
requests.

#### Scenario: Enabling auto clears pending approvals
- **WHEN** a session has a pending approval card and a pending question and the user switches it to auto
- **THEN** the approval is granted and its tool runs, the question remains open, and the agent process is not restarted

#### Scenario: Disabling auto returns to cards
- **WHEN** the user switches a session from auto to manual during a turn
- **THEN** tool uses already granted keep running and the next tool approval request shows an approval card

#### Scenario: Other clients see the switch
- **WHEN** two browsers are attached to the same chat session and one switches its policy
- **THEN** both show the new policy without a reload

### Requirement: Approval policy changes are validated
The system SHALL refuse a policy change for an unknown session, for an
archived session, or with a value other than manual or auto, and SHALL report
an error to the requesting client without changing the stored policy.
Archived chats SHALL NOT show the policy control.

#### Scenario: Archived session refuses a change
- **WHEN** a client requests a policy change for an archived chat session
- **THEN** the request is refused with an error and the stored policy is unchanged

#### Scenario: Unsupported value is refused
- **WHEN** a client requests a policy value that is not manual or auto
- **THEN** the request is refused with an error and the stored policy is unchanged

#### Scenario: Archived chat hides the control
- **WHEN** the user opens an archived chat session
- **THEN** the read-only view shows no approval-policy control

### Requirement: Auto-approved activity is visible
While a chat session's policy is auto, its chat view header SHALL show a
clearly distinguishable auto-approve indicator. Each tool use granted by the
policy SHALL be marked in the transcript as auto-approved, distinct from a
user's Allow, and each policy change SHALL add a transcript notice. Reconnecting
clients SHALL receive these entries in the history snapshot.

#### Scenario: Header indicates auto
- **WHEN** a chat session's policy is auto
- **THEN** its chat view header shows the auto-approve indicator, and the indicator disappears when the policy returns to manual

#### Scenario: Transcript distinguishes who approved
- **WHEN** one tool use is allowed by the user and another is granted by the auto policy
- **THEN** the transcript marks the second as auto-approved and the first as allowed by the user

#### Scenario: Policy change is recorded
- **WHEN** the user switches a session's policy
- **THEN** a notice stating the new policy appears in the transcript of every attached client and in the snapshot sent to clients that attach later

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

### Requirement: Collapsed tool calls show a short input detail
The chat view SHALL label each collapsed tool-call entry with the tool name
followed by a one-line detail in parentheses, derived from the tool's input.
Only an unknown tool, or a known tool whose detail is unusable, SHALL show the
tool name alone. Long details SHALL be truncated visually, with the full
detail on hover. Expanding the entry SHALL still show the full input.

#### Scenario: File tool shows its path
- **WHEN** the transcript contains a `Read` or `NotebookEdit` call whose input has a path field
- **THEN** the collapsed entry reads `Tool: <name> (<path>)`

#### Scenario: Bash shows its description and command
- **WHEN** a `Bash` call has a non-blank `description` and a non-blank `command`
- **THEN** the detail is `<description> — <command>`

#### Scenario: Bash falls back to its command
- **WHEN** a `Bash` call's `description` is missing, blank or not a string, and its `command` is a non-blank string
- **THEN** the detail is the command

#### Scenario: Bash falls back to its description
- **WHEN** a `Bash` call's `command` is missing, blank or not a string, and its `description` is a non-blank string
- **THEN** the detail is the description

#### Scenario: Other known tools show their key field
- **WHEN** a call is to `Glob` or `Grep` (pattern), `WebFetch` (url), `WebSearch` or `ToolSearch` (query), `Agent`, `Task` or `Monitor` (description), `Skill` (skill), `TaskCreate` (subject), `TaskStop` or `TaskOutput` (task_id), or `ExitPlanMode` (planFilePath)
- **THEN** the detail is that field's value

#### Scenario: EnterWorktree shows its path or name
- **WHEN** an `EnterWorktree` call has a non-blank `path`, or only a non-blank `name`
- **THEN** the detail is the path, or the name when no path is usable

#### Scenario: TaskUpdate shows the task id and status
- **WHEN** a `TaskUpdate` call has a `taskId` and a `status`
- **THEN** the detail is `Task <taskId> → <status>`

#### Scenario: AskUserQuestion shows the question header
- **WHEN** an `AskUserQuestion` call's first question has a non-blank `header`
- **THEN** the detail is the header, suffixed with ` · <n> questions` when the call has more than one question

#### Scenario: Unknown tool keeps the plain label
- **WHEN** a call is to a tool with no known mapping, such as an MCP tool
- **THEN** the collapsed entry reads `Tool: <name>` with no parentheses

#### Scenario: No usable field keeps the plain label
- **WHEN** every part of a known tool's detail is missing, blank or not a string (for `Bash`, both `description` and `command`)
- **THEN** the collapsed entry reads `Tool: <name>` with no parentheses

#### Scenario: Multi-line value stays on one line
- **WHEN** a detail value contains line breaks, such as a multi-line Bash command
- **THEN** the collapsed label shows it on a single line, truncated with an ellipsis when too long, and hovering shows the full value

### Requirement: Tool-call paths are shown relative to the project
When a tool-call detail is a file path, the chat view SHALL show it relative
to the chat session's project directory if the path is inside that
directory, and SHALL show it unchanged otherwise. Trailing slashes on either
the path or the project directory SHALL NOT affect the result. Paths that
only share a name prefix with the project directory SHALL count as outside.

#### Scenario: Path inside the project
- **WHEN** the project directory is `/repo` and a `Read` call has `file_path` `/repo/src/index.ts`
- **THEN** the label reads `Tool: Read (src/index.ts)`

#### Scenario: Path outside the project
- **WHEN** the project directory is `/repo` and a `Read` call has `file_path` `/etc/hosts`
- **THEN** the label reads `Tool: Read (/etc/hosts)`

#### Scenario: Sibling directory with a shared prefix
- **WHEN** the project directory is `/repo` and a `Read` call has `file_path` `/repo-other/a.ts`
- **THEN** the label reads `Tool: Read (/repo-other/a.ts)`

#### Scenario: Path equal to the project directory
- **WHEN** the project directory is `/repo` or `/repo/` and a path detail is `/repo` or `/repo/`
- **THEN** the label shows `.` in all four combinations

### Requirement: Edit and Write show a line delta
When a collapsed `Edit` or `Write` tool-call entry has a detail, the chat view
SHALL append the changed line counts as `+<added> −<removed>`, counted over
the input text. A zero side SHALL be omitted, and when both sides are zero the
delta SHALL be omitted entirely.

#### Scenario: Edit shows added and removed lines
- **WHEN** an `Edit` call replaces three lines of `old_string` with five lines of `new_string`
- **THEN** the label reads `Tool: Edit (<path> +5 −3)`

#### Scenario: Write shows added lines only
- **WHEN** a `Write` call has `content` of forty-five lines
- **THEN** the label reads `Tool: Write (<path> +45)`

#### Scenario: A trailing newline does not add a line
- **WHEN** a counted value is `"a\nb\nc"` or `"a\nb\nc\n"`
- **THEN** both count three lines, and the empty string counts zero

#### Scenario: A zero side is omitted
- **WHEN** an `Edit` call's `new_string` is empty, or its `old_string` is empty
- **THEN** the delta shows only the non-zero side, for example `−3` or `+5`

#### Scenario: No delta when nothing changes
- **WHEN** both sides of the delta count zero lines
- **THEN** the label shows the path alone, with no delta

### Requirement: Collapsed tool results show a one-line hint
The chat view SHALL label each collapsed tool-result entry with the first
non-blank line of its output, in parentheses, on one line. The hint SHALL be
truncated visually, with the full line on hover. An output with no non-blank
line SHALL keep the plain `Tool result` or `Tool failed` label. Expanding the
entry SHALL still show the full output.

#### Scenario: Result hint is the first non-blank line
- **WHEN** a tool result's output starts with blank lines and then reads `Task #1 created successfully: Run 6.3`
- **THEN** the collapsed entry reads `Tool result (Task #1 created successfully: Run 6.3)`

#### Scenario: Error result shows the first error line
- **WHEN** a tool result is an error whose first line is `Command failed: bun test`
- **THEN** the collapsed entry reads `Tool failed (Command failed: bun test)`

#### Scenario: Empty output keeps the plain label
- **WHEN** a tool result's output has no non-blank line
- **THEN** the collapsed entry reads `Tool result` or `Tool failed` with no parentheses

#### Scenario: Long hint stays on one line
- **WHEN** the first non-blank line is longer than the available width
- **THEN** the hint is truncated with an ellipsis, and hovering shows the full line

### Requirement: Chat transcript shows the in-flight turn's activity
While a chat turn is in flight, the chat view SHALL show one activity row as the last entry of the transcript, naming what the agent is doing and how long it has been in that phase. The phases are: waiting for the model, thinking, preparing a tool's input, running a tool, and retrying an API request. The elapsed time SHALL count up live without new server messages.

#### Scenario: Waiting for the first token
- **WHEN** the user sends a message and the model has not yet produced any content
- **THEN** the transcript ends with a row reading "Waiting for model…" and an elapsed time that increases each second

#### Scenario: Model is thinking
- **WHEN** the model starts a thinking block
- **THEN** the activity row reads "Thinking…" and its elapsed time restarts from zero

#### Scenario: Tool input is being written
- **WHEN** the model starts a tool-use block whose input is still streaming
- **THEN** the activity row names that tool as being prepared, for example "Writing Edit input…"

#### Scenario: A tool is running
- **WHEN** a tool call has been shown and its result has not yet arrived
- **THEN** the activity row reads "Running <tool>…" with the time since that phase began

#### Scenario: Several tools are running
- **WHEN** more than one tool call of the turn is awaiting its result
- **THEN** the activity row reads "Running <n> tools…"

#### Scenario: API request is retried
- **WHEN** Claude Code reports an API retry with an attempt number, a maximum, and an error status
- **THEN** the activity row reads "Retrying (<attempt>/<max>, <status>)…"

#### Scenario: Turn ends
- **WHEN** the turn completes, is interrupted, or the agent process dies
- **THEN** no activity row is shown

### Requirement: Activity row yields to other visible progress
The chat view SHALL hide the activity row while assistant text is streaming, while an approval or question card awaits the user, and in archived or otherwise read-only chats. The row SHALL return when the turn enters another activity phase.

#### Scenario: Text is streaming
- **WHEN** the model is streaming assistant text
- **THEN** no activity row is shown below the streaming text

#### Scenario: Approval card pending
- **WHEN** a tool approval or agent question awaits the user
- **THEN** no activity row is shown, and after the user answers the row resumes with the next phase

#### Scenario: Archived chat
- **WHEN** the user opens an archived chat
- **THEN** no activity row is shown

### Requirement: Activity is live-only and restored on reconnect
Activity SHALL be ephemeral: it is not part of the conversation history, is not persisted, and does not change the session-list status. A client attaching or reconnecting during a turn SHALL receive the current activity phase and its start time so the row and elapsed time resume.

#### Scenario: Reconnect while thinking
- **WHEN** a client reconnects to a chat whose turn has been thinking for 10 seconds
- **THEN** the transcript ends with "Thinking…" showing roughly 10 seconds elapsed

#### Scenario: History has no activity rows
- **WHEN** a chat with completed turns is reopened or replayed from history
- **THEN** the transcript contains no activity rows

#### Scenario: Session list is unaffected
- **WHEN** a turn moves between activity phases
- **THEN** the session list still reports the session as working and receives no additional updates for the phase changes

### Requirement: The agent starts when a chat is opened
The system SHALL start a chat session's agent process, without sending a prompt, when a client attaches to the session and no process is running for it. Attaching MUST NOT start a process for an archived chat session or for a session whose project directory no longer exists. A start that fails SHALL be reported to attached clients as a session error and SHALL NOT remove the session or its history.

#### Scenario: Open a chat after a server restart
- **WHEN** a client attaches to an unarchived chat session with no running agent process
- **THEN** the agent process starts and resumes the stored conversation, and no message is sent to the agent

#### Scenario: Open an archived chat
- **WHEN** a client attaches to an archived chat session
- **THEN** no agent process is started

#### Scenario: Project directory is missing
- **WHEN** a client attaches to a chat session whose project directory no longer exists
- **THEN** no agent process is started and sending a message is refused as before

#### Scenario: Several clients attach
- **WHEN** two clients attach to the same chat session at the same time
- **THEN** at most one agent process is started for it

### Requirement: Clients receive the chat's slash commands
The system SHALL provide each attached client with the slash commands the session's agent reports, each with its name, description, argument hint, aliases, and whether it is defined by the project or user. The list SHALL have a loading, ready, or unavailable state, be part of the reconnect snapshot, and be replaced for every attached client when the agent reports a changed list. Commands bound to a terminal and internal commands SHALL NOT be included.

#### Scenario: List is ready after opening
- **WHEN** a client attaches to a chat session and the agent finishes starting
- **THEN** the client receives the session's command list in the ready state

#### Scenario: List changes mid-session
- **WHEN** the agent reports a changed command list
- **THEN** every attached client replaces its list with the new one

#### Scenario: Reconnect restores the list
- **WHEN** a client reconnects to a chat session whose command list is ready
- **THEN** the snapshot it receives includes the list

#### Scenario: Agent could not start
- **WHEN** the agent process for a chat session failed to start or is not running
- **THEN** the command list is in the unavailable state and typed messages, including slash commands, can still be submitted

#### Scenario: Terminal-only commands are hidden
- **WHEN** the agent reports commands that are bound to a terminal or are internal
- **THEN** those commands are not included in the list sent to clients

### Requirement: The composer offers a slash-command menu
The chat composer SHALL open a command menu when the message starts with `/`, filtering the session's commands by the typed text against names and aliases first and descriptions second. The menu SHALL be operable by keyboard and pointer. Choosing a command SHALL insert `/<name> ` into the composer without sending it and SHALL show the command's argument hint. The menu SHALL indicate when the list is loading and SHALL NOT block sending.

#### Scenario: Filter and choose by keyboard
- **WHEN** the user types `/re` and presses Enter while a matching command is highlighted
- **THEN** the composer contains `/<chosen name> `, the argument hint is shown, and no message is sent

#### Scenario: Dismiss the menu
- **WHEN** the menu is open and the user presses Escape
- **THEN** the menu closes and the composer text is unchanged

#### Scenario: Send while the menu has no match
- **WHEN** the typed command matches no listed command and the user presses Enter
- **THEN** the menu does not intercept Enter and the message is sent as typed

#### Scenario: List still loading
- **WHEN** the user types `/` before the command list is ready
- **THEN** the menu shows that commands are loading

### Requirement: Local command output appears in the transcript
The system SHALL show output produced by a local slash command in the transcript of the turn that ran it, and SHALL include it in reconnect snapshots and replayed history.

#### Scenario: Run a local command
- **WHEN** the user sends a local command such as `/context`
- **THEN** its output appears in the transcript and the turn completes

#### Scenario: Reload after a local command
- **WHEN** a client attaches to a chat session after a local command ran in it
- **THEN** the command and its output appear in the replayed conversation

### Requirement: Replayed history shows slash commands as typed
Replayed chat history SHALL show a slash-command turn as the command and arguments the user typed, and SHALL NOT show the markup Claude Code records around commands or the expanded prompt text of a command.

#### Scenario: Reload after a project command
- **WHEN** a client attaches to a chat session in which the user ran `/openspec-explore some idea`
- **THEN** the replayed user turn shows `/openspec-explore some idea` and no command markup

### Requirement: Clearing a chat starts a new chat and archives the old one
Sending `/clear`, `/reset`, or `/new`, optionally followed by a name, SHALL create a new chat session in the same project directory with the same profile, named with the given name when present, select it, and then archive the previous chat session. The command SHALL NOT be sent to the agent. If the new session cannot be created, the previous chat session SHALL remain unchanged and the user SHALL receive the creation error.

#### Scenario: Clear a chat
- **WHEN** the user sends `/clear` in a chat session
- **THEN** a new chat session with the same project directory and profile is created and selected, and the previous session is archived with its conversation intact

#### Scenario: New chat with a name
- **WHEN** the user sends `/new release notes`
- **THEN** the new chat session is named `release notes`

#### Scenario: New chat cannot be created
- **WHEN** the user sends `/clear` and the new chat session cannot be created
- **THEN** the previous chat session is not archived and the user sees why creation failed

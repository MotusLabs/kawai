# Spec Delta

## Purpose

Lets a Kawai chat session, and so a team member, run on Codex instead of Claude Code. Each session keeps the same transcript, approval cards, questions, mailbox, task and strategy tools, and limit handling that Claude chat sessions have.

## ADDED Requirements

### Requirement: Codex chat sessions run a separately installed Codex executable
A chat session whose profile's runtime is Codex SHALL run a Codex CLI installed separately from the application. The executable SHALL be the path in the server-only `KAWAI_CODEX_PATH` setting when present, otherwise `codex` resolved from the server's `PATH`. The value SHALL be treated as one executable path, never as a shell command, and SHALL NOT be sent to browsers.

#### Scenario: Explicit Codex path
- **WHEN** `KAWAI_CODEX_PATH` names an executable file and a user creates a chat with a Codex profile
- **THEN** the session runs that executable

#### Scenario: Codex found on PATH
- **WHEN** `KAWAI_CODEX_PATH` is unset and `codex` is on the server's `PATH`
- **THEN** Codex chat sessions run the `codex` found on `PATH`

#### Scenario: Claude sessions are unaffected
- **WHEN** no Codex executable is installed and a user creates a chat with a Claude profile
- **THEN** the session is created and runs as before

### Requirement: The Codex executable is version-checked before creation
Before a Codex chat session is created, the system SHALL verify within a bounded time that the Codex executable exists, is executable, and reports a version at or above the documented supported baseline. A failed check SHALL refuse creation without persisting a session, with an error naming the checked path and the fix. A missing or unsupported Codex executable SHALL NOT affect backend startup, Claude chats, terminal sessions, or reading existing Codex chat history.

#### Scenario: Codex below the baseline
- **WHEN** the Codex executable reports a version older than the supported baseline and a user creates a Codex chat
- **THEN** no session is created and the error names the path, the found version, and the baseline

#### Scenario: Codex missing
- **WHEN** no Codex executable is found and a user creates a Codex chat
- **THEN** no session is created and the error explains how to install Codex or set `KAWAI_CODEX_PATH`

#### Scenario: History stays readable
- **WHEN** the Codex executable is removed after a Codex chat ran
- **THEN** the backend starts and that chat's history still opens

### Requirement: Each Codex chat runs its own protocol server
Each Codex chat session SHALL run its own Codex app-server child process over its standard input and output. It SHALL NOT attach to an app-server daemon or one shared with other sessions. Ending the session's agent through archive, kill, restart, or shutdown SHALL end that child process.

#### Scenario: Two Codex chats
- **WHEN** two Codex chat sessions are live
- **THEN** each has its own app-server process, and killing one leaves the other running

#### Scenario: Installed daemon is ignored
- **WHEN** a Codex app-server daemon is running on the host and a Codex chat starts
- **THEN** the chat spawns its own app-server and never connects to the daemon

### Requirement: Codex conversations persist and resume
A Codex chat SHALL start one Codex thread when its agent first starts and SHALL store that thread's id and transcript file path on the chat record as soon as they are known. A later start of the same chat — after a crash, restart, archive and restore, or backend restart — SHALL resume that thread, never start a new one. A Codex thread SHALL never be ephemeral.

#### Scenario: Backend restart
- **WHEN** the backend restarts while a Codex chat has a stored thread id and a user then sends a message
- **THEN** the agent resumes the same thread and the model sees the earlier conversation

#### Scenario: Archive and restore
- **WHEN** a Codex chat is archived and later restored
- **THEN** the restored chat resumes the same thread

### Requirement: Codex turns stream into the chat transcript
The system SHALL show a Codex turn in the chat transcript through the same event kinds Claude turns use. Streamed agent text SHALL appear as it arrives and be completed by the final message. Command executions, file changes, MCP and dynamic tool calls, and web searches SHALL appear as tool calls with their results. Turn completion SHALL settle status to waiting, and a failed turn SHALL show its error.

#### Scenario: Streaming reply
- **WHEN** Codex streams an agent message
- **THEN** the transcript shows the text growing and then the completed message

#### Scenario: Command execution
- **WHEN** Codex runs a shell command during a turn
- **THEN** the transcript shows a tool call with the command, then its output and exit result

#### Scenario: Failed turn
- **WHEN** a Codex turn completes with an error
- **THEN** the transcript shows the error and the session status becomes waiting

### Requirement: Codex turns show live activity and context use
During an in-flight Codex turn the live activity row SHALL show the same phases as Claude turns: waiting for the model, thinking while reasoning streams, running a named tool, and writing a reply. The chat header's context meter SHALL follow Codex token-usage updates. Activity SHALL stay ephemeral, as it is for Claude chats.

#### Scenario: Reasoning
- **WHEN** Codex streams reasoning during a turn
- **THEN** the activity row shows Thinking with an elapsed timer

#### Scenario: Token usage
- **WHEN** Codex reports updated token usage for the thread
- **THEN** the context meter shows the new usage

### Requirement: Interrupting a Codex turn
Interrupting a Codex chat SHALL stop its in-flight turn through the protocol, cancel the turn's pending approvals and questions, and leave the thread resumable. Urgent direct mail SHALL interrupt a Codex recipient under the same conditions as a Claude recipient.

#### Scenario: User interrupts
- **WHEN** the user interrupts a Codex turn that has a pending approval card
- **THEN** the turn stops, the card is marked cancelled, and the next message continues the same thread

### Requirement: Codex runs in one sandbox under both approval policies
Every Codex turn SHALL run with workspace-write file access limited to the session's project directory, the repository's git common directory, and temporary space, so commits from a linked worktree succeed. Codex SHALL ask for approval only when an action needs more than the sandbox grants. Network access SHALL be on unless the profile turns it off. The sandbox SHALL NOT depend on the approval policy.

#### Scenario: Commit from a linked worktree
- **WHEN** a Codex member in a linked worktree commits
- **THEN** the commit succeeds without an approval request

#### Scenario: Write outside the sandbox
- **WHEN** Codex needs to write outside the project directory and git common directory
- **THEN** it raises an approval request instead of writing

#### Scenario: Profile turns network off
- **WHEN** a Codex profile turns network access off and Codex runs a command that needs the network
- **THEN** the command runs only after an approval request is granted

### Requirement: Codex approval requests follow the chat approval policy
On thread start and resume under either policy, the system SHALL set `approvalsReviewer: "user"` so escalations reach Kawai regardless of Codex home settings. Under manual, each command, file-change, or permission request SHALL show an approval card describing the request; allow SHALL accept it and deny SHALL decline it. Under auto, Kawai SHALL accept without a card. Policy changes SHALL apply to later requests without restarting the thread.

#### Scenario: Manual approval
- **WHEN** a manual Codex chat requests to run a command outside the sandbox and the user allows it
- **THEN** the command runs once, and a later request asks again

#### Scenario: Auto approval
- **WHEN** an auto Codex chat requests to change files outside the sandbox
- **THEN** the request is accepted without a card

#### Scenario: Codex home uses automatic review
- **WHEN** a Codex home's configuration selects `auto_review` and a manual Kawai chat starts or resumes
- **THEN** Kawai overrides the reviewer to `user`, and each escalation waits for a Kawai approval card decision

#### Scenario: Auto policy owns escalation decisions
- **WHEN** a Codex home's configuration selects `auto_review` and an auto Kawai chat starts or resumes
- **THEN** Kawai overrides the reviewer to `user` and accepts escalations itself without cards

#### Scenario: Live policy switch
- **WHEN** the user switches a Codex chat from manual to auto during a turn
- **THEN** later requests in that turn are accepted without cards and the thread is not restarted

### Requirement: Codex questions use question cards
A Codex request for user input SHALL appear as a question card with each question's header, text, and options, offering free text where Codex allows another answer and hiding input where Codex marks it secret. Questions SHALL NOT be answered automatically under either policy. The user's answers SHALL return to Codex keyed by question.

#### Scenario: Question under auto
- **WHEN** an auto Codex chat asks the user a question with options
- **THEN** a question card shows the options and the turn waits for the user's answer

### Requirement: Codex sessions carry the team tools
A Codex chat SHALL have the same `kawai-team` tools as a Claude chat, with identity bound to the calling session, allowed without approval cards under either policy. A call SHALL be served only for the session's own thread. If Codex refuses to register the team tools, the agent SHALL NOT start and the chat SHALL show the reason.

#### Scenario: Codex member sends mail
- **WHEN** a Codex member calls the team send tool for its group's lead
- **THEN** the message is recorded with the Codex session as sender and no approval card appears

#### Scenario: Call for another thread
- **WHEN** a team tool call arrives naming a thread that is not the session's own
- **THEN** it is refused and no tool handler runs

#### Scenario: Tools cannot be registered
- **WHEN** the installed Codex refuses the team tool registration
- **THEN** the chat's agent does not start and the chat shows the refusal

### Requirement: Codex members receive their role and team context
A Codex chat that belongs to a group SHALL receive the same role body, mailbox note, task note, and strategy note a Claude member of that group receives, read when its agent starts. A group's reasoning effort SHALL apply to its Codex members' turns.

#### Scenario: Spawned Codex dev
- **WHEN** worktree staffing spawns a member of a group whose profile is a Codex profile
- **THEN** the new Codex chat starts with that group's role and team notes and the task mail as its first turn

### Requirement: Mail receipt for Codex recipients comes from the Codex transcript
Delivery to a Codex recipient SHALL be acknowledged only by a complete user-message row in its Codex transcript file that carries the envelope's message id. A missing, unreadable, or torn file SHALL hold the message as uncertain, as for Claude recipients. Receipt SHALL be checkable without a running agent.

#### Scenario: Receipt while the turn runs
- **WHEN** a Codex member's transcript records the envelope row while its turn is still running
- **THEN** the message shows delivered without waiting for the turn to end

#### Scenario: Restart after delivery
- **WHEN** the backend restarts after pushing mail to a Codex member whose transcript holds the envelope row
- **THEN** startup reconciliation marks the message delivered without starting the agent

#### Scenario: Torn transcript
- **WHEN** a Codex recipient's transcript ends in a malformed row
- **THEN** the pushed message is held as uncertain for human resolution

### Requirement: Codex chat history replays
Opening a Codex chat SHALL restore its conversation from the Codex thread, including user and peer turns, agent messages, and tool calls with results. Archived Codex chats SHALL replay from their stored transcript file without starting an agent.

#### Scenario: Archived Codex chat
- **WHEN** a user opens an archived Codex chat
- **THEN** its conversation shows read-only and no Codex process starts

### Requirement: Codex sessions require a Codex login
Creating or starting a Codex chat SHALL be refused when its Codex home has no usable login, as Claude chats are without Claude credentials. The error SHALL name the profile and how to sign in; the home path reaches only the server log. A refused worktree spawn SHALL follow the existing failed-spawn retry.

#### Scenario: Not logged in
- **WHEN** a user creates a Codex chat for a Codex home with no login
- **THEN** no session is created and the error names the profile and how to sign in to Codex

#### Scenario: Login lost after creation
- **WHEN** an existing Codex chat's home loses its login and the user sends a message
- **THEN** the agent does not start and the chat shows the sign-in error

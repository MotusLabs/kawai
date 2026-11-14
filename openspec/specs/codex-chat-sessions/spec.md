# codex-chat-sessions Specification

## Purpose

Lets a Kawai chat session, and so a team member, run on Codex instead of Claude Code. Each session keeps the same transcript, approval cards, questions, mailbox, task and strategy tools, and limit handling that Claude chat sessions have.

## Requirements

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
- **WHEN** a Codex member in a linked worktree commits and the sandbox starts with the writable root
- **THEN** the commit runs without an approval request

#### Scenario: Commit where the sandbox cannot help
- **WHEN** the sandbox cannot start, or `.git` stays read-only under `workspace-write`, and a Codex member in a linked worktree commits
- **THEN** the command escalates: an approval card under manual, accepted without one under auto

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
A Codex request for user input SHALL appear as a question card with each question's header, text, and options, offering free text where Codex allows another answer, and always where the question offers no options, since text is then its only answer, and masking the input where Codex marks it secret. Questions SHALL NOT be answered automatically under either policy. The user's answers SHALL return to Codex keyed by question.

#### Scenario: Question under auto
- **WHEN** an auto Codex chat asks the user a question with options
- **THEN** a question card shows the options and the turn waits for the user's answer

#### Scenario: Secret question's input is masked
- **WHEN** Codex marks a question secret and the card renders
- **THEN** the input is masked, on the pending and the answered card

#### Scenario: A question with options offers free text only with another-answer permission
- **WHEN** a question offers options and Codex marks it without another-answer permission
- **THEN** the card offers only Codex's options and no free-text input

#### Scenario: A question without options always offers free text
- **WHEN** a question offers no options, whatever its another-answer permission says
- **THEN** the card offers free text, masked when Codex marks the question secret

#### Scenario: Claude questions are unchanged
- **WHEN** a Claude chat's agent asks a structured question
- **THEN** the card renders as before, with a plain input and free text offered

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

### Requirement: Codex tool use is audited like Claude tool use
A Codex chat SHALL feed every command execution and every external MCP tool call to the outbound observer that audits Claude Bash and MCP calls, with the same classification, withholding, and redaction. The feed SHALL be observation only: it SHALL never block, delay, or deny a call. Team tool calls SHALL NOT be recorded, and a file change SHALL NOT be a send. Codex developer instructions SHALL carry the same outbound-actions security note as the Claude prompt.

#### Scenario: Command execution is observed
- **WHEN** a Codex member runs a shell command that sends to a destination
- **THEN** the outbound audit records the call with its verdict and outcome, and the command runs exactly as it would unobserved

#### Scenario: External MCP call is observed
- **WHEN** a Codex member calls a tool of an external MCP server
- **THEN** the outbound audit records one MCP call row for it

#### Scenario: Observer failure
- **WHEN** the outbound observer throws while a Codex command runs
- **THEN** the command still runs and the turn continues

#### Scenario: Team tools are exempt
- **WHEN** a Codex member calls a `kawai-team` tool
- **THEN** no outbound audit row is written for the call

#### Scenario: A file change is not a send
- **WHEN** a Codex member changes files
- **THEN** no outbound audit row is written for the change

#### Scenario: Security note in developer instructions
- **WHEN** a Codex chat's agent starts or resumes
- **THEN** its developer instructions end with the outbound-actions security note rendered from the configured destinations

### Requirement: Codex members receive their role and team context
A Codex chat that belongs to a group SHALL receive the same role body, mailbox note, task note, and strategy note a Claude member of that group receives, read when its agent starts. A group's reasoning effort SHALL apply to its Codex members' turns.

#### Scenario: Spawned Codex dev
- **WHEN** worktree staffing spawns a member of a group whose profile is a Codex profile
- **THEN** the new Codex chat starts with that group's role and team notes and the task mail as its first turn

### Requirement: Mail receipt for Codex recipients comes from the Codex transcript
Delivery to a Codex recipient SHALL be acknowledged only by a complete user-message row in its Codex transcript file that carries the envelope's message id; such a row counts as delivered whatever follows it, a torn or unreadable tail included. Only an absent receipt beside torn or unreadable evidence SHALL hold the message as uncertain, as for Claude recipients. Receipt SHALL be checkable without a running agent.

#### Scenario: Receipt while the turn runs
- **WHEN** a Codex member's transcript records the envelope row while its turn is still running
- **THEN** the message shows delivered without waiting for the turn to end

#### Scenario: Restart after delivery
- **WHEN** the backend restarts after pushing mail to a Codex member whose transcript holds the envelope row
- **THEN** startup reconciliation marks the message delivered without starting the agent

#### Scenario: Torn tail after the envelope row
- **WHEN** a Codex recipient's transcript holds the envelope row and ends in a malformed row
- **THEN** the message shows delivered despite the torn tail

#### Scenario: Torn transcript without the envelope row
- **WHEN** a Codex recipient's transcript ends in a malformed row and carries no envelope row for the message
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

### Requirement: Codex skills populate the chat command list
A live Codex chat SHALL offer enabled skills reported by its agent for its current working directory through the existing command list and slash menu. Only skills with a valid name and path and an unambiguous name SHALL be offered. Discovery SHALL use that chat's Codex home. Client-local command names SHALL remain reserved.

#### Scenario: Opening a Codex chat discovers skills
- **WHEN** a client attaches to a Codex chat and its agent reports enabled skills for the chat's working directory
- **THEN** the command list becomes ready with those skills' names, descriptions, and project, user, or builtin source as appropriate, without starting a model turn

#### Scenario: Skills excluded from the list
- **WHEN** discovery reports disabled skills, malformed entries, conflicting paths for one name, or skills named clear, reset, or new
- **THEN** those skills are absent from the command list and cannot be resolved by slash name

#### Scenario: No skills installed
- **WHEN** discovery succeeds for the current working directory with no eligible skills
- **THEN** the list is ready and empty

### Requirement: Codex autocomplete uses the shared composer interactions
The Codex composer SHALL offer the existing caret-aware slash menu, including filtering by name and description, keyboard and pointer selection, visible selection, and Escape dismissal. Choosing a skill SHALL replace the current slash word with `/<name> ` without sending. Unknown commands SHALL remain sendable as plain text.

#### Scenario: Choose a skill in the middle of a message
- **WHEN** the user types `please run /exp on this` with the caret after `/exp` and chooses the explore skill with Tab or Enter
- **THEN** the composer contains `please run /explore on this`, the caret follows the inserted space, and no message is sent

#### Scenario: Pointer selection and dismissal
- **WHEN** the user hovers and clicks a Codex skill in the menu, then opens the menu again and presses Escape
- **THEN** clicking inserts the visibly selected skill without sending and Escape closes the reopened menu without changing the draft

#### Scenario: Paths and unknown names
- **WHEN** the user types `https://example` or `/usr/bin`, or sends an unknown `/missing` command
- **THEN** paths do not open the menu and the unknown command is sent unchanged without a skill attachment

### Requirement: Human slash-skill references invoke explicit Codex skills
On human submission, the system SHALL attach one native Codex skill input per distinct eligible exact slash-skill reference in the message, resolved from the server's current ready catalog. The text SHALL remain unchanged in submission and history. References SHALL be whole whitespace-delimited words anywhere in the message. Peer envelopes SHALL NOT acquire skill attachments from their text.

#### Scenario: Invoke a completed or manually typed skill
- **WHEN** the user sends `please /explore this` and explore is eligible in the current ready catalog
- **THEN** Codex receives the unchanged text and an explicit skill input with explore's reported name and path, whether the user chose the menu or typed the reference

#### Scenario: Repeated and multiple skills
- **WHEN** the user sends `/explore /review /explore` and both names are eligible
- **THEN** Codex receives the unchanged text and exactly one skill input for each name in first-reference order

#### Scenario: A reference no longer resolves
- **WHEN** the user submits a draft containing a skill that is absent from the current ready catalog, or discovery is loading or unavailable
- **THEN** the message is sent unchanged without attaching that skill or waiting for discovery

#### Scenario: Exact reference boundaries
- **WHEN** explore is eligible and the human sends `x/explore /explore/more /explore, /Explore`
- **THEN** none of those words attaches explore

#### Scenario: Peer mail and history
- **WHEN** peer mail contains `/explore`, or a human skill turn is reloaded from history
- **THEN** peer delivery adds no skill input and replay shows the human text as submitted without skill-file content or synthetic user messages

### Requirement: Codex command discovery refreshes without interrupting chat
The catalog SHALL refresh on agent start or resume, a working-directory change, and a skill-change notification. Refresh SHALL clear outdated candidates, show loading, then publish ready or unavailable to every attached client and reconnect snapshot. Failed discovery SHALL NOT fail a turn. Results from an old process, directory, or superseded refresh SHALL NOT replace current state.

#### Scenario: Skills change while attached
- **WHEN** the agent announces changed skills
- **THEN** all attached clients see loading with no old candidates, followed by the refreshed ready list or unavailable on failure

#### Scenario: Working directory changes during a request
- **WHEN** the chat changes from directory A to B before A's discovery completes
- **THEN** the chat discovers B's skills and A's late response cannot restore A's list

#### Scenario: Unsupported or failed discovery
- **WHEN** discovery is unsupported, malformed, times out, or fails
- **THEN** the catalog becomes unavailable and ordinary messages still run without waiting for or failing because of discovery

#### Scenario: Agent ends and restarts
- **WHEN** the agent ends with discovery pending and later restarts or resumes
- **THEN** its list becomes unavailable, late replies are ignored, and the new agent independently discovers the current catalog

#### Scenario: Reconnecting and archived chats
- **WHEN** a client reconnects to a live Codex chat, or opens an archived Codex chat
- **THEN** the live snapshot includes its current command state and the archived chat starts no discovery process

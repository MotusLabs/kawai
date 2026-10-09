# Spec Delta

## ADDED Requirements

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

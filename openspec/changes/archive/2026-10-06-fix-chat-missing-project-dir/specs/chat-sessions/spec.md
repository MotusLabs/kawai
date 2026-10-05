# Spec Delta

## MODIFIED Requirements

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

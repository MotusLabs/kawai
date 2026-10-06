# Spec Delta

## Purpose

Defines which Claude Code executable chat sessions run, how its compatibility is checked, and how a missing or unsupported executable is reported without affecting the rest of the backend.

## ADDED Requirements

### Requirement: Chat sessions run a separately installed Claude Code executable
The system SHALL run chat sessions and their availability checks with a Claude Code executable installed separately from the application, not one bundled with its dependencies. The executable SHALL be the path configured in the server-only `KAWAI_CLAUDE_PATH` setting when present, otherwise `claude` resolved from the server's `PATH`. The configured value SHALL be treated as a single executable path, never interpreted as a shell command, and SHALL NOT be sent to browsers.

#### Scenario: Explicit executable path
- **WHEN** `KAWAI_CLAUDE_PATH` names an executable file and a user sends a chat message
- **THEN** the chat session runs that executable

#### Scenario: Executable found on PATH
- **WHEN** `KAWAI_CLAUDE_PATH` is unset and `claude` is on the server's `PATH`
- **THEN** chat sessions run the `claude` found on `PATH`

#### Scenario: Value is not a shell command
- **WHEN** `KAWAI_CLAUDE_PATH` contains spaces, arguments, or shell syntax that does not name an executable file
- **THEN** chat creation is refused as a missing executable and no shell interprets the value

#### Scenario: Released binary without dependencies
- **WHEN** a released single-file Kawai binary runs on a host with a supported Claude Code installed on `PATH`
- **THEN** chat sessions can be created and run

### Requirement: Executable compatibility is checked before chat creation
Before a chat session is created, the system SHALL verify within a bounded time that the selected executable exists, is executable, and reports a version at or above the documented supported baseline. A failed check SHALL refuse creation without persisting a session and with an error naming the checked path and the fix.

#### Scenario: Executable is missing
- **WHEN** no executable is found at `KAWAI_CLAUDE_PATH` or on `PATH` and a user creates a chat session
- **THEN** no session is created and the error explains how to install Claude Code or set `KAWAI_CLAUDE_PATH`

#### Scenario: Path is not executable
- **WHEN** `KAWAI_CLAUDE_PATH` names a directory or a file without execute permission
- **THEN** no session is created and the error names that path

#### Scenario: Version is below the baseline
- **WHEN** the executable reports a version older than the supported baseline
- **THEN** no session is created and the error states the found version and the minimum supported version

#### Scenario: Version check does not answer
- **WHEN** the version check does not complete within its time bound
- **THEN** the check process is stopped, no session is created, and the user receives an actionable error

### Requirement: Executable checks recover without restart
The system SHALL reuse a successful executable check only while the executable is unchanged and SHALL discard failed checks, so an installed, upgraded, or repaired executable is evaluated again without restarting the server.

#### Scenario: Installation repaired
- **WHEN** a creation attempt failed the executable check and the operator then installs a supported executable
- **THEN** the next creation attempt checks again and succeeds without a server restart

### Requirement: Executable problems are confined to chat sessions
A missing, unsupported, or failing Claude Code executable SHALL NOT prevent backend startup, terminal sessions, or reading existing chat history. Sending to an existing chat session when the executable has become unavailable SHALL fail with the same actionable error and SHALL leave the session and its stored conversation identity intact.

#### Scenario: Backend starts without Claude Code
- **WHEN** the server starts on a host with no Claude Code executable
- **THEN** the server starts, terminal sessions work, and only chat creation reports the missing executable

#### Scenario: Executable removed after creation
- **WHEN** the executable is removed and a user sends a message to an existing chat session whose agent is not running
- **THEN** the message is refused with the executable error and the session, history, and stored conversation identity remain available

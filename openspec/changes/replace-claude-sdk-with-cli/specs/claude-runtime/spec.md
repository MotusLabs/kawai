# Spec Delta

## Purpose

Defines the runtime availability and lifecycle guarantees for driving Claude Code conversations directly while preserving Kawai's chat-session interface.

## ADDED Requirements

### Requirement: Claude Code executable availability is explicit
The system SHALL use a separately installed Claude Code executable, selected through server configuration or PATH. Missing or unsupported executables SHALL produce actionable chat errors without preventing backend startup or terminal-session use.

#### Scenario: Executable is missing
- **WHEN** a user creates a chat session and the selected executable is unavailable
- **THEN** creation fails without persisting a session and identifies how to configure or install the executable

#### Scenario: Runtime is incompatible
- **WHEN** the executable is older than the documented supported baseline or fails the required initialization handshake
- **THEN** chat execution fails with a compatibility error and no user prompt is submitted

#### Scenario: Explicit executable selection
- **WHEN** the backend has an explicit executable path configured
- **THEN** chat sessions use that executable without interpreting the value as a shell command

### Requirement: Initialization precedes user execution
The system SHALL establish the required runtime controls before submitting user messages. Initialization failure SHALL release process resources, report a session-scoped error, and leave any persisted conversation identity intact.

#### Scenario: Delayed initialization
- **WHEN** a user submits a message while runtime initialization is pending
- **THEN** the message is held until initialization succeeds

#### Scenario: Initialization times out
- **WHEN** initialization exceeds its bounded deadline
- **THEN** the process is stopped and the user receives an actionable error without an inference prompt being sent

### Requirement: Persistent runtime supports successive turns
The system SHALL keep a successfully initialized runtime usable across completed turns and recoverable turn errors. A completed result SHALL not close the conversation's input. Prior conversation identity SHALL be retained on runtime failure.

#### Scenario: Two turns share a conversation
- **WHEN** a user sends a second message after a completed turn
- **THEN** it continues the same runtime conversation and its events use the existing chat interface

#### Scenario: Recoverable turn error
- **WHEN** the runtime reports an error result while remaining available
- **THEN** the user sees the error and can submit another turn

#### Scenario: Process dies
- **WHEN** the runtime exits unexpectedly
- **THEN** pending requests are cancelled, the failure is reported, and a later send can attempt resume using the retained conversation identity

### Requirement: Runtime permission requests remain cancellable
The system SHALL route runtime tool permission and question requests through the existing chat interaction contract. Cancelled requests SHALL be removed from attached clients, and late answers SHALL have no effect. Unsupported runtime requests SHALL never grant tool execution implicitly.

#### Scenario: Runtime cancels a pending request
- **WHEN** the runtime withdraws a pending permission or question request
- **THEN** attached clients remove it and a later answer is rejected as stale

#### Scenario: Unsupported control request
- **WHEN** the runtime requests an unsupported control operation
- **THEN** the system returns an explicit failure rather than allowing tool execution implicitly

### Requirement: Runtime shutdown releases resources
On session kill, backend shutdown, or failed initialization, the system SHALL stop accepting messages, settle pending controls and user requests, and terminate and reap its runtime processes within a bounded cleanup period.

#### Scenario: Kill during approval
- **WHEN** a session is killed while a tool approval is pending
- **THEN** the request is settled or cancelled and the runtime process is terminated without waiting for a browser answer

#### Scenario: Runtime ignores graceful shutdown
- **WHEN** the runtime does not exit within the graceful cleanup deadline
- **THEN** the system forcibly terminates and reaps it

### Requirement: Launch configuration preserves conversation context
The system SHALL preserve project directory, normal Claude Code context, configured authentication, and server-supplied environment/model/settings for each conversation. Configuration and credentials SHALL remain server-side, and tool approval controls SHALL remain enabled.

#### Scenario: Project context remains active
- **WHEN** a chat conversation starts in a project with user/project/local Claude configuration
- **THEN** that context is available as in the existing chat behavior and permission requests remain answerable in chat

#### Scenario: Independent launch configurations
- **WHEN** two conversations receive different server launch configurations
- **THEN** each uses its own configuration without mutating the backend environment or leaking credentials to clients

### Requirement: Existing conversation identities survive transport replacement
The system SHALL resume existing stored Claude Code conversation IDs and replay their available transcripts after the transport replacement. A failed resume SHALL preserve the stored ID and SHALL not implicitly start a fresh conversation.

#### Scenario: Resume a conversation created by the SDK
- **WHEN** an existing chat session with a stored conversation ID and transcript receives a message after replacement
- **THEN** it continues that conversation with its prior history available

#### Scenario: Resume fails
- **WHEN** the runtime cannot resume a stored conversation
- **THEN** the user receives an actionable error and the stored identity remains unchanged

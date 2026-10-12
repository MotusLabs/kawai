# Spec Delta

## MODIFIED Requirements

### Requirement: Messages carry sender context
Every message SHALL record its sender — the sending session for agent-originated messages, or the human for messages dispatched through task assignment — the sender's kind, the sender's group (none for the human), the sender's vantage directory as `origin_path`, its priority, its tags, its thread, and its creation time. Sender fields SHALL be set by the system and SHALL NOT be settable by the sending agent. Human-originated messages SHALL carry no sending session and their sender SHALL be shown as the human.

#### Scenario: Worktree sender path recorded
- **WHEN** an agent running in a linked worktree sends a message
- **THEN** the delivered message shows the worktree path as its origin

#### Scenario: Sender identity cannot be forged
- **WHEN** an agent's tool input claims a different sender or origin path
- **THEN** the message records the actual sending session and its project directory

#### Scenario: Human dispatch records a human sender
- **WHEN** the human dispatches a task assignment and its instruction is delivered
- **THEN** the peer message names no sending session and shows the human as its sender

### Requirement: Agents can reply
Each chat agent SHALL have a tool to reply to a message it received. A reply SHALL join the original message's thread and SHALL be sent as a direct message to the original sender, following the normal delivery rules. A reply to a human-originated message SHALL be refused with an error that directs the agent to append a journal note on the task instead, because the human reads those notes in the task detail.

#### Scenario: Reply reaches sender
- **WHEN** a dev replies to a message from the team lead
- **THEN** the team lead's session receives the reply as a direct message in the same thread

#### Scenario: Reply to busy sender
- **WHEN** a reply arrives while the original sender's turn is in flight
- **THEN** the reply waits until the sender is idle

#### Scenario: Reply to a human-originated message is refused
- **WHEN** an agent tries to reply to a task instruction dispatched by the human
- **THEN** the tool returns an error directing it to append a task journal note, and no message is queued

# Spec Delta

## MODIFIED Requirements

### Requirement: Messages carry sender context
Every message SHALL record its sender — a chat session with its group and its project directory as `origin_path`, the human, or Kawai itself for plan-execution mail — plus its priority, its tags, its thread, and its creation time. Sender fields SHALL be set by the system and SHALL NOT be settable by the sender. Kawai's mail SHALL have no sender session, and the team's main checkout as its origin.

#### Scenario: Worktree sender path recorded
- **WHEN** an agent running in a linked worktree sends a message
- **THEN** the delivered message shows the worktree path as its origin

#### Scenario: Sender identity cannot be forged
- **WHEN** an agent's tool input claims a different sender or origin path
- **THEN** the message records the actual sending session and its project directory

#### Scenario: Human sender recorded
- **WHEN** the human sends a message from the composer
- **THEN** the message records the human as its sender, with no chat session, and delivered rows show it the same way agent senders are shown

#### Scenario: Kawai sender recorded
- **WHEN** Kawai dispatches an execution instruction
- **THEN** the message records Kawai as its sender, with no chat session and the main checkout as its origin, and delivered rows show it as "Kawai"

## ADDED Requirements

### Requirement: Replies to Kawai's mail are refused with guidance
A reply to a message whose sender is Kawai SHALL be refused with nothing queued, for agents and for the human. The refusal SHALL say how to answer instead: `task_submit_result` for a result, `task_submit_findings` for a verdict, `task_note` for progress, or `send_message` to the responsible group or session.

#### Scenario: A dev replies to Kawai
- **WHEN** a dev calls `reply` on Kawai's fix instruction
- **THEN** the tool returns the guidance and nothing is queued

#### Scenario: The human replies to Kawai
- **WHEN** the human replies to Kawai's instruction in the Messages view
- **THEN** the reply is refused inline with the guidance, and nothing is queued

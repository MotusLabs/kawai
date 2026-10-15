# Spec Delta

## ADDED Requirements

### Requirement: The human can send and reply to team mail
The human SHALL be able to send a message to a group of the team or to one of its chat sessions from the Messages view, with a body, an optional task reference, and a priority defaulting to normal. The composer SHALL explain urgent semantics: urgent direct mail interrupts the recipient after its pending requests resolve, while urgent group mail waits for an idle member. A human reply SHALL stay in its thread and keep its task unless explicitly changed.

#### Scenario: Human sends to a group
- **WHEN** the human composes a message to the `devs` group with normal priority
- **THEN** it is queued in the group's mailbox and follows the normal delivery rules

#### Scenario: Urgent semantics explained
- **WHEN** the composer offers a priority choice
- **THEN** it states that urgent direct mail interrupts the recipient after its pending requests resolve, while urgent group mail waits for an idle member

#### Scenario: Human reply keeps thread and task
- **WHEN** the human replies to a message of a task-linked thread without changing the task
- **THEN** the reply joins that thread and references the same task

#### Scenario: Invalid recipient refused
- **WHEN** the human sends to a session of another team or an unknown group
- **THEN** the composer shows an error and nothing is queued

## MODIFIED Requirements

### Requirement: Messages carry sender context
Every message SHALL record its sender — a chat session with its group and its project directory as `origin_path`, or the human — plus its priority, its tags, its thread, and its creation time. Sender fields SHALL be set by the system and SHALL NOT be settable by the sender.

#### Scenario: Worktree sender path recorded
- **WHEN** an agent running in a linked worktree sends a message
- **THEN** the delivered message shows the worktree path as its origin

#### Scenario: Sender identity cannot be forged
- **WHEN** an agent's tool input claims a different sender or origin path
- **THEN** the message records the actual sending session and its project directory

#### Scenario: Human sender recorded
- **WHEN** the human sends a message from the composer
- **THEN** the message records the human as its sender, with no chat session, and delivered rows show it the same way agent senders are shown

### Requirement: Agents can reply
Each chat agent SHALL have a tool to reply to a message it received. A reply SHALL join the original message's thread and SHALL be sent as a direct message to the original sender, following the normal delivery rules. When the original sender is the human, the reply SHALL be recorded in the thread and delivered to the human directly — no agent session receives it — and connected clients SHALL be notified. An agent SHALL NOT be able to start a new thread to the human.

#### Scenario: Reply reaches sender
- **WHEN** a dev replies to a message from the team lead
- **THEN** the team lead's session receives the reply as a direct message in the same thread

#### Scenario: Reply to busy sender
- **WHEN** a reply arrives while the original sender's turn is in flight
- **THEN** the reply waits until the sender is idle

#### Scenario: Reply to a human message reaches the human
- **WHEN** an agent replies to a message the human sent
- **THEN** the reply is recorded in the thread as delivered to the human, connected clients are notified, and no agent session is started or claimed for it

#### Scenario: Agents cannot start mail to the human
- **WHEN** an agent sends a message addressed to the human rather than replying in a human-started thread
- **THEN** the tool returns an error and nothing is queued

### Requirement: Uncertain receipt is held for the human
When receipt can be neither confirmed nor refuted — the recipient's transcript is missing, unreadable, or ends in a malformed row — the message SHALL be held out of automatic delivery and reassignment and surfaced in the mailbox view. A human retry SHALL go to the same recipient with a possible-duplicate notice keyed by the message id, and discarding SHALL be an explicit action. Every cancel, retry, or discard SHALL be recorded in the message's append-only history, retained in its thread, and the possible duplication SHALL be explained before a retry is performed.

#### Scenario: Receipt without a confirmed durable record
- **WHEN** a pushed message's recipient transcript ends in a torn row after a machine-level crash
- **THEN** the message is held as uncertain rather than requeued, and no other member can receive it

#### Scenario: Transcript unavailable
- **WHEN** reconciliation cannot read the recipient's transcript at all
- **THEN** the message is held as uncertain and the mailbox view shows it for human resolution

#### Scenario: Human retry of an uncertain message
- **WHEN** the user retries a held message to the same recipient
- **THEN** the redelivered envelope tells the agent to treat an already-seen message id as a no-op

#### Scenario: Duplication explained before retry
- **WHEN** the user chooses to retry an uncertain message
- **THEN** the action explains first that the recipient may already have seen the message and a retry may deliver it twice, and the retry can only target the original recipient

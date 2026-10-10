# Spec Delta

## Purpose

Lets chat agents of one team send each other messages — to a specific agent or to a group's shared queue — with delivery that never disrupts an agent's work unless the sender marked the message urgent.

## ADDED Requirements

### Requirement: Agents can send messages
Each chat agent SHALL have a tool to send a message to a group of its team or to a specific chat session of its team, with a body, an optional `urgent` flag, and optional tags. Sending SHALL return a message id immediately and SHALL NOT wait for delivery or a reply. A message to an unknown group or session, or outside the sender's team, SHALL be refused with an error returned to the agent.

#### Scenario: Send to a group
- **WHEN** a team lead agent sends a message to `devs`
- **THEN** the tool returns a message id and the message is queued in the `devs` mailbox

#### Scenario: Send to a specific agent
- **WHEN** an agent sends a message to another chat session of its team
- **THEN** the message is queued in that session's direct mailbox

#### Scenario: Unknown recipient
- **WHEN** an agent sends a message to a group that its team does not define
- **THEN** the tool returns an error naming the unknown group and nothing is queued

#### Scenario: Recipient in another team
- **WHEN** an agent sends a message to a chat session that belongs to a different repository
- **THEN** the tool returns an error and nothing is queued

### Requirement: Messages carry sender context
Every message SHALL record the sending session, the sender's group, the sender's project directory as `origin_path`, its priority, its tags, its thread, and its creation time. Sender fields SHALL be set by the system and SHALL NOT be settable by the sending agent.

#### Scenario: Worktree sender path recorded
- **WHEN** an agent running in a linked worktree sends a message
- **THEN** the delivered message shows the worktree path as its origin

#### Scenario: Sender identity cannot be forged
- **WHEN** an agent's tool input claims a different sender or origin path
- **THEN** the message records the actual sending session and its project directory

### Requirement: Normal messages never interrupt
A message that is not urgent SHALL be delivered only when the recipient is idle: its agent has no turn in flight, no pending approval or question, and no running background worker. It SHALL be delivered as a new turn and SHALL NOT be added to an in-flight turn.

#### Scenario: Recipient busy
- **WHEN** a normal message arrives for an agent whose turn is in flight
- **THEN** the message stays queued, the turn continues undisturbed, and the message is delivered as a new turn after the turn ends

#### Scenario: Recipient idle
- **WHEN** a normal message arrives for an idle agent
- **THEN** the message is delivered as a new turn promptly

### Requirement: Delivery order
Among messages eligible for an agent, the system SHALL deliver urgent messages before normal ones; at equal priority, direct messages before group messages; and otherwise the oldest first.

#### Scenario: Urgent group mail before normal direct mail
- **WHEN** an idle agent has a normal direct message and an urgent message in its group's mailbox
- **THEN** the urgent group message is delivered first

#### Scenario: Direct before group at equal priority
- **WHEN** an idle agent has a normal direct message and an older normal group message
- **THEN** the direct message is delivered first

### Requirement: Urgent direct messages interrupt
An urgent message sent directly to a chat session SHALL interrupt that session's in-flight turn and SHALL then be delivered as the next turn. If an approval or question awaits the human, the system SHALL hold the urgent message until the request is answered, then interrupt and deliver. Urgent group messages SHALL NOT interrupt.

#### Scenario: Interrupt and deliver
- **WHEN** an urgent message is sent directly to an agent whose turn is in flight with no pending request
- **THEN** the turn is interrupted, output so far stays in the transcript, and the urgent message is delivered as the next turn

#### Scenario: Pending card is respected
- **WHEN** an urgent message is sent directly to an agent with an approval card awaiting the human
- **THEN** the card stays open, and only after the human answers it is the turn interrupted and the message delivered

#### Scenario: Urgent group mail waits for an idle member
- **WHEN** an urgent message is sent to a group whose members are all busy
- **THEN** no member is interrupted and the message is delivered first to the next member that becomes idle

### Requirement: Group messages are handled by exactly one member
A group message SHALL be delivered to one idle member of the group. When several members are idle, it SHALL go to the member that has been idle longest. Claiming SHALL be atomic: a message SHALL never be delivered to two members. Archived sessions and sessions without a running or startable agent SHALL NOT claim group messages.

#### Scenario: First free member picks
- **WHEN** a message arrives for `devs` while one member is busy and another is idle
- **THEN** the idle member receives it and the busy member does not

#### Scenario: Concurrent idleness
- **WHEN** two `devs` members become idle at the same moment and one message is queued
- **THEN** exactly one of them receives the message

#### Scenario: Archived member is skipped
- **WHEN** the only idle `devs` member is archived
- **THEN** the message stays queued

### Requirement: Delivered mail is shown as a peer message
A delivered message SHALL appear in the recipient's transcript as a peer-message entry, visually distinct from human messages, showing sender, sender group, priority, origin path, and tags. It SHALL persist in transcript history and reconnect snapshots.

#### Scenario: Peer message row
- **WHEN** an agent receives a message from an architect
- **THEN** its transcript shows an entry labeled with the sender session and group `architects`, distinct from user messages

#### Scenario: Survives reconnect
- **WHEN** a client reconnects to a chat that received peer messages
- **THEN** the peer-message entries are shown as before

### Requirement: Agents can reply
Each chat agent SHALL have a tool to reply to a message it received. A reply SHALL join the original message's thread and SHALL be sent as a direct message to the original sender, following the normal delivery rules.

#### Scenario: Reply reaches sender
- **WHEN** a dev replies to a message from the team lead
- **THEN** the team lead's session receives the reply as a direct message in the same thread

#### Scenario: Reply to busy sender
- **WHEN** a reply arrives while the original sender's turn is in flight
- **THEN** the reply waits until the sender is idle

### Requirement: Replies reach archived or killed senders
When the original sender is archived, the system SHALL restore it and deliver the reply. When the original sender was killed, the system SHALL deliver the reply to the sender's group mailbox with the full thread attached. A killed sender without a group SHALL have the reply dead-lettered.

#### Scenario: Archived sender is restored
- **WHEN** a reply is sent to a message whose sender is archived
- **THEN** the sender is restored, its conversation resumes, and it receives the reply

#### Scenario: Killed sender falls back to its group
- **WHEN** a reply is sent to a message whose sender was a killed `team-lead` member
- **THEN** an idle `team-lead` member receives the reply together with every earlier message of the thread

### Requirement: Agents can schedule messages
Each chat agent SHALL have a tool to schedule a message to itself, a group, or a team member for delivery at a given time or after a delay. A scheduled message SHALL become eligible at that time and then follow the normal delivery rules. Scheduled messages SHALL survive server restart.

#### Scenario: Reminder to self
- **WHEN** an agent schedules a message to itself 20 minutes ahead
- **THEN** 20 minutes later, once the agent is idle, it receives the message as a new turn

#### Scenario: Restart before due time
- **WHEN** the server restarts before a scheduled message is due
- **THEN** the message is still delivered at its due time

### Requirement: Threads have a hop limit
Every thread SHALL count its messages. When sending would exceed the thread's hop limit — the sender group's `hopLimit`, else 20 — the system SHALL accept the message as dead-lettered instead of delivering it, tell the sending agent it was not delivered, and notify the human.

#### Scenario: Ping-pong loop stopped
- **WHEN** two agents keep replying to each other in one thread past its hop limit
- **THEN** the message over the limit is dead-lettered, the sender is told, and the UI shows a notification

### Requirement: Team mailbox is inspectable
The UI SHALL show, per team, queued, scheduled, and dead-lettered messages with their sender, recipient, priority, and age. The user SHALL be able to cancel a queued or scheduled message and to retry or discard a dead-lettered one.

#### Scenario: Cancel a queued message
- **WHEN** the user cancels a queued group message
- **THEN** it is never delivered and no longer listed as queued

#### Scenario: Retry a dead letter
- **WHEN** the user retries a dead-lettered message
- **THEN** it is queued again with its thread's hop count reset

### Requirement: Queued mail survives restart
Queued, scheduled, and dead-lettered messages, and claims of messages not yet delivered, SHALL persist across server restart.

#### Scenario: Restart with queued mail
- **WHEN** the server restarts with messages queued for a group
- **THEN** they are delivered to idle members after the restart

#### Scenario: Recipient killed before delivery
- **WHEN** a session with queued direct messages is killed
- **THEN** those messages are dead-lettered

### Requirement: Claimed mail is reconciled on restart
Every delivered envelope SHALL carry its message id as a stable delivery identity, recorded in the recipient's transcript when delivery happens. On restart, a claimed message SHALL be reconciled against the claiming recipient's transcript by that identity: completed as delivered when the record is found, and returned to the queue when it is not.

#### Scenario: Crash after delivery, before completion
- **WHEN** the server crashes after a claimed message's turn has been recorded in the recipient's transcript but before the message row is marked delivered
- **THEN** on restart the message is reconciled from the transcript, marked delivered, and never delivered to any member again

#### Scenario: Crash after claim, before delivery
- **WHEN** the server crashes after a message is claimed but before its turn reaches the recipient's transcript
- **THEN** on restart the message is returned to the queue and is later delivered exactly once under the normal delivery rules

# agent-mailbox Specification

## Purpose

Lets chat agents of one team send each other messages — to a specific agent or to a group's shared queue — with delivery that never disrupts an agent's work unless the sender marked the message urgent.

## Requirements

### Requirement: Agents can send messages
Each chat agent SHALL have a tool to send a message to a group of its team or to a specific chat session of its team, with a body, an optional `urgent` flag, and optional tags. Sending SHALL return a message id immediately and SHALL NOT wait for delivery or a reply. A message to an unknown group or session, or outside the sender's team, SHALL be refused with an error returned to the agent.

#### Scenario: Send to a group
- **WHEN** a team lead agent sends a message to `devs`
- **THEN** the tool returns a message id and the message is queued in the `devs` mailbox

#### Scenario: Send to a specific agent
- **WHEN** an agent sends a message to another chat session of its team
- **THEN** the message is queued in that session's direct mailbox

#### Scenario: Archived recipient is restored
- **WHEN** an agent sends a message directly to a teammate that is archived
- **THEN** the recipient is restored and the message is delivered by the normal delivery rules

#### Scenario: Unknown recipient
- **WHEN** an agent sends a message to a group that its team does not define
- **THEN** the tool returns an error naming the unknown group and nothing is queued

#### Scenario: Recipient in another team
- **WHEN** an agent sends a message to a chat session that belongs to a different repository
- **THEN** the tool returns an error and nothing is queued

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
The UI SHALL show, per team, every unsettled message state with its sender, recipient, priority, and age: queued due now, awaiting the recipient's approval or answer, scheduled, starting an agent, receiving, parked, held for review, and dead-lettered. A message reserved for an agent being spawned SHALL remain visible while its agent starts instead of disappearing from the view. The user SHALL be able to cancel a queued or scheduled message and to retry or discard a dead-lettered one.

#### Scenario: Cancel a queued message
- **WHEN** the user cancels a queued group message
- **THEN** it is never delivered and no longer listed as queued

#### Scenario: Retry a dead letter
- **WHEN** the user retries a dead-lettered message
- **THEN** it is queued again with its thread's hop count reset

#### Scenario: A message starting an agent stays visible
- **WHEN** a message is reserved for an agent whose startup is held open
- **THEN** the mailbox shows it under a Starting agent section for as long as the startup runs, and it never matches no category

### Requirement: Queued mail survives restart
Queued, scheduled, and dead-lettered messages, and claims of messages not yet delivered, SHALL persist across server restart.

#### Scenario: Restart with queued mail
- **WHEN** the server restarts with messages queued for a group
- **THEN** they are delivered to idle members after the restart

#### Scenario: Recipient killed before delivery
- **WHEN** a session with queued direct messages is killed
- **THEN** those messages are dead-lettered

### Requirement: Delivery is acknowledged by the recipient's durable record
Every delivered envelope SHALL carry its message id. Delivery SHALL be acknowledged only by a well-formed row in the recipient agent's transcript that carries that id; submission — a pushed turn or the `peer_message` display event — SHALL NOT count as receipt. On restart, a message that was pushed but not acknowledged SHALL be reconciled by that record: completed as delivered when the row is found, and returned to the queue when the transcript ends cleanly with no such row.

#### Scenario: Crash after delivery, before completion
- **WHEN** the server crashes after a claimed message's turn has been recorded in the recipient's transcript but before the message row is marked delivered
- **THEN** on restart the message is reconciled from the transcript, marked delivered, and never delivered to any member again

#### Scenario: Crash after claim, before delivery
- **WHEN** the server crashes after a message is claimed but before its turn is pushed
- **THEN** on restart the message is returned to the queue and is later delivered exactly once under the normal delivery rules

#### Scenario: Crash after push, before the agent consumes the input
- **WHEN** the server crashes after the turn is pushed but the SDK never consumed it, so no transcript row was written
- **THEN** on restart the message is returned to the queue and is later delivered exactly once

### Requirement: Uncertain receipt is held for the human
When receipt can be neither confirmed nor refuted (the recipient's transcript is missing, unreadable, or ends in a malformed row), the message SHALL be held out of automatic delivery and reassignment and shown in the mailbox view. A human retry SHALL go to the same recipient with a possible-duplicate notice, after the possible duplication is explained; discarding SHALL be explicit. Every cancel, retry, or discard SHALL be recorded in the message's append-only history and kept in its thread.

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

### Requirement: The human can cancel parked mail
The Mailbox view SHALL offer Cancel on a parked message beside Hand off. Cancelling SHALL cancel the parked message together with its waiting resume message, SHALL record the cancellation as the human's action, and SHALL neither restore nor resume the holder. While the resume turn is in flight, the cancel SHALL be refused with the holder named.

#### Scenario: Cancel work parked on an archived agent
- **WHEN** the user cancels a parked message whose holder is archived
- **THEN** the message and its resume message are cancelled, the row leaves the Parked section, and the holder stays archived

#### Scenario: Resume turn in flight
- **WHEN** the user cancels a parked message while its holder is running the resume turn
- **THEN** the view reports that the holder is resuming the work now, and both messages are unchanged

#### Scenario: Parked state changed meanwhile
- **WHEN** the user cancels a parked message that was unparked or handed off a moment earlier
- **THEN** the view reports that the action is no longer available and the message keeps its new state

### Requirement: Mailbox rows show their message id
Each row of the Mailbox view SHALL show a short form of its message id that matches the id's prefix, and SHALL make the full id available to read and copy, so an id quoted by an agent can be matched to its row.

#### Scenario: Match an id quoted by the lead
- **WHEN** the lead names message `0e849a2e-5025-…` in a chat
- **THEN** the user finds the Mailbox row showing `0e849a2e` and can copy its full id

### Requirement: Waiting rows render their reason
A waiting row — one queued due now, awaiting the recipient's approval or answer, or starting an agent — SHALL show its computed waiting reason's immediate blocker on one line, with the other constraints expandable. Scheduled rows SHALL show their due time, and parked, held-for-review, and dead-lettered rows keep their existing explanations. Named sessions SHALL link to their chats; dead letters SHALL show a readable label for known codes with the code visible.

#### Scenario: A waiting row shows its blocker
- **WHEN** a queued message's waiting reason has group capacity 2 of 2 as its immediate blocker
- **THEN** the row shows that capacity line and can expand to the other constraints that also apply

#### Scenario: A scheduled row keeps its due time
- **WHEN** a queued message's delivery is scheduled for a future time
- **THEN** the row shows when it is due rather than a waiting blocker

#### Scenario: Occupants and worktrees are navigable
- **WHEN** a waiting reason names the session occupying a worktree
- **THEN** the session name links to its chat and the worktree shows a short name with its full path available

#### Scenario: A dead letter reads as a sentence
- **WHEN** a dead-lettered message's reason code is `worktree-missing: /path`
- **THEN** the row shows a readable label such as "Target worktree is missing" with the raw code still visible

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

### Requirement: Replies to Kawai's mail are refused with guidance
A reply to a message whose sender is Kawai SHALL be refused with nothing queued, for agents and for the human. The refusal SHALL say how to answer instead: `task_submit_result` for a result, `task_submit_findings` for a verdict, `task_note` for progress, or `send_message` to the responsible group or session.

#### Scenario: A dev replies to Kawai
- **WHEN** a dev calls `reply` on Kawai's fix instruction
- **THEN** the tool returns the guidance and nothing is queued

#### Scenario: The human replies to Kawai
- **WHEN** the human replies to Kawai's instruction in the Messages view
- **THEN** the reply is refused inline with the guidance, and nothing is queued

### Requirement: Mail dropped by an exhausted turn is dead-lettered
When a turn that flags its session as context-exhausted was handling delivered mail, that message SHALL move from delivered to dead with reason `context-exhausted`, recorded in its history. The Mailbox SHALL show a readable label for the code.

#### Scenario: Go mail dropped
- **WHEN** the lead's mail is delivered and the turn it starts ends with `blocking_limit`
- **THEN** the message is a dead letter with reason `context-exhausted`, not delivered

#### Scenario: Ordinary failure
- **WHEN** a turn handling delivered mail fails with `api_error`
- **THEN** the message stays delivered

### Requirement: Retry of a context-exhausted dead letter avoids the flagged session
Retrying a `context-exhausted` dead letter addressed to a group SHALL requeue it to that group, where the flagged session is not a candidate. Retrying one addressed to a session SHALL be refused while that session is flagged.

#### Scenario: Group mail retried
- **WHEN** the human retries a `context-exhausted` dead letter addressed to `middle-devs`
- **THEN** it is queued to the group and cannot go to the flagged member

#### Scenario: Direct mail retried
- **WHEN** the human retries one addressed to the still-flagged session
- **THEN** the retry is refused naming the flag

### Requirement: Direct mail to a flagged session is refused
New direct mail or a reply addressed to a flagged session SHALL be refused, from an agent or the human, naming the flag, with nothing queued. Direct mail already queued for a session SHALL be dead-lettered `context-exhausted` when it is flagged. A flagged archived session SHALL never be restored by mail.

#### Scenario: Lead replies to the dead dev
- **WHEN** the lead replies in a thread whose sender is the flagged session
- **THEN** the reply is refused naming the flag, and the session is not restored

#### Scenario: Queued direct mail
- **WHEN** a session is flagged while direct mail to it is queued
- **THEN** that mail becomes a `context-exhausted` dead letter

### Requirement: Replies to an open decision question are refused with guidance
A reply to a message tagged `decision-question` whose decision card is still open SHALL be refused with nothing queued, for agents and for the human. The refusal SHALL point agents to `decision_record` and the human to the card's **Answer**. Once the card is decided, replies to that message SHALL follow the normal rules. The decided answer Kawai delivers in the question's thread is not such a reply.

#### Scenario: The Lead replies instead of recording
- **WHEN** a member of the Lead role calls `reply` on an open card's question mail
- **THEN** the tool returns guidance to call `decision_record` for that card, and nothing is queued

#### Scenario: The human replies to the question
- **WHEN** the human replies to an open card's question mail in the Messages view
- **THEN** the reply is refused inline, pointing to the card's **Answer**, and nothing is queued

#### Scenario: After the decision
- **WHEN** the card has been decided and the asker replies to the answer to ask a follow-up
- **THEN** the reply is queued as usual

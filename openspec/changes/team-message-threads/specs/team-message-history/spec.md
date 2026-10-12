# Spec Delta

## Purpose

Gives one team a durable, navigable record of its mail: delivered history beside pending mail, thread views that survive their participants, an append-only history of what happened to each message, and a composer so the human can take part.

## ADDED Requirements

### Requirement: All team mail is listed together
The UI SHALL list, per team, delivered history and pending mail together, newest first and paged, filterable by task, thread, role, session, priority, and delivery state, including mail to and from the human. A task's detail SHALL embed the subset filtered to that task with the same naming and thread links. Another team's messages SHALL NOT be listed.

#### Scenario: Delivered history after delivery
- **WHEN** a message is delivered to an agent and the user opens the team's Messages view
- **THEN** the message is listed alongside pending mail with its delivery state

#### Scenario: Filter by task
- **WHEN** the user filters the list to a task
- **THEN** only messages referencing that task are listed, in every delivery state

#### Scenario: Task detail embeds its mail
- **WHEN** the user opens a task's detail
- **THEN** its messages are shown with named senders and recipients and each row links to its thread

#### Scenario: Team isolation
- **WHEN** a second repository's team exchanges messages
- **THEN** none of those messages appear in this team's Messages view

### Requirement: Thread detail shows the conversation and its delivery facts
Thread detail SHALL show a thread's messages in chronological order with their reply relationships, each message's current recipient or claimant and delivery state, and, for task-linked messages, the task revision the delivered context carried. The revision shown SHALL be the one recorded at delivery, not the task's current revision.

#### Scenario: Chronological order and replies
- **WHEN** the user opens a thread that started as task mail and was answered through different sessions
- **THEN** its messages are listed oldest first, each showing which message it answers

#### Scenario: Revision carried at delivery
- **WHEN** a thread's task was amended after one of its messages was delivered
- **THEN** that message shows the task revision its delivered context carried, and the thread shows the task's current revision separately

### Requirement: Message history is append-only and retained
Every message state change SHALL be recorded in an append-only history with the event kind, the actor (system or human), the time, and the facts the change overwrote, including previous state, claimant, recipient, and reason. Cancel, retry, and discard outcomes SHALL be part of that history, and the history SHALL survive server restart.

#### Scenario: Uncertain hold and retry stay visible
- **WHEN** a message was held uncertain, then retried to the same recipient
- **THEN** the thread shows both the hold with its reason and the retry, in order

#### Scenario: Cancel history survives in the thread
- **WHEN** the user cancels a queued message of a thread
- **THEN** the thread keeps showing the sent and cancelled messages with the cancellation marked as the human's action

#### Scenario: Restart keeps events
- **WHEN** the server restarts
- **THEN** every recorded event of every message is still available in its thread

### Requirement: Participants are named and navigable
Senders, recipients, and claimants SHALL be shown as session names with role badges, with session ids available in expandable metadata. A killed session SHALL keep its recorded name and role with a clear unavailable label. Clicking a live or archived participant SHALL open its chat; a killed one SHALL NOT navigate.

#### Scenario: Named senders with role badges
- **WHEN** a developer and a reviewer exchange messages in a thread
- **THEN** each message names its sender and its role badge, with ids visible in expandable metadata

#### Scenario: Killed sender keeps its identity
- **WHEN** the user reloads the Messages view after one thread participant's session was killed
- **THEN** that participant's messages still show its recorded name and role with an unavailable label, the thread and its history remain, and clicking its name opens nothing

#### Scenario: Click-through to a chat
- **WHEN** the user clicks a live participant's name in a thread
- **THEN** that participant's chat opens

### Requirement: The open view stays current
An open Messages view SHALL update as mail changes without a reload and SHALL be restored with current data after a reconnect. Changes made in other surfaces — deliveries, retries, cancels — SHALL appear in the open view.

#### Scenario: Delivery while open
- **WHEN** a queued message is delivered while the Messages view is open
- **THEN** its row updates to delivered without a reload

#### Scenario: Reconnect restores the view
- **WHEN** the client reconnects while the Messages view is open
- **THEN** the view is restored from an authoritative snapshot of the current filters and thread

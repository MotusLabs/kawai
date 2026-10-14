# Spec Delta

## Purpose

Lets chat agents inspect their team's mailbox and withdraw or clear stale mail, so a stuck or limited agent can be replaced without leaving behind mail that spawns duplicate work. Rights are scoped to the sender's own mail by default and widened by a group setting.

## ADDED Requirements

### Requirement: Agents can withdraw their own undelivered mail
Each chat agent SHALL have a tool to cancel a message it sent, given the message id and a reason, while the message is queued (scheduled or due) or held awaiting its recipient's approval or answer. A cancelled message SHALL never be delivered and SHALL leave the pending mailbox. The tool SHALL return the cancelled message's id and final state.

#### Scenario: Withdraw a stale queued follow-up
- **WHEN** a lead cancels a normal message it sent to `middle-devs` that is still queued because no member can take it
- **THEN** the message is cancelled, never delivered, and no member is spawned for it when capacity later frees

#### Scenario: Withdraw a scheduled message
- **WHEN** an agent cancels a message it scheduled to itself for later
- **THEN** the message is not delivered at its due time

#### Scenario: Withdraw urgent mail held for a pending request
- **WHEN** an agent cancels urgent direct mail it sent that is held until the recipient's approval card is answered
- **THEN** the card is answered later without any interruption or delivery of that message

### Requirement: In-flight and settled mail cannot be cancelled by agents
An agent's cancel SHALL be refused, and the message left unchanged, when the message is claimed, reserved for a member being spawned, delivered, or already settled (cancelled, discarded, or forwarded). The refusal SHALL name the message's current state.

#### Scenario: Claimed message refused
- **WHEN** an agent cancels a message a recipient has already claimed
- **THEN** the tool returns an error stating the message is claimed and the delivery proceeds

#### Scenario: Spawn reservation refused
- **WHEN** an agent cancels a message reserved for a member being spawned
- **THEN** the tool returns an error stating a member is starting for it, and the spawn proceeds

### Requirement: Groups can be granted mailbox management
A group's file SHALL accept `canManageMailbox: true|false`, default `false`. An invalid value SHALL be reported as a group warning and treated as `false`. The setting SHALL be read from the group's current file at each tool call, so an edit applies to the group's members without restarting them.

#### Scenario: Default group has no management right
- **WHEN** a member of a group whose file does not set `canManageMailbox` cancels a message another agent sent
- **THEN** the tool returns an error explaining that only the sender, a group with mailbox management, or the human can cancel it

#### Scenario: Invalid value warned
- **WHEN** a group file sets `canManageMailbox: maybe`
- **THEN** the groups listing reports a warning for that key and members of the group have no management right

### Requirement: Mailbox managers can cancel any team message
A member of a group with `canManageMailbox: true` SHALL be able to cancel any message of its team, whoever sent it, in the states a sender may cancel, and also while it is parked. The in-flight and settled states SHALL be refused as for any agent.

#### Scenario: Lead cancels mail another agent sent
- **WHEN** a lead whose group sets `canManageMailbox: true` cancels a queued message a dev sent to `reviewers`
- **THEN** the message is cancelled and never delivered

#### Scenario: Other team's message
- **WHEN** a mailbox manager cancels a message id that belongs to another team
- **THEN** the tool returns a not-found error and the message is unchanged

### Requirement: Cancelling parked work ends the park
Cancelling a parked message SHALL cancel it together with its scheduled resume message, if that resume is still undelivered, in one step. The holder SHALL then no longer show as paused for that message. It SHALL NOT be restored, resumed, or sent anything because of the cancel, and the message SHALL no longer count as mail it holds.

#### Scenario: Limited dev's parked work cancelled
- **WHEN** a mailbox manager cancels work parked on an archived dev after a provider limit
- **THEN** the work and its resume message are both cancelled, the dev stays archived, and nothing is delivered to it at the reset time

#### Scenario: Holder no longer paused
- **WHEN** the only message parked on a live agent is cancelled
- **THEN** the agent's paused badge clears and it may take group mail again

#### Scenario: Resume already delivered
- **WHEN** a parked message is cancelled after its resume message was already delivered
- **THEN** the parked message is cancelled, the delivered resume stays delivered, and a later outcome of that resume turn changes neither message

### Requirement: Mailbox managers can discard dead and uncertain mail
A mailbox manager SHALL have a tool to discard a dead-lettered or uncertain message of its team, given the message id and a reason. A discarded message SHALL never be retried or delivered. Discarding any other state SHALL be refused. Agents SHALL have no tool to retry or hand off a message.

#### Scenario: Lead discards a handled uncertain message
- **WHEN** a lead discards an uncertain message it already received and acted on, giving that as the reason
- **THEN** the message is discarded and leaves the held-for-review list

#### Scenario: Non-manager discard refused
- **WHEN** a member of a group without mailbox management discards a dead letter
- **THEN** the tool returns an error and the dead letter stays

### Requirement: Agents can inspect the team mailbox
Each chat agent SHALL have a tool listing unsettled team mail: queued, scheduled, awaiting a request, being spawned for, claimed, parked, dead, and uncertain. Each entry SHALL carry the message id, state, sender, recipient, claimant, task, priority, age, due or resume time, reason, current waiting blocker when known, and a body cut to a bounded length. Filters SHALL narrow by state, recipient, sender, and task.

#### Scenario: Lead finds a stale queued message
- **WHEN** a lead lists the mailbox filtered to queued mail of a task
- **THEN** it sees each such message with its id, its age, and why it is still waiting

#### Scenario: Parked work visible with its holder
- **WHEN** an agent lists parked mail
- **THEN** each parked entry names its holder and its resume time

### Requirement: Mailbox visibility is scoped by right
A member without mailbox management SHALL see only mail it sent, mail addressed directly to it, and mail it claims or holds. A mailbox manager SHALL see every message of its team. No agent SHALL see another team's mail.

#### Scenario: Dev sees only its own mail
- **WHEN** a dev lists the mailbox while other agents have queued mail between them
- **THEN** the result contains only messages the dev sent, received directly, or holds

#### Scenario: Manager sees the whole team
- **WHEN** a mailbox manager lists the mailbox
- **THEN** the result contains the unsettled mail of every member of its team and none from other teams

### Requirement: Agent mailbox actions are attributed
Every cancel or discard an agent performs SHALL be recorded in the message's history with the acting agent's session and the reason it gave, distinct from human and system actions. The reason SHALL be required, non-empty, and stored cut to a bounded length. When the message is under a task, the task's journal SHALL gain a note by the acting agent naming the message, its recipient, the action, and the reason.

#### Scenario: Thread shows who cancelled
- **WHEN** a lead cancels a dev's queued message with reason "work already committed"
- **THEN** the message's history shows a cancellation by the lead's session with that reason

#### Scenario: Task journal note
- **WHEN** a mailbox manager cancels parked work under a task
- **THEN** the task's journal gains a note authored by the manager naming the message and the reason

#### Scenario: Missing reason refused
- **WHEN** an agent calls cancel with an empty reason
- **THEN** the tool returns an error and the message is unchanged

### Requirement: The mailbox note describes management rights
The system prompt's mailbox note SHALL describe the inspect and withdraw tools to every agent. It SHALL describe cancelling others' mail, cancelling parked work, and discarding only to agents whose group sets `canManageMailbox: true`, and SHALL state that retry and hand-off remain the human's.

#### Scenario: Lead prompt
- **WHEN** an agent of a group with `canManageMailbox: true` starts
- **THEN** its mailbox note explains cancelling any team message, including parked work, and discarding dead or uncertain mail

#### Scenario: Dev prompt
- **WHEN** an agent of a group without mailbox management starts
- **THEN** its mailbox note explains listing its own mail and withdrawing its own undelivered messages, and does not offer cancelling others' mail

# Spec Delta

## MODIFIED Requirements

### Requirement: The attention queue lists what needs a human or is waiting on an agent
The attention queue SHALL consolidate pending approvals and questions, uncertain deliveries, staffing waits, pending acceptance, and results whose review requested fixes. Each item SHALL show its cause, owner, impact scope, next action, and a link to its card, task, or message. Human-required items SHALL be separated from agent-owned waits. Pending acceptance SHALL be owned by the party expected to close the task. Fixes requested of a gone submitter SHALL name who acts next.
#### Scenario: An open approval is a human-required item (E05)
- **WHEN** a session has a pending approval
- **THEN** the queue lists it as human-required with the session as owner, its task as impact scope, and a link to that chat's approval card

#### Scenario: A staffing wait is agent-owned (E05)
- **WHEN** a message waits on a group cap
- **THEN** the queue lists it under agent-owned waits with the capacity as its cause and a link to the message

#### Scenario: An uncertain delivery needs the human
- **WHEN** a message is held as an uncertain delivery
- **THEN** the queue lists it as human-required with retry or discard as its next action and a link to the message

#### Scenario: Pending acceptance needs the human
- **WHEN** a submitted result of a task the human created awaits **Accept result**, and its newest findings, if any, pass
- **THEN** the queue lists it as human-required with the task as impact scope and a link to the task

#### Scenario: An agent-created task's acceptance waits on its creator
- **WHEN** a submitted result of a task created by a live agent session awaits acceptance, and its newest findings, if any, pass
- **THEN** the queue lists it under agent-owned waits with that session as owner, the task as impact scope, and a link to the task
- **AND** the human can still accept the result from the task

#### Scenario: A creator that is gone hands acceptance to the human
- **WHEN** the agent session that created the task is archived or killed and the task's result awaits acceptance
- **THEN** the queue lists that pending acceptance as human-required

#### Scenario: A running execution's task asks nothing of the human
- **WHEN** a submitted result of a task a running execution owns has not been accepted, and its newest findings, if any, pass
- **THEN** the queue lists no pending acceptance for it, and its task row's next action is Wait for Kawai

#### Scenario: Failing findings are a wait for fixes
- **WHEN** the newest findings bound to a task's unaccepted outstanding result have the verdict fail, and the result's submitter is a live session
- **THEN** the queue lists one agent-owned fixes-requested item with the result's submitter as owner, Wait for fixes as its next action, the task as impact scope, and a link to the task
- **AND** no pending acceptance is listed for that result

#### Scenario: Fixes of a gone submitter under a running execution wait for Kawai
- **WHEN** the newest findings of an unaccepted result of a task a running execution owns fail, its submitter is archived or gone, and no live session holds the task's assignment
- **THEN** the fixes-requested item's cause names the submitter as archived and no session running the task, its owner is Kawai, and its next action is Wait for Kawai to dispatch the fix

#### Scenario: Fixes of a gone submitter outside an execution need a handoff
- **WHEN** the newest findings of an unaccepted result of a task no execution owns fail, its submitter is archived or gone, and no live session holds the task's assignment
- **THEN** the fixes-requested item names the submitter as archived and no session running the task, it is owned by the task's live agent owner (an agent-owned wait) or else by the human (human-required), and its next action is Hand off for fixes

#### Scenario: A live holder still owns the wait
- **WHEN** the submitter of a failing result is archived but another live session has claimed the task's assignment
- **THEN** the fixes-requested item is an agent-owned wait owned by that session

## ADDED Requirements

### Requirement: The attention queue lists pending publication handoffs
The attention queue SHALL hold one item per pending publication handoff, linked to the handoff in its task. An open handoff SHALL be owned by the task's live agent owner as an agent-owned wait, else by the human as human-required, with **Publish prepared revision** as its next action. A stale handoff SHALL be owned by its requester when live, else its group, with **Re-prepare or withdraw**.

#### Scenario: A Kawai task's handoff needs the human
- **WHEN** an agent records an open handoff for a task Kawai created
- **THEN** the queue lists a human-required item naming the task, the base revision, and the requester, with **Publish prepared revision** and a link to the handoff

#### Scenario: A live owner's handoff is an agent wait
- **WHEN** an open handoff is recorded for a task whose owner is a live agent session
- **THEN** the item is an agent-owned wait owned by that session, and the human can still publish the handoff from the task

#### Scenario: An archived owner hands the handoff to the human
- **WHEN** the task's agent owner is archived while its handoff is open
- **THEN** the item is human-required

#### Scenario: A stale handoff goes back to its requester
- **WHEN** the human publishes another revision while the handoff is open
- **THEN** the item is owned by the requester (or its group when the requester is gone) with **Re-prepare or withdraw**, and names the newer revision

#### Scenario: A disposition clears the item
- **WHEN** the handoff is declined, withdrawn, superseded, or its task is closed
- **THEN** its item leaves the queue, and a superseding handoff raises its own item

#### Scenario: Answering a card leaves the item
- **WHEN** the human answers a decision card about the same correction while its handoff is open
- **THEN** the card's item leaves the queue and the handoff's item stays

### Requirement: A published handoff stays visible until its holder acknowledges
After a handoff is published, the queue SHALL hold one follow-up item until the task's current claimed holder acknowledges that revision or a later one, or the task closes, whatever its notices' states. It SHALL wait for the holder once the revision was delivered to it, else send an uncertain notice to the Mailbox's Retry or Discard and a failed one to **Retry notification**; it SHALL name no session running the task when none holds it.

#### Scenario: Notice failure needs the human
- **WHEN** the revision 2 notice from a published handoff is dead-lettered and no other task mail has delivered revision 2 to the holder
- **THEN** the follow-up item is human-required with **Retry notification** and a link to the revision's publication detail

#### Scenario: Delivery after a failed notice waits for the holder
- **WHEN** the revision 2 notice was dead-lettered, later task mail carrying revision 2 is delivered to the same holder, and it has not acknowledged revision 2
- **THEN** the follow-up item is an agent-owned wait owned by the holder, naming delivered revision 2, and offers no **Retry notification**

#### Scenario: Waiting for the holder's acknowledgement
- **WHEN** the notice was delivered and the holder has not acknowledged revision 2
- **THEN** the follow-up item is an agent-owned wait owned by the holder, naming delivered revision 2 and acknowledged revision 1

#### Scenario: Acknowledgement clears the follow-up
- **WHEN** the holder acknowledges revision 2
- **THEN** the follow-up item leaves the queue

#### Scenario: Acknowledgement after a failed notice
- **WHEN** the revision 2 notice failed and the holder then acknowledges revision 2 after reading the task another way
- **THEN** the follow-up item leaves the queue, and no **Retry notification** item remains

#### Scenario: Acknowledgement without any delivery needs no notice
- **WHEN** a handoff is published as revision 2 without notify, and the holder reads the task and acknowledges revision 2 although no task mail carrying it was delivered
- **THEN** the follow-up item leaves the queue, and no **Notify** or **Retry notification** is offered

#### Scenario: An uncertain notice goes to the Mailbox
- **WHEN** the revision 2 notice from a published handoff is held as an uncertain delivery and revision 2 has not been delivered to the holder another way
- **THEN** the follow-up item is human-required with Resolve in the Mailbox (Retry or Discard) linked to that message, and offers neither **Notify** nor **Retry notification**

#### Scenario: Closing the task ends the follow-up
- **WHEN** the task of a published handoff closes before its holder acknowledges
- **THEN** the follow-up item leaves the queue, and no Hand off the task item is raised

#### Scenario: No session holds the task
- **WHEN** a handoff is published for a task with no live claimed assignment
- **THEN** the follow-up item names no session running the task; it is owned by Kawai with Wait for Kawai when a running execution owns the task, else it is human-required with Hand off the task

#### Scenario: Plain publication of a handoff
- **WHEN** a handoff whose notify choice is unset is published while a holder is live
- **THEN** the follow-up item is human-required with **Notify**, until the holder acknowledges

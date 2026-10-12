# Spec Delta

## MODIFIED Requirements

### Requirement: Team mailbox is inspectable
The UI SHALL show, per team, every unsettled message state with its sender, recipient, priority, and age: queued (due now), scheduled (with its due time), starting an agent, receiving, parked, held for review, and dead-lettered. A message reserved for an agent being spawned SHALL remain visible while its agent starts instead of disappearing from the view. Each waiting row SHALL show its computed waiting reason's immediate blocker, with the other constraints expandable; named sessions SHALL link to their chats and worktrees SHALL show a short name with the full path available. Dead-lettered messages SHALL show a readable label for known reason codes while keeping the code visible. The user SHALL be able to cancel a queued or scheduled message and to retry or discard a dead-lettered one.

#### Scenario: Cancel a queued message
- **WHEN** the user cancels a queued group message
- **THEN** it is never delivered and no longer listed as queued

#### Scenario: Retry a dead letter
- **WHEN** the user retries a dead-lettered message
- **THEN** it is queued again with its thread's hop count reset

#### Scenario: A message starting an agent stays visible
- **WHEN** a message is reserved for an agent whose startup is held open
- **THEN** the mailbox shows it under a Starting agent section for as long as the startup runs, and it never matches no category

#### Scenario: A waiting row shows its blocker
- **WHEN** a queued message's waiting reason has group capacity 2 of 2 as its immediate blocker
- **THEN** the row shows that capacity line and can expand to the other constraints that also apply

#### Scenario: A dead letter reads as a sentence
- **WHEN** a dead-lettered message's reason code is `worktree-missing: /path`
- **THEN** the row shows a readable label such as "Target worktree is missing" with the raw code still visible

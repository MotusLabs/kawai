# Spec Delta

## MODIFIED Requirements

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

## ADDED Requirements

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

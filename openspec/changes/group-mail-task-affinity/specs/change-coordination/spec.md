# Spec Delta

## MODIFIED Requirements

### Requirement: Coordinator recovery respects durable ownership
The protocol SHALL require a replacement or withdrawal record with outstanding assignments, mail and handoff references, branches, results, next actions, and owner-bound operations. A replacement SHALL NOT exercise amendment or closing rights over another session's tasks without holding them. It SHALL gain them only through a recorded `task_transfer_owner` handover from the owner, or a takeover once the owner is gone, archived, or context-exhausted; otherwise recovery SHALL use the owner or the human.

#### Scenario: Coordinator lost
- **WHEN** the Change Lead becomes unavailable
- **THEN** participants report the blocked coordination to the Team Lead and avoid duplicate dispatch while recovery is recorded

#### Scenario: Coordinator replaced
- **WHEN** a replacement session is named
- **THEN** affected direction is updated by an authorized owner or the human and participants acknowledge it before following the new coordinator

#### Scenario: Replacement takes over a departed coordinator's tasks
- **WHEN** the original Change Lead is archived and a replacement of its group calls `task_transfer_owner` for its tasks
- **THEN** the replacement owns them, each task's journal records the takeover, and only then may it amend or close them

#### Scenario: No takeover from a live coordinator
- **WHEN** a replacement tries to amend a task whose owner is still live
- **THEN** the amendment is refused naming the owner

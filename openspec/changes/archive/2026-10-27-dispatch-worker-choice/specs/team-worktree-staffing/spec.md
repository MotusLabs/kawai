# Spec Delta

## ADDED Requirements

### Requirement: Spawns honor the worker choice
A spawn for group mail with a worker choice SHALL start on a chosen worker. The worker's cap, the group's `max`, the team spawn cap, and worktree occupancy SHALL apply unchanged. When no chosen worker has a free slot, the message SHALL wait rather than spawn on another worker.

#### Scenario: Spawn on the chosen provider
- **WHEN** worktree task mail chose provider `claude` and no member can take it
- **THEN** the spawned member starts on a `claude` worker of the group

#### Scenario: Chosen worker at its cap
- **WHEN** the only chosen worker is at its cap while another worker has room
- **THEN** no member is spawned on the other worker, and the message waits

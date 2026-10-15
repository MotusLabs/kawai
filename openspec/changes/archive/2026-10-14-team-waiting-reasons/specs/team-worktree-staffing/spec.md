# Spec Delta

## MODIFIED Requirements

### Requirement: Spawning is bounded
The system SHALL NOT spawn when the group already has `max` live members (default 1 unless the group's profile settings derive another), when the team already has its maximum live spawned sessions, or when the worktree — identified by the same worktree-root resolution as delivery — already has a live spawned member of any group that is not archived. A message that cannot spawn SHALL wait and be re-evaluated when a member becomes idle or a slot frees. A spawn that fails SHALL enter a per-message failure backoff, and the message SHALL be re-evaluated when that backoff ends, without requiring an unrelated change to trigger it; the backoff's end SHALL be exposed as the retry time waiting reasons report.

#### Scenario: Group cap
- **WHEN** `devs` has `max: 2` and two live members, both busy in other worktrees
- **THEN** no session is spawned and the message waits

#### Scenario: One spawned writer per worktree
- **WHEN** a spawned `devs` member already runs in `feat-x` and is busy
- **THEN** a second task message for `feat-x` waits for it instead of spawning another

#### Scenario: A failed spawn retries on its own
- **WHEN** a spawn fails, its message is queued again under a 30-second backoff, and nothing else changes in the team
- **THEN** the spawn is retried when the backoff ends, and the waiting reason's retry time is the moment the retry runs

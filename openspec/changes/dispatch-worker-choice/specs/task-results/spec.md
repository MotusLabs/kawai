# Spec Delta

## ADDED Requirements

### Requirement: Handoffs can name a worker
`task_handoff` and the human's handoff actions SHALL accept an optional `worker`, with the same meaning and validation as on group mail. The handoff's instruction mail SHALL carry the choice. The choice SHALL be part of the handoff's request-key payload identity and of the standing-equivalent check, so a retry with a different worker is a different handoff.

#### Scenario: Review on another provider
- **WHEN** the lead requests review from `reviewers` with `worker: "claude"`
- **THEN** the review instruction can be taken only by a `reviewers` worker from provider `claude`

#### Scenario: Same key, different worker
- **WHEN** a handoff is replayed with the same request key but a different worker
- **THEN** it is refused naming `worker` as the differing field

#### Scenario: Worker on a session target
- **WHEN** a handoff targets a session and names a worker
- **THEN** it is refused stating that a worker choice applies only to group targets

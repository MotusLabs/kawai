# Spec Delta

## ADDED Requirements

### Requirement: Flagged sessions are not route candidates
A context-exhausted session SHALL NOT be a candidate for group mail, however long it has been idle. It SHALL still count as a live member toward its group's and worker's caps until it is archived or killed. While a flagged member is excluded, the waiting reason of mail held by caps SHALL name it.

#### Scenario: Longest-idle but flagged
- **WHEN** the longest-idle member of `middle-devs` is flagged and another member is idle
- **THEN** group mail goes to the other member

#### Scenario: Flagged member holds the cap
- **WHEN** a group with `max: 1` has only a flagged human-created member
- **THEN** group mail waits, and its reason names the flagged member

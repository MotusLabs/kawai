# Spec Delta

## Purpose

Explains why team mail is not moving, from the same dispatch, staffing, and routing state that makes delivery decisions, so waiting work is never opaque and never silently disappears.

## ADDED Requirements

### Requirement: Every waiting message carries a computed reason
For each message waiting in the queued-and-due, awaiting-request, or starting-agent state, the system SHALL compute a waiting reason from authoritative dispatch, staffing, and routing state. The reason SHALL identify one immediate blocker and MAY list other constraints that also apply; each constraint SHALL carry its counts and the names of the sessions it implicates where applicable. Reasons SHALL NOT be inferred from navigator badges or from session status alone.

#### Scenario: Group capacity is the blocker
- **WHEN** a group message waits because the group already has its maximum live members, 2 of 2
- **THEN** its waiting reason states the group capacity as the blocker with the count 2 of 2

#### Scenario: Team spawn capacity is the blocker
- **WHEN** a worktree task message waits because the team already has its maximum live spawned members, 5 of 5
- **THEN** its waiting reason states the team spawn capacity as the blocker with the count 5 of 5

#### Scenario: Worktree occupied is the blocker with a name
- **WHEN** a worktree task message waits because the target worktree already has a live spawned member
- **THEN** its waiting reason names that member and the worktree instead of reporting every session as merely busy

#### Scenario: Recipient of direct mail is busy
- **WHEN** normal direct mail waits for a recipient that is working
- **THEN** its waiting reason states that the recipient is working and normal mail will arrive when it is idle

#### Scenario: Multiple constraints with an immediate blocker
- **WHEN** a message is blocked by a group cap while every member is also busy
- **THEN** the reason shows the cap as the immediate blocker and lists member busyness among the other constraints

### Requirement: Waiting reasons are re-evaluated when capacity or availability changes
The system SHALL recompute waiting reasons on every dispatch pass and whenever a session's status, availability, worktree, pending request, profile cooldown, routing rule, or mailbox state changes, and SHALL republish a team's waiting reasons when they change. Waiting reasons SHALL be held in memory only: after a restart they are absent until the first pass rebuilds them, with no persisted state and no new sequenced chat events.

#### Scenario: Freeing the slot updates the reason and delivers once
- **WHEN** a message waits on a group cap of 2 of 2 and one member is archived
- **THEN** the waiting reason updates on the next evaluation and exactly one agent receives the message

#### Scenario: Reasons survive nothing across restart
- **WHEN** the server restarts with messages waiting
- **THEN** their reasons are rebuilt by the first dispatch pass rather than restored from storage

### Requirement: A starting agent is reported with its reservation's facts
While a message is reserved for an agent being spawned, its waiting reason SHALL identify it as starting an agent and SHALL show the group, profile, and worktree of the reservation and how long the start has been running.

#### Scenario: Starting agent detail
- **WHEN** a worktree task message is reserved for a `devs` member being spawned on the default profile in worktree `feat-x`
- **THEN** its waiting reason shows Starting agent with the `devs` group, the profile, `feat-x`, and the elapsed start time

### Requirement: Worktree occupancy is one read model
The system SHALL expose, per team, the live non-archived sessions grouped by their resolved worktree root, each with group, profile, status, spawned identity, and associated task where present, together with pending spawn reservations and their groups and profiles. Delivery-blocking occupancy SHALL count only spawned sessions and pending reservations. The model SHALL be carried on the team mailbox snapshot and SHALL be the same facts the waiting reasons and staffing decisions use.

#### Scenario: Manual session listed but not occupying
- **WHEN** a manually created session and no spawned member run in worktree `feat-x`
- **THEN** the occupancy model lists the manual session and reports the worktree free for spawning

#### Scenario: Occupant is named
- **WHEN** a spawned `devs` member runs in worktree `feat-x`, busy on another message
- **THEN** the occupancy model names it there, and a waiting message for `feat-x` reports the worktree as occupied by that member

#### Scenario: Pending reservation counts
- **WHEN** a spawn reservation is pending for worktree `feat-x`
- **THEN** the occupancy model lists the reservation with its group and profile, and the worktree counts as occupied

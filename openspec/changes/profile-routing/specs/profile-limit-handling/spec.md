# Spec Delta

## Purpose

Keeps team work moving when a provider profile hits its limit: limit events are recorded per profile, profiles cool down, and interrupted work is parked, released, or handed off.

## ADDED Requirements

### Requirement: Limit events are recorded per profile
The system SHALL record a limit event when a chat agent's request fails with a rate-limit, billing, or overload error, marking whether it was a retried attempt or the final failure, with the profile, session, group, time, HTTP status, error message, and provider reset time when given. Limit events SHALL persist across restart for at least 24 hours.

#### Scenario: Final rate-limit failure
- **WHEN** a `glm` agent's turn ends with a rate-limit error after retries
- **THEN** a final limit event for `glm` is recorded

#### Scenario: Survives restart
- **WHEN** the server restarts 10 minutes after a final limit event
- **THEN** routing still sees the event

### Requirement: Profiles cool down after a final limit event
A profile SHALL be in cooldown after a final limit event until the provider's reset time when known, otherwise for one hour, unless a routing rule decides otherwise. Cooldown SHALL apply to the profile in every group of every team and SHALL NOT apply to other profiles in the same group. Retried attempts alone SHALL NOT start a cooldown.

#### Scenario: Only the limited profile cools
- **WHEN** `glm` has a final limit event and `devs` has idle members on `glm` and `claude`
- **THEN** group mail goes to the `claude` member

#### Scenario: Transient retry
- **WHEN** a request is retried after a 429 and then succeeds
- **THEN** no cooldown starts

### Requirement: Limit failures on claimed messages are resolved
When the turn handling a delivered message fails with a final limit event, the system SHALL resolve the message as park, release, or forward. A routing rule's `onLimit` SHALL decide when present; otherwise the group's `onLimit` frontmatter. The default SHALL be park when the agent made progress and the reset is within `parkIfResetWithin` (default 3h), forward to the same group when it made progress and the reset is later, and release otherwise.

#### Scenario: Close reset parks
- **WHEN** an agent that already ran tool calls for a message hits a limit that resets in 40 minutes
- **THEN** the message is parked on that agent

#### Scenario: Far reset forwards
- **WHEN** an agent that made progress hits a limit resetting in 5 hours
- **THEN** the message is forwarded to its group with a handoff package

#### Scenario: No progress releases
- **WHEN** an agent hits a limit before any tool call for the message
- **THEN** the message returns to its group's queue

### Requirement: Parked work resumes on the same agent
Parking SHALL keep the message with the agent and schedule a resume message to that agent at the reset time. A parked agent SHALL receive no group mail and SHALL be shown as paused with the reason and resume time. If the resume fails on a limit again, the message SHALL be resolved again; after 3 parks it SHALL be released.

#### Scenario: Resume after reset
- **WHEN** the parked agent's resume time arrives
- **THEN** it receives a message to continue the task

#### Scenario: Parked agent skipped
- **WHEN** a group message arrives while a member is parked
- **THEN** the parked member does not receive it

#### Scenario: Human message to parked agent
- **WHEN** the user sends a message to a parked agent and the turn succeeds
- **THEN** the scheduled resume is cancelled and the agent is no longer paused

### Requirement: Forwarded work carries a handoff package
A forwarded message SHALL include the task context, the message thread, a progress digest of the previous agent's tool calls and touched files since claim, its last error, the repository commit at claim time, and an instruction to inspect the working directory to reconstruct progress before acting. Forwarding SHALL exclude the limited profile from routing.

#### Scenario: Handoff received
- **WHEN** a message is forwarded from a `glm` dev to the `devs` group
- **THEN** a non-`glm` member receives it with the progress digest, claim commit, and the instruction to inspect the working directory first

### Requirement: The original agent is released and notified
After forwarding, the original agent SHALL no longer hold the message. When its profile leaves cooldown, it SHALL receive a note naming the task and the agent that took it over.

#### Scenario: Notified on recovery
- **WHEN** the forwarding agent's profile leaves cooldown
- **THEN** it receives a note that the task was handed to the new agent

### Requirement: Users can hand off parked work
The UI SHALL offer a Hand off action on a parked message that forwards it, with a handoff package, to a group or agent the user chooses, regardless of the rule's decision.

#### Scenario: Manual handoff
- **WHEN** the user hands off a parked message to `architects`
- **THEN** the message is forwarded with a handoff package and the parked agent's resume is cancelled

### Requirement: Urgent direct mail to a cooling profile is refused
An urgent message sent directly to an agent whose profile is in cooldown SHALL be refused with an error to the sender stating the agent's profile and the cooldown end time.

#### Scenario: Refused urgent mail
- **WHEN** a team lead sends urgent mail directly to a dev whose `glm` profile cools until 15:40
- **THEN** the send fails with a message naming `glm` and 15:40, and nothing is queued

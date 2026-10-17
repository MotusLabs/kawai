# profile-limit-handling Specification

## Purpose
Keeps team work moving when a provider profile hits its limit: limit events are recorded per profile, profiles cool down, and interrupted work is parked, released, or handed off.

## Requirements

### Requirement: Limit events are recorded per profile
The system SHALL record a limit event when a chat agent's request fails with a rate-limit, billing, or overload error, marking whether it was a retried attempt or the final failure, with the profile, session, group, time, HTTP status, error message, and provider reset time when given, read from error text in the profile's `limitResetTimeZone` when it has no zone. Limit events SHALL persist across restart for at least 24 hours.

#### Scenario: Final rate-limit failure
- **WHEN** a `glm` agent's turn ends with a rate-limit error after retries
- **THEN** a final limit event for `glm` is recorded

#### Scenario: Reset written in the error text
- **WHEN** a `glm` agent's final error says its limit resets at `2026-10-13 17:17:00` and the `glm` profile sets `limitResetTimeZone: Asia/Shanghai`
- **THEN** the event's reset time is 09:17 UTC that day; without the field the text sets no reset time

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

### Requirement: Group frontmatter configures limit outcomes
A group's frontmatter SHALL accept an `onLimit` map with `parkIfResetWithin` (a duration such as `90m` or `3h`), `otherwise` (`forward` or `release`, default `forward`) applied when the agent made progress and the reset is later, and `forwardTo` (a group id or team session id, default the same group). Invalid values SHALL be reported and the defaults used.

#### Scenario: Release instead of forward
- **WHEN** `devs` sets `onLimit: { parkIfResetWithin: 1h, otherwise: release }` and a member with progress hits a limit resetting in 2 hours
- **THEN** the message returns to the `devs` queue without a handoff package

#### Scenario: Forward to another group
- **WHEN** `devs` sets `onLimit: { forwardTo: architects }` and a member with progress hits a limit resetting in 5 hours
- **THEN** the message is forwarded to `architects` with a handoff package

#### Scenario: Invalid duration
- **WHEN** `parkIfResetWithin` is set to `soon`
- **THEN** the problem is reported and 3h is used

### Requirement: Parked work resumes on the same agent
Parking SHALL keep the message with the agent and schedule a resume message to that agent at the reset time, delivered before other direct mail. A parked agent SHALL receive no group mail and SHALL be shown as paused with the reason and resume time. If the resume fails on a limit again, the message SHALL be resolved again; after 3 parks it SHALL be released.

#### Scenario: Resume after reset
- **WHEN** the parked agent's resume time arrives
- **THEN** it receives a message to continue the task

#### Scenario: Resume goes before other direct mail
- **WHEN** the resume time arrives while other normal direct mail waits for the parked agent
- **THEN** the agent receives the resume first, and the other mail after it

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

### Requirement: Limits in agent-started turns park the current work
When a turn the agent started itself (a task notification, a Monitor, or resumed) ends after a final limit event, the system SHALL park the session's current work on that agent with a resume at the reset, whatever the policy, progress, or result subtype. Current work SHALL be the newest message delivered to, parked on, or resumed by the session that it still holds. It SHALL never be released or forwarded; with no current work nothing SHALL be resolved.

#### Scenario: Monitor turn after delivered work
- **WHEN** an agent that was delivered a message later starts a turn from a Monitor event and that turn ends after a final limit resetting in 2 hours
- **THEN** the message is parked on that agent and its resume is scheduled at the reset

#### Scenario: Far reset still parks
- **WHEN** the same happens with a reset 5 hours away and the group sets `otherwise: forward`
- **THEN** the message is parked on that agent, not forwarded

#### Scenario: No current work
- **WHEN** an agent that holds no delivered or parked message hits a final limit in a turn it started itself
- **THEN** no message is parked, released, or forwarded

#### Scenario: Human turn
- **WHEN** a human turn with no delivered message ends after a final limit
- **THEN** no message is parked, released, or forwarded, as before

### Requirement: Agent-started limits respect parked work and the park limit
When the current work is already parked, an agent-started final limit SHALL keep it parked with its resume at the later reset and its park count unchanged. Work parked 3 times SHALL be left as it is, neither parked again nor released. A successful agent-started turn SHALL NOT unpark work; only a human turn or the work's own resume SHALL.

#### Scenario: Already parked
- **WHEN** a parked agent's Monitor turn ends after a final limit resetting later than the scheduled resume
- **THEN** the work stays parked, its resume moves to the later reset, and its park count is unchanged

#### Scenario: Park limit reached
- **WHEN** an agent-started turn ends after a final limit while its current work has been parked 3 times
- **THEN** the work stays delivered to that agent and is not released

#### Scenario: Successful resume unparks
- **WHEN** work parked by an agent-started limit receives its resume and that turn succeeds
- **THEN** the work is no longer parked and the agent is no longer paused

#### Scenario: Successful agent-started turn
- **WHEN** a parked agent's background-task turn succeeds
- **THEN** the work stays parked and its resume is still delivered at the reset

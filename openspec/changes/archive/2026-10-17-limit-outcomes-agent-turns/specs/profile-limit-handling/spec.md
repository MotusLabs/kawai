## ADDED Requirements

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

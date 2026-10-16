## MODIFIED Requirements

### Requirement: Limit events are recorded per profile
The system SHALL record a limit event when a chat agent's request fails with a rate-limit, billing, or overload error, marking whether it was a retried attempt or the final failure, with the profile, its provider, session, group, time, HTTP status, error message, the limit window when named, and provider reset time when given, read from error text in the provider's `limitResetTimeZone` when it has no zone. Limit events SHALL persist across restart for at least 24 hours.

#### Scenario: Final rate-limit failure
- **WHEN** an agent on profile `glm` of provider `zai` ends its turn with a rate-limit error after retries
- **THEN** a final limit event naming `glm` and `zai` is recorded

#### Scenario: Reset written in the error text
- **WHEN** a `glm` agent's final error says its limit resets at `2026-10-13 17:17:00` and the provider of `glm` sets `limitResetTimeZone: Asia/Shanghai`
- **THEN** the event's reset time is 09:17 UTC that day; without the field the text sets no reset time

#### Scenario: Window recorded
- **WHEN** an agent on profile `opus` receives a rejected rate-limit report for the `seven_day_opus` window and its turn then ends with a rate-limit error
- **THEN** the final limit event records window `seven_day_opus` with that report's reset time

#### Scenario: Survives restart
- **WHEN** the server restarts 10 minutes after a final limit event
- **THEN** routing still sees the event

### Requirement: Profiles cool down after a final limit event
After a final limit event, its provider SHALL be in cooldown until the provider's reset time when known, otherwise for one hour, unless a routing rule decides otherwise; an event whose window covers one model only SHALL instead cool its own profile alone. A profile SHALL be cooling while its provider or the profile itself is, in every group of every team. Profiles of other providers SHALL NOT cool. Retried attempts alone SHALL NOT start a cooldown.

#### Scenario: Only the limited profile cools
- **WHEN** `glm` of provider `zai` has a final limit event and `devs` has idle members on `glm` and on `claude` of another provider
- **THEN** group mail goes to the `claude` member

#### Scenario: Profiles of one provider cool together
- **WHEN** `glm` and `glm-flash` are profiles of provider `zai`, `glm` has a final limit event, and `juniors` allows `glm-flash` and `haiku` of another provider
- **THEN** `glm-flash` is cooling until the same time, so `juniors` group mail goes to a `haiku` member and no `glm-flash` member is spawned for it

#### Scenario: A model-scoped window cools one profile
- **WHEN** `opus` and `sonnet` are profiles of provider `claude` with idle members, and an `opus` agent's final limit event names window `seven_day_opus`
- **THEN** only `opus` cools, and group mail goes to the `sonnet` member

#### Scenario: A short later window does not release a weekly one
- **WHEN** `opus` and `sonnet` are profiles of provider `claude`, `opus` has a final limit event for window `seven_day` that resets in three days, and `sonnet` later has one for window `five_hour` that resets in two hours
- **THEN** both stay cooling until the `seven_day` reset

#### Scenario: Events recorded before providers
- **WHEN** a final limit event recorded without a provider is still within its cooldown
- **THEN** only the profile that recorded it is cooling

#### Scenario: Transient retry
- **WHEN** a request is retried after a 429 and then succeeds
- **THEN** no cooldown starts

### Requirement: Forwarded work carries a handoff package
A forwarded message SHALL include the task context, the message thread, a progress digest of the previous agent's tool calls and touched files since claim, its last error, the repository commit at claim time, and an instruction to inspect the working directory to reconstruct progress before acting. Forwarding SHALL exclude from routing the limited profile, and the other profiles of its provider while that provider cools.

#### Scenario: Handoff received
- **WHEN** a message is forwarded from a `glm` dev to the `devs` group while `glm` and `glm-flash` of provider `zai` cool
- **THEN** a member on another provider receives it with the progress digest, claim commit, and the instruction to inspect the working directory first, and no `glm-flash` member does

### Requirement: Urgent direct mail to a cooling profile is refused
An urgent message sent directly to an agent whose profile is in cooldown SHALL be refused with an error to the sender stating the agent's profile, its provider when the provider is in cooldown, and the cooldown end time.

#### Scenario: Refused urgent mail
- **WHEN** a team lead sends urgent mail directly to a dev whose `glm` profile cools until 15:40
- **THEN** the send fails with a message naming `glm` and 15:40, and nothing is queued

#### Scenario: Refused for a cooling provider
- **WHEN** a team lead sends urgent mail directly to a dev on `glm-flash` while its provider `zai` cools until 15:40 after a `glm` limit
- **THEN** the send fails with a message naming `glm-flash`, `zai`, and 15:40, and nothing is queued

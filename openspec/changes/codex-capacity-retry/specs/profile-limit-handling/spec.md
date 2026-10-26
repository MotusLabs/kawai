# Spec Delta

## MODIFIED Requirements

### Requirement: Limit events are recorded per profile
The system SHALL record a limit event when a chat agent's request fails with a rate-limit, billing, or overload error other than Codex `serverOverloaded`, marking whether it was a retried attempt or the final failure, with the profile, its provider, session, group, time, HTTP status, error message, the limit window when named, and provider reset time when given, read from error text in the provider's `limitResetTimeZone` when it has no zone. Limit events SHALL persist across restart for at least 24 hours.

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

#### Scenario: Codex model capacity
- **WHEN** a Codex attempt reports `serverOverloaded`, whether retrying or terminal
- **THEN** no quota limit event is recorded for that error

### Requirement: Codex limit failures are recorded as limit events
A Codex turn failing on a usage, rate, spend, or credit limit SHALL record a final limit event. Its reset SHALL be the latest known reset among applicable exhausted windows; cooldown and parked-work resume SHALL use that reset. Non-exhausted windows SHALL NOT extend it. Codex quota retries SHALL record non-final events only. `serverOverloaded` SHALL use capacity recovery instead of quota handling. Other failures SHALL NOT record limit events.

#### Scenario: Usage limit ends the turn
- **WHEN** a Codex member's turn fails because its plan's usage limit was reached and the weekly window resets in 2 days
- **THEN** a final limit event is recorded with that reset time, and the message it was handling is resolved as park, release, or forward

#### Scenario: Multiple exhausted windows
- **WHEN** a Codex turn fails with both the five-hour and weekly windows exhausted, resetting in 1 hour and 2 days respectively
- **THEN** the final limit event and shared-home cooldown use the 2-day reset, and if the work is parked its resume is scheduled for that reset rather than the five-hour reset

#### Scenario: Only one exhausted window
- **WHEN** a Codex turn fails with the five-hour window exhausted and resetting in 1 hour, while the weekly window is below its limit and resets in 2 days
- **THEN** the final limit event and cooldown use the 1-hour reset

#### Scenario: Unrelated failure
- **WHEN** a Codex turn fails because the context window was exceeded
- **THEN** no limit event is recorded

#### Scenario: Exhausted capacity recovery
- **WHEN** capacity retries end after their bounded window
- **THEN** the chat shows its terminal capacity error without recording a final quota limit event or triggering a quota cooldown, park, release, or forward

## ADDED Requirements

### Requirement: Codex model capacity does not cool a shared login
Codex `serverOverloaded` SHALL NOT create or extend profile or shared-home quota cooldowns, use quota reset timestamps, or trigger quota-driven mailbox outcomes. This SHALL apply to internal retries, automatic recovery attempts, and exhausted capacity recovery. Actual quota failures and cooldowns recorded independently of capacity SHALL retain their existing behavior.

#### Scenario: Sibling profile remains eligible
- **WHEN** one Codex profile hits model capacity while another profile uses the same Codex home with no independent quota cooldown
- **THEN** capacity alone does not make the sibling profile ineligible for mail

#### Scenario: Exhausted quota snapshot alongside capacity
- **WHEN** a capacity error arrives with a cached exhausted weekly quota window
- **THEN** the capacity recovery still uses its ten-minute retry window and does not create a weekly cooldown from that error

#### Scenario: Real quota after capacity
- **WHEN** a capacity retry subsequently fails with `usageLimitExceeded`
- **THEN** capacity recovery ends and the actual quota failure follows the existing shared-home cooldown and mailbox resolution rules

#### Scenario: Independent cooldown remains
- **WHEN** a shared home already has an unexpired quota cooldown and a session reports capacity pressure
- **THEN** capacity handling neither clears nor extends that existing cooldown

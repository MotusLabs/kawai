## ADDED Requirements

### Requirement: A payment-required failure is a final credit limit
A chat agent request that fails with HTTP status 402, whether the status comes from the error class or from the error text the agent shows (`API Error: 402 …`), SHALL be recorded as a final limit event for the session's profile and provider in the `credit` window, with no reset time, whatever error class the agent reports.

#### Scenario: OpenRouter balance cannot cover the request
- **WHEN** an `openrouter-opus` turn ends with an assistant error `unknown` whose text starts `API Error: 402 This request requires more credits`
- **THEN** one final limit event is recorded for `openrouter-opus` and provider `openrouter`, window `credit`, with no reset

#### Scenario: 402 under another error class
- **WHEN** any provider's request fails with `billing_error` and status 402
- **THEN** it is recorded as a final `credit` limit event

### Requirement: A credit cooldown is bounded and ends early when credit returns
A final `credit` event SHALL cool its provider for one hour after the event. The cooldown SHALL end earlier once a usage pull completed after the event reports remaining credit greater than the lowest remaining credit reported for that provider since the event, or greater than zero when none was reported. After a restart, only the one-hour bound SHALL apply.

#### Scenario: Owner tops up
- **WHEN** a pull after a credit event reports $0.01 remaining and a later pull reports $10.01
- **THEN** the provider leaves cooldown at that later pull

#### Scenario: No balance source
- **WHEN** a credit event is recorded for a provider with no usage pull
- **THEN** the provider cools for one hour after the event

#### Scenario: Restart during a credit cooldown
- **WHEN** the server restarts 20 minutes after a credit event
- **THEN** the provider stays cooling until one hour after the event, unless a pull shows credit has grown

### Requirement: Credit limits never park work
When the turn handling a delivered message ends after a final `credit` limit, the message SHALL be resolved as if no reset falls within any `parkIfResetWithin`: it SHALL follow the effective `otherwise` outcome (forward or release) and SHALL NOT be parked. Waiting reasons and the urgent-mail refusal for a provider cooling on credit SHALL say it is out of credit rather than naming a reset time.

#### Scenario: Group parks short resets
- **WHEN** a group's `onLimit` is `{ parkIfResetWithin: 3h, otherwise: forward }` and its member's message ends on a credit limit
- **THEN** the message is forwarded with a handoff package to a candidate outside the cooling provider, and nothing is parked

#### Scenario: Urgent mail to a member out of credit
- **WHEN** the human sends urgent direct mail to an agent whose provider cools on credit
- **THEN** the send is refused with a message saying the provider is out of credit and when the cooldown ends at the latest

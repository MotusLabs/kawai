## ADDED Requirements

### Requirement: A payment-required failure is a final credit limit
A chat agent request that fails with HTTP status 402, whether the status comes from the error class or from the error text the agent shows (`API Error: 402 …`), SHALL be recorded as a final limit event for the session's profile and provider in the `credit` window, with no reset time, whatever error class the agent reports. This rule SHALL apply only to Claude Code sessions; a Codex session's failures, a 402 included, SHALL NOT be recorded by it.

#### Scenario: OpenRouter balance cannot cover the request
- **WHEN** an `openrouter-opus` turn ends with an assistant error `unknown` whose text starts `API Error: 402 This request requires more credits`
- **THEN** one final limit event is recorded for `openrouter-opus` and provider `openrouter`, window `credit`, with no reset

#### Scenario: 402 under another error class
- **WHEN** a Claude Code session's request to any provider fails with `billing_error` and status 402
- **THEN** it is recorded as a final `credit` limit event

#### Scenario: A Codex session's 402 is not a credit limit here
- **WHEN** a Codex session's turn fails with HTTP 402
- **THEN** this rule records no `credit` limit event for it

### Requirement: A credit cooldown is bounded and ends early when credit returns
A final `credit` event has no reset when recorded, so its provider cools for one hour after it. The first usage pull completed after the event SHALL only set a baseline. A later pull reporting more remaining credit than the lowest any earlier post-event pull reported SHALL make its own time the event's known reset, held in memory only. Tracking SHALL start when this process records the event: an event recorded before a restart SHALL end only at its one-hour bound.

#### Scenario: Owner tops up
- **WHEN** a pull after a credit event reports $0.01 remaining and a later pull reports $10.01
- **THEN** the provider leaves cooldown at that later pull

#### Scenario: The first pull only sets the baseline
- **WHEN** the owner tops up before the first pull after a credit event, and that pull reports $10.01
- **THEN** the provider keeps cooling until a later pull reports more than $10.01 or one hour after the event passes

#### Scenario: No balance source
- **WHEN** a credit event is recorded for a provider with no usage pull
- **THEN** the provider cools for one hour after the event

#### Scenario: Restart during a credit cooldown
- **WHEN** the server restarts 20 minutes after a credit event
- **THEN** the provider stays cooling until one hour after the event, whatever later pulls report

### Requirement: Credit limits never park work
When the turn handling a delivered message in a Claude Code session ends after a final `credit` limit, the message SHALL be resolved as if no reset falls within any `parkIfResetWithin`: it SHALL follow the effective `otherwise` outcome (forward or release) and SHALL NOT be parked. Waiting reasons and the urgent-mail refusal for a provider cooling on credit SHALL say it is out of credit and give the cooldown's latest end, rather than a reset time.

#### Scenario: Group parks short resets
- **WHEN** a group's `onLimit` is `{ parkIfResetWithin: 3h, otherwise: forward }` and its `openrouter-sonnet` member's message ends on a credit limit
- **THEN** the message is forwarded with a handoff package to a candidate outside the cooling provider, and nothing is parked

#### Scenario: Urgent mail to a member out of credit
- **WHEN** the human sends urgent direct mail to an agent whose provider cools on credit
- **THEN** the send is refused with a message saying the provider is out of credit and when the cooldown ends at the latest

## ADDED Requirements

### Requirement: A turn's cost is the provider-reported charge when streamed
When the provider reports a per-message charge in a turn's streamed message usage, the completed turn SHALL carry the sum of those charges, and the transcript's completion summary SHALL show that amount as the turn's cost in place of the agent's own estimate, identified as the provider-reported charge, noting that unstreamed side calls are not included. A turn without a reported charge SHALL keep showing the agent's estimate, which SHALL remain on every completed turn.

#### Scenario: OpenRouter turn
- **WHEN** a live `openrouter-haiku` turn streams a message usage cost of $0.001064 and the agent's result estimates $0.0426
- **THEN** the completion summary shows the $0.001064 charge, marked as provider-reported, instead of the $0.0426 estimate

#### Scenario: Provider without reported cost
- **WHEN** a GLM turn completes with no streamed cost
- **THEN** the completion summary shows the agent's estimate as before

#### Scenario: Older client
- **WHEN** a client that does not know the provider-reported field receives the completed turn
- **THEN** it shows the agent's estimate, and the turn is otherwise unaffected

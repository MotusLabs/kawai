# Spec Delta

## ADDED Requirements

### Requirement: A worker choice filters route candidates
For group mail with a worker choice, route candidates SHALL include only the members and spawn slots on a chosen worker. Every other filter and cap still applies. When the message also carries a role's allowed profiles, candidates SHALL be limited to the intersection, in the role's order. The filter SHALL apply before any routing rule runs, so neither a rule nor the built-in fallback can pick a candidate outside the choice.

#### Scenario: Members on other workers are skipped
- **WHEN** an idle `glm-flash` member and an idle `sonnet` member are eligible, and the message chose provider `claude`
- **THEN** only the `sonnet` member is a candidate

#### Scenario: Choice within a role's profiles
- **WHEN** a message's role allows `opus` and `glm`, and the message chose provider `zai`, which owns `glm` and `glm-flash`
- **THEN** only `glm` members and `glm` spawn slots are candidates, and a member on `opus` reports the worker choice as its exclusion

#### Scenario: Rule pick outside the choice
- **WHEN** a rule names a candidate that the worker choice filtered out
- **THEN** the pick is treated as unknown, and the built-in strategy picks among the filtered candidates

### Requirement: Rules see the worker choice
The route context and limit-outcome context given to routing rules SHALL include the message's worker choice as an additive metadata field, absent when the message has none.

#### Scenario: Rule reads the choice
- **WHEN** a message with `worker: "claude"` is routed through a group rule
- **THEN** the rule's context shows the choice beside the message's other metadata

### Requirement: A cooling chosen worker holds the message
When every candidate the worker choice allows is on a cooling provider, the message SHALL wait, neither refused nor routed elsewhere. It SHALL be routed again once the cooldown ends or the candidates change.

#### Scenario: Chosen provider is cooling
- **WHEN** a message chose provider `zai`, which cools until 18:00Z
- **THEN** the message stays queued and is routed again at 18:00Z

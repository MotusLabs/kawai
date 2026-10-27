# Spec Delta

## ADDED Requirements

### Requirement: The attention queue lists process degradation
While a degradation rule fires for the team, the attention queue SHALL list one human-required `process-degradation` item for it. The item SHALL have:
- identity `process-degradation:<rule id>`;
- a cause naming the rule and its current and baseline values;
- impact "team delivery";
- next action Open metrics;
- a link that opens the Metrics tab on the 7d window.

The item SHALL disappear once the rule stops firing. Stale delivery facts SHALL raise no degradation item.

#### Scenario: Delivery drop raises one item
- **WHEN** the delivery-drop rule fires
- **THEN** the queue lists one human-required item naming changes landed 6 against 40 and the token totals, whose action opens the Metrics tab on 7d

#### Scenario: Recovery clears the item
- **WHEN** the next read finds the rule no longer holds
- **THEN** the item leaves the queue and the counts drop by one

#### Scenario: One toast while it holds
- **WHEN** the rule keeps firing across many workspace pushes and a reconnect
- **THEN** the client raises at most one toast for that item identity in its session

#### Scenario: Stale facts raise nothing
- **WHEN** the repository was last fetched 30 hours ago
- **THEN** no `process-degradation` item is listed, and the Metrics tab shows the stale marker

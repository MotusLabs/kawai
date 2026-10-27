# Spec Delta

## ADDED Requirements

### Requirement: The attention queue lists process degradation
While a degradation rule fires over current delivery facts, the attention queue SHALL list one human-required item with identity `process-degradation:<rule id>`, a cause naming the rule and its current and baseline values, impact "team delivery", next action Open metrics, and a link to the Metrics tab's 7d window. The item SHALL follow changed values while the rule holds, and SHALL disappear once it stops firing or the delivery state projected at the snapshot is not current.

#### Scenario: Delivery drop raises one item
- **WHEN** the delivery-drop rule fires
- **THEN** the queue lists one human-required item naming changes landed 6 against 40 and the token totals, whose action opens the Metrics tab on 7d

#### Scenario: Recovery clears the item
- **WHEN** the next read finds the rule no longer holds
- **THEN** the item leaves the queue and the counts drop by one

#### Scenario: New values while it holds
- **WHEN** the rule keeps firing and its current values change
- **THEN** the item's cause shows the new values under the same identity

#### Scenario: One toast while it holds
- **WHEN** the rule keeps firing across many workspace pushes and a reconnect
- **THEN** the client raises at most one toast for that item identity in its session

#### Scenario: Stale facts raise nothing
- **WHEN** the repository was last fetched 30 hours ago
- **THEN** no `process-degradation` item is listed, and the Metrics tab shows the stale marker

#### Scenario: Facts go stale while it holds
- **WHEN** the rule is firing and the last fetch becomes older than 24 hours with no other change
- **THEN** the item leaves the queue at that time without waiting for another event

#### Scenario: Refresh fails while it holds
- **WHEN** the rule is firing and the newest read of the head the ref names fails
- **THEN** the item leaves the queue at the next snapshot

#### Scenario: Ref moves while it holds
- **WHEN** the rule is firing and the ref moves to a head whose facts are not yet read
- **THEN** the next snapshot lists no item, without waiting for an evaluation

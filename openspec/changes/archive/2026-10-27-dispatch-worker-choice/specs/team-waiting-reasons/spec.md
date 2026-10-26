# Spec Delta

## ADDED Requirements

### Requirement: Waiting reasons name the worker choice
Group mail held by its worker choice SHALL say so in its waiting reason, naming the chosen worker. When the hold is a cooldown, the reason SHALL give the cooldown end as its retry time. When it is a cap or occupancy, the reason SHALL give the existing capacity constraint for the chosen worker.

#### Scenario: Held by a cooling choice
- **WHEN** mail that chose provider `zai` waits because `zai` cools until 18:00Z
- **THEN** its reason names the choice `zai` and gives 18:00Z as the retry time

#### Scenario: Held by the chosen worker's cap
- **WHEN** mail waits because its chosen worker is at its cap
- **THEN** its reason names the chosen worker and its live-of-cap counts

## ADDED Requirements

### Requirement: Waiting reasons name the cross-model requirement
A review held because no candidate outside the authors' model families is eligible SHALL carry the `cross-model` waiting reason, naming the authors' families and any unknown author. When other-family workers exist but are busy, capped, or cooling, the reason SHALL also give those workers' existing capacity constraints. It SHALL be re-evaluated like every other reason.

#### Scenario: No other-family worker is configured
- **WHEN** a review of a `claude`-family result waits at a group whose only worker is `opus`
- **THEN** its reason is `cross-model`, names family `claude`, and says no worker of another family is configured

#### Scenario: The other-family worker is at its cap
- **WHEN** a review of an `opus`-authored result waits because the group's one `codex-sol` slot is taken
- **THEN** its reason is `cross-model`, names family `claude`, and gives `codex-sol` at 1 of 1

#### Scenario: The reason clears when a worker frees up
- **WHEN** the busy `codex-sol` reviewer goes idle
- **THEN** the review routes to it and its waiting reason is gone

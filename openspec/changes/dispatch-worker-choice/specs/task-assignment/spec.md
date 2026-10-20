# Spec Delta

## ADDED Requirements

### Requirement: Human dispatch can name a worker
**Create and assign** and **Assign / send task** SHALL offer an optional worker when the target is a group. The picker SHALL list the group's workers grouped by provider, each with its provider's usage and cooldown. The choice SHALL be stored on the assignment, carried by its instruction mail, and part of the request key's payload identity.

#### Scenario: Assign on a chosen provider
- **WHEN** the human assigns a task to `middle-devs` with worker `claude`
- **THEN** the assignment records the choice and its instruction can be taken only by a `claude` worker of the group

#### Scenario: Replay with a different worker
- **WHEN** a dispatch is resent with the same request key and a different worker
- **THEN** it is refused naming `worker` as the differing field

#### Scenario: Session target
- **WHEN** the target is a session
- **THEN** no worker picker is offered

### Requirement: The dispatch preview reflects the worker choice
The read-only dispatch preview SHALL state the chosen worker and its provider's cooldown. Its effective profile and staffing availability SHALL be computed with the choice applied. The preview SHALL warn, never block, when the chosen provider is cooling.

#### Scenario: Cooling choice in the preview
- **WHEN** the human previews a dispatch whose chosen provider is cooling
- **THEN** the preview warns that the instruction will wait until the cooldown end, and the dispatch stays allowed

# Spec Delta

## Purpose

Lets the plan's owner hold a whole plan or named changes while they reconsider its direction. A hold stops new work and every landing path for the held changes. It interrupts no turn and keeps every result. It ends only by the owner's explicit release, and its review deadline raises attention, never a release.

## ADDED Requirements

### Requirement: Only the owner places a hold
The human SHALL be able to place a hold on an open plan, scoped to the whole plan or to named changes, under a command id. The hold SHALL record a rationale, a review deadline in the future at most 30 days away, its creation time, and optionally a cited strategy impact review or decision card of the plan. A replay SHALL return the prior hold, and a different payload under the same id SHALL be refused naming the field. No agent tool SHALL place a hold.

#### Scenario: A hold on two changes
- **WHEN** the owner holds changes `api` and `ui` of an open plan with a rationale and a deadline in two days
- **THEN** the hold is recorded with its scope, rationale, deadline, and creation time, and a `hold-placed` plan event

#### Scenario: Unknown change names are refused
- **WHEN** the owner holds a change that is in neither the plan's approved revision nor its running execution
- **THEN** the command is refused naming the change, and no hold exists

#### Scenario: Agents cannot hold
- **WHEN** an agent looks for a tool to place, release, or extend a hold, or calls the service path directly
- **THEN** no such tool exists and the direct call is refused with nothing written

### Requirement: A held change gets no new work
While any active hold covers a change, Kawai SHALL NOT provision it, dispatch an attempt or handoff for it, or run a Retry's dispatch. A decision that would lead to a dispatch, such as a failed round, SHALL still be recorded, and its dispatch SHALL run once no hold covers the change. Placing a hold SHALL NOT interrupt any running turn or cancel delivered or claimed work.

#### Scenario: A failed round under a hold
- **WHEN** a held change's review fails
- **THEN** the round is recorded as failed and no fix attempt is dispatched until the hold is released, after which the fix attempt is dispatched once

#### Scenario: A running turn continues
- **WHEN** the owner holds a change whose developer is mid-turn
- **THEN** the turn continues and no mail interrupts it

### Requirement: A held change never lands or is promoted
While a change is held, Kawai SHALL NOT give it the landing slot, merge it, fast-forward an integration branch to its candidate, or run a promotion that includes it. A held change that holds the slot before its merge started SHALL give it up. A merge, fast-forward, or promotion merge already running SHALL settle. Promote SHALL be refused as `no-hold` while its plan is held or any change it carries is held.

#### Scenario: The slot is given up
- **WHEN** a change holds the landing slot waiting for its base update and the owner holds it
- **THEN** the change gives up the slot and keeps its round, and another team change may take the slot

#### Scenario: Promotion with a held change
- **WHEN** the owner promotes an integration branch that carries a held change
- **THEN** Promote is refused as `no-hold`, naming the hold, and no promotion exists

#### Scenario: A merge in flight settles
- **WHEN** a hold is placed while a change's merge effect is running
- **THEN** the merge settles, and if it completed the change is landed as usual

### Requirement: Results under a hold are kept
Submissions SHALL NOT be refused because a change is held. A result submitted under a hold SHALL be recorded as a round and pushed, and its CI SHALL be read. Its review, landing slot, and merge SHALL wait until no hold covers the change, then continue from where they stopped unless a newer task revision superseded the round.

#### Scenario: A result arrives under a hold
- **WHEN** a held change's developer submits a result
- **THEN** the result and its round exist, its CI is read, and no review handoff is dispatched while the hold stands

#### Scenario: Release resumes the round
- **WHEN** the hold on that change is released after its CI passed
- **THEN** the review handoff is dispatched for that same round

### Requirement: A whole-plan hold refuses Start
Start SHALL evaluate the appended precondition `no-hold` and SHALL refuse while a whole-plan hold of the plan is active, naming it. A hold scoped to changes SHALL NOT refuse Start; its changes SHALL wait under the hold.

#### Scenario: Start under a plan hold
- **WHEN** the owner starts a plan that has an active whole-plan hold
- **THEN** Start is refused as `no-hold`, naming the hold

#### Scenario: Start under a changes hold
- **WHEN** the owner starts a plan whose only active hold covers change `ui`
- **THEN** Start succeeds and `ui` is not provisioned while the hold stands

### Requirement: Holds are released only by the owner
The human SHALL be able to release a hold, with a reason, under a command id: wholly, for some of its changes, or by narrowing a whole-plan hold to named changes in one transaction. The human SHALL be able to extend a hold's deadline. Kawai SHALL NOT release a hold when its deadline passes, a pause resolves, or the plan closes.

#### Scenario: Narrowing a plan hold
- **WHEN** the owner narrows a whole-plan hold to change `api`
- **THEN** the plan hold is released and a hold on `api` with the same rationale, cite, and deadline is active, in one transaction, and a replay of the command changes nothing

#### Scenario: The deadline passes
- **WHEN** a hold's deadline passes
- **THEN** the hold stays active and an attention item asks the owner to release or extend it

### Requirement: Holds are visible to the owner and agents
The plan detail and `plan_get` SHALL list each hold with scope, changes, rationale, deadline, cite, and release. Supervision SHALL name `hold` as a held change's cause, with its holds and deadlines, so the change never reads as stalled. An overdue hold of an open plan SHALL raise the `plan-hold-overdue` attention item until it is released or extended.

#### Scenario: A held change's cause
- **WHEN** a held change's CI has passed and its review waits for the release
- **THEN** its supervision cause is `hold`, naming the hold and its deadline, and no stall alert is raised

#### Scenario: Extending clears the item
- **WHEN** the owner extends an overdue hold
- **THEN** its `plan-hold-overdue` item clears, and a new one appears only if the new deadline also passes

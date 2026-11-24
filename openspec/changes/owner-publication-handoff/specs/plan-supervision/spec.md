# Spec Delta

## ADDED Requirements

### Requirement: A pending publication handoff is a named wait
While a running change's task has a pending publication handoff, the change SHALL list an `owner-publication` wait naming the handoff, its state, its base revision, and who acts next, so it is never reported as a `no-progress` stall. The wait SHALL NOT stop, dispatch, pause, or release the change, its parallel slot, its dependents, or the landing slot.

#### Scenario: A prepared correction waits on the owner
- **WHEN** change `api`'s holder is archived, its task has an open handoff, and no other wait applies
- **THEN** `api` reads waiting on owner publication, naming the handoff and the human as the next actor, and no `no-progress` stall or stall alert is raised for it

#### Scenario: Execution limits are unchanged
- **WHEN** a plan with a parallel limit of 2 has two running changes, one of whose tasks has an open handoff
- **THEN** both still count toward the limit, a third change still waits on the parallel limit, and dependents of the waiting change still wait on it

#### Scenario: Another wait stays the cause
- **WHEN** change `api` waits on pending CI while its task has an open handoff
- **THEN** `api`'s cause is pending CI, and the owner-publication wait is listed as also applying

#### Scenario: A stale handoff waits on its requester
- **WHEN** another revision is published while change `api`'s task has an open handoff
- **THEN** `api` still reads waiting on owner publication, naming the stale handoff and its requester (or the requester's group) as the next actor

#### Scenario: An ended handoff ends the wait
- **WHEN** `api`'s handoff is declined or withdrawn
- **THEN** `api` no longer lists an owner-publication wait, and its other waits and stall rules apply as before

#### Scenario: Publication ends the wait
- **WHEN** the human publishes the handoff
- **THEN** the change no longer lists an owner-publication wait, and the publication is not counted as meaningful progress

### Requirement: A pending handoff stands for the post-Amend item
When a change's open diagnosis awaits an amended contract and the change's task has a pending handoff, the attention queue SHALL show only the handoff's item for it, not the separate **Publish a task revision** item. Publishing the handoff SHALL close the diagnosis as any new task revision does.

#### Scenario: One item for the amended contract
- **WHEN** the Lead decides `Amend the contract` on `api`'s diagnosis and records a handoff with the amended clause
- **THEN** the queue shows one human-required item for `api`'s task, **Publish prepared revision**, and no **Publish a task revision** item

#### Scenario: Publishing the handoff closes the diagnosis
- **WHEN** the human publishes that handoff as revision 4
- **THEN** the diagnosis closes, and a fix attempt naming revision 4 is dispatched

#### Scenario: Without a handoff the existing item stays
- **WHEN** the Lead decides `Amend the contract` and records no handoff
- **THEN** the queue shows the human's **Publish a task revision** item with the decision's rationale, as before

### Requirement: A stall names a gone holder
A stall's attention item and the change's supervision SHALL say when the change's holder session is archived or gone and no live session runs the change. The stall's owner SHALL be unchanged.

#### Scenario: A stall with nothing running
- **WHEN** change `api` stalls without progress and its holder session is archived
- **THEN** the stall item, owned by the plan's Lead role, names the holder as archived and no session running `api`, with **Unblock the holder**

## ADDED Requirements

### Requirement: An open diagnosis reads stalled on convergence
A change with an open diagnosis SHALL read stalled as `convergence`, before any other stall and whatever the change waits on, naming the signals or the backstop with their evidence and the diagnosis card. While the card is undecided its wait SHALL be listed as also applying, and after `Amend the contract` the wait SHALL name the contract revision the owner is asked to publish.

#### Scenario: A diagnosis names its signals
- **WHEN** change `api` opens a diagnosis on S3 and S4
- **THEN** `api` reads stalled as `convergence`, naming S3 with its raised findings and S4 with its three counts, with the card's wait also applying

#### Scenario: Waiting for the amended contract
- **WHEN** the diagnosis of `api` is decided with `Amend the contract`
- **THEN** `api` still reads stalled as `convergence`, and its wait names the revision of its task the owner is asked to publish

### Requirement: The Plans view shows each change's open count by review
The Plans view SHALL show, for each change whose task has counted structured reviews, the open blocking count after each review of the current window in order, and the signals of an open diagnosis.

#### Scenario: A converging change
- **WHEN** the counts after the three reviews of `api` are 5, 3, and 1
- **THEN** the change row reads the counts 5, 3, 1 and names no signal

## MODIFIED Requirements

### Requirement: Repeating failures stall
A change whose two latest consecutive failed rounds have the same failure signature SHALL read stalled as `repeating-failure`, before the backstop opens a diagnosis, whatever the change waits on. The signature SHALL be the sorted names of the failing CI checks, followed by `review:fail` when the round's review failed by a stored text verdict; a review judged by structured findings SHALL add nothing, as the convergence signals judge it.

#### Scenario: The same check fails twice
- **WHEN** rounds 2 and 3 of `api` both fail only `ci / unit-tests`, and round 4's CI is pending
- **THEN** `api` reads stalled as `repeating-failure`, naming the check, with the CI wait listed as also applying, while it still has fix rounds left before the backstop

#### Scenario: Different failures
- **WHEN** round 2 fails `lint` and round 3 fails `unit-tests`
- **THEN** no repeating-failure stall is raised

#### Scenario: Two failed structured reviews
- **WHEN** rounds 2 and 3 of `api` pass CI and both fail on structured reviews, and no signal fires
- **THEN** no repeating-failure stall is raised

### Requirement: A stall alerts the Lead role once per episode
Each stall episode SHALL send one message from Kawai to the plan's Lead role, tagged `plan-stall` and routed under that role's profiles. It SHALL name the change, stage, holder, last progress and activity, rounds and failing checks, and next actions. A `convergence` episode's one message SHALL be its diagnosis card's question, also tagged `plan-stall`. A durable record SHALL keep one alert per episode across restarts. With no Lead role, the stall SHALL be an owner attention item only.

#### Scenario: One alert across a restart
- **WHEN** a stall is alerted and the server restarts while it lasts
- **THEN** no second alert is sent for that episode

#### Scenario: A new episode after progress
- **WHEN** a stalled change makes progress and later stalls again
- **THEN** a second alert is sent for the new episode

#### Scenario: No Lead role
- **WHEN** a change of a plan with no Lead role stalls
- **THEN** no message is sent, and the attention queue shows the stall for the owner

#### Scenario: A diagnosis sends one message
- **WHEN** change `api` opens a diagnosis on a plan with a Lead role
- **THEN** the Lead role receives one message from Kawai, tagged `plan-stall`, carrying the diagnosis card's question and options, and the stall sweep sends nothing more for it

### Requirement: Plan stops, stalls, and conditions need attention
The attention queue SHALL hold a human-owned item per stopped change (**Retry or stop execution**), per acceptance condition holding a change, and for a plan's newest failed promotion with none later and no correction open (**Promote again**); and one per stall, owned by the Lead role, else the human. A `convergence` stall SHALL be its open card's item, then after `Amend the contract` the human's **Publish a task revision**. Items SHALL link to their plan and change and clear with their cause.

#### Scenario: A stop needs the owner
- **WHEN** change `api` stops as `ci-timeout`
- **THEN** the attention queue shows an item for `api` owned by the human, naming the reason, with **Retry or stop execution** and a link to the change

#### Scenario: Retry clears the item
- **WHEN** the owner retries `api`
- **THEN** the item leaves the queue

#### Scenario: The amended contract needs the owner
- **WHEN** the diagnosis of `api` is decided with `Amend the contract`
- **THEN** the card's item leaves the queue, and an item for `api` owned by the human reads **Publish a task revision** with the decision's rationale and a link to the task

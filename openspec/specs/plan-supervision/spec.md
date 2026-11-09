# plan-supervision Specification

## Purpose
Explains an executing plan to its owner and Lead: each change's outcome and what it waits on, meaningful progress apart from activity, stalls that alert the Lead, what stopped and why, and the usage each role and profile spent, all derived from durable records.

## Requirements

### Requirement: Each change of an execution has one derived outcome
Each change of a plan's newest execution SHALL show exactly one outcome, derived when read and never stored: landed, running (stage and instruction holder), waiting (its cause), stalled, stopped (reason and detail), cancelled, or not started. The plan SHALL show counts per outcome, never a percentage. A landed change SHALL show whether its merged tree was verified and its base-branch CI.

#### Scenario: Counts, not a percentage
- **WHEN** a plan of five changes has two landed, one running, one waiting, and one stopped
- **THEN** the plan shows those counts per outcome and no percentage

#### Scenario: Unverified landing flagged
- **WHEN** a change landed while the base moved between the re-read and the merge
- **THEN** its outcome reads landed, flagged as not tree-verified, with its base-branch CI as the evidence

### Requirement: Waiting names its cause
A change that cannot proceed SHALL name one immediate cause: a dependency (or a stopped one), the parallel limit, staffing capacity (with its mailbox waiting reason), a parked holder or cooling profile, a pending approval or question, an open decision card, pending CI, a Kawai effect pending or retrying, member release, an acceptance condition, the landing slot (naming its holder), or an uncertain delivery. A named wait SHALL never count as a `no-progress` stall.

#### Scenario: Blocked by a stopped dependency
- **WHEN** change `ui` depends on `api`, which stopped as `round-limit`
- **THEN** `ui` reads waiting, blocked by stopped `api`, and is never reported as stalled

#### Scenario: Waiting on a decision card
- **WHEN** the dev holding `api` asked a question that is still open
- **THEN** `api` reads waiting on that card, naming who it is addressed to

#### Scenario: Slot held by a promotion
- **WHEN** a passed change waits while a promotion holds the team's landing slot
- **THEN** it reads waiting on the landing slot, naming the promotion

### Requirement: Meaningful progress is shown apart from activity
Each running change SHALL show its last meaningful progress and, separately, its last activity. Progress SHALL be one of: a result accepted by the submission check, CI passing, a review verdict recorded, a round passing, a landing, or a candidate passing. Activity SHALL be turns, messages, and tool use. Tokens, turns, and ticked task boxes SHALL never count as progress.

#### Scenario: Busy without progress
- **WHEN** a holder has run many turns for three hours without submitting a result
- **THEN** the change shows recent activity and its last progress three hours ago

#### Scenario: A result counts
- **WHEN** the holder submits a result the submission check accepts
- **THEN** the change's last progress is that result

### Requirement: An agent-held stage without progress stalls
An implement, fix, update, or review stage held by an agent, with no named wait, SHALL read stalled as `no-progress` when no meaningful progress happened within its deadline: 2 hours for implement, fix, and update, and 1 hour for review. The deadline SHALL count from the latest of the instruction's delivery, the last progress, and the end of the last named wait, and SHALL shorten to 15 minutes while the holder sits idle.

#### Scenario: Idle holder
- **WHEN** a dev's turn ended 20 minutes ago without a result, and it has no running background task, pending request, or queued mail
- **THEN** its change reads stalled as `no-progress`

#### Scenario: A wait restarts the clock
- **WHEN** a change waited 3 hours on a cooling profile and its holder resumed 30 minutes ago
- **THEN** it is not stalled, because its deadline counts from the end of the wait

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

### Requirement: A stopped change alerts the Lead role once per stop
While its execution runs, a change that stops SHALL send one message from Kawai to the plan's Lead role, tagged `plan-stop` and `stop:<reason>` and routed under that role's profiles. It SHALL name the change, the stop reason as a label with its detail, the rounds with their outcomes, the changes blocked by it, and that Retry is the owner's. A durable record SHALL keep each stop to one alert across restarts. Stops of a finished execution SHALL raise no alert. With no Lead role, the stop SHALL be an owner attention item only. Stop alerts SHALL not count as stall alerts in the team's summary.

#### Scenario: One alert across a restart
- **WHEN** a stop is alerted and the server restarts while the change stays stopped
- **THEN** no second alert is sent for that stop

#### Scenario: A new stop after Retry
- **WHEN** the owner retries a stopped change and it stops again
- **THEN** a second alert is sent for the new stop

#### Scenario: The owner stops the execution
- **WHEN** the owner stops an execution that has a stopped change not yet alerted
- **THEN** no alert is sent for it, because Retry is no longer possible

#### Scenario: No Lead role
- **WHEN** a change of a plan with no Lead role stops
- **THEN** no message is sent, and the attention queue shows the stop for the owner

### Requirement: The report says what stopped and why
For each stopped change the plan SHALL show the stop reason as a label with its detail, the last round's evidence, every change blocked by it directly or through other changes, and the next action, Retry or Stop execution. While any change is unlanded the plan SHALL report partial delivery as "Landed N of M" with what blocks the rest, and SHALL never claim its success criteria are met.

#### Scenario: Stop with blocked dependents
- **WHEN** `api` stopped as `round-limit`, `ui` depends on `api`, and `docs` depends on `ui`
- **THEN** the report lists `api` with its reason, last round's failing checks and findings, `ui` and `docs` as blocked, and Retry or Stop execution as next action

#### Scenario: Partial delivery
- **WHEN** an execution finished stopped with three of five changes landed
- **THEN** the plan reads "Landed 3 of 5" with the blockers, and nowhere states that its success criteria are met

### Requirement: The report shows candidates, strategy reviews, and decision measures
The report SHALL show each change's failed and superseded integration candidates beside it, with their checks and outside commits. It SHALL show a non-continue disposition of the plan in the current strategy impact review, linked to that review. It SHALL count Lead decisions overridden as "k of n" and show each landed forward fix's time from override to landing.

#### Scenario: Failed candidate beside its change
- **WHEN** a candidate of `api` failed CI and a later one landed
- **THEN** both show beside `api`, the failed one with its failing checks

#### Scenario: Override count
- **WHEN** the Lead recorded 12 decisions on a plan and the owner overrode 2
- **THEN** the report reads "2 of 12 Lead decisions overridden"

#### Scenario: Strategy disposition
- **WHEN** the current strategy impact review records `reconsider` for the plan
- **THEN** the report shows `reconsider` with a link to that review

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

### Requirement: Decision questions and fixes need attention
The team attention queue SHALL hold one item per open decision card, owned by the group it is addressed to or the human, and one per open fix or correction task: owned by the Lead role while it plans, and by the human while unassigned, while its revision awaits approval (**Approve revision N**), or while it is approved and not running (**Start execution**).

#### Scenario: Fix awaiting approval
- **WHEN** the Lead has submitted the revision holding a fix change
- **THEN** the queue shows the fix owned by the human with **Approve revision N** and a link to the plan

#### Scenario: Owner-addressed question
- **WHEN** a card is addressed to the owner
- **THEN** the queue shows it as needing the human, linked to the card

### Requirement: The morning summary covers plans
The team's summary SHALL add, over its window of the last 24 hours, the changes landed, the changes stopped, the stall alerts raised, the decisions recorded, and the overrides made, each linking to its plan. These buckets SHALL be read from durable records only.

#### Scenario: After a night away
- **WHEN** two changes landed, one stopped, and the Lead recorded three decisions overnight, all within the last 24 hours
- **THEN** the summary lists both landings, the stop, and the three decisions, each linked to its plan

#### Scenario: Survives a restart
- **WHEN** the server restarted during the night
- **THEN** the plan buckets still list everything in the last 24 hours

### Requirement: Kawai records usage per completed turn
Plan usage SHALL read the per-turn `chat_turn_usage` record that `team-process-metrics` writes: session, group, profile, model, input, output, cache-read, and cache-creation tokens, steps, and success. A mail-started turn SHALL belong to that mail's task, none when it has none; any other turn to the session's task. Mail delivered during a turn SHALL not change it. A turn on no task SHALL have a null task and be outside every plan read; nothing SHALL be backfilled.

#### Scenario: A dev's turn
- **WHEN** a dev spawned for change `api` completes a turn
- **THEN** one usage record names its task, group, profile, model, token counts, and steps

#### Scenario: The Lead answers a question
- **WHEN** a Lead session bound to a task completes a turn started by a task-less decision question
- **THEN** its usage record names no task, and no plan's usage counts it

#### Scenario: Mail arrives mid-turn
- **WHEN** task mail is delivered while a turn started by other task mail is still running
- **THEN** that turn's usage record names the task of the mail that started it

### Requirement: The Plans view shows usage per role and profile
A plan SHALL show the recorded usage of the tasks linked to it and of its fix and correction tasks, summed by group and profile and per change, as tokens and turns. It SHALL show no currency and set no budget, and SHALL state what is not counted: turns outside the plan's tasks, and Task subagent calls.

#### Scenario: Two profiles in one role
- **WHEN** `middle-devs` worked a plan on profiles `glm` and `mimo`
- **THEN** the plan shows tokens and turns for each of the two profiles under `middle-devs`, and per change

#### Scenario: No cost or budget
- **WHEN** the owner opens a plan's usage
- **THEN** no currency amount or budget is shown, and a note says turns outside the plan's tasks and Task subagent calls are not counted

### Requirement: Agents read supervision and cannot act on executions
`plan_get` SHALL include each change's outcome, cause, progress, activity, and stalls, the report, and the plan's usage. No agent tool SHALL retry, stop, or dismiss anything in an execution, and stall alerts SHALL be answered by acting, never by replying to Kawai.

#### Scenario: Supervision in plan_get
- **WHEN** the Lead reads a plan with a stalled change
- **THEN** `plan_get` shows the stall kind, its deadline, the holder, and the last progress and activity

#### Scenario: Replying to an alert
- **WHEN** the Lead replies to a `plan-stall` message
- **THEN** the reply is refused with Kawai's reply guidance, and nothing is queued

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

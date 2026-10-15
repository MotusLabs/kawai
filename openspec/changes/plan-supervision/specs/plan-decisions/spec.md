# Spec Delta

## Purpose

Records the questions agents raise while executing a plan and the decisions that settle them, so the owner can review every Lead decision beside the work it affected and override it, with Kawai turning each override into a forward fix that runs through the plan's normal checks.

## ADDED Requirements

### Requirement: A plan may name its Lead role
Plan content SHALL accept an optional `leadGroup`, which SHALL be one of the plan's roles. Saving SHALL refuse a lead group missing from the roles. Content without a lead group SHALL normalize and hash exactly as it did before this field existed. When the current approved revision names no lead group, questions and fixes SHALL go to the owner.

#### Scenario: Lead group outside the roles refused
- **WHEN** a draft sets `leadGroup` to `lead` and its roles list only `middle-devs` and `reviewers`
- **THEN** saving is refused naming `lead` as missing from the roles

#### Scenario: Earlier revisions keep their hash
- **WHEN** a revision approved before this change is read again
- **THEN** its content has no lead group and its content hash is unchanged

### Requirement: Agents on plan work ask with decision cards
An agent SHALL be able to ask a question with `decision_ask`, giving the question, the options considered, and context, when its task is linked to a plan, is a plan's fix or correction task, or when it is a member of the plan's Lead role naming the plan. Kawai SHALL record a decision card naming the asker's session, group, and profile, the plan, revision, change, and task, and return the card id. Other callers SHALL be refused naming the rule.

#### Scenario: A dev asks about its change
- **WHEN** the dev holding the task for change `api` asks whether to keep the v1 endpoint, with two options
- **THEN** a card is recorded with the question, both options, the dev's session, group, and profile, the plan, its revision, `api`, and the task, and the tool returns the card id

#### Scenario: An agent without plan work is refused
- **WHEN** an agent whose task is linked to no plan, and that names no plan whose Lead role it belongs to, calls `decision_ask`
- **THEN** the call is refused naming the rule, and no card or mail is written

#### Scenario: Another team's plan is not found
- **WHEN** a Lead-role member names a plan id of another team
- **THEN** the tool answers not found and writes nothing

### Requirement: Questions go to the Lead role, else to the owner
A card asked by an agent outside the plan's Lead role SHALL be sent as group mail from the asker to the Lead role's group, tagged `decision-question` and naming the card. A card asked by a Lead-role member, or on a plan with no Lead role, SHALL be addressed to the owner as an attention item, and no mail SHALL be sent.

#### Scenario: A dev's question reaches the Lead
- **WHEN** a dev asks on a plan whose Lead role is `lead`
- **THEN** one message from the dev to group `lead`, tagged `decision-question`, names the card, its question, and its options

#### Scenario: The Lead's question reaches the owner
- **WHEN** a member of `lead` asks on its plan
- **THEN** the card is addressed to the owner, shows in the attention queue as needing the human, and no mail is sent

#### Scenario: No Lead role
- **WHEN** a dev asks on a plan whose approved revision names no lead group
- **THEN** the card is addressed to the owner and no mail is sent

### Requirement: The Lead decides cards with a recorded rationale
A member of the group a card is addressed to SHALL decide it with `decision_record`, giving a choice (one of the options, or new text), a required rationale, and optionally the affected tasks. Kawai SHALL record the decision with the decider's session, group, and profile, and deliver it as the decider's reply in the question's thread.

#### Scenario: The Lead answers a dev
- **WHEN** a member of `lead` records option 2 for the dev's card, with a rationale
- **THEN** the card shows the decision with that member's session, group, and profile, and the dev receives the answer as a reply in the question's thread

#### Scenario: A decision without a rationale is refused
- **WHEN** a member of `lead` records a choice with an empty rationale
- **THEN** the call is refused asking for a rationale, and nothing is written

#### Scenario: A member of another group cannot decide
- **WHEN** a reviewer calls `decision_record` on a card addressed to `lead`
- **THEN** the call is refused naming the addressed group, and nothing is written

### Requirement: A card takes one first decision
A card SHALL take only one first decision, from the Lead or the owner. A repeat `decision_record` by the same caller with the same choice SHALL return the recorded decision. Any other attempt to decide a decided card SHALL be refused naming its decider, and only an owner override SHALL replace a decision.

#### Scenario: Retry after a lost result
- **WHEN** the Lead records a decision, loses the tool result, and records the same choice again
- **THEN** the second call returns the first decision, and one decision and one reply exist

#### Scenario: The owner answered first
- **WHEN** the Lead records a decision on a card the owner has already answered
- **THEN** the call is refused naming the owner's decision, and no reply is sent

### Requirement: The Lead records its own calls
A Lead-role member SHALL record a decision it made without a question by calling `decision_record` with the plan, the question it settled, the options considered, the choice, and the rationale. Kawai SHALL record a decided card with that member as both asker and decider. A caller outside the Lead role SHALL be refused.

#### Scenario: An own call becomes a card
- **WHEN** a member of `lead` records that change `ui` keeps the legacy theme, with two options considered and a rationale
- **THEN** the plan shows a decided card for that call with the member as asker and decider

#### Scenario: A dev cannot record an own call
- **WHEN** a dev outside `lead` calls `decision_record` without a card
- **THEN** the call is refused naming the Lead role, and nothing is written

### Requirement: The owner answers open cards
The human SHALL answer any open card from the Plans view under a command id, with a choice and an optional rationale. Kawai SHALL send the answer to the asker as direct mail from the human, on the card's task, tagged `decision-answer`, and SHALL cancel the question mail while it is still queued or awaiting a request. A replay with the same payload SHALL return the recorded answer, and a different payload SHALL be refused naming the field.

#### Scenario: The owner answers before the Lead
- **WHEN** the owner answers a card whose question mail is still queued for `lead`
- **THEN** the question mail is cancelled, the asker receives the owner's answer, and the card shows the owner as decider

#### Scenario: Answer replayed
- **WHEN** an answer is resent with the same command id and payload after its result was lost
- **THEN** the recorded answer is returned, and no second decision or mail exists

#### Scenario: No agent answers for the owner
- **WHEN** an agent lists its `kawai-team` tools
- **THEN** none answers a card as the owner or overrides a decision

### Requirement: The owner overrides a decision
The human SHALL override a card's current decision under a command id, giving another option or new text and a required rationale, and naming the decision being replaced. Kawai SHALL record the override as the card's next decision, superseding the previous one, and keep every earlier decision readable. An override naming a decision that is no longer current SHALL be refused naming the current one. An open card SHALL be answered, not overridden.

#### Scenario: Override supersedes the Lead's decision
- **WHEN** the owner overrides the Lead's option 2 with option 1 and a rationale
- **THEN** the card shows option 1 as current, decided by the owner, and option 2 as superseded with its rationale

#### Scenario: Stale override refused
- **WHEN** the owner overrides a decision that another override has already replaced
- **THEN** the override is refused naming the current decision, and nothing is written

#### Scenario: Override without a rationale refused
- **WHEN** the owner submits an override with an empty rationale
- **THEN** it is refused asking for a rationale

### Requirement: An override creates a forward-fix task
In the override's transaction, Kawai SHALL create a fix task naming the card, the superseded and the new decision, and the affected tasks, changes, and commits, and dispatch it to the plan's Lead role under that role's profiles. With no Lead role, the fix task SHALL stay unassigned for the owner. A newer override of the card SHALL cancel an earlier fix task that is still open.

#### Scenario: Fix task for the Lead
- **WHEN** the owner overrides a decision on a plan whose Lead role is `lead`
- **THEN** a fix task created by Kawai names the card, both decisions, and the affected work, and its instruction is dispatched to `lead`

#### Scenario: No Lead role
- **WHEN** the owner overrides a decision on a plan with no Lead role
- **THEN** the fix task is created unassigned, and the attention queue asks the owner to assign it

#### Scenario: A second override replaces the fix
- **WHEN** the owner overrides a card again while its first fix task is still open
- **THEN** the first fix task is cancelled with a note naming the newer override, and a new fix task is created

### Requirement: An override reopens a completed plan
An override on a completed plan SHALL reopen it in the same transaction, recorded as a plan event by the human naming the override, so the fix can be approved as a new revision. An override on a cancelled plan SHALL be refused until the owner reopens the plan.

#### Scenario: Completed plan reopened
- **WHEN** the owner overrides a decision on a plan Kawai completed
- **THEN** the plan is open again, its history shows a reopen event naming the override, and it accepts new revisions

#### Scenario: Cancelled plan refused
- **WHEN** the owner overrides a decision on a cancelled plan
- **THEN** the override is refused asking to reopen the plan first, and nothing is written

### Requirement: A forward fix runs as a plan change
The fix task's instruction SHALL ask for an OpenSpec change, landed on the base branch and added to a plan revision as a change whose `fixes` names the fix task, so it passes the plan's approval, validation, Start, and gate. Plan content SHALL accept `fixes` on a change as a list of fix or correction task ids, checked for format and uniqueness at save. An id naming no fix or correction task of the plan SHALL show as a warning and complete nothing.

#### Scenario: Fix change names the fix task
- **WHEN** the Lead adds change `api-v1-restore` with `fixes` naming the fix task and submits the revision
- **THEN** the revision shows `api-v1-restore` as the forward fix of that override, awaiting the owner's approval

#### Scenario: Unknown reference warns
- **WHEN** a change's `fixes` names an id that is not a fix or correction task of the plan
- **THEN** the plan shows a warning naming the id, and no fix status changes

### Requirement: Kawai closes a forward fix once its changes land
Kawai SHALL mark a fix task done once a change naming it in `fixes` has landed and no change of the current approved revision naming it is unlanded. Each landed change SHALL be judged by the revision it landed under. A fix that needs no change SHALL end when the owner accepts the Lead's result saying so. A superseded fix SHALL never be completed by later landings.

#### Scenario: Fix lands
- **WHEN** the only change naming the fix task lands
- **THEN** Kawai marks the fix task done, journaled as Kawai with the landing

#### Scenario: A later revision drops the landed fix change
- **WHEN** the fix change lands from revision 5's execution after revision 6, which no longer names it, was approved
- **THEN** Kawai marks the fix task done, naming that landing

#### Scenario: No change needed
- **WHEN** the Lead submits a result explaining that the code already matches the override, and the owner accepts it
- **THEN** the fix task is done and the override's fix status reads no change

### Requirement: Each override shows its fix status
Each override SHALL show a fix status derived when read: planning, in review, approved (naming a running execution it waits for), running, landed (with the time from the override to the last landing), no change, superseded, or cancelled. Landings whose merged tree was not verified SHALL be flagged.

#### Scenario: Approved while another execution runs
- **WHEN** the owner approves the revision holding the fix change while an execution of the earlier revision still runs
- **THEN** the fix status reads approved and names that execution as what it waits for

#### Scenario: Landed with its duration
- **WHEN** the fix change lands 26 hours after the override
- **THEN** the fix status reads landed, with 26 hours from override to landing

### Requirement: A failed promotion gets a correction task
For a promotion that fails as `promotion-conflict` or `ci-failed`, Kawai SHALL create one correction task naming the promotion, its failure, and its evidence, dispatched to the plan's Lead role, or unassigned for the owner without one. Changes SHALL answer it through `fixes` as for a fix task, and it SHALL close as a fix task does, or when a later promotion of the plan merges. Other failures SHALL create no task.

#### Scenario: Conflict gets a correction
- **WHEN** a promotion fails as `promotion-conflict` on two files
- **THEN** one correction task created by Kawai names the promotion and both files, and is dispatched to `lead`

#### Scenario: The correction's change lands
- **WHEN** the change naming the correction task lands on the integration branch
- **THEN** Kawai marks the correction task done, and the owner is asked to promote again

#### Scenario: A later promotion closes it
- **WHEN** the plan's next promotion merges
- **THEN** Kawai marks the correction task done, journaled with the merged promotion

#### Scenario: A moved target gets no task
- **WHEN** a promotion fails as `target-moved`
- **THEN** no correction task is created, and the owner is asked to promote again

### Requirement: Decision cards show beside their change
The Plans view SHALL show each card beside its change, and cards without a change in a Decisions list. A card SHALL show its question, options, choice, rationale, who asked and who decided (session, group, and profile), the affected tasks, their commits since the decision, its decision history, and the fix status, with **Answer** or **Override**. Controls SHALL disable while disconnected, and refusals SHALL show inline.

#### Scenario: Card beside its change
- **WHEN** the owner opens a plan whose change `api` has a decided card
- **THEN** the card sits beside `api` with its question, options, choice, rationale, asker and decider with their profiles, affected tasks, and their commits

#### Scenario: Override history
- **WHEN** a card has been overridden once
- **THEN** it shows the owner's decision as current and the Lead's as superseded, each with its rationale, and the fix status

#### Scenario: Disconnected
- **WHEN** the connection drops while a card is open
- **THEN** Answer and Override are disabled until it returns

### Requirement: Agents read decisions and are pointed to cards
`plan_get` SHALL include the plan's cards and decisions. No agent tool SHALL answer a card as the owner or override a decision. The system prompt's plan note SHALL tell agents on plan work to ask with `decision_ask` rather than a question to the human, and tell Lead-role members to decide with `decision_record`.

#### Scenario: Cards in plan_get
- **WHEN** an agent reads a plan with one open and one overridden card
- **THEN** `plan_get` lists both cards with their decisions, states, and fix status

#### Scenario: Plan note
- **WHEN** an agent of a team with plans starts
- **THEN** its plan note names `decision_ask` for questions on plan work and `decision_record` for the Lead role

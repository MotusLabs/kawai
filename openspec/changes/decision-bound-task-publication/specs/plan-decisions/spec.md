# Spec Delta

## MODIFIED Requirements

### Requirement: Questions go to the Lead role, else to the owner
An ordinary card asked by an agent outside the plan's Lead role SHALL be sent as group mail from the asker to the Lead role's group, tagged `decision-question` and naming the card. A card asked by a Lead-role member, or on a plan with no Lead role, SHALL be addressed to the owner as an attention item, and no mail SHALL be sent. An ask that names a publication handoff SHALL be refused when this routing would address it to the Lead.

#### Scenario: A dev's question reaches the Lead
- **WHEN** a dev asks on a plan whose Lead role is `lead`
- **THEN** one message from the dev to group `lead`, tagged `decision-question`, names the card, its question, and its options

#### Scenario: The Lead's question reaches the owner
- **WHEN** a member of `lead` asks on its plan
- **THEN** the card is addressed to the owner, shows in the attention queue as needing the human, and no mail is sent

#### Scenario: No Lead role
- **WHEN** a dev asks on a plan whose approved revision names no lead group
- **THEN** the card is addressed to the owner and no mail is sent

#### Scenario: A handoff ask cannot redirect a Lead question
- **WHEN** a requester outside the plan's Lead role supplies a publication handoff id on that plan
- **THEN** the ask is refused and no card, binding or question mail is recorded

### Requirement: The owner answers open cards
The human SHALL answer any open card from the Plans view under a command id, with a choice and an optional rationale. Kawai SHALL send the answer to the asker as direct mail from the human, on the card's task (task-less for a bound publication card), tagged `decision-answer`, and SHALL cancel the question mail while it is still queued or awaiting a request. A replay with the same payload SHALL return the recorded answer, and a different payload SHALL be refused naming the field.

#### Scenario: The owner answers before the Lead
- **WHEN** the owner answers a card whose question mail is still queued for `lead`
- **THEN** the question mail is cancelled, the asker receives the owner's answer, and the card shows the owner as decider

#### Scenario: Answer replayed
- **WHEN** an answer is resent with the same command id and payload after its result was lost
- **THEN** the recorded answer is returned, and no second decision or mail exists

#### Scenario: No agent answers for the owner
- **WHEN** an agent lists its `kawai-team` tools
- **THEN** none answers a card as the owner or overrides a decision

#### Scenario: Answering a bound card publishes nothing
- **WHEN** the human answers a bound card with ordinary choice text, including `Approve and publish`, or answers one whose handoff became stale
- **THEN** an answer is recorded and its answer mail carries no task attachment, the handoff disposition and task revision do not change, and further fresh approval of the card is refused

## ADDED Requirements

### Requirement: A publication question binds one prepared handoff
`decision_ask` SHALL accept an optional `publication_handoff_id` for an owner-addressed question by the originating requester. The handoff SHALL be current, open, prepared with notification, and for a task of an authorized plan change. A task-scoped session SHALL use its own task. A plan-only Lead SHALL use a verified task of that plan. Binding SHALL record the card and immutable link together and SHALL publish nothing.

#### Scenario: A requester binds a handoff for review
- **GIVEN** an eligible handoff created with `task_request_publication` and readable with `task_get`
- **WHEN** its requester supplies the handoff id in `decision_ask` from the task's eligible session or its plan-only Lead session
- **THEN** the tool returns the owner card id, task id, handoff id, base revision and full prepared hash, and no revision, notice or question mail is written

#### Scenario: Foreign, borrowed and malformed bindings are refused
- **WHEN** a requester supplies an unknown or foreign id, a handoff of a different task from its resolved scope, a group peer's handoff, a nonnotifying handoff, or a malformed id
- **THEN** the tool refuses with no card, binding or fallback ordinary question, and foreign records are indistinguishable from missing ones

#### Scenario: A retry recovers the same binding
- **WHEN** the original requester retries the typed ask with the same normalized question, options, context and scope, including after the handoff ends
- **THEN** the same card and link are returned as a replay, and changing the question, options or context under that handoff id is refused

### Requirement: The human reviews the exact bound edit
The Plans view SHALL let the human read the named handoff and exact published base from its card. It SHALL show the task, base, complete before/after direction, acceptance and contract, prepared rationale, notification choice and available evidence. The owner SHALL confirm with an explicit **Approve and publish** action using the review's identity. Ordinary plan detail and `plan_get` SHALL expose the binding and any receipt without expanding the prepared text.

#### Scenario: Review is scoped to the card and base
- **WHEN** the human opens a bound card's review, including after a newer handoff or a team switch
- **THEN** only the selected card's exact handoff and base are shown, stale contents are identified as stale, and disconnected, unavailable or in-flight reviews cannot be confirmed

#### Scenario: Ordinary cards remain decision only
- **WHEN** a card has no typed handoff binding, including a diagnosis, dispute, old card or a question containing a handoff id in its text
- **THEN** the card retains its existing controls and behavior, and attempts to approve a publication through that card are refused without effect

### Requirement: Fresh approval publishes only the reviewed handoff
**Approve and publish** SHALL be human-only and SHALL resolve the plan, task, card and handoff from trusted records in the same team. A fresh approval SHALL require an open card, an exact reviewed link and still-current task base, plan and execution context. It SHALL use only the stored prepared edit and SHALL atomically record the first decision and prepared publication. A refusal SHALL leave both unchanged.

#### Scenario: The owner approves the prepared revision
- **WHEN** the human confirms a current exact handoff review
- **THEN** the human is recorded as decider and revision author, the exact prepared edit becomes the next task revision with the prepared rationale, and the response and plan history identify the decision, handoff and revision together

#### Scenario: A moved base or scope refuses approval
- **WHEN** the review's identity differs, the handoff ends, the task base moves even with an unchanged contract, or the approved plan, execution pin, ownership, change generation or attempt changes before publication
- **THEN** approval is refused with the reason and no decision, receipt, revision, disposition change, notice or wakeup is written by that command

#### Scenario: An unauthorized or malformed approval writes nothing
- **WHEN** an agent attempts the human action, an owner action names another team's plan or card, or it supplies replacement content or invalid addressing or review fields
- **THEN** the attempt is refused with no writes and no foreign receipt or review content

### Requirement: One approval intent has one durable receipt
The combined action SHALL use a stable plan command id bound to the action, card, reviewed handoff, binding identity and normalized owner rationale. An exact replay SHALL return its original decision and receipt before fresh eligibility is checked. A different action or payload using that key SHALL be refused. The receipt SHALL identify the associated task revision and original notice and wakeup ids independently of later delivery and task state.

#### Scenario: Competing actions have only their own effects
- **WHEN** two approvals compete with the same or different keys, or an approval competes with an answer, standalone prepared publication, edited draft publication or intervening ordinary revision
- **THEN** only the eligible winner's effects commit, matching approvals return the same receipt, and no task-only publication or decision-only answer can be replayed as an approval

#### Scenario: Reuse of a command id compares the action and input
- **WHEN** a previously committed command id is used with a changed card, handoff id, binding identity, owner rationale or action, including reuse of an approval key by Answer or Override
- **THEN** the command refuses naming the mismatch, the earlier record stands and no additional effects are written

#### Scenario: Restart distinguishes uncommitted and committed intent
- **WHEN** the service stops before commit or loses the response after commit for a binding or approval
- **THEN** reopen shows no partial uncommitted effects, committed intent is readable and exactly replayable, and boot creates no approval, revision or duplicate notice

#### Scenario: Later decisions preserve the original receipt
- **WHEN** the owner overrides the decision, or its task or execution moves after publication
- **THEN** the receipt remains readable with the first decision and an exact retry returns it without publishing or notifying again

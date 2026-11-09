## ADDED Requirements

### Requirement: Kawai raises a diagnosis card in its own name
When a diagnosis opens, Kawai SHALL raise one decision card for it, asked by Kawai and scoped to the change's task. It SHALL go as Kawai's mail to the plan's Lead role, tagged `decision-question` and `plan-stall`, or to the owner when the plan has no Lead role. The card SHALL name the signals or the backstop, the findings involved with their clauses, and the open blocking count after each review of the window.

#### Scenario: The Lead receives a diagnosis
- **WHEN** a change of a plan whose Lead role is `lead` opens a diagnosis on S2
- **THEN** group `lead` receives one message from Kawai, tagged `decision-question` and `plan-stall`, naming the card, S2's clause and findings, the counts by review, and the options

#### Scenario: No Lead role
- **WHEN** a change of a plan with no Lead role opens a diagnosis
- **THEN** the card is addressed to the owner, shows in the attention queue as needing the human, and no mail is sent

### Requirement: A diagnosis card offers the outcomes that apply
A diagnosis card SHALL offer, in order: `Fix round`; `Reject` with the blocking findings the signals name, at most ten, when there are any; `Amend the contract`; `Reassign to <group>` for each other group the execution's plan revision names for a change, at most four; and `Escalate`. A decision SHALL choose one of them, and Kawai SHALL send no answer mail; the outcome is the reply.

#### Scenario: Options of a stagnating change
- **WHEN** the change `api`, implemented by `middle-devs`, opens a diagnosis on S4 with F3 and F4 blocking, and the plan names `senior-devs` for another change
- **THEN** the card offers `Fix round`, `Reject F3, F4`, `Amend the contract`, `Reassign to senior-devs`, and `Escalate`

#### Scenario: Scope pressure names nothing to reject
- **WHEN** a diagnosis opens on S5 alone, whose findings are out of contract and do not block
- **THEN** the card offers no `Reject` option

#### Scenario: A free-text choice is refused
- **WHEN** the Lead records a decision on a diagnosis card with the choice "try harder"
- **THEN** the decision is refused naming the options, and nothing is recorded
